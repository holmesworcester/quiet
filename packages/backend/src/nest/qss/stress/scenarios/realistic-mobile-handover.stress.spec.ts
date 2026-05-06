/**
 * Realistic mobile-handover profile.
 *
 * Companion to TIMEOUT-REALISM.md in this directory. The fuzz catalog
 * profiles in fuzz.ts are tuned to be uncomfortable, not realistic. This
 * scenario applies a profile that approximates what a phone on a degraded
 * 4G/LTE link with a single handover-induced burst actually sees on the wire:
 *
 *   - 2 s baseline downstream latency (cellular edge, bufferbloat)
 *   - 1 s jitter (HARQ retransmits, RRC state churn)
 *   - 5% downstream loss (1–2 bar coverage, sources cited in the doc)
 *   - one 1 s outage timed with the auth-sync round-trip
 *     (a single cell handover on a moving device)
 *
 * Compared to the harness's `latency-3000ms-jitter-1500ms` (which produced
 * 20× failures on 7.1.0), this is materially milder — closer to a single
 * realistic handover burst rather than a sustained worst-case. The
 * assertion is generous (90 s) so the test passes on a healthy 7.1.0 path
 * and only fails when something genuinely regresses the recovery behavior.
 *
 * If this test starts failing on a future change, the changes most likely
 * to break it are:
 *   - tightening `_waitForConnect` below 10 s
 *   - tightening the `timeoutAck` default below 5 s
 *   - removing or shrinking the reconnect backoff cap
 *   - adding a new round-trip to the create-community path without
 *     wiring it through the same retry semantics
 */
import { jest } from '@jest/globals'
import waitForExpect from 'wait-for-expect'

import { bootQssHarness, type QssHarness } from '../harness'
import { Invariants, expectQssConnectedWithin } from '../invariants'
import { QSSAuthConnStatus } from '../../qss.const'
import { JoinStatus } from '../../../libp2p/libp2p.auth'

jest.setTimeout(180_000)

describe('QSS stress: realistic mobile handover profile', () => {
  let harness: QssHarness
  let invariants: Invariants

  beforeEach(async () => {
    harness = await bootQssHarness()
    invariants = new Invariants()
    invariants.start()
  })

  afterEach(async () => {
    if (harness != null) await harness.shutdown()
  })

  it('completes create-community within 90 s under a realistic mobile-handover profile', async () => {
    // 2 s baseline + 1 s jitter on the downstream path. This is sustained
    // throughout — not just during the outage — to model "user is on the
    // edge of coverage the whole time."
    await harness.toxiproxy.addToxic(harness.proxyName, {
      name: 'edge-latency',
      type: 'latency',
      stream: 'downstream',
      toxicity: 1.0,
      attributes: { latency: 2000, jitter: 1000 },
    })

    // 5% partial loss simulated by a 50%-toxicity high-latency toxic on
    // the upstream path. (Toxiproxy doesn't have a true loss toxic; this
    // approximates "5% of upstream packets see a multi-second extra delay,"
    // which TCP eventually treats as a loss / retransmit event.)
    await harness.toxiproxy.addToxic(harness.proxyName, {
      name: 'edge-up-jitter',
      type: 'latency',
      stream: 'upstream',
      toxicity: 0.05,
      attributes: { latency: 4000, jitter: 1000 },
    })

    harness.primeCaptcha()

    await harness.qssService.connect(harness.qssEndpoint, true)
    await expectQssConnectedWithin(harness, 30_000)

    const sigchain = harness.sigchainService.activeChain
    const teamId = sigchain.team!.id

    // Schedule a single 1-second outage shortly after connect — the
    // window where the auto-flow is mid-CREATE_COMMUNITY round-trip on
    // a real client during a cell handover.
    setTimeout(() => {
      void (async () => {
        try {
          await harness.toxiproxy.setEnabled(harness.proxyName, false)
          await new Promise(r => setTimeout(r, 1000))
          await harness.toxiproxy.setEnabled(harness.proxyName, true)
        } catch {
          // best-effort; the test's outer assertion will catch real
          // problems via the qssSetup wait below.
        }
      })()
    }, 3000)

    // Generous: the per-ack timeout is 5 s and reconnect backoff caps at
    // 60 s, so a single sustained 2 s baseline + 1 s outage shouldn't
    // need anywhere close to 90 s. If we ever do, something has
    // regressed in the recovery behavior.
    await waitForExpect(async () => {
      const status = await harness.qssService.getQssInitStatus()
      expect(status.qssSetup).toBe(true)
    }, 90_000)

    await waitForExpect(() => {
      const conn = harness.qssAuthConnManager.getConnection(teamId)
      expect(conn).not.toBeUndefined()
      expect(conn!.connStatus).toBe(QSSAuthConnStatus.CONNECTED)
      expect(conn!.joinStatus).toBe(JoinStatus.JOINED)
    }, 30_000)

    Invariants.expectClean(invariants.stop())
  })
})
