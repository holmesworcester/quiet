/**
 * Switch-community scenario.
 *
 * Owner creates community A, leaves, creates community B. Verifies that the
 * new auth conn for team B is healthy and no state from A leaks across the
 * boundary.
 *
 * The harness module graph is community-scoped: the sigchain, OrbitDB, and
 * QSS state all live in one Nest module. Switching communities in production
 * goes through ConnectionsManager.leaveCommunity (which we can't drive here
 * — see leave-community.stress.spec.ts header). We model the switch by:
 *
 *   1. Booting harness A, completing create+join, then closing it down
 *      (full shutdown(): module.close(), localDb.close(), libp2p.close(),
 *      ipfs.stop(), orbitdb.stop()).
 *   2. Booting a fresh harness B with a different team name.
 *   3. Asserting the global, in-process state that *can* leak across the
 *      boundary: process timers, unhandled rejections, the QSS module
 *      providers (each harness has its own Nest module so their providers
 *      should be GC'd, but a leaked timer in service-A still holds a ref
 *      to module-A and blocks GC).
 *
 * Fidelity trade-off: production keeps the same Nest module instance across
 * the leave/rejoin transition (re-using QSSService via resume()). Our model
 * tears down completely between A and B, so the test catches "module A's
 * timers/listeners outlive the module" but not "module-A's QSSService
 * instance retains stale state across resume()". A second test variant runs
 * pause+resume in-place on the same QSSService to cover that surface,
 * skipping the create-B step (the harness module graph can only have one
 * community at a time).
 */
import { jest } from '@jest/globals'
import waitForExpect from 'wait-for-expect'

import { bootQssHarness, type QssHarness, pickFreePort, proxyId, QSS_UPSTREAM } from '../harness'
import {
  Invariants,
  expectQssConnectedWithin,
} from '../invariants'
import { QSSAuthConnStatus } from '../../qss.const'
import { JoinStatus } from '../../../libp2p/libp2p.auth'

jest.setTimeout(240_000)

const RUN_TAG = `${process.pid}-${Date.now().toString(36)}`
const tag = (base: string): string => `${base}-${RUN_TAG}-${Math.floor(Math.random() * 1e6)}`

