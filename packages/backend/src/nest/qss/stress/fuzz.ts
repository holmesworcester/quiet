/**
 * Configuration sweep utilities for the QSS stress harness.
 *
 * A `ChaosProfile` describes a set of network faults applied at specific
 * phases of the fresh-create-community sequence. The same profile can be run
 * repeatedly with different seeds; failures print the seed for repro.
 */
import { Toxic } from './toxiproxy'

export type ScenarioPhase =
  | 'preConnect' // before qssService.connect()
  | 'preCaptcha' // after connect, before primeCaptcha()
  | 'preCreate' //  after primeCaptcha, before createCommunity()
  | 'duringAuthSync' // after createCommunity returns, during LFA handshake

export interface OutageWindow {
  /** When the outage starts (which phase). */
  at: ScenarioPhase
  /** Length of the outage in ms. */
  durationMs: number
}

/**
 * Rapidly toggles the proxy enabled/disabled while a phase runs.
 * `cycleMs` is the on-then-off period; `totalMs` is the total duration.
 */
export interface FlapWindow {
  at: ScenarioPhase
  cycleMs: number
  totalMs: number
}

/**
 * Synchronous JS event-loop block. Models "phone backgrounded": V8 stops
 * scheduling callbacks while the OS suspends the app. The TCP socket stays
 * alive at the kernel level (until keepalive expires) but no JS handler
 * runs on it for the duration. See `chaos.ts:eventLoopPause`.
 *
 * If the same phase also has an outage with `durationMs <= pause.durationMs`,
 * the orchestrator disables the proxy at the start of the pause so a
 * kernel-level connection drop completes during the JS suspension —
 * matches the "TCP keepalive expires while phone is asleep" path.
 */
export interface PauseWindow {
  at: ScenarioPhase
  durationMs: number
}

export interface ChaosProfile {
  name: string
  /** Applied for the lifetime of the scenario. */
  toxics?: Toxic[]
  /** One or more proxy-disable windows applied at specific phases. */
  outages?: OutageWindow[]
  /** Rapid enable/disable cycles applied at specific phases. */
  flaps?: FlapWindow[]
  /** Synchronous JS event-loop suspension at specific phases. */
  pauses?: PauseWindow[]
}

/**
 * Tiny xorshift32 PRNG. Deterministic, seedable, no dependency.
 * Returns a function that produces uniform floats in [0, 1).
 */
export function makeRng(seed: number): () => number {
  let s = seed | 0
  if (s === 0) s = 0x12345678
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) / 0x1_0000_0000
  }
}

const choose = <T>(rng: () => number, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]
const range = (rng: () => number, min: number, max: number): number => Math.floor(min + rng() * (max - min))

/**
 * A finite, hand-picked catalog covering the failure modes seen in recent
 * QSS bug-fix commits. Add to this when a fuzz run uncovers a new bucket.
 */
