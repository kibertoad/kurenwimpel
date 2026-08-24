# 0005 — Traffic allocation is a separate draw from treatment assignment

Date: 2026-08-24 · Status: accepted

## Context

An A/B test wants two dials, not one: _how much traffic enters the
experiment_ (exposure) and _how the entered traffic splits_ (assignment).
With only weighted rollouts, "expose 20%, split 50/50" is written as
`[10, 10, 80]` — and ramping exposure to 100% rewrites the weights to
`[50, 50, 0]`, which moves subjects **between treatments** mid-experiment.
A user measured under `control` for three weeks silently becomes `treatment`;
the analysis is now garbage.

Split solves this with `trafficAllocation` plus a dedicated
`trafficAllocationSeed`: the allocation gate and the treatment split are
independently seeded hashes (verified in `javascript-commons`'
`engineUtils.ts`). Users outside the allocation get the default treatment,
labelled `not in split`, and individually targeted keys bypass the gate
entirely ("Whitelisting has more priority than traffic allocation" —
`condition/index.ts`). LaunchDarkly reaches the same end differently, with
experiment-kind rollouts, untracked variations, and `inExperiment` reasons.

## Decision

A flag-level gate:

```json
"allocation": { "percent": 20, "seed": "optional-re-draw" }
```

evaluated after the kill switch, prerequisites, and individual targets, and
before any rule. A subject outside the allocation is served `defaultVariant`
with reason **`NOT_ALLOCATED`** — the in-process equivalent of Split's
`not in split` label, and exactly the signal an experiment analysis needs to
separate "not exposed" from "exposed, got control".

The gate hashes the `<salt>!allocation[:<seed>]` domain (ADR 0002), which is
decorrelated from every assignment domain by construction. The consequences
are the two properties an experiment ramp needs, both pinned by tests:

- **Widening 20% → 60% only admits.** Nobody leaves, and nobody already
  admitted changes treatment, because admission and assignment are
  independent draws.
- **The admitted population is unbiased** with respect to assignment buckets
  — the 20% who enter still split 50/50, not "the 20% who would have gotten
  treatment anyway".

Individual targets sit above the gate (Split's semantics): a QA account
pinned to `treatment` sees it even at `percent: 0`.

## Consequences

- The canonical A/B flag is `allocation` + a flag-level `rollout` + `seed`s;
  ramping exposure touches one number and invalidates nothing.
- `NOT_ALLOCATED` has no OFREP name; it maps to `STATIC` on the wire
  (ADR 0003) since the statically configured default is what was served.
- Allocation always buckets on `targetingKey` (not `bucketBy`) — one identity
  decides "is this subject in the experiment", even if assignment then
  clusters by account. Absent key → the usual serve-default-plus-error path.

## Alternatives rejected

- **Expressing exposure inside the split weights** (`[10, 10, 80]`): the
  reshuffling-on-ramp problem above; it also conflates "control" with "not in
  experiment", which corrupts exposure-based metrics.
- **LaunchDarkly's model** (rollout `kind: "experiment"`, untracked
  variations, `inExperiment` flags on reasons): strictly more machinery for
  the same two dials — the untracked-variation list is exposure expressed as
  per-variation bookkeeping. One gate with one percent is easier to reason
  about, and impressions (ADR 0007) already tell analysis who was exposed.
- **Per-rule allocation**: Split applies allocation split-wide once the first
  rollout rule is reached, not per rule; per-rule gates would make "what
  fraction is exposed" depend on rule order in a way no one can eyeball.
- **A dedicated `Experiment` entity** separate from flags: doubles the
  concept count (Split and LD both keep experimentation on the flag), and
  everything an experiment needs is already flag-shaped.
