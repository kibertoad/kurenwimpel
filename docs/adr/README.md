# Architecture decision records

Decisions that shaped `@kurenwimpel/core`, with the alternatives that were
considered and rejected. Each record is written against what LaunchDarkly,
Split (Harness FME), and Flagsmith actually do — verified from their SDK and
engine sources, not from marketing pages — so "we deviate from X here" is a
statement about code, and the deviation is deliberate. Three records are
exceptions. 0009 is about `@kurenwimpel/ofrep`, and the deviations it discusses
are from the OFREP document itself. 0010 is about the ruleset format and 0011 is
about the control plane service; neither makes such a comparison.

| ADR                                            | Decision                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| [0001](0001-pure-evaluation-over-snapshots.md) | Evaluation is a pure function over an immutable snapshot                 |
| [0002](0002-murmur3-bucketing.md)              | MurmurHash3 bucketing with derived, decorrelated hash domains            |
| [0003](0003-ofrep-shaped-model.md)             | The domain model is OFREP-expressible by construction                    |
| [0004](0004-segments.md)                       | Segments: shared audiences, compiled to sets, exclusion wins, no nesting |
| [0005](0005-traffic-allocation.md)             | Traffic allocation is a separate draw from treatment assignment          |
| [0006](0006-prerequisites.md)                  | Prerequisites re-evaluate the dependency, fail closed, off on failure    |
| [0007](0007-experimentation-primitives.md)     | Impressions are a synchronous hook; seeds and bucketBy live on the split |
| [0008](0008-operator-set.md)                   | Semver operators in, regex and date operators out                        |
| [0009](0009-vendored-ofrep-spec.md)            | The OFREP contract is grounded on a vendored copy of the document        |
| [0010](0010-ruleset-schema.md)                 | Rulesets have a published JSON Schema and a schemaVersion                |
| [0011](0011-control-plane-service.md)          | A control plane service publishes through the GitOps publisher           |

The evaluation pipeline the records collectively describe, in order:

1. `enabled: false` → `offVariant` (`DISABLED`) — the kill switch.
2. Failed prerequisite → `offVariant` (`PREREQUISITE_FAILED`).
3. Individual target listing the targeting key → its variant (`TARGETING_MATCH`).
4. Outside the traffic allocation → `defaultVariant` (`NOT_ALLOCATED`).
5. First rule whose conditions all match → its variant (`TARGETING_MATCH`) or rollout (`SPLIT`).
6. The flag's own rollout (`SPLIT`).
7. `defaultVariant` (`STATIC`).

The three product use cases map onto it directly:

- **Strict feature toggle** — `enabled`, `offVariant`, optionally prerequisites
  as a layered kill switch. Deterministic; no hashing on the path.
- **Canary release** — a rollout ramped 5 → 50 → 100, optionally per-cohort via
  `bucketBy`, per-version via semver conditions, with QA accounts pinned
  through `targets`.
- **A/B test** — `allocation` limits exposure, the rollout splits treatments,
  `seed` re-randomises between iterations, and `onImpression` feeds exposure
  records (with `metadata` such as the experiment id) to analytics.
