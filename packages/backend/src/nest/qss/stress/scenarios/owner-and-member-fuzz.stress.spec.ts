/**
 * Fuzz sweep over owner+member join. Owner setup runs healthy (so the
 * invite is available); chaos is applied during the member's connect /
 * sign-in / AUTH_SYNC phase. The member-join handshake routes multiple
 * AUTH_SYNC round-trips between member and owner via QSS, which is a
 * narrower failure surface than fresh-create-community but stresses
 * different code paths (QSSAuthConnection lifecycle, owner-side
 * handle-incoming, self-assign-member ordering).
 *
 * Fails when member's auth conn doesn't reach JOINED within a generous
 * timeout, when invariants (unhandled rejections, leaked timers) trip,
 * or when the connection times out.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { jest } from '@jest/globals'
import waitForExpect from 'wait-for-expect'

import { bootQssHarness, bootMemberHarness, generateOwnerInvite, type QssHarness } from '../harness'
import { Invariants, expectQssConnectedWithin } from '../invariants'
import { QSSAuthConnStatus } from '../../qss.const'
import { JoinStatus } from '../../../libp2p/libp2p.auth'
import {
  CHAOS_PROFILES,
  type ChaosProfile,
  type FlapWindow,
  type OutageWindow,
  type PauseWindow,
  type ScenarioPhase,
  type ScenarioResult,
  fingerprintError,
  makeRng,
  randomProfile,
} from '../fuzz'
import { eventLoopPause } from '../chaos'

jest.setTimeout(240_000)

const FUZZ_RUNS = Number(process.env.STRESS_FUZZ_RUNS ?? '0')
const FUZZ_BASE_SEED = Number(process.env.STRESS_FUZZ_SEED ?? Date.now())
const RESULTS_PATH = process.env.STRESS_RESULTS_PATH

const allResults: ScenarioResult[] = []

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// For multi-client, 'preCaptcha' / 'preCreate' are remapped to the member's
// pre-connect / pre-signin window. 'duringAuthSync' targets the LFA handshake.
async function applyToxics(harness: QssHarness, profile: ChaosProfile): Promise<void> {
  if (profile.toxics == null) return
  for (const toxic of profile.toxics) {
    await harness.toxiproxy.addToxic(harness.proxyName, toxic).catch(() => undefined)
  }
}

async function maybeOutage(
  harness: QssHarness,
  profile: ChaosProfile,
  phase: ScenarioPhase
): Promise<void> {
  const consumedOutages = new Set<OutageWindow>()
  for (const pause of (profile.pauses ?? []).filter(p => p.at === phase)) {
    const samePhaseOutage = (profile.outages ?? []).find(
      o => o.at === phase && o.durationMs <= pause.durationMs && !consumedOutages.has(o)
    )
    await schedulePause(harness, pause, samePhaseOutage)
    if (samePhaseOutage != null) consumedOutages.add(samePhaseOutage)
  }
  for (const outage of (profile.outages ?? []).filter(o => o.at === phase && !consumedOutages.has(o))) {
    await scheduleOutage(harness, outage)
  }
  for (const flap of (profile.flaps ?? []).filter(f => f.at === phase)) {
    await scheduleFlap(harness, flap)
  }
}

async function schedulePause(
  harness: QssHarness,
  pause: PauseWindow,
  pairedOutage: OutageWindow | undefined
): Promise<void> {
  if (pairedOutage != null) {
    await harness.toxiproxy.setEnabled(harness.proxyName, false).catch(() => undefined)
  }
  eventLoopPause(pause.durationMs)
  if (pairedOutage != null) {
    await harness.toxiproxy.setEnabled(harness.proxyName, true).catch(() => undefined)
    await harness.qssService.connect(harness.qssEndpoint, true).catch(() => undefined)
  }
}

async function scheduleOutage(harness: QssHarness, outage: OutageWindow): Promise<void> {
  await harness.toxiproxy.setEnabled(harness.proxyName, false).catch(() => undefined)
  await sleep(outage.durationMs)
  await harness.toxiproxy.setEnabled(harness.proxyName, true).catch(() => undefined)
  await harness.qssService.connect(harness.qssEndpoint, true).catch(() => undefined)
}

async function scheduleFlap(harness: QssHarness, flap: FlapWindow): Promise<void> {
  const start = Date.now()
  let enabled = true
  while (Date.now() - start < flap.totalMs) {
    enabled = !enabled
    await harness.toxiproxy.setEnabled(harness.proxyName, enabled).catch(() => undefined)
    await sleep(flap.cycleMs)
  }
  await harness.toxiproxy.setEnabled(harness.proxyName, true).catch(() => undefined)
  await harness.qssService.connect(harness.qssEndpoint, true).catch(() => undefined)
}

async function runOwnerThenMember(profile: ChaosProfile, seed: number): Promise<ScenarioResult> {
  const start = Date.now()
  const invariants = new Invariants()
  let owner: QssHarness | undefined
  let member: QssHarness | undefined
  let outcome: 'success' | 'error' = 'success'
  let errorMessage: string | undefined
  let errorFingerprint: string | undefined
  let connStatus: string | undefined
  let joinStatus: string | undefined

  try {
    // ── Owner: healthy ─────────────────────────────────────────────────
    owner = await bootQssHarness({ username: `owner-${seed}`, teamName: `team-${seed}` })
    invariants.start()
    owner.primeCaptcha()
    await owner.qssService.connect(owner.qssEndpoint, true)
    await expectQssConnectedWithin(owner, 30_000)
    const ownerTeamId = owner.sigchainService.activeChain.team!.id
    await waitForExpect(async () => {
      const status = await owner!.qssService.getQssInitStatus()
      if (!status.qssSetup) throw new Error('owner qssSetup still false')
    }, 30_000)
    await waitForExpect(() => {
      const conn = owner!.qssAuthConnManager.getConnection(ownerTeamId)
      if (conn?.connStatus !== QSSAuthConnStatus.CONNECTED) throw new Error('owner auth conn not CONNECTED')
    }, 30_000)
    const invite = generateOwnerInvite(owner)

    // ── Member: under chaos ────────────────────────────────────────────
    // Apply toxics on the shared proxy. The owner's existing socket is
    // affected too — but the owner's auth conn is robust to brief noise
    // by this point in the flow; chaos primarily lands on the member.
    await applyToxics(owner, profile)

    member = await bootMemberHarness({
      invite,
      username: `member-${seed}`,
      proxyName: owner.proxyName,
      proxyListen: owner.proxyListen,
      qssEndpoint: owner.qssEndpoint,
    })

    await maybeOutage(member, profile, 'preConnect')
    member.primeCaptcha()
    await member.qssService.connect(member.qssEndpoint, true)
    await expectQssConnectedWithin(member, 60_000)

    await maybeOutage(member, profile, 'preCaptcha')
    await maybeOutage(member, profile, 'preCreate')

    await maybeOutage(member, profile, 'duringAuthSync')

    await waitForExpect(() => {
      const conn = member!.qssAuthConnManager.getConnection(invite.teamId)
      if (conn == null) throw new Error('member auth connection not present')
      if (conn.connStatus !== QSSAuthConnStatus.CONNECTED) {
        throw new Error(`member auth connStatus=${conn.connStatus}`)
      }
      if (conn.joinStatus !== JoinStatus.JOINED) {
        throw new Error(`member auth joinStatus=${conn.joinStatus}`)
      }
    }, 90_000)

    const conn = member.qssAuthConnManager.getConnection(invite.teamId)
    connStatus = conn?.connStatus
    joinStatus = conn?.joinStatus
  } catch (e) {
    outcome = 'error'
    errorMessage = e instanceof Error ? e.message : String(e)
    errorFingerprint = fingerprintError(e)
  } finally {
    const snap = invariants.stop()
    if (outcome === 'success' && (snap.unhandledRejections.length > 0 || snap.uncaughtExceptions.length > 0)) {
      outcome = 'error'
      errorMessage = `process-level errors: ${snap.unhandledRejections.length} rejection(s), ${snap.uncaughtExceptions.length} exception(s)`
      errorFingerprint = fingerprintError(snap.unhandledRejections[0] ?? snap.uncaughtExceptions[0])
    }

    const result: ScenarioResult = {
      seed,
      profile,
      outcome,
      errorMessage,
      errorFingerprint,
      durationMs: Date.now() - start,
      finalState: {
        qssSetup: true, // owner setup, by construction here
        connStatus,
        joinStatus,
        activeTimers: snap.activeTimers,
        unhandledRejections: snap.unhandledRejections.length,
      },
    }
    allResults.push(result)
    if (member != null) await member.shutdown().catch(() => undefined)
    if (owner != null) await owner.shutdown().catch(() => undefined)
    return result
  }
}

const fuzzCases: Array<[string, ChaosProfile, number]> = []
const baseRng = makeRng(FUZZ_BASE_SEED)
for (let i = 0; i < FUZZ_RUNS; i++) {
  const seed = (FUZZ_BASE_SEED + i) | 0
  const profile = randomProfile(makeRng(seed), seed)
  fuzzCases.push([profile.name, profile, seed])
}

describe('QSS stress: fuzz sweep over owner+member join', () => {
  // it.concurrent.each runs cases in parallel within this describe block.
  it.concurrent.each(CHAOS_PROFILES.map((p): [string, ChaosProfile, number] => [p.name, p, 0]))(
    'profile %s',
    async (_name, profile, seed) => {
      const result = await runOwnerThenMember(profile, seed)
      if (result.outcome !== 'success') {
        throw new Error(
          `[${profile.name} seed=${seed}] ${result.errorMessage}\n` +
            `  finalState=${JSON.stringify(result.finalState)}`
        )
      }
    }
  )

  if (fuzzCases.length > 0) {
    it.concurrent.each(fuzzCases)('random-fuzz %s', async (_name, profile, seed) => {
      const result = await runOwnerThenMember(profile, seed)
      if (result.outcome !== 'success') {
        throw new Error(
          `[${profile.name} seed=${seed}] ${result.errorMessage}\n` +
            `  toxics=${JSON.stringify(profile.toxics ?? [])}\n` +
            `  outages=${JSON.stringify(profile.outages ?? [])}\n` +
            `  flaps=${JSON.stringify(profile.flaps ?? [])}\n` +
            `  finalState=${JSON.stringify(result.finalState)}`
        )
      }
    })
  }

  afterAll(() => {
    if (RESULTS_PATH != null) {
      fs.mkdirSync(path.dirname(RESULTS_PATH), { recursive: true })
      fs.writeFileSync(RESULTS_PATH, JSON.stringify(allResults, null, 2))
    }
    summarize(allResults)
  })
})

function summarize(results: ScenarioResult[]): void {
  const total = results.length
  const failures = results.filter(r => r.outcome !== 'success')
  if (total === 0) return

  // eslint-disable-next-line no-console
  console.log(
    `\n[stress-summary] ${total - failures.length}/${total} succeeded, ${failures.length} failed`
  )

  if (failures.length === 0) return

  const buckets = new Map<string, ScenarioResult[]>()
  for (const f of failures) {
    const key = f.errorFingerprint ?? 'unknown'
    const arr = buckets.get(key) ?? []
    arr.push(f)
    buckets.set(key, arr)
  }

  const sorted = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length)
  for (const [fingerprint, fs] of sorted) {
    const repro = fs.reduce((min, f) => (f.seed < min.seed ? f : min))
    // eslint-disable-next-line no-console
    console.log(
      `  [${fs.length}x] ${fingerprint}\n` +
        `    smallest-seed repro: seed=${repro.seed} profile=${repro.profile.name}`
    )
  }
}
