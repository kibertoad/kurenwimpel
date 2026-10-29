# Running experiments

An A/B test has two halves. Assignment decides who sees which variant and
records that they saw it. Analysis joins those exposures to outcomes and
decides whether the difference is real. kurenwimpel does the first half and
none of the second. This guide draws that line, then describes a pipeline for
the half you build yourself and the mistakes the engine cannot stop you making.

## The boundary

The engine provides:

- **Assignment.** A deterministic split (`rollout`) that lands the same subject
  in the same variant on every runtime and in every process.
- **Exposure control.** A traffic `allocation` gate that ramps how many subjects
  enter without moving anyone between variants
  ([ADR 0005](adr/0005-traffic-allocation.md)).
- **Re-randomisation and units.** A `seed` per split and per gate, and
  `bucketBy` for randomising on something other than the targeting key
  ([ADR 0007](adr/0007-experimentation-primitives.md)).
- **An exposure feed.** One `ImpressionEvent` per evaluation through
  `onImpression`, and a batcher that deduplicates and batches them for your
  sink (see [Impressions](../README.md#impressions)).

It does not provide, and has no plans to:

- metric definitions, or any notion of an outcome event
- statistics: effect sizes, confidence intervals, p-values, power
- guardrail metrics, or alerts when one degrades
- automatic stopping, or automatic promotion of a winner
- delivery guarantees for impressions: a batch whose `flush` rejects is dropped,
  not retried

Those belong to your warehouse and your experimentation tooling. The rest of
this guide covers what the engine's side has to look like for them to work.

## What an impression carries

Every field below comes from `ImpressionEvent` in
`packages/core/src/runtime/impressions.ts`.

| Field          | Type                                    | Notes                                                                                                                                     |
| -------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `flagKey`      | string                                  | Always present.                                                                                                                           |
| `variant`      | string or absent                        | The variant served. Absent when nothing could be resolved, such as `FLAG_NOT_FOUND`.                                                      |
| `value`        | boolean, string, number, object, absent | The served value. A typed getter that fell back to the caller's default reports that default.                                             |
| `reason`       | string                                  | `SPLIT`, `NOT_ALLOCATED`, `TARGETING_MATCH`, `STATIC`, `DISABLED`, `PREREQUISITE_FAILED` or `ERROR`.                                      |
| `ruleId`       | string, optional                        | The rule that decided the outcome. Absent for the flag-level rollout.                                                                     |
| `errorCode`    | string, optional                        | For example `TARGETING_KEY_MISSING` when the key or the `bucketBy` attribute is missing; the default variant is still served.             |
| `targetingKey` | string, optional                        | The key bucketing used, always a string. It is the targeting key even when the split buckets on `bucketBy`.                               |
| `flagVersion`  | number, optional                        | The definition's `version`, when the control plane stamps one.                                                                            |
| `metadata`     | object of scalars, optional             | The flag's own `metadata`, copied onto every evaluation of a flag that exists. It is per flag: rules and rollouts cannot carry their own. |
| `timestamp`    | number                                  | Epoch milliseconds at evaluation time, not at flush time.                                                                                 |

The engine attaches no meaning to any `metadata` key. This guide uses the
convention from the README's example definition, an `experiment` key naming the
experiment: `"metadata": { "experiment": "checkout-q3" }`.

## Reference pipeline

```
getBoolean() ──> onImpression ──> batcher ──> flush(events) ──> flag_impressions table
                                                                   │
outcome events (orders, signups, ...) ─────────────────────────────┴─> join on targeting_key
                                                                        and experiment id
```

### 1. Ship impressions through the batcher

Pass the `impressions` option to `PollingFlagClient` or `WorkerFlags`, or use
`createImpressionBatcher` in a custom wrapper. The sink writes rows; it does no
filtering beyond what you choose to drop.

```ts
const flags = new PollingFlagClient({
  provider,
  impressions: {
    flush: (events) =>
      warehouse.insert(
        'flag_impressions',
        events.map((event) => ({
          flag_key: event.flagKey,
          variant: event.variant ?? null,
          value: event.value === undefined ? null : JSON.stringify(event.value),
          reason: event.reason,
          rule_id: event.ruleId ?? null,
          error_code: event.errorCode ?? null,
          targeting_key: event.targetingKey ?? null,
          flag_version: event.flagVersion ?? null,
          metadata: event.metadata === undefined ? null : JSON.stringify(event.metadata),
          evaluated_at: new Date(event.timestamp),
        })),
      ),
    onError: (error) => logger.warn({ error }, 'impression batch dropped'),
  },
});
```

Exposure points are the typed getters. `evaluateAll()` emits nothing unless
called with `{ impressions: true }`, because a bulk prefetch is not an exposure.
Evaluate the flag where the variant actually changes what the subject sees.

### 2. Know what deduplication does to first exposure

The batcher drops an event only when the last one it emitted for the same
`(flagKey, targetingKey)` had the same `variant` and `flagVersion` and is less
than `dedupWindowMs` older. So:

- A subject's first evaluation in a process is always emitted. Deduplication
  never hides a first exposure.
- A variant or version change is always emitted, including a flip back to an
  earlier variant.
- The state is per batcher, so per process or Worker isolate. Two instances
  each emit their own first event, and the same instance emits again once the
  window has passed. The warehouse sees several rows per subject and has to
  take the earliest.
- Events with no `targetingKey` all share one dedup entry per flag. They cannot
  be joined to anything anyway; drop them in the sink or in the query.

Events can still be lost: a rejected `flush` drops its batch, and a queue past
`maxQueueSize` evicts its oldest event. Watch `failed` and `dropped` in
`impressionStats()` or `stats()`. Losses that are uniform across variants
shrink the sample; losses that are not show up as a sample ratio mismatch.

### 3. Store them in one table

A schema derived from the fields above, in PostgreSQL. Other warehouses need
only the type names changed.

```sql
CREATE TABLE flag_impressions (
  flag_key       text        NOT NULL,
  variant        text,
  value          jsonb,
  reason         text        NOT NULL,
  rule_id        text,
  error_code     text,
  targeting_key  text,
  flag_version   bigint,
  metadata       jsonb,
  experiment_id  text GENERATED ALWAYS AS (metadata ->> 'experiment') STORED,
  evaluated_at   timestamptz NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX flag_impressions_experiment
  ON flag_impressions (experiment_id, targeting_key, evaluated_at);
```

`received_at` against `evaluated_at` shows how far delivery lags, which matters
when deciding how fresh a readout can be.

### 4. Join on targeting key and experiment id, from first exposure

The exposed population is the rows with `reason = 'SPLIT'` for the experiment.
Leave out:

- `NOT_ALLOCATED`: outside the allocation, never randomised.
- `TARGETING_MATCH`: an individual target or a rule with a fixed variant. QA
  accounts pinned to `treatment` land here, above the allocation gate.
- `ERROR`: includes `TARGETING_KEY_MISSING`, which serves the default variant
  without bucketing.
- Rows from a different `rule_id`, when the flag has more than one rollout.
  Each rollout is its own randomisation; analyse one at a time.

Each subject is assigned to the variant of its first `SPLIT` exposure, and only
outcomes after that moment count. A subject seen in more than one variant was
moved between treatments, by a change to weights, targets or rules mid-test;
count those separately and exclude them rather than letting them dilute both
arms.

## Running an experiment correctly

**Ramp with `allocation.percent`, never with the weights.** Raising `percent`
from 20 to 60 only admits subjects; nobody already inside changes variant. A
split is normalised by the sum of its weights, so writing exposure into the
weights (`[10, 10, 80]` becoming `[50, 50, 0]`) moves subjects between
treatments. See [ADR 0005](adr/0005-traffic-allocation.md). When your control
plane bumps `version` on each edit, a ramp step makes the batcher re-emit for
subjects it has already seen; first exposure is unaffected.

**Start each iteration with a new `seed` and a new experiment id.** Change
`rollout.seed` to re-randomise assignment, and `allocation.seed` too when the
allocation is under 100% and you want a fresh sample of who is admitted.
Reusing the previous iteration's population carries over whatever the last
treatment did to them. The seed is not on the impression, so also change the
`experiment` metadata (`checkout-q3-i2`) to keep the iterations apart in the
warehouse. `salt` reshuffles every split of the flag at once and is the wrong
tool for one experiment.

**Use `bucketBy` when the unit is the account.** When users of one account
influence each other (shared settings, shared billing, a team workspace),
randomise the account: `rollout.bucketBy: "accountId"`. Give the gate the same
attribute, `allocation.bucketBy: "accountId"`, or it admits an account's users
independently and splits the cohort the rollout kept together. Impressions
still carry the user's `targetingKey`, not the account, so the analysis joins
users to accounts from your own data and counts accounts, not users. A
context without the `bucketBy` attribute gets the default variant with
`TARGETING_KEY_MISSING`.

**Check for sample ratio mismatch before reading results.** If a 50/50 split
produced 10 000 and 10 600 exposed subjects, something other than chance is
removing subjects from one arm: a crash in one treatment, a redirect that skips
the evaluation, lost impression batches. Any metric read on that population is
biased. Run the check below first and stop if it fails.

## Sample queries

PostgreSQL, against the table above, for experiment `checkout-q3` on flag
`new-checkout`.

### Exposure counts per variant

Raw events against distinct subjects. The first is what the batcher delivered;
only the second is a sample size.

```sql
SELECT variant,
       count(*)                      AS impressions,
       count(DISTINCT targeting_key) AS subjects
FROM flag_impressions
WHERE experiment_id = 'checkout-q3'
  AND flag_key = 'new-checkout'
  AND reason = 'SPLIT'
  AND targeting_key IS NOT NULL
GROUP BY variant
ORDER BY variant;
```

### First exposure per subject

```sql
CREATE VIEW checkout_q3_exposures AS
WITH split AS (
  SELECT targeting_key, variant, evaluated_at
  FROM flag_impressions
  WHERE experiment_id = 'checkout-q3'
    AND flag_key = 'new-checkout'
    AND reason = 'SPLIT'
    AND targeting_key IS NOT NULL
),
crossed AS (
  SELECT targeting_key
  FROM split
  GROUP BY targeting_key
  HAVING count(DISTINCT variant) > 1
)
SELECT DISTINCT ON (targeting_key)
       targeting_key, variant, evaluated_at AS first_exposed_at
FROM split
WHERE targeting_key NOT IN (SELECT targeting_key FROM crossed)
ORDER BY targeting_key, evaluated_at;
```

Joining outcomes then keeps only events after exposure:

```sql
SELECT e.variant,
       count(*)                                        AS subjects,
       count(o.targeting_key)                          AS converted,
       count(o.targeting_key)::numeric / count(*)      AS conversion_rate
FROM checkout_q3_exposures e
LEFT JOIN LATERAL (
  SELECT targeting_key
  FROM orders o
  WHERE o.user_id = e.targeting_key
    AND o.created_at >= e.first_exposed_at
  LIMIT 1
) o ON true
GROUP BY e.variant;
```

The conversion rate is where this guide stops. Whether the difference between
the two rates is real is a question for your statistics tooling.

### Sample ratio mismatch

A chi-square goodness-of-fit test of distinct exposed subjects against the
configured weights. `expected` lists the rollout's buckets; weights are
relative, exactly as in the definition.

```sql
WITH expected(variant, weight) AS (
  VALUES ('on', 50), ('off', 50)
),
observed AS (
  SELECT variant, count(*) AS n
  FROM checkout_q3_exposures
  GROUP BY variant
),
totals AS (
  SELECT (SELECT sum(n) FROM observed) AS n,
         (SELECT sum(weight) FROM expected) AS w
)
SELECT sum((coalesce(o.n, 0) - t.n * x.weight / t.w) ^ 2 / (t.n * x.weight / t.w)) AS chi_square,
       count(*) - 1                                                              AS degrees_of_freedom
FROM expected x
LEFT JOIN observed o USING (variant)
CROSS JOIN totals t;
```

Compare `chi_square` with the critical value for its degrees of freedom at a
strict threshold; p < 0.001 is common, because the check runs on every readout.
That is 10.83 for one degree of freedom (two variants) and 13.82 for two. Above
it, find the cause before looking at any metric.

The check only covers the population that reached the split. Subjects matched
by a fixed-variant rule after the gate are `TARGETING_MATCH`, so the ratio of
`SPLIT` to `NOT_ALLOCATED` subjects equals `allocation.percent` only for a flag
whose admitted traffic all goes to the one rollout.
