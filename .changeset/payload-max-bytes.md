---
'@kurenwimpel/node': minor
'@kurenwimpel/cloudflare': minor
---

`HttpFlagProvider` and `KvFlagProvider` gain `maxBytes` (default 10 MiB, exported as `DEFAULT_HTTP_MAX_BYTES` and `DEFAULT_KV_MAX_BYTES`). A larger payload fails the load before it is parsed: the HTTP provider rejects on `Content-Length` and also stops reading the body once it passes the limit, and the KV provider streams the value and stops at the limit. A `maxBytes` that is not a positive integer throws a `RangeError` from the constructor. `KvFlagProvider` now reads the value as a stream, and no longer reads it at all when its revision matches the loaded snapshot.
