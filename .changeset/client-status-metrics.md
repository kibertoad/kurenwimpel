---
'@kurenwimpel/core': minor
'@kurenwimpel/node': minor
---

`FeatureFlagClient` gains `status()`, reporting readiness, snapshot origin and version, `lastSuccessfulLoadAt` (which advances on "unchanged" answers too, so it is the freshness signal), failure counts and the parse issue count. New options: `onSnapshotChange(snapshot, previous)`, called when a new snapshot is installed, and `metrics`, a sink whose `record(flagKey, variant, reason, errorCode)` runs once per evaluation without building an event object. Core ships `CountingMetrics`, an in-memory counter whose `collect()` returns and resets the counts. Providers can report parse issues through the new optional `ProviderLoadContext.reportParseIssues`. `@kurenwimpel/node/opentelemetry` adds `OpenTelemetryMetrics`, which exports `flag.evaluations`, `flag.snapshot.age` and `flag.load.failures`, with `@opentelemetry/api` as an optional peer dependency. `PollingFlagClientOptions` now accepts every `FeatureFlagClient` option.