export const CHAOS_PROFILES: readonly ChaosProfile[] = [
  {
    name: 'baseline-healthy',
  },
  {
    name: 'latency-300ms-jitter-100ms',
    toxics: [
      {
        name: 'lat',
        type: 'latency',
        stream: 'downstream',
        toxicity: 1.0,
        attributes: { latency: 300, jitter: 100 },
      },
    ],
  },
  {
    name: 'latency-1000ms-jitter-500ms',
    toxics: [
      {
        name: 'lat',
        type: 'latency',
        stream: 'downstream',
        toxicity: 1.0,
        attributes: { latency: 1000, jitter: 500 },
      },
    ],
  },
  {
    name: 'partial-loss-50pct',
    toxics: [
      {
        name: 'lat',
        type: 'latency',
        stream: 'downstream',
        toxicity: 0.5,
        attributes: { latency: 800, jitter: 400 },
      },
    ],
  },
  {
    name: 'low-bandwidth-32kbps',
    toxics: [
      {
        name: 'bw-down',
        type: 'bandwidth',
        stream: 'downstream',
        toxicity: 1.0,
        attributes: { rate: 32 },
      },
      {
        name: 'bw-up',
        type: 'bandwidth',
        stream: 'upstream',
        toxicity: 1.0,
        attributes: { rate: 32 },
      },
    ],
  },
  {
    name: 'outage-2s-pre-create',
    outages: [{ at: 'preCreate', durationMs: 2000 }],
  },
  {
    name: 'outage-5s-pre-create',
    outages: [{ at: 'preCreate', durationMs: 5000 }],
  },
  {
    name: 'outage-2s-during-authsync',
    outages: [{ at: 'duringAuthSync', durationMs: 2000 }],
  },
  {
    name: 'outage-5s-during-authsync',
    outages: [{ at: 'duringAuthSync', durationMs: 5000 }],
  },
  {
    name: 'outage-2s-pre-captcha',
    outages: [{ at: 'preCaptcha', durationMs: 2000 }],
  },
  {
    name: 'latency-plus-outage',
    toxics: [
      {
        name: 'lat',
        type: 'latency',
        stream: 'downstream',
        toxicity: 1.0,
        attributes: { latency: 400, jitter: 200 },
      },
    ],
    outages: [{ at: 'preCreate', durationMs: 2000 }],
  },
  {
    name: 'slicer-1kb',
    toxics: [
      {
        name: 'slicer',
        type: 'slicer',
        stream: 'downstream',
        toxicity: 1.0,
        attributes: { average_size: 1024, size_variation: 256, delay: 5 },
      },
    ],
  },
  // ── more aggressive ─────────────────────────────────────────────────
  {
    name: 'latency-3000ms-jitter-1500ms',
    toxics: [
      {
        name: 'lat',
        type: 'latency',
        stream: 'downstream',
        toxicity: 1.0,
        attributes: { latency: 3000, jitter: 1500 },
      },
    ],
  },
  {
    name: 'stacked-outages-pre-and-during-authsync',
    outages: [
      { at: 'preCreate', durationMs: 2000 },
      { at: 'duringAuthSync', durationMs: 2000 },
    ],
  },
  {
    name: 'stacked-outages-everywhere',
    outages: [
      { at: 'preCaptcha', durationMs: 1500 },
      { at: 'preCreate', durationMs: 1500 },
      { at: 'duringAuthSync', durationMs: 1500 },
    ],
  },
  {
    name: 'flap-200ms-during-pre-create',
    flaps: [{ at: 'preCreate', cycleMs: 200, totalMs: 4000 }],
  },
  {
    name: 'flap-100ms-during-authsync',
    flaps: [{ at: 'duringAuthSync', cycleMs: 100, totalMs: 5000 }],
  },
  {
    name: 'flap-and-latency',
    toxics: [
      {
        name: 'lat',
        type: 'latency',
        stream: 'downstream',
        toxicity: 1.0,
        attributes: { latency: 500, jitter: 250 },
      },
    ],
    flaps: [{ at: 'preCreate', cycleMs: 250, totalMs: 5000 }],
  },
  {
    name: 'long-outage-10s-pre-create',
    outages: [{ at: 'preCreate', durationMs: 10_000 }],
  },
  {
    name: 'long-outage-10s-during-authsync',
    outages: [{ at: 'duringAuthSync', durationMs: 10_000 }],
  },
  {
    name: 'high-loss-and-stacked-outages',
    toxics: [
      {
        name: 'lat',
        type: 'latency',
        stream: 'downstream',
        toxicity: 0.9,
        attributes: { latency: 1500, jitter: 800 },
      },
    ],
    outages: [
      { at: 'preCaptcha', durationMs: 2500 },
      { at: 'duringAuthSync', durationMs: 2500 },
    ],
  },
  {
    name: 'reset-peer-pre-create',
    outages: [{ at: 'preCreate', durationMs: 500 }],
    toxics: [
      {
        name: 'reset',
        type: 'reset_peer',
        stream: 'downstream',
        toxicity: 0.3,
        attributes: { timeout: 0 },
      },
    ],
  },
  // ── pause profiles (event-loop block) ───────────────────────────────
  // Models "phone backgrounded mid-handshake": JS pauses entirely, kernel
  // socket stays alive (unless paired with an outage to model keepalive expiry).
  {
    name: 'pause-2s-pre-create',
    pauses: [{ at: 'preCreate', durationMs: 2_000 }],
  },
  {
    name: 'pause-10s-during-authsync',
    pauses: [{ at: 'duringAuthSync', durationMs: 10_000 }],
  },
  {
    name: 'pause-30s-pre-create',
    pauses: [{ at: 'preCreate', durationMs: 30_000 }],
  },
  // Pause + outage: JS frozen AND kernel-side TCP teardown happens during the
  // freeze. On resume the socket is dead and the service has to reconnect.
  {
    name: 'pause-10s-with-outage-during-authsync',
    pauses: [{ at: 'duringAuthSync', durationMs: 10_000 }],
    outages: [{ at: 'duringAuthSync', durationMs: 8_000 }],
  },
]

