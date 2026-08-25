# 0009 — The OFREP contract is grounded on a vendored copy of the document

Date: 2026-08-25 · Status: accepted

## Context

`@kurenwimpel/ofrep` is a hand transcription of the OFREP 0.3.0 OpenAPI
document. A transcription's failure mode is not a typo — the parse tests catch
those — it is the source moving underneath it. Upstream's history says that is
the normal case, not the edge one: `/ofrep/v1/configuration` removed, the
`cacheable` property removed, `codeDefaultFlag` added, event streams added, all
inside a year and all under the same `0.3.0` `info.version`. With nothing pinned,
"we deviate deliberately here" and "we are eighteen months stale here" are the
same state of the repository.

What upstream actually publishes:

- **`open-feature/protocol`, `service/openapi.yaml`** (OpenAPI 3.1.0) and
  **`service/event-streams.yaml`** (3.2.0, the SSE format). The machine-readable
  artefact — but on a branch, with no tags, no releases and no npm package. There
  is no version to depend on, only a commit.
- **`@openfeature/ofrep-core`** on npm. An implementation, not a specification:
  its interfaces are hand-written and looser than the document (`key`, `value`
  and `reason` all optional, `reason` an open string, no per-type value union),
  and it pulls in `@openfeature/core`.
- **Prose**: `guideline/` and `service/adrs/`. Shapes the contract, cannot be
  compared against it.
- **`open-feature/spec`**, the OpenFeature SDK specification, as a JSON list of
  numbered requirements. Requirements, not types.

## Decision

Vendor the two documents at a pinned commit, in `packages/ofrep/spec`, and check
the transcription against them mechanically. Three guards, because there are
three ways this can rot:

1. **The contract stops matching the document.** `test/spec-*.test.ts` reduces
   both sides to the same structural descriptor — properties, requiredness,
   types, enum values — by running the vendored JSON Schema and zod's
   `toJSONSchema` output through one normaliser. The expectations are read out of
   the document rather than written down, so a new required field or a seventh
   flag type fails a test nobody had to anticipate. `test/component-registry.ts`
   maps each `components/schemas` entry to the schema that stands for it and is
   exhaustive by test, which is what catches a component added upstream.
2. **The document moves on.** `pnpm spec:check` compares the vendored bytes to
   upstream and runs weekly in CI. It needs the network, so it is nobody's
   pre-commit hook and not part of `pnpm run check`.
3. **A vendored file is edited to make a test pass.** `provenance.json` carries a
   sha256 per file, asserted offline.

Refinements the contract adds on purpose — `minLength` on a path key, `format`,
`pattern`, bounds — are outside the comparison. They are stricter readings of a
declared type, not different types, and the document churns descriptions and
examples far more often than shapes.

`@openfeature/ofrep-core` is not a dependency, in either direction.

## Consequences

- Reconciling an upstream change is a runbook rather than an investigation: the
  failing tests name the schema, the route or the example that moved, and
  `spec/README.md` maps each failure to where it is fixed.
- The deliberate deviations become executable. The extra `flagNotFound` arm in a
  bulk `flags` array is expressed as "the document's two arms plus this
  component", derived from the document, so it stops being a deviation
  automatically if upstream fixes its own `oneOf`.
- A `yaml` dev dependency and a ~200-line normaliser to maintain, and a
  comparison that is structural rather than total: a document that tightened
  `key` to a pattern would fail nothing. The weekly checksum alarm is what
  makes that diff visible anyway.
- `spec/` is dev-time only; the published package still ships `dist` alone.

## Alternatives rejected

- **Depend on `@openfeature/ofrep-core` for the types.** Inverts the layering (a
  specification depending on someone's provider implementation) and would
  loosen the contract to match interfaces that are looser than the document —
  optional keys, an open `reason`. The one artefact that looks like a types
  package is the one that would cost the most accuracy.
- **Generate the schemas from the OpenAPI document.** Generated `allOf`/`oneOf`
  output is unreadable, and this package's value is in the reading: why
  `codeDefaultFlag` is `optional(never())`, why `type` stays an open string, why
  the bulk array admits a third arm. No generator emits those, and a generator
  would erase the deviations rather than record them. The transcription is small
  and stable; the checking is what needed automating.
- **Fetch the document in the test instead of vendoring it.** Tests would need
  the network, would go red on upstream's schedule rather than ours, and could
  not tell "we are stale" from "GitHub is down". Hermetic tests plus a scheduled
  alarm separates those two.
- **Let Renovate watch it.** There is nothing for a dependency bot to watch: no
  package, no tags, no releases. `spec:check` is the bespoke equivalent.
- **Compare the JSON Schemas whole.** Descriptions, examples and formats would
  make every upstream copy-edit a test failure, and the contract's intentional
  refinements would each need an exception. A check that noisy gets an exception
  list instead of a fix.
