/**
 * Focused process-pause scenario.
 *
 * Models "phone backgrounded mid-handshake". The harness drives the normal
 * fresh-create-community sequence, then synchronously blocks the Node event
 * loop with `eventLoopPause(ms)` between key phases. The QSS service should
 * recover after the pause: `qssSetup` should flip true and the auth
 * connection should reach `JOINED`.
 *
 * Three deterministic cases — 2 s, 10 s, 30 s — covering "brief background"
 * through "user took a phone call mid-flow". Each case boots a fresh harness
 * (QSS rate-limits captcha to one create per socket).
 *
 * See `chaos.ts` for the honest limitations of in-process pause vs OS-level
 * SIGSTOP.
 */
import { jest } from '@jest/globals'
import waitForExpect from 'wait-for-expect'

import { bootQssHarness, type QssHarness } from '../harness'
import { Invariants, expectQssConnectedWithin } from '../invariants'
import { eventLoopPause } from '../chaos'
import { QSSAuthConnStatus } from '../../qss.const'
import { JoinStatus } from '../../../libp2p/libp2p.auth'

jest.setTimeout(240_000)

describe('QSS stress: process-pause primitive (event-loop block)', () => {
  let harness: QssHarness
  let invariants: Invariants

  beforeEach(async () => {
    harness = await bootQssHarness()
    invariants = new Invariants()
    invariants.start()
  })

  afterEach(async () => {
    if (harness != null) await harness.shutdown().catch(() => undefined)
  })

  it('survives a 2-second JS pause right after connect', async () => {
    harness.primeCaptcha()

    await harness.qssService.connect(harness.qssEndpoint, true)
    await expectQssConnectedWithin(harness, 15_000)

    // Phone backgrounded right after the socket comes up.
    eventLoopPause(2_000)

    const sigchain = harness.sigchainService.activeChain
    const teamId = sigchain.team!.id

    await waitForExpect(async () => {
      const status = await harness.qssService.getQssInitStatus()
      expect(status.qssSetup).toBe(true)
    }, 60_000)

    await waitForExpect(() => {
      const conn = harness.qssAuthConnManager.getConnection(teamId)
      expect(conn).not.toBeUndefined()
      expect(conn!.connStatus).toBe(QSSAuthConnStatus.CONNECTED)
      expect(conn!.joinStatus).toBe(JoinStatus.JOINED)
    }, 60_000)

    Invariants.expectClean(invariants.stop())
  })

  it('survives a 10-second JS pause during the AUTH_SYNC handshake', async () => {
    harness.primeCaptcha()

    await harness.qssService.connect(harness.qssEndpoint, true)
    await expectQssConnectedWithin(harness, 15_000)

    const sigchain = harness.sigchainService.activeChain
    const teamId = sigchain.team!.id

    // Wait for create to reach the AUTH_SYNC stage (qssSetup === true means
    // the team is on QSS; AUTH_SYNC is the next handshake).
    await waitForExpect(async () => {
      const status = await harness.qssService.getQssInitStatus()
      expect(status.qssSetup).toBe(true)
    }, 60_000)

    // Now suspend JS for 10 s while AUTH_SYNC is in flight.
    eventLoopPause(10_000)

    await waitForExpect(() => {
      const conn = harness.qssAuthConnManager.getConnection(teamId)
      expect(conn).not.toBeUndefined()
      expect(conn!.connStatus).toBe(QSSAuthConnStatus.CONNECTED)
      expect(conn!.joinStatus).toBe(JoinStatus.JOINED)
    }, 90_000)

    Invariants.expectClean(invariants.stop())
  })

  it('survives a 30-second JS pause right after connect (long-background)', async () => {
    harness.primeCaptcha()

    await harness.qssService.connect(harness.qssEndpoint, true)
    await expectQssConnectedWithin(harness, 15_000)

    // 30 s ~ "user took a phone call mid-flow". This is long enough that
    // many timer-driven reconnect / heartbeat paths will have fired
    // multiple times during the suspension; we need to assert the state
    // machine still converges after JS resumes.
    eventLoopPause(30_000)

    const sigchain = harness.sigchainService.activeChain
    const teamId = sigchain.team!.id

    await waitForExpect(async () => {
      const status = await harness.qssService.getQssInitStatus()
      expect(status.qssSetup).toBe(true)
    }, 90_000)

    await waitForExpect(() => {
      const conn = harness.qssAuthConnManager.getConnection(teamId)
      expect(conn).not.toBeUndefined()
      expect(conn!.connStatus).toBe(QSSAuthConnStatus.CONNECTED)
      expect(conn!.joinStatus).toBe(JoinStatus.JOINED)
    }, 90_000)

    Invariants.expectClean(invariants.stop())
  })
})
