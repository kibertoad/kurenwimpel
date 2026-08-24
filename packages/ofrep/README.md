# @kurenwimpel/ofrep

The **OpenFeature Remote Evaluation Protocol** (OFREP) as an executable contract.

OFREP is the vendor-neutral HTTP layer between an OpenFeature provider and a flag
management system. Implement it and every community-maintained OFREP provider can
talk to you; no bespoke SDK, no per-language client.

This package is a transcription of the [OFREP OpenAPI document][spec] (v0.3.0)
into [toad-contracts][toad] routes and [valibot][valibot] schemas. It is a
specification, not an implementation: it describes both sides of the wire and
implements neither. It also does not depend on `@kurenwimpel/core`, so it stays
usable as a plain OFREP contract.

[spec]: https://github.com/open-feature/protocol/blob/main/service/openapi.yaml
[toad]: https://github.com/kibertoad/toad-contracts
[valibot]: https://valibot.dev

## Routes

| Contract                    | Route                                | Shape                                                |
| --------------------------- | ------------------------------------ | ---------------------------------------------------- |
| `evaluateFlagContract`      | `POST /ofrep/v1/evaluate/flags/:key` | Server-side. One flag, context supplied per request. |
| `evaluateFlagsBulkContract` | `POST /ofrep/v1/evaluate/flags`      | Client-side. All flags, one static context, ETagged. |

Both are exported individually and together as `OFREP_CONTRACTS`.

```ts
import { describeApiContract } from '@toad-contracts/core';
import { safeParse } from 'valibot';
import { evaluateFlagContract } from '@kurenwimpel/ofrep';

describeApiContract(evaluateFlagContract); // 'POST /ofrep/v1/evaluate/flags/:key'
evaluateFlagContract.pathResolver({ key: 'new-checkout' }); // '/ofrep/v1/evaluate/flags/new-checkout'

const body = safeParse(evaluateFlagContract.requestBodySchema, await request.json());
const ok = safeParse(evaluateFlagContract.responsesByStatusCode[200], payload);
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

**`type: object` excludes arrays.** valibot's `record` disagrees: it accepts
`[1, 2]` and silently rewrites it to `{ "0": 1, "1": 2 }`. A `check` cannot catch
that, because it runs on the already-rewritten output. So `metadata` and object
flag values are guarded _before_ `record` sees the input.

**Event streams are exclusive.** `eventStream` carries either `url` or `endpoint`,
never both. Each arm of the union declares the other field `optional(never())`, so
supplying both fails instead of quietly matching whichever arm came first.

## Where this deviates from the document

Three places, all deliberate.

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
meant to guide — but the seams are known, and none of them is discovered
comfortably halfway through.

### Reasons

`EvaluationReason` from `@kurenwimpel/core` does not line up one-to-one.

| kurenwimpel       | OFREP             | Note                                                      |
| ----------------- | ----------------- | --------------------------------------------------------- |
| `DISABLED`        | `DISABLED`        |                                                           |
| `TARGETING_MATCH` | `TARGETING_MATCH` |                                                           |
| `SPLIT`           | `SPLIT`           |                                                           |
| `DEFAULT`         | `STATIC`          | OFREP has no `DEFAULT`; `UNKNOWN` is the other candidate. |
| `ERROR`           | —                 | Not a wire reason. Becomes an `evaluationFailure` body.   |

### Error codes

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

`FlagValue` in the core is `JsonValue`, which includes `null` and arrays. OFREP's
`oneOf` covers boolean, string, integer, float, and object — **arrays and `null`
have no representation on the wire.** A flag serving `[1, 2, 3]` cannot be
expressed. An implementation has to choose: reject such flags when the ruleset is
parsed, wrap the value in an object, or omit the flag from bulk responses with an
`evaluationFailure`.

### Context

The two shapes are not the same. OFREP is flat, with `targetingKey` alongside the
attributes; the core nests them under `attributes`:

```ts
// OFREP wire
{ targetingKey: 'u1', plan: 'pro' }
// @kurenwimpel/core
{ targetingKey: 'u1', attributes: { plan: 'pro' } }
```

The core also narrows attribute values to
`string | number | boolean | string[] | number[]`, where OFREP allows any JSON.
Anything else has to be dropped or rejected on the way in.

## What is not here

No provider, no server, no client. Specifically absent:

- an OFREP-backed `FlagProvider` for `@kurenwimpel/node`
- a request handler serving `@kurenwimpel/core` evaluations over these routes
- an OpenFeature JS SDK `Provider`, which is the _in-process_ standard rather than
  this HTTP one

The contract is the shared definition each of those would be built against.
