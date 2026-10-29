# kurenwimpel

A simple feature flag solution for backend services.

Evaluation is a pure function over data. That core knows nothing about where its
flags came from or what runtime it is on; each platform gets a thin wrapper that
supplies a `FlagProvider` and nothing else.

## The name

<p align="center">
  <img src="docs/kurenwimpel.svg" alt="A Kurenwimpel: a checkered home plate on a mast, extended by a carved wooden village scene" width="560">
</p>

A Kurenwimpel (Lithuanian _vėtrungė_) is the carved, painted wooden vane at the
masthead of a _Kurenkahn_, the flat-bottomed sailing boat fishermen used on the
Curonian Lagoon. In 1844 the Prussian authorities required every boat to fly a
plate in the colours of its home village, so an inspector could tell from the
shore whether a boat was fishing in waters it had a right to. Fishermen soon
extended the plates with carved scenes of home: houses, churches, trees, boats,
elks. The vanes are now the emblem of the Curonian Spit and are still made in
Nida and Klaipėda.

A feature flag does the same job in a service. The vane told an inspector which
rules applied to the boat that carried it; a flag tells the code which behaviour
applies to the request, user or tenant in front of it.

## Layout

| Package                   | Directory             | What it is                                                       |
| ------------------------- | --------------------- | ---------------------------------------------------------------- |
| `@kurenwimpel/core`       | `packages/core`       | Runtime-agnostic engine. Zero dependencies, no platform globals. |
| `@kurenwimpel/cli`        | `packages/cli`        | The `kurenwimpel` command: validate, diff, explain and publish.  |
| `@kurenwimpel/cloudflare` | `packages/cloudflare` | Workers wrapper: KV-backed provider, isolate-scoped client.      |
| `@kurenwimpel/node`       | `packages/node`       | Node wrapper: file and HTTP providers, polling client.           |
| `@kurenwimpel/ofrep`      | `packages/ofrep`      | The OpenFeature remote evaluation protocol, as an API contract.  |

Both wrappers re-export the core, so a service only ever imports one package.
`@kurenwimpel/ofrep` stands apart from all three: it is a specification rather than
an implementation, and depends on none of them.

The core's source is grouped by role — `model/` (domain types), `evaluation/`
(pure decision functions), `parsing/` (validation for untrusted JSON), and
`runtime/` (snapshots, providers, the client). The design decisions behind the
engine — and the alternatives from LaunchDarkly, Split, and Flagsmith that were
considered and rejected — are recorded in [`docs/adr`](docs/adr/README.md).

## Toolchain

pnpm 11 workspaces, Turborepo, oxlint (type-aware, via `oxlint-tsgolint`), oxfmt,
TypeScript 7, Vitest. ESM only.

```sh
pnpm install
pnpm run check       # format:check + lint + typecheck + test
pnpm run build
pnpm run format      # rewrite with oxfmt
pnpm run lint:fix
pnpm run pack:check  # publint + attw against each packed tarball
```

`pnpm run lint` is type-aware and therefore slower; `pnpm run lint:quick` runs the
syntax-only pass.

Each package carries two TypeScript configs. `tsconfig.json` is the whole program
— sources, tests, and config files — and is what editors and the type-aware linter
discover. `tsconfig.build.json` narrows to `src/` and is the only one that emits.

The linter enforces size budgets: 300 lines per file, 60 per function, 4
parameters, 4 levels of nesting. Blank lines and comments do not count, so
documenting a function never pushes it over. `describe` blocks are exempt from the
per-function budget — they group tests rather than doing work — but test files are
still held to the file-size limit.

### Testing

Core and Node tests run under Node. Cloudflare tests run **inside workerd** via
`@cloudflare/vitest-pool-workers`, against the KV binding declared in
`packages/cloudflare/wrangler.toml` — the provider is exercised against a real KV
implementation rather than a stub. A guard assertion fails the suite if it ever
falls back to a Node environment.

`packages/cloudflare/worker-configuration.d.ts` holds the Workers runtime types and
is generated, not written by hand. It is committed so a fresh clone typechecks
without codegen. Regenerate it after editing `wrangler.toml`:

