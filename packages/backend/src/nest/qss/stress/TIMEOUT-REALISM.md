# QSS timeouts vs. real-world network conditions

This is a follow-up to the harness in this directory. The fuzz catalog in
[`fuzz.ts`](./fuzz.ts) was tuned to be *uncomfortable*, not realistic. After
the harness produced 22 failures on `7.1.0` (20× `qssSetup still false` under
3 s ± 1.5 s sustained downstream latency, 2× `QSS did not reach connected
within 30 s` under 4.6 s latency + 15% upstream `reset_peer` + 6.3 s
preCaptcha outage), it's worth asking whether real users actually see the
profiles that triggered them — and which timeouts in the QSS client are
likely to bite first when they do.

This doc is research, not a fix. It maps each failure-inducing profile onto
a real network scenario, with sources, then ranks them by how likely a
typical Quiet user is to hit it. The intent is to give whoever picks up the
follow-up fix a defensible starting point for "raise the 10 s connect
timeout? add backoff inside it? leave it alone?"

## The three timeouts under discussion

All three are on the QSS-clearnet path. (Confirmed: QSS uses
`socket.io-client.connect()` directly without the SOCKS proxy agent, see
[`qss.client.ts:121`](../qss.client.ts). Tor is only on the libp2p
peer-to-peer path. So everything here is direct-to-Internet, no Tor
overhead.)

| Constant / location | Value | What it guards |
| --- | --- | --- |
| [`qss.client.ts:163`](../qss.client.ts) `_waitForConnect` | **10 s** hardcoded | The socket.io handshake (TCP + WS upgrade + EIO open). One‑shot per `connect()` attempt. |
| [`qss.client.ts:254`](../qss.client.ts) `sendMessage` `timeoutAck` | **5 s** default (2 s for `GET_CAPTCHA_SITE_KEY`) | Round-trip ack for `GEN_PUB_KEYS`, `CREATE_COMMUNITY`, `VERIFY_CAPTCHA`, `SIGN_IN_COMMUNITY`. |
| [`qss.const.ts`](../qss.const.ts) `QSS_RECONNECT_*` | start 50 ms, ×2 backoff, cap 60 s | The retry schedule after `_waitForConnect` rejects. |

The reconnect schedule itself isn't a timeout the user can blow past — given
enough wall-clock time it will eventually retry. The two failure modes the
harness saw are both about the per-attempt budgets:

1. **Connect-timeout bucket (2/22):** the 10 s `_waitForConnect` deadline
   fires before the WS handshake completes.
2. **Setup-timeout bucket (20/22):** the test's outer 60 s `waitForExpect`
   on `qssSetup === true` fires because the four-step round-trip
   (`GEN_PUB_KEYS` → `VERIFY_CAPTCHA` → `CREATE_COMMUNITY` → `SIGN_IN_COMMUNITY`)
   plus reconnection cycles can't fit. Each individual `timeoutAck` is 5 s,
   but every aborted ack (caused by a momentary disconnect mid-RTT) costs a
   reconnect cycle, which under 3 s ± 1.5 s downstream latency itself eats
   most of a 10 s budget.

## Real-world scenarios

For each, I cite a concrete latency/jitter/loss profile, name which timeout
it trips, and describe the user-visible symptom. Source quality is called
out per item — measurement studies and operator reports first, blog posts
with measured numbers second, anecdote last.

### 1. Mobile cellular handover (4G/5G)

Source quality: good (Ericsson white paper, peer-reviewed surveys).

