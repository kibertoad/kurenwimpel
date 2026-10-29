---
'@kurenwimpel/cli': minor
---

New package `@kurenwimpel/cli` with the `kurenwimpel` command. `validate` reports every parse issue in a ruleset file, `diff` classifies each change between two rulesets by its effect on live traffic (including the reweights and bucketing changes that reshuffle everyone), and `eval` explains the variant a context gets, with the deciding rule and each prerequisite's outcome. Exit codes and JSON output are documented in the package README.
