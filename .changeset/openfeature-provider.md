---
'@kurenwimpel/core': minor
'@kurenwimpel/openfeature': minor
---

New package `@kurenwimpel/openfeature`: `KurenwimpelProvider`, an OpenFeature server provider that wraps any `FeatureFlagClient`. It maps results through `toOfrepReason` and `toOfrepErrorCode`, converts a top-level `Date` in the context to epoch millis, and emits `ConfigurationChanged`, `Stale` and `Ready`. `@openfeature/server-sdk` is a peer dependency. `FeatureFlagClient` gains `subscribe({ onSnapshotChange, onLoad })`, which lets code that wraps a client it did not construct observe snapshot installs and load outcomes; it returns an unsubscribe function, and a throwing listener is reported through `onError` with the operation `listener`.
