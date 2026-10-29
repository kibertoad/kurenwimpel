---
'@kurenwimpel/ofrep-server': minor
'@kurenwimpel/node': minor
---

`@kurenwimpel/ofrep-server` gains an `eventStream` option that serves an OFREP SSE change stream on a configurable `GET` route, sends `refetchEvaluation` with `lastModified` when the client's snapshot version changes, heartbeats inside `inactivityDelaySec`, and advertises the stream in bulk responses as `eventStreams`. `PollingFlagClient` in `@kurenwimpel/node` gains a `changeStream` option that refreshes on each event, reconnects with exponential backoff and jitter, and polls ten times less often while the stream is connected.
