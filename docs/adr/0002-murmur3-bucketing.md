# 0002 — MurmurHash3 bucketing with derived, decorrelated hash domains

Date: 2026-08-24 · Status: accepted

## Context

Every percentage decision — canary ramps, treatment splits, traffic allocation
— needs to map a subject to a stable point in [0, 1) such that:

1. the same subject lands on the same point on every runtime, forever;
2. widening a range only ever admits subjects, never ejects or reshuffles them;
3. distinct decisions are statistically independent, so the unlucky tail of one
   experiment is not the unlucky tail of all of them.

Prior art: Split buckets with MurmurHash3 x86 32-bit into 100 buckets (1%
granularity), seeded per flag, and keeps a _second_ seed for traffic
allocation (`trafficAllocationSeed` in `IDefinition`, hashed independently in
`engineUtils.ts`). LaunchDarkly hashes `flagKey.salt.key` with SHA-1, takes 15
hex chars, and buckets into 100 000 (0.001%). Flagsmith joins object ids and
runs MD5.

## Decision

A hand-rolled MurmurHash3 (x86, 32-bit) over UTF-8 bytes, verified against the
reference vectors, bucketing into `BUCKET_COUNT = 10_000` (0.01% granularity).

Not `node:crypto`, not WebCrypto: the first does not exist on workerd or in
browsers, the second is async — and evaluation is synchronous by contract
(ADR 0001). Murmur3 is ~40 lines, allocation-free after the input encoding,
non-cryptographic by intent (this is partitioning, not security), and fast —
the hash is the whole hot-path cost of a rollout.

Every decision hashes a domain tuple plus the subject. The tuple opens with a
purpose tag and carries the flag's salt (default: its key):

| Decision                  | Domain tuple                 |
| ------------------------- | ---------------------------- |
| Flag-level rollout        | `rollout, <salt>`            |
| Rule-level rollout        | `rule, <salt>, <ruleId>`     |
| Either, with a `seed`     | `<seed>` appended            |
| Traffic allocation        | `allocation, <salt>`         |
| Allocation, with a `seed` | `allocation, <salt>, <seed>` |

The hash input is the tuple — subject included — with every part
length-prefixed, which makes the encoding injective: no choice of salt, seed,
or rule id, including ones containing delimiter characters (a seed literally
`allocation`, a flag key `checkout:v2`), can make two distinct decisions share
a hash input.

Distinct domains give independent draws (property 3); the cumulative-weight
walk inside one domain gives monotone ramps (property 2); hashing gives
determinism with zero state (property 1). Changing a flag's `salt` reshuffles
everything under it — the documented big red button.

Weights are relative and normalised by their sum (`[{on,1},{off,3}]` is
25/75), so a control plane is never forced to make integers add up to a magic
total — Split requires partitions to sum to exactly 100, and its
`Treatments.parse` throws otherwise, which is a class of config error this
design cannot have.

## Consequences

- A Worker at the edge and a Node service agree on every bucket with no
  coordination, no shared store, no sticky sessions.
- 10 000 buckets bound ramp granularity at 0.01% — finer than Split's 1%,
  coarser than LaunchDarkly's 0.001%. For the audiences this targets, a 0.01%
  slice is already below the noise floor of any experiment.
- The murmur implementation is pinned by reference test vectors; it can never
  be "fixed" without knowingly re-bucketing the world.

## Alternatives rejected

- **SHA-1 or MD5 via platform crypto** (LaunchDarkly / Flagsmith): async or
  absent on target runtimes, an order of magnitude slower, and cryptographic
  strength buys nothing here.
- **Random assignment persisted per subject** (sticky bucketing with storage):
  requires a read-write store on the hot path and breaks the zero-coordination
  property; hashing gets the same stickiness for free.
- **One shared bucket per subject** (hash the key once, reuse across flags):
  cheaper, but violates independence — every flag's 10% would be the _same_
  10% of users, which quietly correlates all experiments.
- **Split's integer partitions summing to 100**: rejected in favour of
  relative weights; see above.
