---
'@kurenwimpel/ofrep-server': minor
'@kurenwimpel/cloudflare': minor
---

New package `@kurenwimpel/ofrep-server` serves the OFREP single-flag and bulk evaluation routes from a `FeatureFlagClient` as one Fetch API handler, with a mandatory `authorize` hook, `bulkFilter` for server-only flags, and ETag/304 on the bulk route. `@kurenwimpel/cloudflare` adds `createOfrepWorker`, which serves it from Workers KV.
