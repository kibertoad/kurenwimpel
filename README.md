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

| Package                    | Directory              | What it is                                                       |
| -------------------------- | ---------------------- | ---------------------------------------------------------------- |
| `@kurenwimpel/core`        | `packages/core`        | Runtime-agnostic engine. Zero dependencies, no platform globals. |
| `@kurenwimpel/cloudflare`  | `packages/cloudflare`  | Workers wrapper: KV-backed provider, isolate-scoped client.      |
| `@kurenwimpel/node`        | `packages/node`        | Node wrapper: file and HTTP providers, polling client.           |
| `@kurenwimpel/openfeature` | `packages/openfeature` | OpenFeature server provider wrapping any client.                 |
| `@kurenwimpel/ofrep`       | `packages/ofrep`       | The OpenFeature remote evaluation protocol, as an API contract.  |

Both wrappers re-export the core, so a service only ever imports one package.
`@kurenwimpel/openfeature` sits on top of either of them for services that code
against the OpenFeature API. `@kurenwimpel/ofrep` stands apart from the rest: it is
a specification rather than an implementation, and depends on none of them.

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

### Benchmarks

```sh
pnpm run bench                                    # every package, one at a time
pnpm --filter @kurenwimpel/core run bench         # one package
```

Benchmarks are `vitest bench` files. Core's live in `packages/core/bench/`: any
`*.bench.ts` there is picked up, and `fixtures.ts` builds the rulesets they share.
`packages/cloudflare/bench/` times the same snapshot build inside workerd, from
the same fixtures. Retained heap is printed as `retained heap | ... ` lines, from
`bench/heap.ts`.

CI runs them on every pull request and keeps one comment on the PR updated with
the results. The job never fails a PR: shared runners are too noisy for a
threshold, so read the numbers as a trend.

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

