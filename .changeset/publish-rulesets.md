---
'@kurenwimpel/cli': minor
'@kurenwimpel/cloudflare': minor
---

`kurenwimpel publish`, `rollback` and `revisions` publish a ruleset to Workers KV, a file, S3 or R2 as a content-addressed revision, refuse a ruleset with parse issues unless `--allow-issues` is passed, and write nothing when the target already serves the same revision. Environments and their targets live in `kurenwimpel.config.json`; credentials come from environment variables only. The publisher is exported as `publishRuleset`, `rollbackRuleset` and `createTarget`. `@kurenwimpel/cloudflare` exports its KV key layout from `@kurenwimpel/cloudflare/kv-layout`, adding `DEFAULT_REVISION_PREFIX`, `revisionKey` and `KvRevisionMetadata`.
