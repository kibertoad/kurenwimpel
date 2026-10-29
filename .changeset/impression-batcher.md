---
'@kurenwimpel/core': minor
'@kurenwimpel/node': minor
'@kurenwimpel/cloudflare': minor
---

Core adds `createImpressionBatcher(options)`, which batches and deduplicates the impression feed with no timers of its own. It returns `{ onImpression, flush, close, stats }`. Options: `flush` (the sink), `maxBatchSize` (500), `dedupWindowMs` (60 000), `maxQueueSize` (10 000, dropping the oldest event past it), `maxDedupKeys` (100 000) and `onError`. A repeat is dropped only when the last event sent for the same flag and `targetingKey` had the same `variant` and `flagVersion`, so a variant or version change is always sent. A rejected batch is reported and dropped, not retried. There is no sampling option. `PollingFlagClient` and `WorkerFlags` take the same options plus `flushIntervalMs` (10 000) as `impressions`, and gain `flushImpressions()` and `impressionStats()`. Node flushes on an unref'd interval and on `close()`; Workers hands the flush to `ctx.waitUntil` from `get(ctx)`. `ClientErrorInfo.operation` gains `'impressionFlush'`.
