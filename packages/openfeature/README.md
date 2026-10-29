# @kurenwimpel/openfeature

An [OpenFeature](https://openfeature.dev) server provider for kurenwimpel. Call
sites code against the OpenFeature API; flags are still evaluated in process by a
`FeatureFlagClient`, so a lookup never does I/O.

```sh
pnpm add @kurenwimpel/openfeature @openfeature/server-sdk
```

`@openfeature/server-sdk` is a peer dependency, so the application keeps one copy
of the OpenFeature API.

## Usage

`KurenwimpelProvider` wraps a client you construct: a `PollingFlagClient` from
`@kurenwimpel/node`, the `client` of a `WorkerFlags` from `@kurenwimpel/cloudflare`,
or a plain `FeatureFlagClient`.

```ts
import { HttpFlagProvider, PollingFlagClient } from '@kurenwimpel/node';
import { KurenwimpelProvider } from '@kurenwimpel/openfeature';
import { OpenFeature } from '@openfeature/server-sdk';

const flags = new PollingFlagClient({
  provider: new HttpFlagProvider({ url: 'https://flags.internal/ruleset.json' }),
});
await flags.start();

await OpenFeature.setProviderAndWait(new KurenwimpelProvider(flags));

const features = OpenFeature.getClient();
const enabled = await features.getBooleanValue('new-checkout', false, {
  targetingKey: user.id,
  plan: user.plan,
  signedUpAt: user.createdAt,
});
```

`initialize()` calls `client.init()` only when the client is not ready yet. It does
not start polling: call `start()` on a `PollingFlagClient` first, as above, or the
provider serves the snapshot from that one load forever. `OpenFeature.close()`
closes the client.

## Resolution

Each `resolve*Evaluation` calls the matching `get*Details` getter on the client,
so impressions and metrics configured on the client still fire. The result maps
onto OpenFeature's `ResolutionDetails`:

- `value` and `variant` as served.
- `reason` through `toOfrepReason`, since OFREP and OpenFeature share the
  vocabulary: `NOT_ALLOCATED` becomes `STATIC`, `PREREQUISITE_FAILED` becomes
  `DISABLED`, and a failed evaluation is `ERROR`.
- `errorCode` through `toOfrepErrorCode`, except `PROVIDER_NOT_READY` and
  `TYPE_MISMATCH`, which OpenFeature names itself and OFREP folds into `GENERAL`.
- `flagMetadata` is the flag's `metadata`.

OpenFeature serves the caller's default whenever a resolution carries an error
code. A flag that buckets on a missing targeting key therefore returns the
caller's default through OpenFeature, where the native client serves the flag's
default variant.

## Context mapping

OpenFeature contexts allow `Date` values and nested structures; the engine's
context is flat JSON.

| OpenFeature value       | Engine value                                     |
| ----------------------- | ------------------------------------------------ |
| top-level `Date`        | epoch milliseconds, so `gt`/`lt` can compare it  |
| nested object or array  | passed through unchanged; conditions fail closed |
| `targetingKey`          | passed through; a missing one stays missing      |
| string, number, boolean | passed through                                   |

A condition like `{ "attribute": "signedUpAt", "operator": "lt", "value":
1600000000000 }` matches a context carrying `signedUpAt: new Date(...)`.

## Events

| Event                  | When                                                           |
| ---------------------- | -------------------------------------------------------------- |
| `ConfigurationChanged` | the client installs a new snapshot, after the first one        |
| `Stale`                | a load fails while serving; emitted once until a load succeeds |
| `Ready`                | the first successful load after `Stale`                        |

`ConfigurationChanged` carries the snapshot version as `metadata.version` when the
snapshot has one. An "unchanged" answer emits nothing. A client that comes up on a
last-known-good copy reports `Ready`, and goes `Stale` on its next failed load.

## Impressions

The client's `onImpression` keeps working under the provider. A team that already
ships OpenFeature telemetry can use an `after` hook instead, which sees every
successful evaluation with its variant, reason and flag metadata:

```ts
import type { Hook } from '@openfeature/server-sdk';

const exposures: Hook = {
  after(hookContext, details) {
    analytics.track('flag_exposure', {
      flag: details.flagKey,
      variant: details.variant,
      reason: details.reason,
      targetingKey: hookContext.context.targetingKey,
    });
  },
};

OpenFeature.addHooks(exposures);
```

An `after` hook does not run for errored evaluations; use `error` or `finally` for
those.