`HttpFlagProvider` refuses a response body larger than `maxBytes` (10 MiB by
default) before parsing it: up front when `Content-Length` says so, and otherwise
as soon as the body read passes the limit. See [Limits](#limits) for what a
ruleset of that size costs.

To keep booting while the control plane is down, give the provider a store for
the last ruleset that loaded (see [Failure behaviour](#failure-behaviour)):

```ts
import { FileLastKnownGoodStore, HttpFlagProvider } from '@kurenwimpel/node';

const provider = new HttpFlagProvider({
  url: process.env.FLAGS_URL!,
  lastKnownGood: new FileLastKnownGoodStore({ path: '/var/lib/billing/flags.json' }),
});
```

### Health and metrics

`client.status()` reports how fresh the served snapshot is:

| Field                  | Meaning                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `ready`                | A snapshot has been installed.                                                                           |
| `origin`               | `'live'`, or `'fallback'` while a last-known-good copy or `bootstrap` is served.                         |
| `snapshotVersion`      | The served snapshot's revision or ETag.                                                                  |
| `snapshotBuiltAt`      | When the served snapshot was built. It stays put while the provider answers 304.                         |
| `lastSuccessfulLoadAt` | The last load that installed a live snapshot or confirmed the current one unchanged.                     |
| `lastFailedLoadAt`     | The last load that failed or booted from a fallback.                                                     |
| `consecutiveFailures`  | Failed loads since the last successful one.                                                              |
| `totalLoadFailures`    | Failed loads over the client's lifetime.                                                                 |
| `lastParseIssueCount`  | Parse issues in the served snapshot. A custom provider reports them through `context.reportParseIssues`. |

Alert on `lastSuccessfulLoadAt`, not `snapshotBuiltAt`: a healthy client whose
control plane answers 304 keeps its old snapshot, so the build time keeps aging
while the client is perfectly fresh. A readiness probe built on it:

```ts
const MAX_STALENESS_MS = 5 * 60_000;

app.get('/ready', (_request, reply) => {
  const status = flags.status();
  const fresh =
    status.lastSuccessfulLoadAt !== undefined &&
    Date.now() - status.lastSuccessfulLoadAt < MAX_STALENESS_MS;
  reply.code(status.ready && fresh ? 200 : 503).send(status);
});
```

`onSnapshotChange(snapshot, previous)` is called whenever a new snapshot replaces
the served one, with `previous` undefined on the first install. Code that wraps a
client it did not construct registers the same hook with
`client.subscribe({ onSnapshotChange, onLoad })`, where `onLoad(result)` runs once
per load with `installed`, `unchanged` or `failed`, after `status()` reflects it.
`subscribe` returns a function that removes the listener.

The `metrics` option takes a sink whose `record(flagKey, variant, reason,
errorCode)` is called once per evaluation, including each flag of
`evaluateAll()`. No event object is built for it, so it is cheaper than
`onImpression`. `CountingMetrics` counts in memory, and `collect()` returns the
counts since the previous call:

```ts
import { CountingMetrics, PollingFlagClient } from '@kurenwimpel/node';

const usage = new CountingMetrics();
const flags = new PollingFlagClient({ provider, metrics: usage });

setInterval(() => report(usage.collect()), 60_000);
```

`@kurenwimpel/node/opentelemetry` feeds the same data to OpenTelemetry. It needs
`@opentelemetry/api`, an optional peer dependency that the main entry never
loads.

```ts
import { metrics } from '@opentelemetry/api';
import { OpenTelemetryMetrics } from '@kurenwimpel/node/opentelemetry';

const otel = new OpenTelemetryMetrics(metrics.getMeter('billing'));
const flags = new PollingFlagClient({ provider, metrics: otel });
otel.observe(flags);
```

| Instrument           | Kind               | Attributes                                                                                    |
| -------------------- | ------------------ | --------------------------------------------------------------------------------------------- |
| `flag.evaluations`   | counter            | `feature_flag.key`, `feature_flag.result.variant`, `feature_flag.result.reason`, `error.type` |
| `flag.snapshot.age`  | gauge, seconds     | `feature_flag.provider.name`; age measured from `lastSuccessfulLoadAt`                        |
| `flag.load.failures` | observable counter | `feature_flag.provider.name`; reads `totalLoadFailures`                                       |

Reasons and error codes are reported lowercased (`targeting_match`,
`flag_not_found`), as the feature-flag semantic conventions spell them.

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

A failed first load does not fail the request. `get()` resolves to a client whose
getters return the caller's default, and the next attempt waits `retryAfterMs`.
To serve real flags through a KV outage instead, pass a ruleset bundled at build
time as `bootstrap`:

```ts
import bootstrap from './flags.json';

flags ??= new WorkerFlags({
  provider: new KvFlagProvider({ namespace: env.FLAGS, timeoutMs: 500 }),
  bootstrap,
});
```

| Option                        | Default            | Effect                                                                                                                             |
| ----------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `KvFlagProvider` `timeoutMs`  | `1000`             | Fails a KV read that takes longer. The read is abandoned, since KV's `get` takes no `AbortSignal`.                                 |
| `KvFlagProvider` `maxBytes`   | 10 MiB             | Fails the load when the KV value is larger. The value is streamed and the read stops at the limit, so it is never parsed.          |
| `WorkerFlags` `onInitFailure` | `'serve-defaults'` | `'throw'` makes `get()` reject while no snapshot has loaded, for services that would rather fail closed.                           |
| `WorkerFlags` `retryAfterMs`  | `5000`             | Wait after a failed first load before the next request tries again; also the refresh interval while a fallback snapshot is served. |
| `WorkerFlags` `bootstrap`     | none               | Raw ruleset installed with `origin: 'fallback'` when the first load fails.                                                         |

Stamp `{ revision: string }` as the KV metadata when writing the ruleset — the
provider uses it to skip re-parsing an unchanged payload.

## Failure behaviour

The design assumption is that a flag lookup must never be the reason a request
fails.

- The **first** load is strict: `init()` / `start()` reject, so a service that
  cannot read its flags at startup should fail to start rather than serving every
  request on fallbacks. A provider answering "unchanged" to that first load (a
  304 from a caching proxy, say) counts as a failure: there is no snapshot
  behind it to serve.
- A provider given a **last-known-good store** softens that first load. Every
  ruleset that loads is written to the store, and when the first load fails the
  provider boots from the stored copy instead. The client comes up `ready`,
  `snapshot.origin` reads `'fallback'`, `snapshot.fetchedAt` is when the stored
  copy was fetched, and the original error still goes to `onError`. The first
  successful refresh replaces it, and a 304 or "unchanged" answer against it
  re-marks the same snapshot `'live'`. An empty, unreadable or corrupt store
  changes nothing: `init()` rejects with the original error. A failed write is
  reported through `onError` with operation `'store'` and never fails a load.
  A stored ruleset has no age limit, so alert on `origin` if an old kill switch
  must not come back after a long outage.
- On **Workers**, `WorkerFlags` never lets that first load fail a request. A
  failed cold load is reported through `onError` once, `get()` resolves to the
  not-ready client (its getters answer with the caller's default and
  `PROVIDER_NOT_READY`), and requests skip the load until `retryAfterMs` has
  passed instead of each paying for a KV round trip. With `bootstrap` set, that
  ruleset is served as an `origin: 'fallback'` snapshot instead, and is refreshed
  every `retryAfterMs` until a live load replaces it. `onInitFailure: 'throw'`
  rejects `get()` instead when there is no bootstrap. A KV read slower than the
  provider's `timeoutMs` counts as a failed load.
- **Refreshes** are lenient: failures go to `onError` and the previous snapshot
  keeps serving.
- A payload larger than the provider's **`maxBytes`** is a failed load, like an
  unreachable source: it is never parsed, and a last-known-good store or
  `bootstrap` covers it the same way.
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
- **Per-flag evaluation** never throws. Unknown key, missing variant, wrong
  type, absent targeting key, a prerequisite cycle, or a hand-built definition
  the parser never saw all return the caller's default plus an `errorCode` on
  the `*Details` variant of the getter.
- `evaluateAll()` is the one call that throws, and only before the first load: a
  bulk body has no per-flag slot to report `PROVIDER_NOT_READY` in, and
  answering it with zero flags is indistinguishable from a healthy empty
  ruleset. Check `ready` first if a 5xx is not what you want.
- A throwing `onImpression` hook or `metrics` sink is reported through `onError`
  and never fails the evaluation. A throwing `onSnapshotChange` is reported the
  same way, and the snapshot is installed regardless. So is a throwing
  `subscribe` listener, under the operation `listener`; the other listeners still
  run.

## Limits

The whole ruleset lives in memory in every process and every Worker isolate, and
an isolate parses it on the request path of its first request. These limits come
from the platform and from the benchmarks in this repo.

| Limit                                              | Value  | Source                                                                          |
| -------------------------------------------------- | ------ | ------------------------------------------------------------------------------- |
| Workers KV value size                              | 25 MiB | [Cloudflare](https://developers.cloudflare.com/kv/platform/limits/)             |
| Workers memory per isolate                         | 128 MB | [Cloudflare](https://developers.cloudflare.com/workers/platform/limits/#memory) |
| `maxBytes` on `HttpFlagProvider`, `KvFlagProvider` | 10 MiB | Default; pass `maxBytes` to change it                                           |

Measured on 2026-10-29 on an Intel Core Ultra 9 285HX (24 logical cores, 63 GiB),
Windows 11, Node v26.13.0, and workerd 1.20260815.1 through
`@cloudflare/vitest-pool-workers` 0.22.0. Each figure is the mean of a
`pnpm run bench` run. Expect a CI runner or a production colo to be slower.

| Snapshot build (JSON parse, validate, build) | Payload  | Node    | workerd | Retained heap, Node |
| -------------------------------------------- | -------- | ------- | ------- | ------------------- |
| 1 000 flags                                  | 0.48 MiB | 3.6 ms  | 4.2 ms  | 1.3 MiB             |
| 20 000 flags                                 | 9.62 MiB | 84 ms   | 86 ms   | 25.5 MiB            |
| one segment of 100 000 keys                  | 1.23 MiB | 11.2 ms | 15.6 ms | 5.5 MiB             |

| Evaluation                                | Mean   |
| ----------------------------------------- | ------ |
| trivial flag                              | 0.1 µs |
| 20 rules, then a rollout                  | 1.5 µs |
| prerequisites three deep                  | 1.0 µs |
| `inSegment` against a 100 000-key segment | 0.2 µs |
| `evaluateAll` over 500 flags              | 138 µs |

What that means in practice:

- **Cold start** costs about 9 ms per MiB of flags and 13 ms per MiB of segment
  keys in workerd. The first request of every new isolate pays it once. workerd
  reports time in whole milliseconds, so its small-payload figures are coarse.
- **Memory** retained by a snapshot is about 2.7 times the payload for flags and
  4.5 times for segment keys, and a refresh briefly holds the old snapshot, the
  new one and the payload together. A 10 MiB ruleset keeps about 26 MiB, which
  leaves most of a 128 MB isolate to the application; a ruleset near the 25 MiB
  KV limit would not.
- **Evaluation** of one flag does not grow with the size of the ruleset or of a
  segment: segment membership is a set lookup. Rule count and prerequisite depth
  are what cost. `evaluateAll` grows linearly with the number of flags.
- The 10 MiB `maxBytes` default sits where a cold start costs about 90 ms and the
  snapshot keeps about 26 MiB. Raise it with both of those in mind.

## Adding a platform

Implement `FlagProvider` and hand it to `FeatureFlagClient`:

```ts
interface FlagProvider {
  readonly name: string;
  // Return null to mean "unchanged"; `previous` enables conditional fetching.
  // `context.reportError` reaches the client's `onError`.
  load(previous?: FlagSnapshot, context?: ProviderLoadContext): Promise<FlagSnapshot | null>;
  close?(): Promise<void>;
}
```

`snapshotFromRuleset(raw, meta, options)` from the core validates a raw payload
(flags and segments in one document), builds the snapshot and writes the payload
to a `lastKnownGood` store when one is given. Wrapping the live load in
`loadWithFallback(previous, load, options)` adds the store fallback. That is the
whole contract: see `packages/node/src/file-provider.ts` for the smallest
complete example.

## Speaking OpenFeature

`@kurenwimpel/openfeature` is an OpenFeature server provider over any
`FeatureFlagClient`, so call sites can use `OpenFeature.getClient()` instead of
this project's API. See [`packages/openfeature/README.md`](packages/openfeature/README.md).

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
