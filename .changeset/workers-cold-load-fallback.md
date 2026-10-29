---
'@kurenwimpel/cloudflare': minor
---

A failed cold-isolate load no longer fails the request. `WorkerFlags` gains `onInitFailure` (default `'serve-defaults'`, which resolves `get()` to the not-ready client), `retryAfterMs` (default 5000) to back off between failed loads, and `bootstrap`, a raw ruleset served with `origin: 'fallback'` until a live load succeeds. `KvFlagProvider` gains `timeoutMs` (default 1000) so a slow KV read fails the load instead of holding the response.