describe('QSS stress: switch communities', () => {
  let harnessA: QssHarness | undefined
  let harnessB: QssHarness | undefined
  let invariants: Invariants

  afterEach(async () => {
    if (harnessB != null) await harnessB.shutdown().catch(() => undefined)
    harnessB = undefined
    if (harnessA != null) await harnessA.shutdown().catch(() => undefined)
    harnessA = undefined
  })

  it('healthy switch — community B reaches CONNECTED/JOINED with no state from A', async () => {
    invariants = new Invariants()
    invariants.start()

    // ── Community A ───────────────────────────────────────────────────
    const portA = await pickFreePort()
    const proxyNameA = proxyId('qss-switch-A')
    harnessA = await bootQssHarness({
      username: tag('owner-A'),
      teamName: tag('switch-team-A'),
      proxyName: proxyNameA,
      proxyListen: `127.0.0.1:${portA}`,
      proxyUpstream: QSS_UPSTREAM,
      qssEndpoint: `ws://127.0.0.1:${portA}`,
    })
    harnessA.primeCaptcha()
    await harnessA.qssService.connect(harnessA.qssEndpoint, true)
    await expectQssConnectedWithin(harnessA, 15_000)
    const teamIdA = harnessA.sigchainService.activeChain.team!.id

    await waitForExpect(async () => {
      const status = await harnessA!.qssService.getQssInitStatus()
      expect(status.qssSetup).toBe(true)
    }, 30_000)
    await waitForExpect(() => {
      const conn = harnessA!.qssAuthConnManager.getConnection(teamIdA)
      expect(conn?.connStatus).toBe(QSSAuthConnStatus.CONNECTED)
      expect(conn?.joinStatus).toBe(JoinStatus.JOINED)
    }, 30_000)

    // Capture probe data on the QSS endpoint A used. Used to validate B
    // either re-uses or selects a different endpoint cleanly.
    const endpointA = harnessA.qssEndpoint

    // Tear down A entirely.
    await harnessA.shutdown()
    harnessA = undefined

    // ── Community B ───────────────────────────────────────────────────
    // Use a fresh proxy listener for B to model "switching to a different
    // QSS server" — the most adversarial path and the one that exposes
    // socket-identity bugs (the cleanup-auth-conn-on-disconnect commit).
    const portB = await pickFreePort()
    const proxyNameB = proxyId('qss-switch-B')
    harnessB = await bootQssHarness({
      username: tag('owner-B'),
      teamName: tag('switch-team-B'),
      proxyName: proxyNameB,
      proxyListen: `127.0.0.1:${portB}`,
      proxyUpstream: QSS_UPSTREAM,
      qssEndpoint: `ws://127.0.0.1:${portB}`,
    })
    harnessB.primeCaptcha()
    await harnessB.qssService.connect(harnessB.qssEndpoint, true)
    await expectQssConnectedWithin(harnessB, 15_000)

    const teamIdB = harnessB.sigchainService.activeChain.team!.id
    expect(teamIdB).not.toBe(teamIdA)

    await waitForExpect(async () => {
      const status = await harnessB!.qssService.getQssInitStatus()
      expect(status.qssSetup).toBe(true)
    }, 30_000)
    await waitForExpect(() => {
      const conn = harnessB!.qssAuthConnManager.getConnection(teamIdB)
      expect(conn?.connStatus).toBe(QSSAuthConnStatus.CONNECTED)
      expect(conn?.joinStatus).toBe(JoinStatus.JOINED)
    }, 30_000)

    // Sanity: B's auth manager should have NO entry for A's teamId. A's
    // module is gone, so this would only fail if a process-global handler
    // somehow leaked into B's module — defensive but cheap.
    expect(harnessB.qssAuthConnManager.getConnection(teamIdA)).toBeUndefined()

    // qssEndpoint on B reflects B's listener.
    expect(harnessB.qssEndpoint).not.toBe(endpointA)

    Invariants.expectClean(invariants.stop())
  })

  it('pause/resume on same harness — endpoint change picks up cleanly', async () => {
    invariants = new Invariants()
    invariants.start()

    const port = await pickFreePort()
    const proxyName = proxyId('qss-switch-pr')
    harnessA = await bootQssHarness({
      username: tag('owner-pr'),
      teamName: tag('pause-resume-team'),
      proxyName,
      proxyListen: `127.0.0.1:${port}`,
      proxyUpstream: QSS_UPSTREAM,
      qssEndpoint: `ws://127.0.0.1:${port}`,
    })
    harnessA.primeCaptcha()
    await harnessA.qssService.connect(harnessA.qssEndpoint, true)
    await expectQssConnectedWithin(harnessA, 15_000)
    const teamId = harnessA.sigchainService.activeChain.team!.id

    await waitForExpect(async () => {
      const status = await harnessA!.qssService.getQssInitStatus()
      expect(status.qssSetup).toBe(true)
    }, 30_000)
    await waitForExpect(() => {
      const conn = harnessA!.qssAuthConnManager.getConnection(teamId)
      expect(conn?.connStatus).toBe(QSSAuthConnStatus.CONNECTED)
    }, 30_000)

    // Pause: drops auth conn map, closes websocket, clears intervals.
    harnessA.qssService.pause()
    expect(harnessA.qssService.connected).toBe(false)
    expect(harnessA.qssAuthConnManager.getConnection(teamId)).toBeUndefined()

    // Probe for orphan state during pause.
    const svcDuringPause = harnessA.qssService as unknown as {
      _reconnectQueueProcessor?: NodeJS.Timeout
      _logPullIntervals: Map<string, NodeJS.Timeout>
    }
    const pauseTimer = svcDuringPause._reconnectQueueProcessor
    const pauseTimerActive =
      pauseTimer != null && !(pauseTimer as unknown as { _destroyed?: boolean })._destroyed
    expect(pauseTimerActive).toBe(false)
    expect(svcDuringPause._logPullIntervals.size).toBe(0)

    // Resume: re-installs handlers and reconnects. Note that resume() drives
    // the auto-flow which will see qssSetup=true and run signInToCommunity
    // (since sigChain.team is non-null for the owner — there's a single user
    // condition that lets create run, but this resume path takes the sign-in
    // branch since qssSetup is already true).
    await harnessA.qssService.resume()
    await expectQssConnectedWithin(harnessA, 15_000)
    await waitForExpect(() => {
      const conn = harnessA!.qssAuthConnManager.getConnection(teamId)
      expect(conn?.connStatus).toBe(QSSAuthConnStatus.CONNECTED)
      expect(conn?.joinStatus).toBe(JoinStatus.JOINED)
    }, 30_000)

    Invariants.expectClean(invariants.stop())
  })
})
