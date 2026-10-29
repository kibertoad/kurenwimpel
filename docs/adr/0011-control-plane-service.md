# 0011: A control plane service that publishes through the GitOps publisher

Date: 2026-10-29 · Status: accepted

## Context

The GitOps setup (#12) gives engineering teams review, history and rollback
through a repository. It does not serve a product manager who needs to turn a
flag on, or a support agent who adds an account to a segment several times a
day. Both need a service with storage, an API, a UI, sign-in, an audit log and
approvals.

Three constraints shape it:

- The service is never on the evaluation path. SDKs read published snapshots
  (ADR 0001) from a target, so the service can be down without any flag
  changing. Its writes are rare and its reads are few.
- GitOps and the service must produce the same artifact for the same content,
  so a team can move an environment from one to the other.
- The OFREP server (#17) needs credentials scoped to one environment, and it
  must check them without calling the service.

The HTTP API is `@kurenwimpel/control-plane-contract`, written with
toad-contracts like `@kurenwimpel/ofrep`. This record decides the design the
contract describes.

## Decision

### Storage: D1 behind a storage port, Postgres as a second adapter

The service talks to its database through one narrow port, and the first
adapter is Cloudflare D1. Workers KV, R2 or S3 stay what they are today:
publish targets, not service storage.

|                        | D1 (with KV as the target)                                          | Postgres                                                    |
| ---------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------- |
| Platform               | Same account and deploy as the KV target and the Workers SDK        | Runs anywhere; a second platform to operate next to Workers |
| Transactions           | Atomic batches only, no interactive transactions                    | Full transactions and row locks                             |
| Limits that matter     | 2 MB per row, 10 GB per database                                    | None at this scale                                          |
| Operating cost         | No server, backups through Time Travel                              | A managed instance, its backups and its upgrades            |
| Fit for the write rate | Writes are a few per minute at most, well inside one primary writer | More than needed                                            |

D1 is the recommendation for the reference deployment: the engine already
targets Workers and KV, and a team that runs both gets a control plane without
a database server. The port keeps Postgres open for teams that self-host away
from Cloudflare, so its adapter is a follow-up rather than a rewrite.

The schema is written for D1's constraints, which also run unchanged on
Postgres:

- Every write is one atomic batch: a version-guarded `UPDATE` of the resource,
  the audit `INSERT` conditioned on that row, and the new desired revision.
  A stale write matches no row and leaves no trace.
- Segment members are stored one row per key, not as a JSON array on the
  segment. That keeps a large list under the row limit and makes adding a key a
  single insert.
- JSON lives in `TEXT` columns and no statement uses an engine-specific
  function.

### Domain: organisation, project, environment, then flags and segments

An organisation holds projects, and a project holds environments. Flags and
segments belong to one environment, and each environment publishes one complete
ruleset document to one target. This is the GitOps layout of #12 (one document
per environment, no overlays), so the two hold the same thing.

Every flag, segment, environment and change request carries a `version`: an
integer that starts at 1, grows by one on every change and never goes back.
Writes name the version they are based on, in `if-match` for a direct write or
as `expectedVersion` in a change request operation, and a mismatch answers 412.
A segment's member edits take no version, because adding and removing keys
commute.

**The flag version is `flagVersion`.** When the service builds the document it
stamps each flag's version into its `version` field, which the engine already
carries to `ImpressionEvent.flagVersion`. A client cannot set `version` in a
definition; the contract rejects it. An analyst joining impressions to outcomes
can tell which definition a user saw.

### Publishing through the shared publisher

The service builds the `{ schemaVersion, flags, segments }` document from its
rows, with flags and segments sorted by key, and publishes it with
`publishRuleset(createTarget(config, deps), document)` from `@kurenwimpel/cli`.
The environment's target uses the shape `kurenwimpel.config.json` uses for the
same environment, and credentials come from the service's secrets, never from
the API. The revision is therefore `revisionOf(document)`, the SHA-256 of its
canonical JSON, exactly as for a GitOps publish.

- A write commits first and publishes second, in the same request. A failed
  publish does not undo the write: the environment's publication shows `failed`
  with the error, and the scheduler retries every minute until it succeeds.
- Publishes of one environment run one at a time (a Durable Object per
  environment on Workers, an advisory lock on Postgres), so an older document
  never overwrites a newer one.
- The service keeps every document it publishes. Rollback calls
  `rollbackRuleset` to repoint the target at once, then restores the stored
  rows to that document as new versions of every flag and segment it changes.
  The target and the database agree afterwards, and the next unrelated edit does
  not ship the bad state again.
- A rollback can only reach revisions the service published itself. Earlier
  ones belong to Git and are rolled back with the CLI.

### Coexistence with GitOps: one source per environment

Each environment has `source: service | git`, and there is no two-way sync.

- With `git`, the service holds only the environment's settings, role bindings
  and SDK keys. Content routes answer 409 `MANAGED_BY_GIT`, and schedules run in
  the GitHub workflow from #13.
- Handing an environment to Git: export the document, commit it as
  `flags/<env>.json`, set `source` to `git`. The export is the byte-exact
  document the service publishes, so the first GitOps publish reports
  `unchanged`.
- Taking one over from Git: import the committed document. The service stores
  it, keeps the `version` of each flag that carries one (1 otherwise), sets the
  source to `service` and publishes. Setting `source: service` directly is not
  allowed, so the service always starts from what Git last held.

### Authentication, roles and SDK keys

People sign in with OIDC (authorization code with PKCE) against the
organisation's identity provider. Automation uses an OIDC token too: a
client-credentials grant, or a workload identity such as a GitHub Actions token.
Every API call carries `Authorization: Bearer`, and the service issues no
long-lived API tokens of its own.

Roles are granted per environment by binding an OIDC group to a role, so access
is managed in the identity provider:

- **viewer**: reads content, publication state and the environment's audit
  events.
- **editor**: writes content in an unprotected environment, and opens change
  requests in a protected one.
- **approver**: reviews and applies change requests, and rolls back.

Organisation admins, named by OIDC group on the organisation, manage projects,
environments, role bindings, SDK keys and imports.

SDK keys belong to one environment and are `server` or `client` keys. The
secret (`kw_server_...`, `kw_client_...`) is shown once; the service stores its
SHA-256. On every key change it publishes the set of live hashes to the
environment's target under a key next to the ruleset, with the same publisher.
The OFREP server's `authorize` hook hashes the presented key and checks it
against that set, so it never calls the service. It applies `bulkFilter` to
client keys, which ship inside apps and are public in practice. A revocation
takes effect at the OFREP server's next refresh.

### Audit log

Every change appends one event: actor, time, action, resource, the resource
before and after (`null` on the side where it did not exist), and the change
request and revision it came with. The event is written in the same batch as
the change, so there is no change without its event. The API has no route that
edits or deletes events, and secrets are never recorded. A flag's version
history is read from the same events.

### Approvals

A protected environment takes content changes only through change requests.
A change request lists operations (put or delete a flag or a segment, add or
cancel a schedule entry), each pinned to the version it was written against.

- Approvals come from approvers other than the author; the environment sets how
  many are needed (1 by default, at most 5).
- Revising a change request clears its reviews, so approvals always cover what
  gets applied.
- Applying runs every operation in one batch, or none of them when any expected
  version is stale. The author then revises the request against current content.
- One exception keeps incidents fast: an editor may turn a flag off directly
  (`enabled: false`, nothing else changed) in a protected environment. It is the
  kill switch, the first step of the evaluation pipeline, and it is audited like
  any other change.

### Scheduling

For environments the service owns, it runs the schedule from #13 itself. An
entry has the same shape as a line of `flags/<env>.schedule.json`: an id, a
time, a flag and a shallow patch. It is checked with `parseRuleset` when it is
written and again when it fires.

- A Cron Trigger (an interval on Node) fires every minute and applies due
  entries in time order, each as a change by the `scheduler` actor: a new flag
  version, an audit event and a publish.
- An entry whose patch no longer produces a valid ruleset is marked `failed`
  with the issues, and nothing is applied.
- In a protected environment, adding or cancelling an entry is a change request
  operation. Approving the entry approves its effect, so firing needs no second
  approval.

Precision is one minute, against several minutes for the GitHub scheduler.

## Consequences

- A team picks Git or the service per environment, and moving between them is
  an export or an import with no rewrite of the content.
- Impressions carry a `flagVersion` for every flag the service publishes.
- The service imports the publisher from `@kurenwimpel/cli`, which pulls the
  command-line code and the file target into a Worker. The publisher needs its
  own entry point, without `node:fs`, before the service can bundle it.
- A Worker deployment needs `nodejs_compat`, because the publisher hashes with
  `node:crypto`.
- `@kurenwimpel/control-plane-contract` stays `private` until the API is built
  against it, so its shapes can change with review of this record.

## Alternatives rejected

- **Two-way sync between Git and the service.** Every edit would need conflict
  resolution between a commit and a database row, and neither side could be
  trusted as the record.
- **Flags defined per project with per-environment overrides**, as LaunchDarkly
  does. It is the overlay system #12 rejects, and the published document would
  no longer match a GitOps one.
- **Storing each environment as one document blob.** It loses per-flag versions,
  turns every edit into a whole-document conflict, and puts large segments over
  D1's row limit.
- **Postgres only.** It adds a database server to every deployment, when the
  reference deployment already runs on Workers.
- **Service-issued API tokens for automation.** They are long-lived secrets to
  rotate; OIDC client credentials and workload identities already cover CI.
- **The OFREP server checking SDK keys against the service.** That puts the
  service on the evaluation path, which the snapshot design exists to avoid.

## Follow-up work

- #40: the storage port and the D1 adapter.
- #41: OIDC, role bindings, SDK keys and the OFREP `authorize` helper.
- #42: the service that serves the contract, the publisher entry point and
  the scheduler.
- #43: the UI.
