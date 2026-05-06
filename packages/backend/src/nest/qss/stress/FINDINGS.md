# QSS stress-harness findings

Stress-test results from the harness in this directory.

## 🆕 Process-pause primitive

`chaos.ts` exposes `eventLoopPause(ms)`, a synchronous JS-runtime suspension
that models the "phone backgrounded mid-handshake" failure mode (iOS /
Android suspending the V8 runtime). Wired into `ChaosProfile.pauses` and
applied at each named phase by the fresh-create-community and owner+member
fuzz orchestrators. Canonical profiles: `pause-2s-pre-create`,
`pause-10s-during-authsync`, `pause-30s-pre-create`,
`pause-10s-with-outage-during-authsync`.

Focused scenario at `scenarios/pause-during-authsync.stress.spec.ts` covers
2 s / 10 s / 30 s baselines and asserts the QSS service recovers
(`qssSetup === true` and the auth conn reaches `JOINED`).

**Honest limitation:** an in-process event-loop block does not simulate
kernel-side TCP keepalive expiry. The kernel socket stays alive while JS
is paused, so on resume the service sees a quiet socket rather than a
FIN/RST. The combined `pause-10s-with-outage-during-authsync` profile is
the way to exercise that path in this harness — it disables the proxy at
the start of the pause window so a kernel-level drop is in flight when JS
resumes.

## 🐛 Bug 1: orphan reconnect timer survives `QSSService.close()`

**Status:** confirmed, deterministic repro included.
**Test:** `scenarios/close-leaks-reconnect-timer.stress.spec.ts`
**File:** `packages/backend/src/nest/qss/qss.service.ts`

`connect()` at line 339-341 sets `this._reconnectQueueProcessor = setInterval(...)` if it isn't set. `close()` at line 1006-1016 clears `_deadLetterQueueProcessor` and `_logPullIntervals` but **never clears `_reconnectQueueProcessor`**. The interval fires every `QSS_RECONNECT_DELAY_MS` (60 s) calling `this.connect`, with the binding still pointing at the now-defunct service instance.

Confirmed two ways:

1. The repro test inspects `qssService._reconnectQueueProcessor._destroyed` after `close()` — `false` (still alive).
2. Patching `close()` to add `clearInterval(this._reconnectQueueProcessor); this._reconnectQueueProcessor = undefined` flips the test green and drops the post-close active-timer count by exactly 1.

**Impact:** every leave-community or app-shutdown leaves an orphan timer running. Multiple leave/rejoin cycles in one process accumulate timers. Each retains a reference to the old service instance (and through it, large chunks of the old Nest module graph), preventing GC. This matches the shape of recent commits like `aadcc1e5f fix leave community hang` and `b9cb9fa90 fix crashes when leaving fails to fully tear down`.

**Suggested fix:**

```ts
public close(): void {
  this.logger.info(`Closing QSS service`)
  clearInterval(this._deadLetterQueueProcessor)
  if (this._reconnectQueueProcessor != null) {
    clearInterval(this._reconnectQueueProcessor)
    this._reconnectQueueProcessor = undefined as unknown as NodeJS.Timeout
  }
  for (const interval of this._logPullIntervals.values()) {
    clearInterval(interval)
  }
  ...
}
```

(The `as unknown as NodeJS.Timeout` cast is just because the field is typed non-optional. Better long-term: change the type to `NodeJS.Timeout | undefined` and remove the cast.)

## ⚠️ Cluster: chaos sweep timeouts (single-client fresh-create)

**Status:** observed under aggressive chaos profiles. Some likely real bugs, some likely tight test timeouts.
**Test:** `scenarios/fuzz-create-community.stress.spec.ts`

20 / 52 cases failed in an aggressive sweep with profiles like `latency-3000ms-jitter-1500ms`, multiple stacked outages, and randomized 50–5000 ms latency. Failure buckets:

| Count | Fingerprint | Smallest repro |
|---:|---|---|
| 16 | `qssSetup still false` | seed=0, profile `latency-3000ms-jitter-1500ms` (3 s downstream latency, 1.5 s jitter, no outages) |
| 4 | `QSS did not reach connected within 30000ms` | seed=42 (latency=4336 ms, jitter=1132 ms) |

The connect-timeout bucket is plausibly just a timing threshold: `QSSClient._waitForConnect` polls 20 × 500 ms = 10 s before giving up, and 4 s downstream latency × ~3 socket.io handshake messages exceeds it. The QSS service's reconnect interval is 60 s so the next attempt arrives long after the test has timed out.

The `qssSetup-still-false` bucket warrants a closer look. With pure 3 s latency and no outages, the create flow should eventually succeed if every round-trip just takes longer. That it doesn't, even after 60 s, suggests something stuck — possibly related to the timer-leak above (an early failed connect leaves an orphan timer that the new connect path doesn't reuse correctly).

Recommended next step: extend the scenario to *clear chaos and wait additional time*, and only fail if the service doesn't recover. That distinguishes "stuck state" from "tight timeout."

## ✅ Multi-client join works healthy

**Test:** `scenarios/owner-and-member.stress.spec.ts`

Owner creates community, member joins via QSS-routed AUTH_SYNC, both reach `JoinStatus.JOINED` in 2.6 s. Two harness instances share one Toxiproxy proxy.

For the join to succeed, the owner must call `sigchain.lockbox.createInviteLockboxes(seed, salt)` immediately after `inviteService.createLongLivedUserInvite()` — without that, the member's self-assign-MEMBER step throws an LFA `keysAllGenerations` assertion. (`generateOwnerInvite` in `harness.ts` does this automatically.)

The member harness does **not** initialise OrbitDB at boot — the LFA identity provider reads `sigchain.team.id` during construction, which throws while the member is pre-join. Production defers OrbitDB init too; we mirror that.

## 🔜 Open: message exchange between two in-process clients

Not implemented yet. `OrbitDbService.events` is a static class-level EventEmitter shared across all in-process harnesses. Two harnesses listening to it both fire on every put → both call `qssService.sendLogEntrySyncMessage` → QSS sees duplicate writes. Functionally harmless (idempotent dedupe) but noisy.

Bigger blocker: each harness's OrbitDB has a different address (derived from creator identity), so even if QSS fanout reaches the member, `ingestEntries` finds no local store with the matching `id`. Production solves this by deriving the channel address from team metadata; mirroring that in the harness needs more plumbing.

Two clean paths forward:
- One process per peer (heavier infrastructure, real fidelity).
- An in-harness `openSharedStore(address)` helper that the member uses to open the owner's pre-existing store by address.