```sh
pnpm --filter @kurenwimpel/cloudflare run cf-typegen
```

### Mutation testing

Stryker measures how much of each suite actually bites — it mutates the source
and counts which mutants the tests kill:

```sh
pnpm run test:mutation                             # every package, sequentially
pnpm --filter @kurenwimpel/core run test:mutation  # one package
```

The HTML report lands in `packages/<name>/reports/mutation/`. Core and node run
incrementally (`reports/stryker-incremental.json`), so a re-run only tests what
changed — with one caveat: a _static_ mutant (one in a top-level initialiser)
keeps its old verdict even when a new test targets it, so delete the incremental
file when the score itself is the point. The Cloudflare package is not mutated:
its tests run inside workerd, which Stryker's vitest runner cannot drive.

### Releasing

Versions and changelogs are managed with [Changesets](https://changesets.dev). A PR
that changes what a published package does carries a changeset describing it:

```sh
pnpm changeset   # pick the packages and the bump, then write the changelog entry
```

This writes a Markdown file under `.changeset/`, committed with the PR. Internal
changes (tests, CI, docs) need none.

On `main`, `.github/workflows/release.yml` collects pending changesets into a
"Version packages" PR that bumps versions and writes each `CHANGELOG.md`. Merging
that PR publishes every bumped package to npm through
[trusted publishing](https://docs.npmjs.com/trusted-publishers): the registry
accepts the workflow's OIDC token, so the repository holds no npm token, and each
release carries a provenance attestation.

Internal dependencies are declared as `workspace:^`, which `pnpm publish` rewrites
to a caret range on the current version. While the packages are below 1.0, a minor
bump of `@kurenwimpel/core` therefore also releases the packages that depend on it.

A new package can't be published by the workflow until it exists on npm. Publish
its first version by hand, then add `kibertoad/kurenwimpel`, workflow
`release.yml` and environment `npm` as its trusted publisher on npmjs.com.

## Concepts

A **flag** has named **variants** mapping to values. A variant value is a
boolean, string, finite number, or JSON object — the exact set OFREP can carry
on the wire; a `rate-limit` flag can serve `{ "perMinute": 600 }`. Which variant
a caller gets is decided, in order:

1. `enabled: false` → `offVariant`. The kill switch; nothing else is consulted.
2. A failed **prerequisite** → `offVariant`. Each entry names another flag and
   the variants that satisfy it; the dependency must be enabled and serving one
   of them, for this same context. A closed gate upstream closes everything
   under it.
3. An **individual target** listing the context's `targetingKey` → its variant.
   QA accounts and demo tenants get pinned here, above every percentage.
4. Outside the **traffic allocation** → `defaultVariant`, reason
   `NOT_ALLOCATED`. `allocation: { percent: 20 }` admits 20% of traffic into
   the rules and rollouts; everyone else never reaches them.
5. The first **rule** whose conditions all match → its `rollout`, else its
   `variant`. That first match decides; nothing below it is consulted, so a rule
   whose rollout is parked at zero serves `defaultVariant` rather than handing
   the subject to the next rule — or falling back to a fixed `variant` the same
   rule happens to declare.
6. The flag's own `rollout`, if no rule matched.
7. `defaultVariant`, reason `STATIC`.

The **context** is flat, the same shape OpenFeature and OFREP use on the wire:

```ts
{ targetingKey: user.id, plan: 'pro', appVersion: '2.4.1', roles: ['admin'] }
```

A **rollout** is a weighted split bucketed on the `targetingKey`. Weights are
relative, so `[{on, 1}, {off, 3}]` is 25/75. The object form adds two knobs:

```json
"rollout": {
  "bucketBy": "accountId",
  "seed": "iteration-2",
  "buckets": [{ "variant": "on", "weight": 50 }, { "variant": "off", "weight": 50 }]
}
```

`bucketBy` hashes an attribute instead of the targeting key, so a whole
account flips together. `seed` re-randomises this one split — a fresh draw for
an experiment's next iteration — without touching anything else.

The allocation gate is a separate draw and hashes the targeting key by default,
which admits an account's users independently even where assignment clusters
them. An experiment that has to take or leave whole accounts gives the gate the
same attribute: `allocation: { percent: 20, bucketBy: "accountId" }`.

A **segment** is a named, reusable audience: explicit `included` / `excluded`
key lists (compiled to hash sets, so a hundred-thousand-key list costs one
probe) plus condition rules. Flags reference segments with the `inSegment` /
`notInSegment` operators. Exclusion always wins — an excluded key is out no
matter what the rules say — and membership never nests, so it can never cycle.

Bucketing is MurmurHash3 over an injectively encoded domain tuple plus the
targeting key, with domains derived from a per-flag salt. Four consequences
worth relying on:

- The same subject always lands in the same bucket, on every runtime and in every
  process — no coordination needed between a Worker at the edge and a Node service.
- Widening an allocation only ever adds subjects. Ramping `percent` 20 → 50
  never takes someone back out, and never reassigns anyone already inside.
- A rollout is monotone the same way **as long as its weights still add up to
  the same total**, because a split is normalised by that sum: `[on 20, off 80]`
  → `[on 50, off 50]` only moves subjects into `on`, but bumping `on` to 50 and
  leaving `off` at 80 re-scales every boundary and reshuffles the population.
  Ramping exposure is the allocation gate's job, not the weights' — see
  [ADR 0005](docs/adr/0005-traffic-allocation.md).
- Allocation and assignment are independent draws: the 20% admitted to an
  experiment still split 50/50, not "the users who would have gotten treatment
  anyway".

### Example definition

```json
{
  "key": "new-checkout",
  "enabled": true,
  "variants": { "on": true, "off": false },
  "defaultVariant": "off",
  "offVariant": "off",
  "metadata": { "experiment": "checkout-q3" },
  "prerequisites": [{ "flag": "new-backend", "variants": ["on"] }],
  "targets": [{ "variant": "on", "keys": ["qa-account-1"] }],
  "allocation": { "percent": 20 },
  "rules": [
    {
      "id": "internal-staff",
      "conditions": [{ "operator": "inSegment", "segments": ["employees"] }],
      "variant": "on"
    },
    {
      "id": "recent-app",
      "conditions": [{ "attribute": "appVersion", "operator": "semverGte", "value": "2.4.0" }],
      "rollout": [
        { "variant": "on", "weight": 50 },
        { "variant": "off", "weight": 50 }
      ]
    }
  ]
}
```

A ruleset payload is an array of flags, a key-to-definition object, or the
document form `{ "flags": [...], "segments": [...] }` once segments are in play.

`@kurenwimpel/core/ruleset.schema.json` is a JSON Schema for all three shapes.
Point a document at it with `"$schema"` for editor completion, or validate with it
in CI. The document form also takes an optional `schemaVersion`; see
[ADR 0010](docs/adr/0010-ruleset-schema.md) for when it changes.

```json
{
  "$schema": "https://unpkg.com/@kurenwimpel/core/schema/ruleset.schema.json",
  "schemaVersion": 1,
  "flags": [],
  "segments": []
}
```

Operators: `exists`, `notExists`, `eq`, `neq`, `in`, `notIn`, `contains`,
`startsWith`, `endsWith`, `gt`, `gte`, `lt`, `lte`, `semverEq`, `semverGt`,
`semverGte`, `semverLt`, `semverLte`, `inSegment`, `notInSegment`.

Array-valued attributes are matched as sets by the equality and set operators,
so `roles: ["admin", "billing"]` satisfies `eq: "admin"` and `in: ["admin"]` and
fails `neq: "admin"` and `notIn: ["admin"]` — a rule written to exclude a cohort
never targets it. Each element is read the way the operator reads a single value,
so `roles: ["administrator"]` satisfies `contains: "admin"`, exactly as
`roles: "administrator"` does. The ordering operators (`gt`, `lt`, the `semver*`
family) and the anchored string ones (`startsWith`, `endsWith`) have no set
reading and simply do not match a compound attribute.

`targetingKey` is the one attribute conditions read through the same identity
rule bucketing uses, so it compares as the string it is bucketed as: a context
carrying `targetingKey: 42` satisfies both `eq: 42` and `eq: "42"`.

Everything fails closed: a missing attribute, a wrong type, an unknown segment,
or an operator from a newer control plane matches nothing.

## Usage

### Node

```ts
import { HttpFlagProvider, PollingFlagClient } from '@kurenwimpel/node';

const flags = new PollingFlagClient({
  provider: new HttpFlagProvider({ url: process.env.FLAGS_URL! }),
  pollIntervalMs: 30_000,
  defaultContext: { service: 'billing' },
  onError: (error, info) => logger.warn({ error, ...info }, 'flag refresh failed'),
  onImpression: (event) => analytics.enqueue(event), // exposure feed for A/B analysis
});

await flags.start(); // throws if the first load fails

// Synchronous from here on: no I/O, no throwing.
if (flags.getBoolean('new-checkout', false, { targetingKey: user.id, plan: user.plan })) {
  // ...
}
```

`FileFlagProvider` is the alternative for flags shipped with the deployment or
mounted from a ConfigMap.

### Cloudflare Workers

```ts
import { KvFlagProvider, WorkerFlags } from '@kurenwimpel/cloudflare';

// Module scope: isolates are reused, so this loads once per isolate.
let flags: WorkerFlags | undefined;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    flags ??= new WorkerFlags({
      provider: new KvFlagProvider({ namespace: env.FLAGS, cacheTtlSeconds: 60 }),
    });

    const client = await flags.get(ctx); // refreshes via ctx.waitUntil when stale
    const enabled = client.getBoolean('new-checkout', false, {
      targetingKey: request.headers.get('x-user-id') ?? undefined,
    });

    return new Response(String(enabled));
  },
};
```

Only the first request an isolate serves pays for a load. Later requests read the
in-memory snapshot and hand any refresh to `ctx.waitUntil`, so it never sits on the
response path.

`kurenwimpel publish` writes the ruleset in the layout the provider reads, with
`{ revision: string }` as the KV metadata. The provider uses that revision to skip
re-parsing an unchanged payload, and `kurenwimpel rollback` repoints it at an
earlier revision. See the [CLI README](packages/cli/README.md#publish).

## Running it in production

The control plane is a Git repository. [`examples/gitops`](examples/gitops/README.md)
is a template for one: a `flags/` directory with one complete ruleset per
environment, a `kurenwimpel.config.json` mapping each environment to its publish
target and its approvers, a CODEOWNERS file, and a GitHub Actions workflow that
ties `validate`, `diff` and `publish` together. CI in this repository runs the
template's commands against file targets, so it keeps working as the CLI changes.

End to end:

1. Someone edits `flags/staging.json` and opens a pull request.
2. The workflow validates every environment the change touches. Each issue shows
   as an annotation on the line of the broken flag, and fails the check.
3. A sticky comment shows what the change does to live traffic, environment by
   environment, and says so when it reshuffles a rollout.
4. CODEOWNERS requests a review from the environment's approvers, and branch
   protection requires it.
5. On merge, a job bound to the GitHub environment `staging` publishes the new
   revision with that environment's credentials, once the environment's required
   reviewers, if it has any, approve the deployment.
6. If the publish or a check after it fails, the job prints the
   `kurenwimpel rollback` command, and a manual workflow runs it under the same
   protection.

What this gives you:

- An audit log: every change is a commit with an author, a reviewer and a pull
  request explaining it.
- Approvals per environment, from CODEOWNERS and GitHub environment protection.
- Review of the effect, not the JSON: the diff names widened allocations,
  reshuffled rollouts and rebucketed subjects.
- Rollback without a rebuild to any revision a `kv` or `file` target keeps, and
  `git revert` for the lasting fix.
- No service of its own to run: GitHub, the CLI and the publish target are all of it.

What it does not give you:

- Scheduled changes, such as turning a flag on at a set time. That is
  [#13](https://github.com/kibertoad/kurenwimpel/issues/13).
- A UI for people who do not edit JSON in pull requests. That is
  [#23](https://github.com/kibertoad/kurenwimpel/issues/23).
- Promotion between environments. Each environment publishes as soon as its own
  change merges, in no order relative to the others; copying a change from staging
  to production is a second pull request.
- Drift detection. A publish or rollback run by hand, outside the workflow, is not
  noticed until the next merge to that environment overwrites it.

## Failure behaviour

The design assumption is that a flag lookup must never be the reason a request
fails.

- The **first** load is strict: `init()` / `start()` reject, so a service that
  cannot read its flags at startup should fail to start rather than serving every
  request on fallbacks. A provider answering "unchanged" to that first load —
  a 304 from a caching proxy, say — counts as a failure: there is no snapshot
  behind it to serve.
- **Refreshes** are lenient: failures go to `onError` and the previous snapshot
  keeps serving.
- A **malformed flag or segment** is dropped and reported through
  `onParseIssues`; the rest of the ruleset still loads. A key defined twice
  keeps the first definition and reports the rest, rather than letting array
  order decide which one goes live.
- A **dangling reference** — a prerequisite naming a flag or variant that is not
  in the payload, an `inSegment` naming a segment that is not — is reported but
  kept. Each one already fails closed at evaluation, and dropping the flag would
  answer `FLAG_NOT_FOUND` and send every SDK to its own hardcoded default
  instead.
- A **rule using an operator from a newer control plane** is dropped and
  reported; the rest of the flag or segment still loads. Such a rule matches
  nobody either way, so dropping it decides nothing differently — and it avoids
  the same `FLAG_NOT_FOUND` outage.
- A **document with a newer `schemaVersion`** than the SDK's
  `SUPPORTED_SCHEMA_VERSION` still loads, with one issue at `schemaVersion`.
  Whatever the older SDK cannot read fails closed, and the issue on every
  refresh says the SDK is behind.
- **Per-flag evaluation** never throws. Unknown key, missing variant, wrong
  type, absent targeting key, a prerequisite cycle, or a hand-built definition
  the parser never saw all return the caller's default plus an `errorCode` on
  the `*Details` variant of the getter.
- `evaluateAll()` is the one call that throws, and only before the first load: a
  bulk body has no per-flag slot to report `PROVIDER_NOT_READY` in, and
  answering it with zero flags is indistinguishable from a healthy empty
  ruleset. Check `ready` first if a 5xx is not what you want.
- A throwing `onImpression` hook is reported through `onError` and never fails
  the evaluation.

## Adding a platform

Implement `FlagProvider` and hand it to `FeatureFlagClient`:

```ts
interface FlagProvider {
  readonly name: string;
  // Return null to mean "unchanged"; `previous` enables conditional fetching.
  load(previous?: FlagSnapshot): Promise<FlagSnapshot | null>;
  close?(): Promise<void>;
}
```

`parseRuleset(raw)` from the core does the validation — flags and segments in
one payload — and `createSnapshot` builds the result. That is the whole contract
— see `packages/node/src/file-provider.ts` for the smallest complete example.

## Speaking OpenFeature

`@kurenwimpel/ofrep` is the [OpenFeature Remote Evaluation
Protocol](https://openfeature.dev/docs/reference/other-technologies/ofrep/) written
out as a [toad-contracts](https://github.com/kibertoad/toad-contracts) API contract:
two routes, every request and response body, and the change-notification stream,
as Zod Mini schemas checked against the specification's own examples.

The specification is vendored at a pinned commit in `packages/ofrep/spec` and the
transcription is compared to it schema by schema, route by route and example by
example on every test run, with a weekly CI job watching upstream for movement
([ADR 0009](docs/adr/0009-vendored-ofrep-spec.md)). Updating to a newer revision:

```sh
pnpm --filter @kurenwimpel/ofrep run spec:sync   # then run the tests
pnpm --filter @kurenwimpel/ofrep run spec:check  # is the vendored copy current?
```

OFREP is the HTTP layer between an OpenFeature provider and a flag management
system. Serving it means every community-maintained OFREP provider — in any
language — can read flags from this project without a bespoke SDK.

Nothing implements it yet, but the core's model is OFREP-expressible by
construction ([ADR 0003](docs/adr/0003-ofrep-shaped-model.md)): the context is
the wire's flat shape, variant values exclude what the wire cannot carry, the
reason vocabulary matches where the protocol has names, and `toOfrepReason` /
`toOfrepErrorCode` in the core pin the mapping for the two reasons it does not.
`packages/ofrep/README.md` documents the remaining wire-level sharp edges.
