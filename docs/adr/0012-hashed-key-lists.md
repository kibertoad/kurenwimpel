# 0012: Segments and targets may hold SHA-256 digests of targeting keys

Date: 2026-10-29 · Status: accepted

## Context

Segment `included` / `excluded` lists and individual `targets` name subjects by
targeting key, and a targeting key is often a user id, an account id or, against
advice, an email address. The whole ruleset reaches every process and every
Worker isolate that evaluates flags, sits in KV or a bucket, and is written to a
last-known-good store. Anything that can read the ruleset can read those lists.

"Keep PII out of rulesets" is the first answer, and the README gives it. It is not
always available: some teams target by an identifier they cannot replace with an
opaque one, and some want the ruleset to be harmless to leak even when the ids in
it are already opaque.

The alternative is to ship `sha256(targetingKey)` and hash the context's key at
evaluation time. Evaluation is synchronous and core has no platform APIs, so
neither `node:crypto` nor Web Crypto's asynchronous `digest` is available. The
hash has to be a pure TypeScript SHA-256, and the question this record answers is
whether its per-evaluation cost is acceptable.

LaunchDarkly hashes context keys only for its big-segment store lookups, where
the store is external; its in-ruleset segment lists are plain. Split and
Flagsmith ship plain keys. A hashed list is a deviation, opted into per list.

## Measurements

`packages/core/bench/hashed-keys.bench.ts`, measured on 2026-10-29 on the
machine the README's [Limits](../../README.md#limits) section uses (Intel Core
Ultra 9 285HX, Windows 11, Node v26.13.0). Each figure is a mean over a vitest
bench run. "Fresh key" means every iteration evaluates a different targeting key,
which is what a request for a new subject pays.

| Operation                                               | Mean    |
| ------------------------------------------------------- | ------- |
| `sha256Hex`, 10-character key                           | 1.08 µs |
| `sha256Hex`, 36-character UUID                          | 1.01 µs |
| `inSegment`, 100 000-key `included`, fresh key          | 0.26 µs |
| `inSegment`, 100 000-key `includedHashes`, fresh key    | 1.81 µs |
| individual target, 1 000 plain `keys`, fresh key        | 0.24 µs |
| individual target, 1 000 `keyHashes`, fresh key         | 1.44 µs |
| `inSegment`, `includedHashes`, same key as the last one | 0.20 µs |

A hashed list adds about 1.2 to 1.6 µs to the first evaluation that needs a
digest for a given key: six to seven times a plain lookup, and about the cost of
a flag with twenty rules (1.5 µs in the README's table). The plain paths did not
move: the existing `evaluation` and `evaluate-all` benchmarks show the same means
before and after the change, within run-to-run noise.

## Decision

**Accepted.** A segment may declare `includedHashes` and `excludedHashes`, and an
individual target may declare `keyHashes`, each as
`{ "algorithm": "sha256", "values": ["<64 lowercase hex>", ...] }`. A value is the
SHA-256 of the key's UTF-8 encoding. Plain and hashed lists can sit side by side.

**The cost is paid only by the lists that use it.** Compiling a segment builds a
digest set only when the definition declares one, and a flag's hashed targets fold
into their own digest-to-variant map. Evaluation hashes the targeting key only
when the segment or flag it is probing has a digest set, so a ruleset without
hashed lists never hashes at all.

**At most one hash per evaluation, usually fewer.** The digest of the most recent
targeting key is remembered. A flag whose hashed target and three hashed segments
all need the digest pays for one hash, and `evaluateAll` over a ruleset with many
hashed lists pays for one per context. Evaluation is synchronous, so nothing can
interleave between computing the digest and reading it back.

**Order is unchanged.** A plain match is probed before a hashed one. Exclusion
still wins across both forms: a key in `excluded` or `excludedHashes` is out
before `included` or `includedHashes` is consulted.

**Strict validation.** The parser accepts only `"sha256"` and only 64 lowercase
hex characters. Uppercase is rejected rather than folded, because the evaluator
compares digests as strings and a list that matches only after normalisation would
read differently to any other consumer of the ruleset. Duplicate digests within
a target or across a flag's targets are rejected the same way duplicate plain
keys are.

**`sha256Hex` is exported** from `@kurenwimpel/core`, so tooling that converts a
plain list (the CLI's `hash-keys`, a control plane) produces digests with the
same encoding the evaluator uses.

## Consequences

- A leaked ruleset no longer reveals hashed identifiers directly. It does not make
  them secret: an unsalted SHA-256 of a low-entropy key, such as an email address
  or a sequential id, can be recovered by hashing candidates. The README says
  so, and still recommends opaque ids first.
- The digest is unsalted on purpose. A per-ruleset salt would stop dictionary
  attacks across rulesets but not within one, and would make the same key hash
  differently in every environment, which breaks copying a list between them.
- A hashed list cannot be reviewed by eye. Tooling has to hash a candidate key to
  answer "is this user in the segment".
- The parser cannot tell that a plain key and a digest name the same subject, so
  a key listed in both forms on different targets is not reported. The plain
  target wins, as documented.
- Adding an algorithm later is a parser and compiler change: an unknown
  `algorithm` is rejected today, and a hand-built list naming one compiles to
  nothing, which matches nobody.
