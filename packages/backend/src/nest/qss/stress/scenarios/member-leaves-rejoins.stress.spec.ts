/**
 * Member-leaves-and-rejoins scenario.
 *
 * Owner + member, member joins, member leaves, member rejoins via the same
 * invite. Asserts member reaches JOINED again on the second attempt.
 *
 * The "leave" here is the QSS side of leave-community: tear down the member
 * harness's QSSService (close auth conn, websocket, clear timers) and clear
 * its localDb community pointer. We do NOT keep the member's sigchain in
 * memory across the leave/rejoin boundary — production would also drop it
 * (deleteChainFromDisk: true in connections-manager.service.ts:328) — so the
 * second join restarts from scratch with the same invite seed/salt/teamId.
 *
 * The owner stays up the whole time. Only the member tears down.
 *
 * What this catches:
 *  - Owner-side stale state: e.g. if the owner's auth conn for the member
 *    holds onto leftover handler references that prevent the second join's
 *    LFA handshake from completing. Recent commits like "reset LFA join
 *    status when in intermediate state on disconnect" point at this surface.
 *  - Captcha-per-socket reuse: the member's second QSS connect goes through
 *    a fresh socket; we re-prime captcha so the QSS_HANDLE_SIGN_IN flow on
 *    that fresh socket works.
 *  - Invite re-use: long-lived user invites should accept multiple joins
 *    over time. If the seed/salt path picks up stale derived state on the
 *    second attempt, the LFA self-assign-MEMBER step fails.
 */
import { jest } from '@jest/globals'
import waitForExpect from 'wait-for-expect'

import {
  bootQssHarness,
  bootMemberHarness,
  generateOwnerInvite,
  type QssHarness,
  pickFreePort,
  proxyId,
  QSS_UPSTREAM,
} from '../harness'
import { Invariants, expectQssConnectedWithin } from '../invariants'
import { QSSAuthConnStatus } from '../../qss.const'
import { JoinStatus } from '../../../libp2p/libp2p.auth'

jest.setTimeout(300_000)

const RUN_TAG = `${process.pid}-${Date.now().toString(36)}`
const tag = (base: string): string => `${base}-${RUN_TAG}-${Math.floor(Math.random() * 1e6)}`

/**
 * Allocate a fresh per-test owner proxy. The harness's default proxy is on
 * 127.0.0.1:3013 — shared with other concurrent stress runs and other
 * harness instances in the same process. We use a free port + unique name
 * so this test doesn't fight neighbours over toxiproxy listener ownership.
 */
async function freshOwnerProxy(): Promise<{ proxyName: string; proxyListen: string; qssEndpoint: string }> {
  const port = await pickFreePort()
  const proxyName = proxyId('qss-mlr-owner')
  return {
    proxyName,
    proxyListen: `127.0.0.1:${port}`,
    qssEndpoint: `ws://127.0.0.1:${port}`,
  }
}

