# GitOps template

A repository layout and GitHub Actions wiring that turn a Git repository into the
control plane for kurenwimpel flags. Copy this directory to the root of a repository
of its own, or merge it into an existing one.

```text
flags/
  kurenwimpel.config.json   environments, their targets, rulesets and approvers
  production.json           one complete ruleset per environment
  staging.json
  development.json
  <env>.schedule.json       changes to apply at a set time, when there are any
.github/
  CODEOWNERS                who approves a change to each environment
  workflows/flags.yml       validate and diff on pull requests, publish on merge
  workflows/flags-schedule.yml  applies due schedule entries every 5 minutes
  workflows/flags-rollback.yml
  actions/setup-kurenwimpel installs Node.js and the CLI
```

Each environment has one complete document, with no overlays or inheritance.
Duplication between environments is visible in review, and an overlay system would
be a second evaluation language to get wrong.

## Setting it up

1. Edit `flags/kurenwimpel.config.json`: one entry per environment, with its
   `target` (see the [CLI configuration](../../packages/cli/README.md#configuration)),
   its `ruleset`, and the `approvers` that must review a change to it.
2. Make `.github/CODEOWNERS` list those approvers. This prints the lines, and the
   workflow fails a pull request when one is missing:

   ```sh
   kurenwimpel envs --config flags/kurenwimpel.config.json --format codeowners
   ```

   Turn on "Require review from Code Owners" in the branch protection or ruleset
   for `main`, or GitHub only requests the review.

3. Create a [GitHub environment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
   per flag environment, with the same name. Put the target's credentials in its
   secrets, under the variable names the CLI reads: `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID` for the `kv` targets here. The workflow also passes the
   `R2_*` and `AWS_*` ones for `r2` and `s3` targets, which keep no revisions to
   roll back to. Add required reviewers or a wait timer to the
   ones that need them.
4. Pin the CLI to the `@kurenwimpel/cli` version you tested with: replace `latest`
   in `CLI_VERSION` in `flags.yml`, in the `cli-version` default of
   `flags-rollback.yml`, and in both places `flags-schedule.yml` names it.
5. Make the `validate and diff` job a required status check on `main`.

## What the workflow does

On a pull request, the `validate and diff` job:

- maps the changed files to environments with `kurenwimpel envs --changed`. A
  change to the config counts as a change to every environment;
- runs `kurenwimpel validate --format github` on each changed ruleset, so every
  issue appears as an annotation on the line of the broken flag, and fails the
  check when there is one;
- runs `kurenwimpel schedule validate` on each changed environment, so a schedule
  entry that would break the ruleset fails the check, whether the pull request adds
  the entry or edits the ruleset under it;
- posts one sticky comment with, per environment, the validation result,
  `kurenwimpel diff --format markdown` against the base branch, and the pending
  schedule entries with what each does to its flag. A change that
  reshuffles a rollout or rebuckets subjects is called out in the diff's headline
  and in bold in its table. Pull requests from forks get the annotations and the
  job summary but no comment, since their token cannot write one.

On a push to `main`, the `publish` jobs run `kurenwimpel publish` once per changed
environment, each bound to the GitHub environment of the same name, so its
reviewers and secrets apply. When a publish or the optional `verify` command after
it fails, the job prints the `kurenwimpel rollback` command to run, with the
revision it replaced.

`flags.yml` also runs as a reusable workflow (`workflow_call`), taking `config`,
`cli-version` and `verify` as inputs. The publish jobs read the secrets of their
GitHub environment, so a caller passes none.

`flags-rollback.yml` runs that rollback from the Actions tab, under the same
environment protection. Revert the change on `main` afterwards, or the next merge
touching that environment publishes it again.

## Scheduled changes

To change a flag at a set time, add an entry to `flags/<env>.schedule.json` in a
pull request (the [CLI README](../../packages/cli/README.md#schedule) has the
format):

```json
[
  {
    "id": "checkout-ramp-50",
    "at": "2026-11-03T09:00:00Z",
    "flag": "new-checkout",
    "set": { "allocation": { "percent": 50 } }
  }
]
```

The pull request check applies every pending entry to the ruleset and fails when
one would break it, and the comment lists what each entry will do. The schedule
has the same CODEOWNERS approvers as the ruleset.

Every 5 minutes, `flags-schedule.yml` runs `kurenwimpel schedule apply` on each
environment, commits the changed rulesets and schedules to `main` with the applied
entry ids in the message, and publishes those environments through `flags.yml`. The
commit is the audit trail: who scheduled the change is in the pull request that
added the entry, and when it went live is in the commit that applied it.

Timing is approximate:

- GitHub starts scheduled workflows late, often by several minutes and more at the
  top of the hour, and drops runs when it is under load. An entry goes live at its
  `at` time plus the wait for the next 5-minute run, plus that delay, plus the
  publish.
- There is no second-level precision. A launch that has to happen at an exact
  moment flips the flag by hand, in a pull request merged at that moment.
- GitHub disables scheduled workflows in a public repository after 60 days without
  activity. Re-enable it in the Actions tab.

Some details of `flags-schedule.yml`:

- A push made with `GITHUB_TOKEN` does not start other workflows, so the push to
  `main` does not trigger `flags.yml`. Instead, `flags-schedule.yml` calls
  `flags.yml` as a reusable workflow with the environments to publish and the
  commit to publish them from. That keeps one publish job, with its GitHub
  environment protection, secrets and rollback output, and needs no personal access
  token.
- The push goes straight to `main`. If a ruleset or branch protection on `main`
  requires pull requests, let the workflow through: give it a GitHub App token
  that the rule allows to bypass, in place of `GITHUB_TOKEN`. A push with an App
  token also starts `flags.yml` on its own, which publishes the same revision
  again and writes nothing.
- When `main` moves between the checkout and the push, the push is rejected and the
  run fails. The next run starts from the new `main` and applies the same entries.
- An environment whose due entries have issues fails the run and stays as it is.
  The other environments still apply and publish.

## Adding a section to the pull request comment

The comment is assembled from Markdown files under `$RUNNER_TEMP/comment/<env>/`,
concatenated in file name order under one heading per environment. The workflow
writes `10-validate.md`, `20-diff.md`, and `25-schedule.md` when the environment
has pending schedule entries. Another check adds its own section by
writing one more file in the same step loop, for example
`$RUNNER_TEMP/comment/$environment/30-lint.md`.