/**
 * Generate a random profile within aggressive bounds. Use the seeded `rng`
 * so each iteration is reproducible from its seed alone. Calibrated to be
 * *uncomfortable* — high latencies, multiple stacked outages, and flaps —
 * because the canonical mid-intensity catalog passes 100%.
 */
export function randomProfile(rng: () => number, seed: number): ChaosProfile {
  const includeLatency = rng() < 0.8
  const includeBandwidth = rng() < 0.25
  const numOutages = rng() < 0.3 ? 0 : rng() < 0.5 ? 1 : rng() < 0.7 ? 2 : 3
  const includeFlap = rng() < 0.4
  const includeResetPeer = rng() < 0.15

  const toxics: Toxic[] = []
  if (includeLatency) {
    toxics.push({
      name: 'lat',
      type: 'latency',
      stream: 'downstream',
      toxicity: rng() < 0.7 ? 1.0 : 0.6 + rng() * 0.4,
      attributes: {
        latency: range(rng, 100, 5000),
        jitter: range(rng, 0, 2000),
      },
    })
  }
  if (includeBandwidth) {
    toxics.push({
      name: 'bw',
      type: 'bandwidth',
      stream: 'downstream',
      toxicity: 1.0,
      attributes: { rate: range(rng, 4, 128) },
    })
  }
  if (includeResetPeer) {
    toxics.push({
      name: 'reset',
      type: 'reset_peer',
      stream: choose(rng, ['upstream', 'downstream']),
      toxicity: 0.1 + rng() * 0.4,
      attributes: { timeout: 0 },
    })
  }

  const phases: ScenarioPhase[] = ['preCaptcha', 'preCreate', 'duringAuthSync']
  const outages: OutageWindow[] = []
  for (let i = 0; i < numOutages; i++) {
    outages.push({
      at: choose(rng, phases),
      durationMs: range(rng, 500, 8000),
    })
  }

  const flaps: FlapWindow[] = []
  if (includeFlap) {
    flaps.push({
      at: choose(rng, phases),
      cycleMs: range(rng, 80, 600),
      totalMs: range(rng, 2000, 8000),
    })
  }

  return {
    name: `random-seed-${seed}`,
    toxics: toxics.length > 0 ? toxics : undefined,
    outages: outages.length > 0 ? outages : undefined,
    flaps: flaps.length > 0 ? flaps : undefined,
  }
}

export interface ScenarioResult {
  seed: number
  profile: ChaosProfile
  outcome: 'success' | 'error'
  errorFingerprint?: string
  errorMessage?: string
  durationMs: number
  finalState: {
    qssSetup: boolean
    connStatus?: string
    joinStatus?: string
    activeTimers: number
    unhandledRejections: number
  }
}

/**
 * Reduce a thrown error to a short, stable string suitable for grouping
 * results in triage output. Strips run-specific noise (timestamps, IDs).
 */
export function fingerprintError(err: unknown): string {
  if (err == null) return 'unknown'
  const msg = err instanceof Error ? err.message : String(err)
  return msg
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\b\d{4,}\b/g, '<num>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}
