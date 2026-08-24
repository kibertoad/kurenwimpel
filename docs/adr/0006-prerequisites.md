# 0006 — Prerequisites re-evaluate the dependency, fail closed, off on failure

Date: 2026-08-24 · Status: accepted

## Context

Features layer: `checkout-redesign` is meaningless unless `new-backend` is
serving `on`. Without first-class dependencies, teams either duplicate the
parent's targeting into every child (drift) or check two flags at every call
site (forgotten once, broken forever). LaunchDarkly models this as
prerequisites — dependency must be **on** and serving an **exact variation**,
else the dependent serves its off variation with `PREREQUISITE_FAILED`; cycles
are caught at runtime as malformed flags. Split added the same concept as
`prerequisites: [{n, ts}]` — flag name plus a _list_ of acceptable treatments
— serving the default treatment on failure.

## Decision

```json
"prerequisites": [{ "flag": "new-backend", "variants": ["on"] }]
```

Each prerequisite is checked, in order, before anything else about the flag
except its own kill switch. The dependency must:

1. exist in the evaluation environment (the snapshot's flags),
2. be `enabled` — an off dependency fails the check even if its `offVariant`
   happens to be listed, because "the kill switch upstream is pulled" must
   propagate (LaunchDarkly's evaluator has the same special case), and
3. evaluate, with the same context, to one of the listed `variants` —
   Split's list shape rather than LaunchDarkly's single variation, since
   "either paid tier" should not need two prerequisite entries.

On failure the flag serves its **`offVariant`** with reason
`PREREQUISITE_FAILED` and `failedPrerequisite` naming the dependency
(LaunchDarkly's behaviour; Split serves the default treatment instead — the
off variant is chosen because a prerequisite is a gate, and a closed gate
should look like "off", not like "on but defaulted").

Failure is closed in every direction: missing dependency, missing
environment, dependency serving the wrong variant, dependency erroring (it
cannot bucket without a targeting key, say — the fallback variant it serves
alongside the error vouches for nothing) — all `PREREQUISITE_FAILED`. A
dependency that cannot be checked is a dependency that does not hold.

**Cycles are a config bug, reported as one.** Evaluation carries the visiting
chain; re-entering a flag yields `ERROR` / `INVALID_DEFINITION` with the cycle
named, propagated up the chain undisguised (an ordinary
`PREREQUISITE_FAILED` would let a broken graph masquerade as a working gate).
The parser additionally rejects the trivial self-cycle. Depth needs no
separate cap: the chain is bounded by the number of flags in the snapshot.

## Consequences

- One kill switch can now fell a whole feature tree, which is the point.
- Prerequisite evaluations do not emit their own impressions — only the flag
  the caller asked about does. LaunchDarkly emits events for prerequisite
  evaluations; if experiment analysis ever needs dependency exposures, that
  is an additive change in the client, not the evaluator.
- Cross-flag validation (does the referenced flag exist? are the listed
  variants real?) cannot happen in the per-flag parser; it surfaces at
  evaluation as a failed prerequisite. A control plane can lint the graph;
  the evaluator stays safe without it.

## Alternatives rejected

- **Parse-time graph validation only** (reject cycles when the ruleset
  loads): definitions also arrive hand-built through the public
  `evaluateFlag`, and two individually-valid payloads can form a cycle across
  a partial refresh. The runtime guard is the one that cannot be bypassed;
  a parse-time lint would be additive, not a replacement.
- **Split's serve-the-default-treatment on failure**: makes a closed gate
  indistinguishable from "no rule matched", which is exactly the confusion
  reasons exist to prevent.
- **Inlining the dependency as a condition** (`flag:new-backend eq on`
  pseudo-attributes): stringly-typed, invisible to tooling, and re-implements
  prerequisite evaluation inside condition matching where cycles cannot be
  guarded.
- **No dependencies** (status quo): the duplication-and-drift problem in the
  Context.
