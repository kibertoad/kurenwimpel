# GitOps template

A repository layout and GitHub Actions wiring that turn a Git repository into the
control plane for kurenwimpel flags. Copy this directory to the root of a repository
of its own, or merge it into an existing one.

```text
flags/
  kurenwimpel.config.json   environments, their targets, rulesets and approvers, lint settings
  production.json           one complete ruleset per environment
  staging.json
  development.json
.github/
  CODEOWNERS                who approves a change to each environment
  workflows/flags.yml       validate, diff and lint on pull requests, publish on merge
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
   in `CLI_VERSION` in `flags.yml` and in the `cli-version` default of
   `flags-rollback.yml`.
5. Make the `validate and diff` job a required status check on `main`.

## What the workflow does

On a pull request, the `validate and diff` job:

- maps the changed files to environments with `kurenwimpel envs --changed`. A
  change to the config counts as a change to every environment;
- runs `kurenwimpel validate --format github` on each changed ruleset, so every
  issue appears as an annotation on the line of the broken flag, and fails the
  check when there is one;
- posts one sticky comment with, per environment, the validation result and
  `kurenwimpel diff --format markdown` against the base branch. A change that
  reshuffles a rollout or rebuckets subjects is called out in the diff's headline
  and in bold in its table. Pull requests from forks get the annotations and the
  job summary but no comment, since their token cannot write one;
- runs `kurenwimpel lint --since-git` on each changed ruleset and adds its findings
  to the comment and as annotations: flags past their `lifecycle.expiresOn`, flags
  serving one variant to everyone, flags switched off and for how long, and, since
  the config sets `lint.requireOwner`, flags without a `lifecycle.owner`. Lint
  never fails the check. To make it blocking, replace `|| true` after the
  `--format github` run with `|| failed=true`.

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

## Adding a section to the pull request comment

The comment is assembled from Markdown files under `$RUNNER_TEMP/comment/<env>/`,
concatenated in file name order under one heading per environment. The workflow
writes `10-validate.md`, `20-diff.md` and `30-lint.md`. Another check adds its own
section by writing one more file in the same step loop, for example
`$RUNNER_TEMP/comment/$environment/40-refs.md`.
