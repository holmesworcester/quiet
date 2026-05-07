/**
 * Rejoin-after-server-restart scenario.
 *
 * Owner + community already set up, then the QSS connection drops as if the
 * server restarted. The QSS server *itself* is shared across the test process
 * and other in-flight scenarios, so we can't actually restart it — instead we
 * model the restart by toggling the toxiproxy proxy off/on for ~5s. The
 * client-side reconnect path is what we want to exercise; from the client's
 * point of view, "server restarted" and "proxy/network was down for 5s" look
 * identical (TCP RST → reconnect → fresh socket → fresh handshake).
 *
 * Fidelity trade-off: a real QSS restart would clear server-side socket
 * state, room membership, etc. Toxiproxy off/on doesn't — when we re-enable
 * the proxy, the server might still see the old socket as live until its TCP
 * keepalive expires. In practice this isn't a problem because the client
 * makes a fresh socket on reconnect and the server's old socket eventually
 * times out, but it does mean this scenario is closer to "QSS connection
 * loss" than "QSS server restart".
 *
 * What this catches:
 *  - Stale auth-conn references after the wire is back up (the
 *    cleanup-auth-connection-on-disconnect commit shape).
 *  - Reconnect path hangs: the QSS reconnect interval is 50ms baseline with
 *    backoff (qss.const.ts:2-4), so the client should reconnect fast.
 *  - In-flight log entries during the outage going to the DLQ and replaying
 *    on reconnect.
 *  - "Already-have-team" rejoin (the only-run-qss-log-sync-once-auth-conn-
 *    connected commit shape).
 */
import { jest } from '@jest/globals'
import waitForExpect from 'wait-for-expect'

import { bootQssHarness, type QssHarness, pickFreePort, proxyId, QSS_UPSTREAM } from '../harness'

async function freshProxy(prefix: string): Promise<{ proxyName: string; proxyListen: string; qssEndpoint: string }> {
  const port = await pickFreePort()
  return {
    proxyName: proxyId(prefix),
    proxyListen: `127.0.0.1:${port}`,
    qssEndpoint: `ws://127.0.0.1:${port}`,
  }
}
import {
  Invariants,
  expectQssConnectedWithin,
  expectQssDisconnectedWithin,
} from '../invariants'
import { QSSAuthConnStatus } from '../../qss.const'
import { JoinStatus } from '../../../libp2p/libp2p.auth'

jest.setTimeout(240_000)

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const RUN_TAG = `${process.pid}-${Date.now().toString(36)}`
const tag = (base: string): string => `${base}-${RUN_TAG}-${Math.floor(Math.random() * 1e6)}`