describe('QSS stress: member leaves and rejoins', () => {
  let owner: QssHarness | undefined
  let member: QssHarness | undefined
  let invariants: Invariants

  afterEach(async () => {
    if (member != null) await member.shutdown().catch(() => undefined)
    member = undefined
    if (owner != null) await owner.shutdown().catch(() => undefined)
    owner = undefined
  })

  it('healthy leave/rejoin — member reaches JOINED on first and second join', async () => {
    invariants = new Invariants()
    invariants.start()

    // ── Owner ─────────────────────────────────────────────────────────
    const ownerProxy = await freshOwnerProxy()
    owner = await bootQssHarness({
      username: tag('owner-mlr'),
      teamName: tag('mlr-team'),
      proxyName: ownerProxy.proxyName,
      proxyListen: ownerProxy.proxyListen,
      proxyUpstream: QSS_UPSTREAM,
      qssEndpoint: ownerProxy.qssEndpoint,
    })
    owner.primeCaptcha()
    await owner.qssService.connect(owner.qssEndpoint, true)
    await expectQssConnectedWithin(owner, 15_000)
    const teamId = owner.sigchainService.activeChain.team!.id
    await waitForExpect(async () => {
      const status = await owner!.qssService.getQssInitStatus()
      expect(status.qssSetup).toBe(true)
    }, 30_000)
    await waitForExpect(() => {
      const conn = owner!.qssAuthConnManager.getConnection(teamId)
      expect(conn?.connStatus).toBe(QSSAuthConnStatus.CONNECTED)
      expect(conn?.joinStatus).toBe(JoinStatus.JOINED)
    }, 30_000)

    const invite = generateOwnerInvite(owner)

    // ── First join ────────────────────────────────────────────────────
    member = await bootMemberHarness({ invite, username: 'member-mlr-' + RUN_TAG })
    member.primeCaptcha()
    await member.qssService.connect(member.qssEndpoint, true)
    await expectQssConnectedWithin(member, 15_000)
    await waitForExpect(() => {
      const conn = member!.qssAuthConnManager.getConnection(invite.teamId)
      expect(conn?.connStatus).toBe(QSSAuthConnStatus.CONNECTED)
      expect(conn?.joinStatus).toBe(JoinStatus.JOINED)
    }, 60_000)

    // Owner side should still be JOINED.
    expect(owner.qssAuthConnManager.getConnection(teamId)?.joinStatus).toBe(JoinStatus.JOINED)

    // ── Member leaves ─────────────────────────────────────────────────
    // Full shutdown of the member harness. Mirrors production's
    // ConnectionsManager.leaveCommunity in scope-of-this-harness terms:
    // drop the QSS state, drop the sigchain (module.close() walks
    // SigChainModule providers), drop OrbitDB, drop the localDb
    // community pointer, free the proxy.
    await member.shutdown()
    member = undefined

    // The owner's auth manager may still see the member in its team state,
    // but the member's QSS-level connection is gone. Give the auth conn a
    // moment to observe (async) — not strictly required for the rejoin
    // assertion, but useful to catch "owner doesn't notice the member left".
    await new Promise(r => setTimeout(r, 1500))

    // ── Member rejoins via the same invite ────────────────────────────
    // Same invite (seed/salt/teamId/teamName) but a fresh harness — fresh
    // sigchain built from the invite seed, fresh QSS websocket. This is
    // exactly what production does when a user reinstalls with the same
    // invite link: a new device joining an old team via a long-lived
    // invite.
    member = await bootMemberHarness({ invite, username: 'member-mlr-' + RUN_TAG })
    member.primeCaptcha()
    await member.qssService.connect(member.qssEndpoint, true)
    await expectQssConnectedWithin(member, 15_000)
    await waitForExpect(() => {
      const conn = member!.qssAuthConnManager.getConnection(invite.teamId)
      expect(conn?.connStatus).toBe(QSSAuthConnStatus.CONNECTED)
      expect(conn?.joinStatus).toBe(JoinStatus.JOINED)
    }, 60_000)

    // Owner is still JOINED.
    expect(owner.qssAuthConnManager.getConnection(teamId)?.joinStatus).toBe(JoinStatus.JOINED)

    Invariants.expectClean(invariants.stop())
  })

  it('rejoin under owner-side latency — second join still completes', async () => {
    invariants = new Invariants()
    invariants.start()

    const ownerProxy = await freshOwnerProxy()
    owner = await bootQssHarness({
      username: tag('owner-mlr-lat'),
      teamName: tag('mlr-lat-team'),
      proxyName: ownerProxy.proxyName,
      proxyListen: ownerProxy.proxyListen,
      proxyUpstream: QSS_UPSTREAM,
      qssEndpoint: ownerProxy.qssEndpoint,
    })
    owner.primeCaptcha()
    await owner.qssService.connect(owner.qssEndpoint, true)
    await expectQssConnectedWithin(owner, 15_000)
    const teamId = owner.sigchainService.activeChain.team!.id
    await waitForExpect(async () => {
      const status = await owner!.qssService.getQssInitStatus()
      expect(status.qssSetup).toBe(true)
    }, 30_000)
    await waitForExpect(() => {
      const conn = owner!.qssAuthConnManager.getConnection(teamId)
      expect(conn?.connStatus).toBe(QSSAuthConnStatus.CONNECTED)
    }, 30_000)

    const invite = generateOwnerInvite(owner)

    // First join.
    member = await bootMemberHarness({ invite, username: 'member-mlr-lat-' + RUN_TAG })
    member.primeCaptcha()
    await member.qssService.connect(member.qssEndpoint, true)
    await waitForExpect(() => {
      const conn = member!.qssAuthConnManager.getConnection(invite.teamId)
      expect(conn?.connStatus).toBe(QSSAuthConnStatus.CONNECTED)
      expect(conn?.joinStatus).toBe(JoinStatus.JOINED)
    }, 60_000)

    // Member leaves.
    await member.shutdown()
    member = undefined

    // Inject latency on the OWNER's link to QSS (the owner is the LFA peer
    // who has to accept the second join). This models "owner has poor
    // network during the rejoin".
    await owner.toxiproxy.addToxic(owner.proxyName, {
      name: 'owner-rejoin-latency',
      type: 'latency',
      stream: 'downstream',
      toxicity: 1.0,
      attributes: { latency: 600, jitter: 200 },
    })

    // Rejoin.
    member = await bootMemberHarness({ invite, username: 'member-mlr-lat-' + RUN_TAG })
    member.primeCaptcha()
    await member.qssService.connect(member.qssEndpoint, true)
    await waitForExpect(() => {
      const conn = member!.qssAuthConnManager.getConnection(invite.teamId)
      expect(conn?.connStatus).toBe(QSSAuthConnStatus.CONNECTED)
      expect(conn?.joinStatus).toBe(JoinStatus.JOINED)
    }, 90_000)

    await owner.toxiproxy.removeToxic(owner.proxyName, 'owner-rejoin-latency').catch(() => undefined)

    Invariants.expectClean(invariants.stop())
  })
})
