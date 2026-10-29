# 0010: Rulesets have a published JSON Schema and a schemaVersion

Date: 2026-10-29 · Status: accepted

## Context

`parseRuleset` was the only definition of a valid ruleset. An editor, a CI
pipeline written in another language or a future UI could not check a document
without running the engine.

A document also carried no version. An older SDK reading a newer document
ignores fields it does not know and drops rules whose operator it does not know,
so it fails closed, which is safe. But nothing could say "this document needs
engine version N", and nothing told an operator that the SDKs reading it were
behind.

## Decision

**A hand-written JSON Schema (draft 2020-12)** lives at
`packages/core/schema/ruleset.schema.json` and is exported as
`@kurenwimpel/core/ruleset.schema.json`. It describes all three shapes
`parseRuleset` accepts: an array of flags, a key-to-flag object, and the
`{ flags, segments }` document.

Fixture tests keep the two definitions in step. Every fixture the parser reads
without an issue must validate, and every fixture the parser reports a
structural issue for must fail. Two further tests pin the operator list against
`ConditionOperator` and the schema's `schemaVersion` maximum against
`SUPPORTED_SCHEMA_VERSION`. `ajv` runs these tests as a dev dependency; core
still has no runtime dependencies.

The schema covers shape: types, required fields, non-empty strings, ranges, the
semver pattern, a rule needing a variant or a rollout, a segment needing at
least one criterion, and a document key that holds misplaced definitions. It
does not cover references between values: a `defaultVariant` naming a declared
variant, prerequisite and segment references, duplicate keys and rule ids, and a
targeting key claimed by two targets. Those remain parse issues only. Unknown
fields are allowed, as the parser allows them.

**The document form accepts `$schema`**, so an editor offers completion and
validation. It needs no parser change: the document key check already ignores a
value that cannot hold definitions.

**The document form accepts an optional integer `schemaVersion`.** Absent means 1.
Core exports `SUPPORTED_SCHEMA_VERSION`, currently 1. A higher value produces
one issue at `schemaVersion` and the ruleset still loads, so a lagging SDK keeps
serving, fails closed on whatever it cannot read, and reports the gap through
`onParseIssues` on every refresh. A value that is not a positive integer is
reported the same way. The array and key-to-flag shapes have nowhere to carry a
version and are version 1.

### When a change bumps `schemaVersion`

Bump it when an engine that ignores the new field would evaluate differently
without any issue to say so. A new field whose absence changes evaluation is the
case: a flag-level holdout that an older engine skips would serve treatment to
the holdout group.

Do not bump it for a change an older engine already handles safely:

- a new operator, because the older engine drops the rule, reports it, and the
  rule could not have matched anyway;
- a new field evaluation does not read, such as an annotation;
- a relaxed constraint, which an older engine rejects with an issue.

The schema's `maximum` moves with `SUPPORTED_SCHEMA_VERSION`, so the schema a
release ships describes the version that release reads.

## Consequences

- Editors validate with a `$schema` line, and a non-TypeScript CI job can check
  a ruleset with any 2020-12 validator.
- An operator learns that an SDK is behind from a parse issue, not from a flag
  that quietly behaves differently.
- There are two definitions to maintain. The fixture tests catch structural
  drift; a new cross-reference rule in the parser needs no schema change.

## Alternatives rejected

- **Generate the schema from the TypeScript types.** The types do not carry most
  of what the parser checks (non-empty strings, ranges, the semver pattern, a
  rule needing a variant or a rollout), and generated output reads poorly in an
  editor's error messages. The fixture tests guard against drift either way.
- **Validate with the schema at runtime.** It would add a dependency to core,
  and a schema failure is all or nothing, where the parser drops one bad
  definition and keeps the rest.
- **Reject a document with a newer `schemaVersion`.** That turns an SDK that is
  one release behind into an outage, when the parts it cannot read already fail
  closed.
- **A semver string for `schemaVersion`.** The only question an engine asks is
  whether it reads the document in full, and an integer answers it.
