# @kurenwimpel/ofrep

The **OpenFeature Remote Evaluation Protocol** (OFREP) as an executable contract.

OFREP is the vendor-neutral HTTP layer between an OpenFeature provider and a flag
management system. Implement it and every community-maintained OFREP provider can
talk to you; no bespoke SDK, no per-language client.

This package is a transcription of the [OFREP OpenAPI document][spec] (v0.3.0)
into [toad-contracts][toad] routes and [Zod Mini][zod] schemas. It is a
specification, not an implementation: it describes both sides of the wire and
implements neither. It also does not depend on `@kurenwimpel/core`, so it stays
usable as a plain OFREP contract.

The document itself is vendored at a pinned commit in [`spec/`](spec/README.md)
and the transcription is checked against it on every test run — see
[_Grounded on the document_](#grounded-on-the-document).

[spec]: https://github.com/open-feature/protocol/blob/main/service/openapi.yaml
[toad]: https://github.com/kibertoad/toad-contracts
[zod]: https://zod.dev/packages/mini

`zod` is a peer dependency, so a consumer keeps one copy and picks the version —
which matters here, since the schemas this package exports are parsed with the
consumer's zod rather than its own.

```sh
pnpm add @kurenwimpel/ofrep zod
```

## Routes

| Contract                    | Route                                | Shape                                                |
| --------------------------- | ------------------------------------ | ---------------------------------------------------- |
| `evaluateFlagContract`      | `POST /ofrep/v1/evaluate/flags/:key` | Server-side. One flag, context supplied per request. |
| `evaluateFlagsBulkContract` | `POST /ofrep/v1/evaluate/flags`      | Client-side. All flags, one static context, ETagged. |

Both are exported individually and together as `OFREP_CONTRACTS`.

```ts
import { describeApiContract } from '@toad-contracts/core';
import * as z from 'zod/mini';
import { evaluateFlagContract } from '@kurenwimpel/ofrep';

describeApiContract(evaluateFlagContract); // 'POST /ofrep/v1/evaluate/flags/:key'
evaluateFlagContract.pathResolver({ key: 'new-checkout' }); // '/ofrep/v1/evaluate/flags/new-checkout'

const body = z.safeParse(evaluateFlagContract.requestBodySchema, await request.json());
const ok = z.safeParse(evaluateFlagContract.responsesByStatusCode[200], payload);
```

Every schema is exported on its own too, under the name the specification gives it
— `evaluationSuccessSchema`, `bulkEvaluationFailureSchema`, `eventStreamSchema` —
along with its inferred type (`OfrepEvaluationSuccess`, and so on).

## How the schemas are built

**Unknown fields survive.** Every object is a `looseObject`, never `object` or
`strictObject`. OFREP is versioned and still moving, and implementations are told
to ignore what they do not recognise — which they can only do if parsing kept it.
A v0.3.0 client keeps working against a v0.4.0 server.

**A success is a six-way union.** `evaluationSuccess` is `oneOf` boolean, string,
integer, float, object, and _code default_. The last one is distinguished by the
absence of `value`, which the contract enforces with `optional(never())` rather
than by ordering the union. Without that, any payload whose `value` matched none
of the typed branches — `value: null`, say — would fall through and be reported to
the caller as "use your hard-coded default".

**`type: object` excludes arrays**, and `z.record` agrees — it rejects an array
and a null rather than coercing either into an object, so `metadata` and object
flag values need no guard beyond the record itself. The tempting loosening is
`z.unknown()` for "any JSON"; that would admit both and quietly widen what the
protocol says a flag can hold, which is why the exclusion is asserted.

**Zod Mini rather than Zod classic.** The functional API tree-shakes: a consumer
that imports one schema does not pull in every checker Zod ships. The cost is no
method chaining — `z.optional(z.string())` and `z.string().check(z.minLength(1))`
in place of `z.string().min(1).optional()`. Both compile to the same Standard
Schema, so `@toad-contracts/core` neither knows nor cares which was used.

**Event streams are exclusive.** `eventStream` carries either `url` or `endpoint`,
never both. Each arm of the union declares the other field `optional(never())`, so
supplying both fails instead of quietly matching whichever arm came first.

## Grounded on the document

A transcription's real failure mode is the source changing underneath it, and
upstream has no version to depend on: the OpenAPI document lives on a branch of
[`open-feature/protocol`][protocol], with no tags, no releases and no npm
package. So `spec/` holds a byte-for-byte copy of it at a recorded commit, and
three guards keep the two in step ([ADR 0009](../../docs/adr/0009-vendored-ofrep-spec.md)):

| Guard                            | Catches                                                      | Runs                       |
| -------------------------------- | ------------------------------------------------------------ | -------------------------- |
| `test/spec-*.test.ts`            | A schema, route, parameter or example that no longer matches | `pnpm test`, offline       |
| `pnpm spec:check`                | Upstream having moved on                                     | Weekly in CI, or on demand |
| `spec/provenance.json` checksums | A vendored document edited to make a test pass               | `pnpm test`, offline       |

The checks are read out of the document rather than written down beside it: the
component map is exhaustive by test, every example in the document is parsed by
the schema that would receive it on the wire, and both sides of every shape
comparison go through the same JSON Schema normaliser. A property added upstream,
an enum value renamed, a seventh flag type, a new query parameter — each fails a
test that nobody had to think to write.

Updating to a newer revision is `pnpm --filter @kurenwimpel/ofrep run spec:sync`
followed by the test run; [`spec/README.md`](spec/README.md) maps each possible
failure to where it is reconciled.

[protocol]: https://github.com/open-feature/protocol

## Where this deviates from the document

Three places, all deliberate — and each one pinned by a test against the vendored
copy, so it stays a deviation from a known baseline rather than becoming drift.

1. **`flagNotFound` is accepted inside a bulk `flags` array.** The specification
   types those items as `oneOf: [evaluationSuccess, evaluationFailure]` and leaves
   `FLAG_NOT_FOUND` out of `evaluationFailure`'s error codes — yet its own bulk
   example returns an entry carrying exactly that code. The two cannot both be
   honoured; the contract sides with the example, since that is what a server
   implementer will have copied.
2. **A path-parameter `key` must be non-empty.** The document types it as a bare
   string. An empty one does not address the single-flag route, it addresses the
   bulk route.
3. **`retry-after` is a string.** The document types the 429 header as a
   `date-time`, but HTTP defines it as either a delay in seconds or an HTTP-date,
   and it is never a JSON number.

Two more sharp edges are faithful to the document rather than deviations, and are
worth knowing before implementing:

- **`targetingKey` is required.** OpenFeature itself treats it as optional. A
  client that evaluates without a subject still has to send one.
- **`flagConfigLastModified` is typed as a number or an ISO 8601 string**, but it
  travels on the query string, which carries neither. A server reads
  `"1771622898"` and has to coerce before validating.

## Serving kurenwimpel flags over OFREP

Nothing here maps the two together — that is the implementation this contract is
meant to guide — but the core's model is now shaped to cross this wire by
construction (see [ADR 0003](../../docs/adr/0003-ofrep-shaped-model.md)). The
seams that used to need discovering are closed or pinned:

### Reasons

Every reason the protocol can name is spelled identically in
`EvaluationReason`; the two it cannot name have a canonical mapping, shipped by
the core as `toOfrepReason`:

| kurenwimpel           | OFREP             | Note                                                    |
| --------------------- | ----------------- | ------------------------------------------------------- |
| `STATIC`              | `STATIC`          |                                                         |
| `TARGETING_MATCH`     | `TARGETING_MATCH` |                                                         |
| `SPLIT`               | `SPLIT`           |                                                         |
| `DISABLED`            | `DISABLED`        |                                                         |
| `NOT_ALLOCATED`       | `STATIC`          | Outside the traffic allocation; the default was served. |
| `PREREQUISITE_FAILED` | `DISABLED`        | A kill switch upstream of the flag closed it.           |
| `ERROR`               | —                 | Not a wire reason. Becomes an `evaluationFailure` body. |

### Error codes

Mapped by the core's `toOfrepErrorCode`:

| kurenwimpel             | OFREP                                |
| ----------------------- | ------------------------------------ |
| `FLAG_NOT_FOUND`        | 404 `flagNotFound` body              |
| `INVALID_DEFINITION`    | `PARSE_ERROR`                        |
| `TARGETING_KEY_MISSING` | `TARGETING_KEY_MISSING`              |
| `VARIANT_NOT_FOUND`     | `GENERAL`                            |
| `PROVIDER_NOT_READY`    | 500 `generalErrorResponse`           |
| `TYPE_MISMATCH`         | — resolved in the provider, not here |

The last one is not an omission. OFREP returns a value in its natural JSON type
and the calling SDK compares it against what the call site asked for, so a server
never reports a type mismatch.

### Values

`FlagValue` in the core is `boolean | string | number | JsonObject` — exactly
the arms of the `evaluationSuccess` union. A top-level `null` or array, which
has no wire representation here, is rejected by the core's parser with an error
that says why, so an unserveable flag cannot exist by the time a server would
have to serve it.

### Context

One shape on both sides: the core's `EvaluationContext` is flat, with
`targetingKey` alongside the attributes, and attribute values admit any JSON —
the same latitude this contract gives the `context` object. A request body's
context is a core context; no mapping, no dropped attributes.

```ts
// OFREP wire and @kurenwimpel/core alike
{ targetingKey: 'u1', plan: 'pro' }
```

## What is not here

No provider, no server, no client. Specifically absent:

- an OFREP-backed `FlagProvider` for `@kurenwimpel/node`
- a request handler serving `@kurenwimpel/core` evaluations over these routes
- an OpenFeature JS SDK `Provider`, which is the _in-process_ standard rather than
  this HTTP one

The contract is the shared definition each of those would be built against.
