---
'@kurenwimpel/cli': minor
---

`kurenwimpel envs` lists the configured environments, or with `--changed <file...>` the ones a set of changed files touches, as text, JSON or CODEOWNERS lines. An environment in `kurenwimpel.config.json` takes an optional `ruleset` (defaulting to `<env>.json`) and `approvers`, and `kurenwimpel publish <env>` publishes the configured ruleset when no file is named. `kurenwimpel validate` adds `--format markdown` for pull request comments and `--format github`, which prints an `::error` workflow command per issue on the line of the definition it is about.
