/**
 * Process-level chaos primitives for the QSS stress harness.
 *
 * The Toxiproxy primitives in `toxiproxy.ts` simulate **network-layer** faults
 * (latency, jitter, drops, outages, slicing). Those don't reach the bug class
 * where iOS / Android suspends the JS runtime entirely while a handshake is in
 * flight: when the OS resumes the process, the socket may have been silently
 * dropped, in-flight ack callbacks never fire, and timer-based reconnect logic
 * comes back into a state machine that's been paused for seconds-to-minutes.
 *
 * `eventLoopPause(ms)` is a synthetic, in-process model of that behaviour: it
 * synchronously blocks the Node event loop for `ms` milliseconds. Every JS
 * callback — timers, socket handlers, promise resolutions — is delayed by the
 * pause window. From the QSS service's perspective, everything that was
 * scheduled is delayed; from the test runner's perspective, the entire run
 * stops dead for the duration.
 *
 * ## Design choice: in-process block vs SIGSTOP
 *
 * Two ways to model "phone backgrounded":
 *
 * 1. **`SIGSTOP` / `SIGCONT` to a child process.** Spawn the QSS-bearing
 *    process as a child, then send `SIGSTOP` for `pauseDurationMs`, then
 *    `SIGCONT`. The OS suspends every thread; on resume, real wall time has
 *    advanced and any keepalive / timeout countdowns at the kernel level have
 *    continued ticking. **Cost:** massive harness refactor — the current
 *    harness boots Nest in-process, so this would need a child-process wrapper
 *    plus RPC plumbing for `qssService.connect()` etc., plus a way to read
 *    internal state across the process boundary.
 *
 * 2. **Synthetic event-loop block (this primitive).** Block Node's event loop
 *    in-process via `Atomics.wait(...)`. The TCP socket itself stays alive at
 *    the kernel level, but no JS callback runs on it for the pause window.
 *    **Cost:** trivial.
 *
 * We chose (2). When a phone backgrounds, V8 doesn't pause at the OS level
 * either — the Node runtime just stops being scheduled. Same effect from the
 * perspective of the QSS state machine.
 *
 * ## Honest limitations of `eventLoopPause`
 *
 * - **Doesn't model kernel-side keepalive expiry.** If the suspended duration
 *   exceeds the OS TCP keepalive timeout, real iOS would see the connection
 *   drop and the kernel would post the FIN/RST that JS then sees on resume.
 *   `eventLoopPause` alone doesn't model that — the socket is still alive at
 *   the kernel level when the loop unblocks.
 * - **Doesn't model wall-clock-based hardware timers.** Some native modules
 *   use OS-level timers; those keep firing during the pause and queue events
 *   that all flush at once when the loop unblocks. JS-only timers (the
 *   common case) are paused.
 *
 * To model kernel-side connection drop too, combine `eventLoopPause` with a
 * Toxiproxy outage that overlaps the pause window. The harness orchestrators
 * support this by accepting both `pauses` and `outages` in a profile.
 *
 * ## Correctness notes
 *
 * - `Atomics.wait` requires a `SharedArrayBuffer`. We allocate a 4-byte buffer
 *   per call; it's only used as a lock object that nothing ever notifies.
 * - The wait timeout is a positive integer. We clamp negative or zero values
 *   to 1 ms so callers can safely pass dynamic values.
 * - `Atomics.wait` is synchronous and will throw if called on the main thread
 *   in a worker that doesn't allow blocking. Our jest config runs scenarios
 *   on the main thread of `jest-environment-node`, where blocking is allowed.
 */

/**
 * Synchronously block the Node event loop for `ms` milliseconds.
 *
 * This is the point: it models "JS pauses entirely". No timers fire, no
 * socket handlers run, no promise continuations resolve. The test runner is
 * unresponsive for the duration. Use this to drive scenarios that need to
 * simulate phone-backgrounded behaviour mid-handshake.
 *
 * It does NOT spin the CPU — `Atomics.wait` parks the thread.
 */
export const eventLoopPause = (ms: number): void => {
  const clamped = Math.max(1, Math.floor(ms))
  // 4-byte buffer; nothing else ever touches it. We just need a target.
  const buf = new SharedArrayBuffer(4)
  const view = new Int32Array(buf)
  // Wait for `view[0]` to differ from 0; nothing ever sets it, so we always
  // unblock on the timeout. Return value is one of 'ok', 'not-equal',
  // 'timed-out' — we don't care which; the side effect (time having passed)
  // is what matters.
  Atomics.wait(view, 0, 0, clamped)
}
