# The vendored OFREP specification

`openapi.yaml` and `event-streams.yaml` are byte-for-byte copies of
[`open-feature/protocol`][protocol] `service/*.yaml`, taken at the commit
recorded in `provenance.json`. Nothing in this directory is written or edited by
hand — `scripts/sync-spec.mjs` writes all three files.

[protocol]: https://github.com/open-feature/protocol

## Why they are vendored

The protocol repository publishes no tags, no releases, and no npm package: the
OpenAPI document on `main` is the whole artefact. (`@openfeature/ofrep-core` on
npm is an implementation, and its hand-written interfaces are looser than the
document — `key`, `value` and `reason` are all optional there — so grounding on
it would weaken this contract rather than pin it.) A commit sha and a checksum
are therefore the only way to say which revision `src/` was transcribed from,
and the only way to notice when that revision stops being current.

That gives two kinds of drift, each with its own guard:

| Drift                                        | Caught by                                   | When                    |
| -------------------------------------------- | ------------------------------------------- | ----------------------- |
| The contract stops matching the document     | `test/spec-*.test.ts`, offline              | Every `pnpm test`       |
| The document moves on                        | `pnpm spec:check`, needs network            | Weekly in CI, on demand |
| A vendored file is edited to make tests pass | The checksum test against `provenance.json` | Every `pnpm test`       |

## What reads them

| File                       | Checks                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `spec-conformance.test.ts` | Every `components/schemas` entry against the schema in `src/` that stands for it.  |
| `spec-operations.test.ts`  | Paths, methods, status codes, bodies per status, parameters, headers, tags.        |
| `spec-examples.test.ts`    | Every example payload in the document, parsed by the schema that would receive it. |

The comparison is structural — properties, requiredness, types, enum values —
and ignores descriptions, examples, formats and bounds, so the contract stays
free to be stricter than the document where it has a reason to be. Each such
deviation is listed in the package README and pinned by a test.

## Updating to a newer upstream revision

```sh
# Refresh to the current tip of main…
pnpm --filter @kurenwimpel/ofrep run spec:sync
# …or pin a specific commit, branch or tag.
pnpm --filter @kurenwimpel/ofrep run spec:sync --ref=<sha>
```

Then:

1. **Read what changed.** `git diff packages/ofrep/spec` — the YAML diff is the
   whole story; `provenance.json` just records where it came from.
2. **Run the tests.** `pnpm --filter @kurenwimpel/ofrep test`. The failures are
   the work list, and each names its own fix:

   | Failing test                                    | What upstream did                                                        | Where to reconcile it                                          |
   | ----------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------- |
   | `component schemas > are all accounted for`     | Added, renamed or removed a schema                                       | `test/component-registry.ts`, plus a schema in `src/`          |
   | `<name> is transcribed with the shape…`         | Changed a property, requiredness, type or enum                           | The matching schema in `src/`                                  |
   | `operations > …`                                | Changed a route, status, parameter or header                             | `src/contracts.ts`, `src/http.ts`                              |
   | `the examples in the document > … parses`       | Published a payload the schemas reject                                   | Usually `src/`; occasionally the document is wrong (see below) |
   | `the fixtures the rest of the suite parses > …` | Edited an example                                                        | Copy the new example into `test/fixtures.ts`                   |
   | `the vendored documents > are the bytes…`       | Nothing — a vendored file was hand-edited, or `provenance.json` is stale | Re-run `spec:sync`                                             |

3. **Bump the revision if it moved.** If `info.version` changed, update
   `OFREP_PROTOCOL_VERSION` in `src/common.ts`; the version, the package
   description and the READMEs all name it.
4. **Record decisions, not just diffs.** A deviation added or dropped belongs in
   the package README's _Where this deviates from the document_ section; a change
   that is a judgement call rather than a transcription belongs in
   [`docs/adr`](../../../docs/adr/README.md).
5. **Commit `spec/` together with the code that reconciles it.** A refreshed
   document that `src/` has not caught up with is exactly the state this
   directory exists to make impossible.

An example the schemas reject is worth a second look before "fixing" `src/`: the
document contradicts itself in at least one place today (its bulk example returns
a `FLAG_NOT_FOUND` entry that its own `oneOf` cannot produce), and that
contradiction was found this way. Siding with the example, and pinning both
halves in a test, is a legitimate outcome.

## Not vendored

The protocol repository also carries prose that shapes the contract but cannot be
machine-checked: [`guideline/`][guideline] for provider behaviour and
[`service/adrs/`][adrs] for the decisions behind the document — ADR-0008, which
introduced event streams, is the one `src/event-stream.ts` refers to. Read those
from upstream; there is nothing here to compare them against.

[guideline]: https://github.com/open-feature/protocol/tree/main/guideline
[adrs]: https://github.com/open-feature/protocol/tree/main/service/adrs
