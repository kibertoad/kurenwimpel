# @kurenwimpel/cli

The `kurenwimpel` command: validate a ruleset before it ships, see what an edit
does to live traffic, and explain why a context gets the variant it gets.

```sh
npm install --save-dev @kurenwimpel/cli
npx kurenwimpel --help
```

Every command reads a ruleset file in any shape `parseRuleset` accepts: an array
of flags, a key-to-definition object, or the `{ "flags": [...], "segments": [...] }`
document.

## `validate`

```sh
kurenwimpel validate flags.json other.json [--format text|json]
```

Runs the SDK's own parser over each file and prints every issue with its `at`
path, the same issues a running service would report through `onParseIssues`. A
file that is not valid JSON is reported as an issue at `$`.

## `diff`

```sh
kurenwimpel diff old.json new.json [--format text|json|markdown] [--exit-code]
```

A per-flag and per-segment diff that classifies each change by its effect on
traffic, rather than a JSON diff. `--format markdown` is meant to be posted as a
pull request comment. Parse issues of either file are printed to stderr; the diff
covers what parsed.

| Kind                      | Where                            | Effect                                                                |
| ------------------------- | -------------------------------- | --------------------------------------------------------------------- |
| `kill-switch`             | `enabled`                        | Everyone moves to `offVariant`, or back to targeting.                 |
| `allocation-widened`      | `allocation.percent`             | Only adds subjects. Nobody already admitted is reassigned.            |
| `allocation-narrowed`     | `allocation.percent`             | Removes subjects, who fall back to `defaultVariant`.                  |
| `rollout-shifted`         | `rollout`, `rules[<id>].rollout` | Same total weight: only subjects at a moved boundary change variant.  |
| `rollout-reshuffled`      | `rollout`, `rules[<id>].rollout` | Different total weight: every boundary moves. Reshuffles everyone.    |
| `rollout-added`           | `rollout`, `rules[<id>].rollout` | A split appears where a fixed variant or the default served.          |
| `rollout-removed`         | `rollout`, `rules[<id>].rollout` | A split is gone.                                                      |
| `bucketing-changed`       | `salt`, `*.seed`, `*.bucketBy`   | A fresh draw for every subject. Reshuffles everyone.                  |
| `rules-added`             | `rules`                          | New rules take subjects from every rule below them.                   |
| `rules-removed`           | `rules`                          | Their subjects fall through to the next match.                        |
| `rules-reordered`         | `rules`                          | First match wins, so subjects matching several rules move.            |
| `rule-changed`            | `rules[<id>]`                    | Conditions or fixed variant changed.                                  |
| `targets-changed`         | `targets`                        | Counts of keys added, removed, and moved to another variant.          |
| `variants-changed`        | `variants`                       | Counts of variants added, removed, and given a new value.             |
| `default-variant-changed` | `defaultVariant`                 |                                                                       |
| `off-variant-changed`     | `offVariant`                     |                                                                       |
| `prerequisites-changed`   | `prerequisites`                  |                                                                       |
| `metadata-changed`        | `metadata`                       |                                                                       |
| `included-changed`        | `included` (segment)             | Counts of keys added to and removed from the list.                    |
| `excluded-changed`        | `excluded` (segment)             | Counts of keys added to and removed from the list.                    |
| `segment-rules-changed`   | `rules` (segment)                | Counts of membership rules added, removed and changed. Order ignored. |

Rules are matched by `id`, so a renamed rule reads as one removed and one added.
That is also its effect on traffic: the rule id is part of its split's hash.

## `eval`

```sh
kurenwimpel eval flags.json --flag new-checkout --context '{"targetingKey":"user-1","appVersion":"2.4.1"}'
kurenwimpel eval flags.json --all --context '{"targetingKey":"user-1"}' --format json
```

Evaluates through the same engine a service runs and prints the value, variant,
reason, the rule that decided, and each prerequisite's outcome. The context is
the flat OpenFeature shape and defaults to `{}`.

## Exit codes

| Code | Meaning                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Success. `validate` found no issue; `diff` ran (whether or not anything changed); `eval` resolved every flag without an error code.         |
| `1`  | Findings. `validate` found an issue in some file; `diff --exit-code` found a change; `eval` returned an error code for some flag.           |
| `2`  | The command could not run: unknown command or option, wrong number of files, an unreadable file, a `diff` or `eval` input that is not JSON. |

## JSON output

`--format json` prints one JSON document to stdout. Warnings and errors go to
stderr, so stdout always parses. Fields may be added in a minor release; existing
fields keep their meaning.

`validate`:

```json
{
  "valid": false,
  "files": [
    {
      "path": "flags.json",
      "flags": 1,
      "segments": 1,
      "issues": [
        {
          "at": "new-checkout",
          "message": "flag new-checkout: defaultVariant points at unknown variant x"
        }
      ]
    }
  ]
}
```

`flags` and `segments` count the definitions that loaded despite the issues.

`diff`:

```json
{
  "old": "old.json",
  "new": "new.json",
  "issues": { "old": [], "new": [] },
  "flags": [
    {
      "key": "new-checkout",
      "status": "changed",
      "changes": [
        {
          "kind": "allocation-widened",
          "at": "allocation.percent",
          "from": 20,
          "to": 50,
          "reshuffles": false,
          "summary": "allocation 20% to 50%: only adds subjects, nobody admitted is reassigned"
        }
      ]
    }
  ],
  "segments": [
    {
      "key": "employees",
      "status": "changed",
      "referencedBy": ["new-checkout"],
      "changes": [
        {
          "kind": "included-changed",
          "at": "included",
          "added": 3,
          "removed": 1,
          "reshuffles": false,
          "summary": "included: 3 keys added, 1 removed; added keys join the segment, removed ones fall back to its rules"
        }
      ]
    }
  ],
  "reshuffles": false
}
```

- `status` is `added`, `removed` or `changed`. Added and removed entries carry no
  `changes`; unchanged ones are left out.
- `reshuffles` on a change is `true` for `rollout-reshuffled` and
  `bucketing-changed`. The top-level `reshuffles` is `true` when any change has it.
- `from` and `to` hold the old and new value and are absent for a side that was
  unset. `added`, `removed` and `changed` are counts.
- `referencedBy` lists the flags in either file whose conditions name the segment.
- Treat an unknown `kind` as a change whose effect is not classified.

`eval`:

```json
{
  "context": { "targetingKey": "qa-account-1" },
  "results": [
    {
      "key": "new-checkout",
      "value": true,
      "variant": "on",
      "reason": "TARGETING_MATCH",
      "metadata": { "experiment": "checkout-q3" },
      "prerequisites": [
        {
          "flag": "new-backend",
          "requiredVariants": ["on"],
          "status": "satisfied",
          "variant": "on",
          "reason": "STATIC"
        }
      ]
    }
  ]
}
```

Each result is the core's `EvaluationResult` (`ruleId`, `failedPrerequisite`,
`errorCode` and `errorMessage` appear when set) plus `prerequisites`. A
prerequisite's `status` is `satisfied`, `failed`, `missing` (not in the ruleset),
or `not-evaluated` (evaluation stopped before reaching it).

## Programmatic use

The package also exports what the commands are built from: `diffRuleset`,
`explain`, `loadRuleset`, the renderers, and `run(argv, io)`, which runs one
invocation against an injected `CliIo` and returns its exit code.
