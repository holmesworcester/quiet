/**
 * Leave-community scenario.
 *
 * Owner creates a community on QSS, then "leaves". This harness only boots
 * the QSS path of the Nest module graph (TestModule + SigChain/Ipfs/OrbitDb/
 * QSS modules), so we don't have access to ConnectionsManager.leaveCommunity
 * (which also tears down libp2p, tor, and the full state machine). Instead we
 * drive the leave by:
 *
 *   1. Calling QSSService.close() — production's tear-down path for QSS,
 *      executed by ConnectionsManager.leaveCommunity transitively.
 *   2. Closing QSSAuthConnectionManager explicitly (close() calls this too,
 *      but we assert against its post-state).
 *   3. Clearing localDb's currentCommunityId via deleteCommunity.
 *
 * Fidelity trade-off vs. production: production also tears down libp2p,
 * orbitdb, Tor hidden services, and resets state. We don't run those here
 * because they're outside the harness's module graph. The QSS surface is what
 * this scenario is meant to assert against, so this trim is acceptable.
 *
 * Asserts:
 *  - QSS websocket reports disconnected
 *  - QSSAuthConnectionManager has no entry for the team
 *  - localDb's currentCommunityId is cleared (empty string)
 *  - QSSService._reconnectQueueProcessor is not orphaned (the timer fix in
 *    7.1.0; we double-check by reading the private field)
 *  - No log-pull intervals or DLQ timers remain set
 *  - No unhandled rejections during the leave path
 *
 * Then the same flow under chaos: latency on the close path, and an outage
 * during the leave so the disconnect arrives as a socket reset.
 */
import { jest } from '@jest/globals'
import waitForExpect from 'wait-for-expect'

import { bootQssHarness, type QssHarness, pickFreePort, proxyId, QSS_UPSTREAM } from '../harness'
import {
  Invariants,
  expectQssConnectedWithin,
  expectQssDisconnectedWithin,
} from '../invariants'

/**
 * Per-test fresh proxy listener. Avoids fighting parallel agent runs that
 * share the default 127.0.0.1:3013 listener on the shared toxiproxy admin.
 */
async function freshProxy(prefix: string): Promise<{ proxyName: string; proxyListen: string; qssEndpoint: string }> {
  const port = await pickFreePort()
  return {
    proxyName: proxyId(prefix),
    proxyListen: `127.0.0.1:${port}`,
    qssEndpoint: `ws://127.0.0.1:${port}`,
  }
}
import { QSSAuthConnStatus } from '../../qss.const'
import { JoinStatus } from '../../../libp2p/libp2p.auth'

jest.setTimeout(180_000)

interface LeaveProbes {
  reconnectTimerActive: boolean
  logPullIntervalCount: number
  logPullSuccessTimeoutCount: number
  storageReadyTeamCount: number
}

/**
 * Inspect QSSService private timer/state fields without modifying production.
 * If 7.1.0 left an orphan timer (the bug FINDINGS.md called out), this
 * surfaces as `reconnectTimerActive=true` after close().
 */
function probeQssService(harness: QssHarness): LeaveProbes {
  const svc = harness.qssService as unknown as {
    _reconnectQueueProcessor?: NodeJS.Timeout
    _logPullIntervals: Map<string, NodeJS.Timeout>
    _logPullSuccessTimeouts: Map<string, NodeJS.Timeout>
    _storageReadyTeams: Set<string>
  }
  const timer = svc._reconnectQueueProcessor
  const reconnectTimerActive =
    timer != null && !(timer as unknown as { _destroyed?: boolean })._destroyed
  return {
    reconnectTimerActive,
    logPullIntervalCount: svc._logPullIntervals?.size ?? 0,
    logPullSuccessTimeoutCount: svc._logPullSuccessTimeouts?.size ?? 0,
    storageReadyTeamCount: svc._storageReadyTeams?.size ?? 0,
  }
}

/**
 * Drive the harness through a "leave" — closing QSS state and clearing the
 * localDb pointers production's leaveCommunity would also clear. See file
 * header for what we don't replicate (libp2p/tor/orbitdb).
 */
async function leave(harness: QssHarness, communityId: string): Promise<void> {
  // Production's qssService.close() flips _paused, clears intervals, tears
  // down handlers, closes the auth manager and the websocket.
  harness.qssService.close()
  // localDb mirrors what ConnectionsManager.leaveCommunity does to the
  // currentCommunityId pointer.
  await harness.localDbService.deleteCommunity(communityId)
}

// Suffix every team/community name with a per-process unique tag. The QSS
// server persists per-team state across the session, so re-using the same
// name across runs (e.g. "leave-team") can cause subtle flake when an old
// sigchain or auth-conn entry survives. A fresh suffix per test keeps each
// run isolated on the server side.
const RUN_TAG = `${process.pid}-${Date.now().toString(36)}`
const tag = (base: string): string => `${base}-${RUN_TAG}-${Math.floor(Math.random() * 1e6)}`

