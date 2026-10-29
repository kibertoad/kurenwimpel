---
'@kurenwimpel/core': minor
---

Segments accept `includedHashes` and `excludedHashes`, and individual targets accept `keyHashes`, each as `{ algorithm: 'sha256', values: [...] }` holding the SHA-256 of targeting keys as 64 lowercase hex characters. A ruleset can then target individual subjects without carrying their identifiers. Evaluation hashes the targeting key only for segments and flags that declare a hashed list, at most once per evaluation, and a plain match is still checked first. `sha256Hex` is exported for tooling that converts plain lists. `VariantTarget.keys` is now optional, since a target may list only `keyHashes`.