Steady-state 4G handover interruption time is **30–60 ms** in real networks,
with a 5G NR target below 20 ms ([Ericsson, *Reducing mobility interruption
time in 5G networks*](https://www.ericsson.com/en/blog/2020/4/reducing-mobility-interruption-time-5g-networks)).
That's well under any QSS budget on its own.

The realistic problem isn't the handover *event* — it's the surrounding
**bursty queueing**. A handover triggers RRC state transitions, and a large
fraction of total cellular packet loss happens during those transitions
([*Dissecting packet loss in mobile broadband networks from the edge*, IEEE
2015](https://ieeexplore.ieee.org/document/7218404/)). Combined with deep
buffers ("bufferbloat"), under load latency on a 5G link can spike to
**~1 s** even without a handover ([Netradar, *Understanding Latency in
Modern Mobile Networks*](https://www.netradar.com/understanding-latency-in-modern-mobile-networks/)).
A handover during a buffered burst on a moving vehicle/elevator is what
gets you the 1–10 s tail.

- **Profile:** 200–500 ms baseline + transient 1–3 s spikes during handover
  + occasional 30–100 ms "loss event."
- **Trips:** the 5 s `timeoutAck` (each ack RTT is now 1–6 s with the
  spike). `_waitForConnect` survives if the WS handshake started before
  the spike; otherwise it can clip the 10 s budget on a single handover.
- **User symptom:** `CREATE_COMMUNITY` ack times out, `qssSetup` stays
  false, the auto-flow's outer wait expires. UI shows a stuck "Setting up
  community..." spinner. This is the harness's bucket-1 failure mode in
  the wild.

### 2. Captive WiFi portals

Source quality: medium (Apple Developer Forums reports, third-party
measurement blog posts; no formal study).

iOS users routinely report **30–60 s** delays between joining a hotel/cafe
network and seeing the captive portal page ([Apple Developer Forums,
*Delay of 45 Seconds with captive portal*](https://developer.apple.com/forums/thread/706265),
[*Captive page very slow*](https://developer.apple.com/forums/thread/113712)).
That's the *detection* delay; the actual TCP/TLS path is unreliable for the
full window because the portal's NAT may DROP, RST, or redirect arbitrary
egress traffic until the user clicks through.

The QSS-relevant case: the user starts Quiet on hotel WiFi *before*
clicking through. socket.io tries to handshake; the captive portal either
intercepts (returning HTTP redirect on the WS upgrade) or silently drops
TCP. socket.io-client retries internally, but `_waitForConnect`'s 10 s
deadline almost always wins — the user sees a connect failure, then a
reconnect-backoff cycle that may not align with their click-through.

There's also a nested-captcha angle: QSS itself uses hCaptcha. If the user
gets through the *portal* captcha and the *QSS* captcha back-to-back, the
total round-trip budget tightens further, and `VERIFY_CAPTCHA`'s 5 s ack
is extra-fragile if any latency from the portal's authentication backend
is added to the underlying TCP path.

- **Profile:** 0–10 s of TCP RST or silent drop, then sudden recovery.
- **Trips:** `_waitForConnect` (10 s), every time. Reconnect retry loop
  may eventually catch a working window, but only if the user has already
  clicked through.
- **User symptom:** stuck "Connecting…" until the user clicks through the
  portal in their browser, even if Quiet is the only app they care about.
  This is high-frequency in absolute terms (every laptop user, every hotel
  trip) but low-stakes because the user is already context-switched into
  resolving WiFi.

### 3. Cellular dead spots / 1–2 bar coverage

Source quality: medium (Opensignal aggregate reports, IEEE measurement
study).

In low-SNR conditions (1–2 bars), latency rises to **2–10 s** with **1–30%
loss** as retransmits and HARQ recovery dominate. On 4G/LTE this is
documented in operator measurement studies ([Opensignal, *Understanding
mobile network experience metrics*](https://insights.opensignal.com/2021/05/26/understanding-mobile-network-experience-what-do-opensignals-metrics-mean)).
The harness's bucket-1 (3 s ± 1.5 s sustained) is a direct match for an
extended LTE edge condition.

This is also the scenario where TCP RST is most realistic on the wire:
when a cell drops the user equipment because the sector is overloaded or
the user has crossed into a new sector where the prior bearer wasn't
preserved, the user-side TCP stack can see RST from the operator's PGW
proxying.

- **Profile:** 2–5 s sustained latency, 5–15% loss, occasional RST during
  re-attach.
- **Trips:** the 5 s `timeoutAck` on every round-trip. `_waitForConnect`
  marginal — at 3 s baseline the 10 s budget can fit one handshake but
  not always two if the first attempt fails partway.
- **User symptom:** repeated "Failed to connect to QSS, will retry later"
  log spam, with eventual success after the user moves into better
  coverage. Same outer symptom as bucket 1: `qssSetup` stays false while
  the user is in the dead spot.

### 4. Starlink / LEO satellite handover

Source quality: good (APNIC measurement, peer-reviewed
[*StarTCP*](https://dl.acm.org/doi/10.1145/3663408.3665803)).

Starlink schedules a satellite handover **every 15 s** (at +12, +27, +42,
+57 s of each minute). The handover adds **30–80 ms** of latency for that
RTT and contributes to a **~1–2% baseline packet loss** unrelated to
congestion ([APNIC, *A transport protocol's view of Starlink*, blog
post](https://blog.apnic.net/2024/05/17/a-transport-protocols-view-of-starlink/),
[The Register summary](https://www.theregister.com/2024/05/22/starlink_tcp_performance_evaluation/)).
Total disruption per handover is sub-second.

This is *not* the multi-second outage Quiet would care about — current-gen
Starlink's handover is well within QSS's 5 s ack budget. The ~1–2%
packet-loss baseline is more concerning than the handovers themselves: a
single dropped ack mid-`CREATE_COMMUNITY` will retry once at the
socket.io layer, and the user-visible round-trip widens by ~200 ms, but
shouldn't bust 5 s on its own.

- **Profile:** 30–80 ms handover spikes every 15 s, 1–2% baseline loss,
  occasional 200+ ms latency tail.
- **Trips:** Nothing on its own. Combined with another stressor it could
  push `timeoutAck` over 5 s, but it's not the primary risk.
- **User symptom:** none typical. Maybe occasional retransmitted ack;
  not user-visible.

Honest assessment: **low priority** for QSS. The Quiet user demographic is
not predominantly Starlink-on-an-RV; even if they were, the symptoms here
are mild compared to mobile.

### 5. Tor circuit rebuild

Source quality: good (Tor Metrics performance dashboard, official
specifications).

Tor circuit build times follow a Pareto distribution; the Tor client
itself sets its CIRCUIT_BUILD_TIMEOUT at the 80th-percentile mark of recent
build times. Onionperf data historically puts the median 3-hop build at
**~1–3 s** with a heavy right tail; circuit rebuilds after a relay drop
can take **5–30 s** ([Tor path-spec, *Learning when to give up on circuit
construction*](https://spec.torproject.org/path-spec/learning-timeouts.html),
[Tor Metrics performance dashboard](https://metrics.torproject.org/onionperf-buildtimes.html)).

**This does not apply to QSS.** Confirmed in code: QSS uses raw
`socket.io-client.connect(qssEndpoint)` ([`qss.client.ts:121`](../qss.client.ts))
without the `SOCKS_PROXY_AGENT` that libp2p uses. QSS is clearnet. So Tor
rebuild timing is only relevant to the *libp2p* peer-to-peer path, which
has its own timeouts outside the scope of this doc.

The implication is the opposite of what one might guess: because QSS
*doesn't* go over Tor, it's much *less* susceptible to the seconds-scale
delays that would matter most to a privacy-tool user. The QSS client's 10 s
budget is plenty for a clearnet TCP+WS handshake under any normal
condition — it only fails when the underlying network itself is degraded.

- **Trips:** N/A for QSS path. Worth knowing for the auth-conn /
  message-sync path on libp2p, which is a separate investigation.

### 6. iOS/Android app background → foreground transition

Source quality: medium (Apple developer documentation, multiple
StackOverflow / GitHub-issue corroboration).

When iOS suspends an app (typically within seconds of background entry,
unless the app uses one of the sanctioned background modes), all JS pauses
and TCP sockets are torn down by the OS. On `applicationWillEnterForeground`,
the socket is dead but the JS state machine in `QSSClient` doesn't yet know
— `socket.connected` may still be true from its perspective. The next
`emit()` either sits in a buffer or fires onto a dead socket, the ack never
arrives, the 5 s timeout fires, and the reconnect loop kicks in. Best case:
the user loses ~5–15 s before things stabilize. Worst case: the app is
backgrounded again before the reconnect completes, and the cycle repeats.

This is documented at the socket.io level — see e.g. [socket.io-client-swift
issue #88, *won't reconnect when app gets suspended*](https://github.com/socketio/socket.io-client-swift/issues/88)
and [Apple Developer Forums, *Prevent WebSocket from closing*](https://developer.apple.com/forums/thread/716118).
Apple's official guidance: re-open and resync on `didBecomeActive`.

This scenario isn't a network condition per se — but the on-the-wire
symptom is identical to a 30+ s outage from QSS's point of view, because
the OS held the socket idle then killed it. So it slots cleanly into the
same bucket as the 5 s outage in the harness's `outage-5s-during-authsync`
profile, except it can be much longer.

- **Profile:** Arbitrary outage from seconds to hours. Resume is
  instantaneous from the app's perspective (no gradual recovery).
- **Trips:** `_waitForConnect` if the resume happens while the connect is
  in-flight; `timeoutAck` if mid-handshake; otherwise just the user's
  patience. Reconnect schedule's max delay (60 s) means worst-case a
  resumed app waits up to a minute before the next attempt.
- **User symptom:** "I came back to the app and nothing was loading for
  a while." Most users will swipe away and reopen, masking the underlying
  reconnect cycle. This is **the most common, every-user, every-day
  scenario**. It's what mobile users actually hit.

## Summary table

| Scenario | Probability for typical Quiet user | Current behavior on 7.1.0 | Suggested mitigation |
| --- | --- | --- | --- |
| Mobile background → foreground | **Daily, every mobile user** | Stuck reconnect cycle; user-visible delay 5–60 s | Listen for OS lifecycle events; force a clean teardown + immediate connect on resume. Quick win. |
| Mobile cellular handover (driving, train) | **Weekly, mobile users** | `timeoutAck` fires on bursts > 5 s; `qssSetup` stays false | Raise `timeoutAck` for the create-community round-trip to ~15 s. Quick win. |
| Cellular dead spot (1–2 bar) | **Weekly, mobile users** | Repeated reconnects; eventual success when coverage returns | Adaptive `timeoutAck` based on observed RTT; make reconnect schedule respect `Retry-After` semantics. Medium effort. |
| Captive WiFi portal | **Trip-frequency for laptop users** | Stuck "Connecting…" until user clicks through | Detect captive portal HTTP responses on the WS upgrade; surface a UI hint. Larger change, possibly out of scope. |
| Starlink handover | **Rare for typical user** | No impact; well within budgets | None. |
| Tor circuit rebuild | **N/A for QSS path** | QSS is clearnet | None on this path. |

## Honest assessment

**Likely (worth fixing soon):**
- *Mobile background → foreground.* This is the single largest realistic
  cause of the harness's bucket-1 failure mode. Most mobile users hit it
  multiple times a day. The fix is a state-machine change, not a
  timeout-knob change: on `appActive`, drop any cached `socket.connected`
  state and force a fresh connect.
- *Mobile cellular handover.* The 5 s `timeoutAck` is the load-bearing
  number here. 5 s was a reasonable default for a healthy datacenter
  socket; for a cellular client it's too tight. The `CREATE_COMMUNITY`
  round-trip in particular is the one users notice — if it has to
  succeed exactly once during a fresh signup, raising its `timeoutAck`
  from 5 s to ~15 s is essentially free risk-wise (the bound exists so
  the user gets feedback eventually, not because 5 s is correct).

**Plausible but lower priority:**
- *Captive WiFi portal.* Real, but the user already knows their internet
  isn't working. The fix (detect intercepted HTTP responses) is
  invasive and the payoff is "give up faster and tell the user."
- *Cellular dead spot.* Same family as handover but rarer; the fix is
  the same `timeoutAck` adjustment, so it's free-rides on the handover
  fix.

**Unlikely:**
- *Starlink handover.* Real, but doesn't trip QSS budgets. The 1–2%
  baseline loss is well within socket.io's own retry behavior.
- *Tor circuit rebuild.* Doesn't apply to QSS at all.

## Suggested concrete code changes

These are starting points for a follow-up PR, not finished proposals.

1. **Per-call `timeoutAck` budgets, generously.**
   `qss.client.ts:254` defaults to 5 s. The four create-community
   round-trips (`GEN_PUB_KEYS` 5 s, `VERIFY_CAPTCHA` 5 s, `CREATE_COMMUNITY`
   5 s, `SIGN_IN_COMMUNITY` 5 s) total 20 s in the *fast* case. Under any
   sustained > 1 s latency they each blow up serially. Either:
   - Raise the default to 15 s for round-trips that are part of a one-shot
     setup flow (vs. routine messaging where 5 s is fine), or
   - Make `timeoutAck` adaptive: track recent ack RTT, set the deadline
     to `max(5 s, 4 × p95_ack_rtt)`.

2. **`_waitForConnect` deadline.**
   `qss.client.ts:163`'s 10 s is fine for a healthy connect. Under captive
   portal / dead-spot conditions it doesn't matter how long you wait —
   the connection isn't going through until the underlying network
   recovers. Raising the budget alone doesn't help. The right move is to
   use a shorter probe (e.g., 5 s) and rely on the existing reconnect
   schedule; that gives the user faster feedback and converges the
   reconnect schedule on the new, larger network delay. Counter-arg: it
   makes things worse in mobile-handover where the network recovers in
   8 s. So this knob is genuinely contested.

3. **Background/foreground state machine.**
   Add a hook (renderer-side or Nest-side, depending on app architecture)
   that on app-resume calls `qssService.close()` then immediately
   reconnects, regardless of the cached `socket.connected` flag. This
   short-circuits the "phantom connection" problem where the app thinks
   it's connected but the OS has silently dropped the socket. Quick win,
   small surface area.

4. **AbortController-style reconnect.**
   The current reconnect uses `setTimeout` with an exponentially growing
   delay capped at 60 s. After the cap, every retry is a full minute
   apart — too slow if the user is actively waiting. Consider a "user is
   foreground / actively waiting" mode that forces aggressive retries
   for the first 30 s after wakeup, then falls back to the existing
   schedule. This is more invasive (it needs a signal from the UI layer)
   and is best left for a follow-up.

## A note on the harness's chaos profiles

The 22 failures came from `randomProfile()` in
[`fuzz.ts`](./fuzz.ts), specifically from the lines
```ts
latency: range(rng, 100, 5000),
jitter: range(rng, 0, 2000),
```
i.e., uniformly distributed up to 5 s baseline + 2 s jitter. That's
beyond what any single real network condition produces *in steady state*.
But it's a reasonable approximation of two stacked real conditions
(handover during a buffered burst on a degraded cell, or a backgrounded
app waking up onto a portal-protected network). So while the profile
itself is synthetic, the *answer* it produces — "the 5 s ack budget is
too tight" — is correctly aimed at a real problem.

A more focused realistic-mobile profile is added as
[`scenarios/realistic-mobile-handover.stress.spec.ts`](./scenarios/realistic-mobile-handover.stress.spec.ts).
It applies a 2 s baseline + 1 s jitter + 5% loss + a single 1 s outage
mid-handshake and asserts QSS recovers within a generous 90 s window. If
that test starts failing, the analysis above is the place to look first.
