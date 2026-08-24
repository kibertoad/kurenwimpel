# 0008 — Semver operators in, regex and date operators out

Date: 2026-08-24 · Status: accepted

## Context

Condition operators are the vocabulary of targeting, and each one is a
permanent compatibility commitment — an operator can never change meaning
once rulesets in the wild use it. The engine had thirteen (existence,
equality, set, string, numeric). The question is what earns a place beside
them. Prior art for the candidates: LaunchDarkly ships semver, regex, and
date operators; Split ships string/set/boolean matchers plus a dependency
matcher; Flagsmith ships `REGEX`, `MODULO`, and nested ALL/ANY/NONE rule
trees.

## Decision

**In: `semverEq`, `semverGt`, `semverGte`, `semverLt`, `semverLte`.** The
canary-release use case is very often "app version ≥ X": mobile and desktop
fleets upgrade gradually, and `gte` on a version _string_ is wrong the moment
`2.10` meets `2.9`. The comparator is a trimmed SemVer 2.0.0 — numeric core,
full prerelease precedence (the spec's own ordering chain is a test), build
metadata ignored — tolerant of a leading `v` and a short core (`"2.1"`),
strict otherwise. Two sharp edges are deliberate:

- The parser validates the condition's `value` at ruleset load; a typo like
  `semverGte: "latest"` is a parse issue, not a silently-never-matching rule.
- A context attribute that fails to parse simply never matches, fail closed,
  like every other type mismatch.

**Out: regex matching.** A regex in a flag definition is remotely-supplied
code running on every request. JavaScript's engine is backtracking, so a
hostile-or-clumsy pattern is a ReDoS against every service that evaluates the
ruleset — the blast radius of the config plane at its worst. LaunchDarkly and
Flagsmith accept this risk; this engine does not, and `startsWith` /
`endsWith` / `contains` cover the common intents. If it ever becomes
unavoidable, the bar is a linear-time engine (RE2-class), which is not a
zero-dependency proposition.

**Out: date/time operators.** Evaluation reads no clock (ADR 0001) — that is
what makes results reproducible and tests deterministic. "Scheduled rollout"
is a control-plane feature: flip the flag at the scheduled time, and every
runtime agrees. A caller who genuinely needs request-time conditions can pass
a timestamp attribute and compare numerically today.

**Out: nested boolean rule trees** (Flagsmith's ALL/ANY/NONE with sub-rules).
Conditions AND within a rule; rules OR within a flag. That two-level algebra
is complete (any boolean expression has a DNF), reads flat in JSON, and keeps
the matcher a loop instead of a tree-walk. The rare genuinely-complex
audience is a segment, which is the named, testable version of the same OR.

## Consequences

- Unknown operators from a newer control plane still fail closed at both
  layers: the parser reports the definition, and a hand-built condition with
  an unrecognised operator matches nothing.
- The semver comparator is ~80 lines owned in-repo (`evaluation/semver.ts`),
  pinned by the SemVer spec's precedence examples, rather than a dependency.
- "No regex" is a security posture, recorded here so a future "just add
  `matches`" PR has to argue with the reasoning, not rediscover it.
