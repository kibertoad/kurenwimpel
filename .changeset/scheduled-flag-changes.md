---
'@kurenwimpel/cli': minor
---

`kurenwimpel schedule validate <env>` and `kurenwimpel schedule apply <env> [--now <iso>]` handle changes that take effect at a set time. Each environment gets a schedule file, `<env>.schedule.json` unless the new `schedule` config field names another, holding entries `{ id, at, flag, set }` where `set` is a shallow patch over the flag. `validate` applies every entry in time order and fails on any parse issue it would introduce; `--format markdown` prints a pull request comment section listing what each pending entry does. `apply` writes the ruleset with the due entries applied and removes them from the schedule. `envs --changed` now counts a schedule change as a change to its environment, `envs` JSON output gains `schedule`, and `envs --format codeowners` prints a line for each schedule file too. `CliIo` gains a required `writeFile`.
