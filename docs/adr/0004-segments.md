# 0004 — Segments: shared audiences, compiled to sets, exclusion wins, no nesting

Date: 2026-08-24 · Status: accepted

## Context

"Beta testers", "EU enterprise accounts", "do-not-experiment" — the same
audience appears in many flags. Without a shared definition it gets copied
into each one and the copies drift. Every mature system has this concept:
Split has standard segments (explicit key lists, up to 100k keys), large
segments (up to 1M, not evaluated by server SDKs), and rule-based segments;
LaunchDarkly has included/excluded key lists plus rules (each rule optionally
weighted), and "big segments" backed by external stores.

## Decision

A `SegmentDefinition` is `{ key, included?, excluded?, rules? }` — explicit
key lists and/or condition rules, referenced from flags through the
`inSegment` / `notInSegment` operators (`{ operator: 'inSegment', segments:
[...] }`, matching any of the listed keys).

**Membership order: excluded → included → rules.** An excluded key is out no
matter what the rules say. This inverts LaunchDarkly, whose evaluator checks
included first (source comment: "always check for included before excluded").
Exclusion-wins is chosen deliberately: the operational use of an exclusion
list is a hard opt-out — a GDPR objector, a jittery enterprise customer, a
load-test account — and a list called "excluded" that can be overridden by a
rule match is a support incident waiting to be written up. Rules run even
without a targeting key, since they match on attributes.

**Compiled once, matched in O(1).** The wire form carries key lists as JSON
arrays; `compileSegment` turns them into `ReadonlySet`s when the snapshot is
built. A 100 000-key segment costs one set build per refresh and a hash probe
per evaluation. This is also the answer to "my `in` list is huge": flag-level
target and condition lists are linear scans meant for tens of keys; big lists
belong in segments. (Same guidance LaunchDarkly gives — big lists go in
segments, not targets.)

**No nesting.** Segment rules may not use the segment operators; the parser
rejects them, and a hand-built one fails closed in the matcher. Membership
therefore never recurses and can never cycle — there is no segment analogue
of the prerequisite cycle guard because the shape makes cycles inexpressible.

**Fail closed.** An unknown segment key, or a snapshot with no segments at
all, makes `inSegment` false (and `notInSegment` true — it is a negation, not
a second lookup). Split returns the `control` treatment when a server SDK
meets a large segment it cannot evaluate; here the flag simply proceeds to
its later, non-matching branches.

## Consequences

- One audience, defined once, referenced everywhere; ruleset payloads carry it
  under `{ flags, segments }` and every provider ships it into the snapshot.
- Segments live in the same payload and snapshot as flags — same consistency,
  same refresh, no second distribution channel. That caps segment size at
  "fits in the payload"; a million-key segment wants a different transport
  (see rejected alternatives).
- Exclusion-wins differs from LaunchDarkly; anyone migrating semantics should
  read this record. The test suite pins the order.

## Alternatives rejected

- **Per-rule percentage weights inside segments** (LaunchDarkly's
  `SegmentRule.Weight`): a second place where percentage logic lives, with its
  own bucketing quirk (LD buckets a missing attribute to 0, which _matches_
  the weighted rule). Percentages stay in flags — a rule that wants "10% of
  matching users" is a flag rule with a rollout.
- **Nested segments** (Split's rule-based segments can reference other
  segments; LD added nesting recently): requires cycle detection at parse or
  evaluation time and makes membership cost unbounded. Flat segments plus
  multiple keys on one `inSegment` condition cover the OR case.
- **Externally-stored membership with a lookup interface** (LD big segments,
  Split large segments): a `BigSegmentProvider`-style seam means async
  membership, which breaks synchronous evaluation (ADR 0001). If audiences
  outgrow the payload, that seam is the known extension point — behind a
  snapshot-time materialisation, not an evaluation-time call.
- **Inline-only conditions, no segments**: rejected for the drift problem that
  motivated this record.
