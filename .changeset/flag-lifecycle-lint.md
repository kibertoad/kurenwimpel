---
'@kurenwimpel/core': minor
'@kurenwimpel/cli': minor
---

A flag takes an optional `lifecycle` block (`owner`, `kind`, `expiresOn`, `tags`) that evaluation ignores and that never reaches an evaluation result. The JSON Schema covers it, and a bad value is a parse issue that drops that field and keeps the flag. `kurenwimpel lint <file>` reports expired, fully rolled out and switched off flags, exempting `ops` and `permission` flags, and flags without an owner when the config sets `lint.requireOwner`; `--since-git` reads `git log` for how long a flag has been off. `kurenwimpel refs <file> --src <dir>` reports flags no getter reads and getter calls naming flags the ruleset does not define. `kurenwimpel diff` reports a `lifecycle-changed` change.
