# 0007 — Impressions are a synchronous hook; seeds and bucketBy live on the split

Date: 2026-08-24 · Status: accepted

## Context

An A/B test is a join: _who saw which treatment_ against _what they then did_.
The flag engine owns the first half. Split records an impression per
`getTreatment` (treatment, label, change number, timestamp) and ships them in
batches; LaunchDarkly emits evaluation events gated by `trackEvents` and
marks experiment traffic with `inExperiment`. Both SDKs own buffering,
batching, flush intervals, and delivery — hundreds of lines of I/O policy.

Two more experiment mechanics live in the assignment itself: re-randomising
between iterations (LaunchDarkly: a rollout `seed` replaces the hash prefix,
"rollouts with the same seed assign the same users to the same buckets"), and
bucketing by something other than the user so cohorts move together
(LaunchDarkly `bucketBy`; Split's separate bucketing key).

## Decision

**The core emits; the platform ships.** `FeatureFlagClient` takes an
`onImpression` hook, called synchronously once per evaluation — typed getters
included, and exactly once even though they wrap the raw path — with the full
exposure record: flag key, served value and variant (the _served_ one: a
typed getter that fell back reports the fallback), reason, rule id, error
code, targeting key, flag `version`, flag `metadata`, timestamp. A hook that
throws is routed to `onError` and never fails the evaluation. No hook, no
cost: the event object is never built.

There is no flag-level `trackEvents` toggle and no sampling knob in the core.
`reason` and `metadata` carry everything a consumer needs to filter
("`SPLIT` and `NOT_ALLOCATED` on flags with an `experiment` metadata key"),
and a filter is one line in the hook. The core cannot buffer or flush anyway
— timers and network are platform concerns by charter.

**Assignment mechanics on the split**, in its object form:

```json
"rollout": { "seed": "iteration-3", "bucketBy": "accountId", "buckets": [...] }
```

- `seed` feeds the hash domain (ADR 0002): a new seed is a fresh draw for
  exactly this split, nothing else. That is LaunchDarkly's iteration
  reshuffle, minus the special rollout kind.
- `bucketBy` hashes a context attribute instead of the targeting key, so an
  account's users land together. A **missing** `bucketBy` attribute serves the
  default variant with `TARGETING_KEY_MISSING` naming the attribute —
  explicitly rejecting LaunchDarkly's behaviour, where a missing attribute
  buckets to 0 and silently serves "the first variation with weight > 0",
  which its own docs admit "may not be the default variation".
- The bare-array rollout form stays valid; the object form is the same thing
  with knobs.

`evaluateAll(context)` rounds this out for the OFREP bulk route: every flag,
one context. It emits **no** impressions unless asked (`{ impressions: true }`)
— a bulk fetch is a prefetch, not an exposure, and one event per flag would
make every experiment's exposed population "everyone who loaded the page",
which is exactly the join this feed exists to support. The typed getters are
the exposure points.

## Consequences

- Wrappers choose their own delivery: a Node service batches to its analytics
  pipeline on a timer; a Worker `ctx.waitUntil`s a fetch. The core stays
  I/O-free and the hook contract is three lines to test.
- Synchronous hooks put the consumer on the hot path. That is deliberate —
  push the queue to the platform layer — and the guard rails are "throwing is
  contained" plus "absent is free".
- `inExperiment` is not a field; it is derivable (`reason === 'SPLIT'`, with
  `NOT_ALLOCATED` as the unexposed complement) and pinned to flag identity by
  `metadata`.

## Alternatives rejected

- **An event queue inside the core** (Split/LD style buffering with flush
  intervals): needs timers, network, and shutdown hooks — all platform APIs
  the core is forbidden to touch, and all policy the platforms disagree on.
- **Flag-level `trackEvents`** (LaunchDarkly): a second on/off system that
  silently eats data when misconfigured; filtering in the hook is explicit
  and lives next to the code that pays for the events.
- **LaunchDarkly's experiment rollout kind** (`kind: "experiment"`, untracked
  variations, bucketBy forcibly ignored): three special cases replacing two
  orthogonal knobs (`seed`, allocation from ADR 0005) that compose.
- **Bucket-to-zero on missing `bucketBy`** (LaunchDarkly): serving a
  non-default variant because an attribute was absent is the least
  explainable outcome in the whole design space; fail loud, serve the
  default.
