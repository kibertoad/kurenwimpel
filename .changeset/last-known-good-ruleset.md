---
'@kurenwimpel/core': minor
'@kurenwimpel/node': minor
'@kurenwimpel/cloudflare': minor
---

Providers accept a `lastKnownGood` store and boot from the last ruleset that loaded when the first load fails, marking the snapshot `origin: 'fallback'` and still reporting the outage through `onError`. Core adds the `LastKnownGoodStore` interface, the `snapshotFromRuleset` and `loadWithFallback` helpers, and `FlagSnapshot.origin`; `@kurenwimpel/node` adds `FileLastKnownGoodStore`, which writes atomically.
