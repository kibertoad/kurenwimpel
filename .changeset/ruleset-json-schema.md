---
'@kurenwimpel/core': minor
---

Publish a JSON Schema for rulesets as `@kurenwimpel/core/ruleset.schema.json`. The document form accepts `$schema` and an optional `schemaVersion`; a document newer than the exported `SUPPORTED_SCHEMA_VERSION` still loads and reports one parse issue at `schemaVersion`.