describe('QSS stress: rejoin after server restart (modelled)', () => {
  let harness: QssHarness | undefined
  let invariants: Invariants

  afterEach(async () => {
    if (harness != null) {
      // Make sure the proxy is back on for the next test.
      await harness.toxiproxy.setEnabled(harness.proxyName, true).catch(() => undefined)
      await harness.toxiproxy.clearToxics(harness.proxyName).catch(() => undefined)
      await harness.shutdown().catch(() => undefined)
    }
    harness = undefined
  })

  it('healthy reconnect — auth conn returns to CONNECTED/JOINED after a 5s outage', async () => {
    invariants = new Invariants()
    invariants.start()

    const proxy = await freshProxy('qss-restart-1')
    harness = await bootQssHarness({
      username: tag('owner-restart'),
      teamName: tag('restart-team'),
      proxyName: proxy.proxyName,
      proxyListen: proxy.proxyListen,
      proxyUpstream: QSS_UPSTREAM,
      qssEndpoint: proxy.qssEndpoint,
    })
    harness.primeCaptcha()
    await harness.qssService.connect(harness.qssEndpoint, true)
    await expectQssConnectedWithin(harness, 15_000)

    const teamId = harness.sigchainService.activeChain.team!.id

    await waitForExpect(async () => {
      const status = await harness!.qssService.getQssInitStatus()
      expect(status.qssSetup).toBe(true)
    }, 30_000)
    await waitForExpect(() => {
      const conn = harness!.qssAuthConnManager.getConnection(teamId)
      expect(conn?.connStatus).toBe(QSSAuthConnStatus.CONNECTED)
      expect(conn?.joinStatus).toBe(JoinStatus.JOINED)
    }, 30_000)

    // ── Simulate server restart: 5s outage ────────────────────────────
    await harness.toxiproxy.setEnabled(harness.proxyName, false)
    await expectQssDisconnectedWithin(harness, 15_000)

    // Auth manager should have closed the conn on QSS_DISCONNECTED. We
    // accept either "conn entry removed" or "conn entry present but
    // inactive" — production might leave the entry around until the next
    // startNewConnection call (see qss-auth-conn-manager.service.ts:70-73
    // close-on-disconnect path).
    {
      const conn = harness.qssAuthConnManager.getConnection(teamId)
      // The handler calls close(false) which removes all entries.
      expect(conn).toBeUndefined()
    }

    await sleep(5_000)
    await harness.toxiproxy.setEnabled(harness.proxyName, true)

    // Reconnect: in-process retry interval baseline is 50ms (qss.const.ts:2)
    // so the service should reconnect on its own. Drive connect() too in
    // case the schedule timer was in its backoff phase.
    await harness.qssService.connect(harness.qssEndpoint, true)
    await expectQssConnectedWithin(harness, 30_000)

    // The auto-flow on QSS_CONNECTED runs QSS_HANDLE_SIGN_IN which sees
    // qssSetup=true and runs signInToCommunity, which starts a new auth
    // conn for the team.
    await waitForExpect(() => {
      const conn = harness!.qssAuthConnManager.getConnection(teamId)
      expect(conn?.connStatus).toBe(QSSAuthConnStatus.CONNECTED)
      expect(conn?.joinStatus).toBe(JoinStatus.JOINED)
    }, 60_000)

    Invariants.expectClean(invariants.stop())
  })

  it('in-flight log entries queued during outage are replayed via DLQ', async () => {
    invariants = new Invariants()
    invariants.start()

    const proxy = await freshProxy('qss-restart-2')
    harness = await bootQssHarness({
      username: tag('owner-rdlq'),
      teamName: tag('restart-dlq-team'),
      proxyName: proxy.proxyName,
      proxyListen: proxy.proxyListen,
      proxyUpstream: QSS_UPSTREAM,
      qssEndpoint: proxy.qssEndpoint,
    })
    harness.primeCaptcha()
    await harness.qssService.connect(harness.qssEndpoint, true)
    await expectQssConnectedWithin(harness, 15_000)

    const teamId = harness.sigchainService.activeChain.team!.id

    await waitForExpect(async () => {
      const status = await harness!.qssService.getQssInitStatus()
      expect(status.qssSetup).toBe(true)
    }, 30_000)
    await waitForExpect(() => {
      const conn = harness!.qssAuthConnManager.getConnection(teamId)
      expect(conn?.connStatus).toBe(QSSAuthConnStatus.CONNECTED)
    }, 30_000)

    // Drop the wire.
    await harness.toxiproxy.setEnabled(harness.proxyName, false)
    await expectQssDisconnectedWithin(harness, 15_000)

    // Push synthetic log entries while disconnected. sendLogEntrySyncMessage
    // sees `connected === false` and writes to the DLQ via
    // localDbService.addPendingQssLogSyncMessage (qss.service.ts:1062-1068).
    const syntheticAddr = '/orbitdb/test/channels.restart-dlq-team'
    const inFlightHashes = [
      `zb2rh-restart-dlq-1-${Date.now()}`,
      `zb2rh-restart-dlq-2-${Date.now()}`,
      `zb2rh-restart-dlq-3-${Date.now()}`,
    ]
    for (const hash of inFlightHashes) {
      const result = await harness.qssService.sendLogEntrySyncMessage({
        teamId,
        hash,
        id: syntheticAddr,
        addr: syntheticAddr,
        entry: { synthetic: true, hash } as unknown as never,
      })
      // While disconnected, sendLogEntrySyncMessage returns undefined (the
      // "skipped, queued to DLQ" return path). It does NOT throw.
      expect(result).toBeUndefined()
    }

    // DLQ should now contain our hashes.
    const queuedBefore = await harness.localDbService.getPendingQssLogSyncMessages()
    const queuedHashes = Object.values(queuedBefore).flat()
    for (const hash of inFlightHashes) {
      expect(queuedHashes).toContain(hash)
    }

    // Bring the wire back up.
    await harness.toxiproxy.setEnabled(harness.proxyName, true)
    await harness.qssService.connect(harness.qssEndpoint, true)
    await expectQssConnectedWithin(harness, 30_000)

    // The auth conn returns to CONNECTED/JOINED, which fires
    // QSS_AUTH_JOINED, which triggers processDeadLetterQueue. But that
    // processor early-returns unless the team's storage was marked ready
    // via QSSService.markTeamStorageReady (production calls this from
    // ConnectionsManager once orbitdb is up). We mark it explicitly here
    // so the DLQ drain path actually runs.
    await waitForExpect(() => {
      const conn = harness!.qssAuthConnManager.getConnection(teamId)
      expect(conn?.connStatus).toBe(QSSAuthConnStatus.CONNECTED)
      expect(conn?.joinStatus).toBe(JoinStatus.JOINED)
    }, 60_000)
    harness.qssService.markTeamStorageReady(teamId)

    // processDeadLetterQueue calls orbitDbService.getLogEntriesByHashes,
    // which won't find our synthetic hashes (we never wrote them to a real
    // OrbitDB). Production drains them via the "if hash isn't in OrbitDB,
    // remove from DLQ" branch (qss.service.ts:307-311). The DLQ should
    // therefore drain even though the entries are bogus — i.e. the orphan
    // entries aren't stuck forever waiting on something that will never
    // arrive.
    await waitForExpect(async () => {
      const queued = await harness!.localDbService.getPendingQssLogSyncMessages()
      const remainingHashes = Object.values(queued).flat()
      for (const hash of inFlightHashes) {
        expect(remainingHashes).not.toContain(hash)
      }
    }, 30_000)

    Invariants.expectClean(invariants.stop())
  })
})