describe('QSS stress: leave community', () => {
  let harness: QssHarness | undefined
  let invariants: Invariants

  afterEach(async () => {
    if (harness != null) await harness.shutdown().catch(() => undefined)
    harness = undefined
  })

  it('healthy leave — auth conn cleared, websocket disconnected, no orphan timers', async () => {
    invariants = new Invariants()
    invariants.start()

    const proxy = await freshProxy('qss-leave-1')
    harness = await bootQssHarness({
      username: tag('owner-leave'),
      teamName: tag('leave-team'),
      proxyName: proxy.proxyName,
      proxyListen: proxy.proxyListen,
      proxyUpstream: QSS_UPSTREAM,
      qssEndpoint: proxy.qssEndpoint,
    })
    harness.primeCaptcha()
    await harness.qssService.connect(harness.qssEndpoint, true)
    await expectQssConnectedWithin(harness, 15_000)

    const teamId = harness.sigchainService.activeChain.team!.id
    const communityId = harness.community.id

    // Wait for the create/join flow to fully settle so we're leaving from a
    // realistic post-create steady state, not mid-handshake.
    await waitForExpect(async () => {
      const status = await harness!.qssService.getQssInitStatus()
      expect(status.qssSetup).toBe(true)
    }, 30_000)
    await waitForExpect(() => {
      const conn = harness!.qssAuthConnManager.getConnection(teamId)
      expect(conn?.connStatus).toBe(QSSAuthConnStatus.CONNECTED)
      expect(conn?.joinStatus).toBe(JoinStatus.JOINED)
    }, 30_000)

    // ── Leave ─────────────────────────────────────────────────────────
    await leave(harness, communityId)

    // ── Invariants ────────────────────────────────────────────────────
    expect(harness.qssService.connected).toBe(false)
    expect(harness.qssClient.connected).toBe(false)
    // Auth manager should have dropped the entry on close().
    expect(harness.qssAuthConnManager.getConnection(teamId)).toBeUndefined()
    // currentCommunityId should be empty after deleteCommunity (see
    // local-db.service.ts:271-274) — getCurrentCommunity returns undefined.
    const currentCommunity = await harness.localDbService.getCurrentCommunity()
    expect(currentCommunity).toBeUndefined()

    const probes = probeQssService(harness)
    expect(probes.reconnectTimerActive).toBe(false)
    expect(probes.logPullIntervalCount).toBe(0)
    expect(probes.logPullSuccessTimeoutCount).toBe(0)
    expect(probes.storageReadyTeamCount).toBe(0)

    Invariants.expectClean(invariants.stop())
  })

  it('leave with downstream latency — close still drops to disconnected', async () => {
    invariants = new Invariants()
    invariants.start()

    const proxy = await freshProxy('qss-leave-2')
    harness = await bootQssHarness({
      username: tag('owner-leave-lat'),
      teamName: tag('leave-lat-team'),
      proxyName: proxy.proxyName,
      proxyListen: proxy.proxyListen,
      proxyUpstream: QSS_UPSTREAM,
      qssEndpoint: proxy.qssEndpoint,
    })
    harness.primeCaptcha()
    await harness.qssService.connect(harness.qssEndpoint, true)
    await expectQssConnectedWithin(harness, 15_000)

    const teamId = harness.sigchainService.activeChain.team!.id
    const communityId = harness.community.id

    await waitForExpect(async () => {
      const status = await harness!.qssService.getQssInitStatus()
      expect(status.qssSetup).toBe(true)
    }, 30_000)
    await waitForExpect(() => {
      const conn = harness!.qssAuthConnManager.getConnection(teamId)
      expect(conn?.connStatus).toBe(QSSAuthConnStatus.CONNECTED)
    }, 30_000)

    // Layer chaos right before the leave so any in-flight messages from QSS
    // arrive late (or not at all). close() is synchronous and shouldn't
    // depend on the wire to flip the local connected flag.
    await harness.toxiproxy.addToxic(harness.proxyName, {
      name: 'leave-latency',
      type: 'latency',
      stream: 'downstream',
      toxicity: 1.0,
      attributes: { latency: 800, jitter: 200 },
    })

    await leave(harness, communityId)

    expect(harness.qssService.connected).toBe(false)
    expect(harness.qssAuthConnManager.getConnection(teamId)).toBeUndefined()
    expect(probeQssService(harness).reconnectTimerActive).toBe(false)

    Invariants.expectClean(invariants.stop())
  })

  it('leave during a forced outage — disconnect-driven close path is also clean', async () => {
    invariants = new Invariants()
    invariants.start()

    const proxy = await freshProxy('qss-leave-3')
    harness = await bootQssHarness({
      username: tag('owner-leave-out'),
      teamName: tag('leave-out-team'),
      proxyName: proxy.proxyName,
      proxyListen: proxy.proxyListen,
      proxyUpstream: QSS_UPSTREAM,
      qssEndpoint: proxy.qssEndpoint,
    })
    harness.primeCaptcha()
    await harness.qssService.connect(harness.qssEndpoint, true)
    await expectQssConnectedWithin(harness, 15_000)

    const teamId = harness.sigchainService.activeChain.team!.id
    const communityId = harness.community.id

    await waitForExpect(async () => {
      const status = await harness!.qssService.getQssInitStatus()
      expect(status.qssSetup).toBe(true)
    }, 30_000)

    // Disable the proxy: the auth manager fires the disconnect handler which
    // closes all auth conns. THEN we call leave() — exercises the path where
    // the user hits "leave" while already disconnected.
    await harness.toxiproxy.setEnabled(harness.proxyName, false)
    await expectQssDisconnectedWithin(harness, 15_000)

    await leave(harness, communityId)

    expect(harness.qssService.connected).toBe(false)
    expect(harness.qssAuthConnManager.getConnection(teamId)).toBeUndefined()
    const probes = probeQssService(harness)
    expect(probes.reconnectTimerActive).toBe(false)
    expect(probes.logPullIntervalCount).toBe(0)

    Invariants.expectClean(invariants.stop())
  })
})
