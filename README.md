# kurenwimpel

A simple feature flag solution for backend services.

Evaluation is a pure function over data. That core knows nothing about where its
flags came from or what runtime it is on; each platform gets a thin wrapper that
supplies a `FlagProvider` and nothing else.

## Layout

| Package                   | Directory             | What it is                                                       |
| ------------------------- | --------------------- | ---------------------------------------------------------------- |
| `@kurenwimpel/core`       | `packages/core`       | Runtime-agnostic engine. Zero dependencies, no platform globals. |
| `@kurenwimpel/cloudflare` | `packages/cloudflare` | Workers wrapper: KV-backed provider, isolate-scoped client.      |
| `@kurenwimpel/node`       | `packages/node`       | Node wrapper: file and HTTP providers, polling client.           |

Both wrappers re-export the core, so a service only ever imports one package.

## Toolchain

pnpm 11 workspaces, Turborepo, oxlint (type-aware, via `oxlint-tsgolint`), oxfmt,
TypeScript 7, Vitest. ESM only.

```sh
pnpm install
pnpm run check       # format:check + lint + typecheck + test
pnpm run build
pnpm run format      # rewrite with oxfmt
pnpm run lint:fix
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

## Concepts

A **flag** has named **variants** mapping to values. Which variant a caller gets is
decided, in order:

1. `enabled: false` → `offVariant`. The kill switch; rules are not consulted.
2. The first **rule** whose conditions all match → its `variant`, or its `rollout`.
3. The flag's own `rollout`, if it has one.
4. `defaultVariant`.

A **rollout** is a weighted split bucketed on the context's `targetingKey`. Weights
are relative, so `[{on, 1}, {off, 3}]` is 25/75.

Bucketing is MurmurHash3 over `"<salt>:<targetingKey>"`, salted per flag. Two
consequences worth relying on:

- The same subject always lands in the same bucket, on every runtime and in every
  process — no coordination needed between a Worker at the edge and a Node service.
- Widening a rollout only ever adds subjects to the treatment group. Ramping 20% →
  50% never takes someone back out.

### Example definition

```json
{
  "key": "new-checkout",
  "enabled": true,
  "variants": { "on": true, "off": false },
  "defaultVariant": "off",
  "offVariant": "off",
  "rules": [
    {
      "id": "internal-staff",
      "conditions": [{ "attribute": "email", "operator": "endsWith", "value": "@example.com" }],
      "variant": "on"
    },
    {
      "id": "paid-ramp",
      "conditions": [{ "attribute": "plan", "operator": "in", "value": ["pro", "enterprise"] }],
      "rollout": [
        { "variant": "on", "weight": 20 },
        { "variant": "off", "weight": 80 }
      ]
    }
  ]
}
```

Variant values are any JSON, not just booleans — a `rate-limit` flag can serve
`{ "perMinute": 600 }`.

Operators: `exists`, `notExists`, `eq`, `neq`, `in`, `notIn`, `contains`,
`startsWith`, `endsWith`, `gt`, `gte`, `lt`, `lte`. Array-valued attributes are
matched as sets, so `roles: ["admin", "billing"]` satisfies `in: ["admin"]`.

## Usage

### Node

```ts
import { HttpFlagProvider, PollingFlagClient } from '@kurenwimpel/node';

const flags = new PollingFlagClient({
  provider: new HttpFlagProvider({ url: process.env.FLAGS_URL! }),
  pollIntervalMs: 30_000,
  defaultContext: { attributes: { service: 'billing' } },
  onError: (error, info) => logger.warn({ error, ...info }, 'flag refresh failed'),
});

await flags.start(); // throws if the first load fails

// Synchronous from here on: no I/O, no throwing.
if (flags.getBoolean('new-checkout', false, { targetingKey: user.id })) {
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

Stamp `{ revision: string }` as the KV metadata when writing the ruleset — the
provider uses it to skip re-parsing an unchanged payload.

## Failure behaviour

The design assumption is that a flag lookup must never be the reason a request
fails.

- The **first** load is strict: `init()` / `start()` reject, so a service that
  cannot read its flags fails to start rather than serving every request on
  fallbacks.
- **Refreshes** are lenient: failures go to `onError` and the previous snapshot
  keeps serving.
- A **malformed flag** is dropped and reported through `onParseIssues`; the rest of
  the ruleset still loads.
- **Evaluation** never throws. Unknown key, missing variant, wrong type, or absent
  targeting key all return the caller's default plus an `errorCode` on the
  `*Details` variant of the getter.

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

`parseFlagDefinitions(raw)` from the core does the validation, and `createSnapshot`
builds the result. That is the whole contract — see `packages/node/src/file-provider.ts`
for the smallest complete example.
