# @kurenwimpel/cli

The `kurenwimpel` command: validate a ruleset before it ships, see what an edit
does to live traffic, explain why a context gets the variant it gets, and publish
it with revisions you can roll back to.

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

## `publish`

```sh
kurenwimpel publish production flags/production.json [--config <path>] [--allow-issues] [--format text|json]
```

Publishes a ruleset to the target configured for an environment (see
[Configuration](#configuration)).

- A ruleset with parse issues is refused with exit code 1, and nothing is written.
  The check runs before the config is read, so it needs no credentials.
  `--allow-issues` publishes it anyway, for emergencies, and prints a banner to
  stderr listing every definition clients will drop.
- The revision is the SHA-256 of the document's canonical JSON (keys sorted, no
  whitespace), and the canonical JSON is what gets written. Identical content
  always gets the same revision, so publishing a document the target already
  serves writes nothing and leaves every client's snapshot alone.
- The payload is checked against the target's size limit before anything is
  written: 25 MiB for a KV value, 5 GiB for an S3 or R2 PUT.

What each target writes:

| Target    | Writes                                                                                                                                                                                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kv`      | `flags:rev:<revision>` with metadata `{ revision, publishedAt }`, then `flags:current` with metadata `{ revision }`, through the Cloudflare REST API. Revisions beyond the newest `keep` are deleted. `KvFlagProvider` reads `flags:current` and skips re-parsing an unchanged `revision`. |
| `file`    | `<path>.revisions/<revision>.json`, then `<path>`, each through a temp file and `rename`, so a reader never sees a partial file. Revisions beyond the newest `keep` are deleted.                                                                                                           |
| `s3`/`r2` | One signed PUT of the object, with the revision as `x-amz-meta-revision`. `HttpFlagProvider` uses the ETag the store assigns. No revisions are kept: turn on bucket versioning for history.                                                                                                |

The key layout is exported from `@kurenwimpel/cloudflare/kv-layout`, the same
module `KvFlagProvider` reads it from.

## `rollback`

```sh
kurenwimpel rollback production [--to <revision>] [--config <path>] [--format text|json]
```

Points the environment back at a stored revision. Nothing is rebuilt, so it works
while the repository itself is broken. Without `--to`, it goes back to the
revision published before the current one, and running it again keeps walking
back. `--to` takes a full revision or a unique prefix, and can roll forward again.
Rolling back to the revision already served writes nothing. Works on `kv` and
`file` targets.

## `revisions`

```sh
kurenwimpel revisions production [--config <path>] [--format text|json]
```

Lists the stored revisions, newest first, with the time each was published. The
one served now is marked with `*`.

```text
* 5f0c3a9e...  2026-10-29T10:12:44.120Z
  9d1b77e2...  2026-10-28T16:03:10.002Z
```

## Configuration

`publish`, `rollback` and `revisions` read `kurenwimpel.config.json` from the
working directory, or the file `--config` names. It maps each environment to the
target it publishes to:

```json
{
  "environments": {
    "production": {
      "target": { "type": "kv", "accountId": "0f2a...", "namespaceId": "9c41..." }
    },
    "staging": {
      "target": { "type": "r2", "accountId": "0f2a...", "bucket": "flags", "key": "staging.json" }
    },
    "local": {
      "target": { "type": "file", "path": "../deploy/flags.json" }
    }
  }
}
```

| Type   | Field                | Default                                                                                                                             |
| ------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `kv`   | `namespaceId`        | required                                                                                                                            |
|        | `accountId`          | `CLOUDFLARE_ACCOUNT_ID`                                                                                                             |
|        | `key`                | `flags:current`                                                                                                                     |
|        | `revisionPrefix`     | `flags:rev:`                                                                                                                        |
|        | `keep`               | `20`, the current revision included                                                                                                 |
|        | `apiTokenEnv`        | `CLOUDFLARE_API_TOKEN`                                                                                                              |
| `file` | `path`               | required, relative to the config file                                                                                               |
|        | `keep`               | `20`                                                                                                                                |
| `s3`   | `bucket`, `key`      | required                                                                                                                            |
| `r2`   | `endpoint`           | `https://<bucket>.s3.<region>.amazonaws.com` for `s3`, `https://<accountId>.r2.cloudflarestorage.com` for `r2`; path style when set |
|        | `region`             | `us-east-1` for `s3`, `auto` for `r2`                                                                                               |
|        | `accountId`          | `r2` only: `CLOUDFLARE_ACCOUNT_ID`                                                                                                  |
|        | `accessKeyIdEnv`     | `AWS_ACCESS_KEY_ID`, or `R2_ACCESS_KEY_ID` for `r2`                                                                                 |
|        | `secretAccessKeyEnv` | `AWS_SECRET_ACCESS_KEY`, or `R2_SECRET_ACCESS_KEY` for `r2`                                                                         |
|        | `sessionTokenEnv`    | `AWS_SESSION_TOKEN` for `s3`, none for `r2`                                                                                         |

Unknown fields are rejected, so a typo fails instead of falling back to a default.

### Credentials

Credentials come from environment variables only. A field that would put a secret
in the file (`apiToken`, `secretAccessKey` and the like) is rejected with a
pointer to its `...Env` counterpart, which names the variable to read instead.
That is how two environments in different accounts use different credentials:

```json
{ "type": "kv", "namespaceId": "9c41...", "apiTokenEnv": "CLOUDFLARE_API_TOKEN_PRODUCTION" }
```

| Variable                                     | Used by                                            |
| -------------------------------------------- | -------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`                       | `kv`. Needs Workers KV Storage edit permission.    |
| `CLOUDFLARE_ACCOUNT_ID`                      | `kv` and `r2`, when the config has no `accountId`. |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`   | `r2`. An R2 API token's S3 credentials.            |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `s3`.                                              |
| `AWS_SESSION_TOKEN`                          | `s3`, optional, for temporary credentials.         |

A missing variable fails the command with exit code 2 before anything is written.

## Exit codes

| Code | Meaning                                                                                                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`  | Success. `validate` found no issue; `diff` ran (whether or not anything changed); `eval` resolved every flag without an error code; `publish` published or found nothing to write; `rollback` and `revisions` ran.                                     |
| `1`  | Findings. `validate` found an issue in some file; `diff --exit-code` found a change; `eval` returned an error code for some flag; `publish` refused a ruleset with parse issues.                                                                       |
| `2`  | The command could not run: unknown command or option, wrong number of files, an unreadable file, an input that is not JSON, an invalid config, a missing credential, a payload over the size limit, a target that failed, no revision to roll back to. |

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

`publish`:

```json
{
  "environment": "production",
  "file": "flags/production.json",
  "status": "published",
  "revision": "5f0c3a9e...",
  "previousRevision": "9d1b77e2...",
  "bytes": 1832,
  "issues": [],
  "target": "kv namespace 9c41... key flags:current"
}
```

`status` is `published` or `unchanged`. A refused ruleset prints
`{ "status": "refused", "issues": [...] }` and exits 1. `previousRevision` is absent
on a first publish.

`rollback` prints `{ "environment", "status", "from", "to" }`, with `status`
`rolled-back` or `unchanged`. `revisions` prints `{ "environment", "revisions" }`,
each revision `{ "revision", "publishedAt", "current" }`, newest first.

## Programmatic use

The package also exports what the commands are built from: `diffRuleset`,
`explain`, `loadRuleset`, the renderers, and `run(argv, io)`, which runs one
invocation against an injected `CliIo` and returns its exit code.

The publisher is usable without the command:

```ts
import { createTarget, publishRuleset, rollbackRuleset } from '@kurenwimpel/cli';

const target = createTarget({ type: 'kv', accountId, namespaceId }, { env: process.env, fetch });
const result = await publishRuleset(target, document); // { status, revision, ... }
await rollbackRuleset(target); // or { to: revision }
```

`publishRuleset` throws `RulesetIssuesError` (unless `allowIssues` is set) and
`PayloadTooLargeError` before writing anything. A `PublishTarget` is a small
interface (`currentRevision`, `write`, and optional `revisions` for rollback), so
a caller can publish somewhere this package has no target for.
