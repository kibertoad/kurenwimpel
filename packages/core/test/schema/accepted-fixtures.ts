import type { Condition, ConditionOperator } from '../../src/index.js';

export const flag = {
  key: 'checkout',
  enabled: true,
  variants: { on: true, off: false },
  defaultVariant: 'off',
  offVariant: 'off',
};

export const segment = { key: 'beta', included: ['user-1'] };

/** One valid condition per operator; the type makes it exhaustive. */
export const conditionByOperator = {
  exists: { attribute: 'plan', operator: 'exists' },
  notExists: { attribute: 'plan', operator: 'notExists' },
  eq: { attribute: 'plan', operator: 'eq', value: 'pro' },
  neq: { attribute: 'beta', operator: 'neq', value: true },
  in: { attribute: 'plan', operator: 'in', value: ['pro', 3] },
  notIn: { attribute: 'tier', operator: 'notIn', value: [] },
  contains: { attribute: 'email', operator: 'contains', value: '@' },
  startsWith: { attribute: 'email', operator: 'startsWith', value: 'qa' },
  endsWith: { attribute: 'email', operator: 'endsWith', value: '.com' },
  gt: { attribute: 'seats', operator: 'gt', value: 10 },
  gte: { attribute: 'seats', operator: 'gte', value: 0.5 },
  lt: { attribute: 'seats', operator: 'lt', value: -1 },
  lte: { attribute: 'seats', operator: 'lte', value: 100 },
  semverEq: { attribute: 'app', operator: 'semverEq', value: '2.4.1' },
  semverGt: { attribute: 'app', operator: 'semverGt', value: 'v2' },
  semverGte: { attribute: 'app', operator: 'semverGte', value: '2.1' },
  semverLt: { attribute: 'app', operator: 'semverLt', value: '3.0.0-rc.1' },
  semverLte: { attribute: 'app', operator: 'semverLte', value: '1.0.0-alpha+build.5' },
  inSegment: { operator: 'inSegment', segments: ['beta'] },
  notInSegment: { operator: 'notInSegment', segments: ['beta'] },
} satisfies { [K in ConditionOperator]: Condition & { readonly operator: K } };

const everyOperator = {
  ...flag,
  rules: Object.values(conditionByOperator).map((condition, index) => ({
    id: `rule-${index}`,
    conditions: [condition],
    variant: 'on',
  })),
};

const everyField = {
  ...flag,
  key: 'full',
  variants: { on: { limits: { perMinute: 600, hosts: ['a', null] } }, off: 'off', n: 3 },
  prerequisites: [{ flag: 'checkout', variants: ['on'] }],
  targets: [{ variant: 'on', keys: ['qa-1', 'qa-2'] }],
  allocation: { percent: 20, bucketBy: 'accountId', seed: 'draw-2' },
  rules: [
    { id: 'staff', conditions: [], variant: 'on' },
    {
      id: 'split',
      conditions: [conditionByOperator.eq],
      variant: null,
      rollout: { bucketBy: 'accountId', seed: 's', buckets: [{ variant: 'on', weight: 1 }] },
    },
  ],
  rollout: [
    { variant: 'on', weight: 0 },
    { variant: 'off', weight: 0 },
  ],
  metadata: { experiment: 'q3', owner: 'growth', weight: 2, live: true },
  lifecycle: {
    owner: 'team-checkout',
    kind: 'release',
    expiresOn: '2027-01-31',
    tags: ['checkout'],
    ticket: 'a field this version does not read',
  },
  salt: 'reshuffled',
  version: 7,
  description: 'a field this version does not read',
};

const nullOptionals = {
  ...flag,
  prerequisites: null,
  targets: null,
  allocation: { percent: 0, bucketBy: null, seed: null },
  rules: null,
  rollout: null,
  metadata: null,
  salt: null,
  version: null,
  lifecycle: null,
};

const nullLifecycleFields = {
  ...flag,
  lifecycle: { owner: null, kind: null, expiresOn: null, tags: null },
};

/** Documents `parseRuleset` reads with no issues; each must validate. */
export const accepted: Record<string, unknown> = {
  'an array of flags': [flag],
  'a key-to-flag object': { checkout: flag },
  'an empty array': [],
  'a document with $schema and schemaVersion': {
    $schema: 'https://unpkg.com/@kurenwimpel/core/schema/ruleset.schema.json',
    schemaVersion: 1,
    flags: [flag],
    segments: [segment],
  },
  'a document with null sides': { flags: null, segments: [segment] },
  'a document of keyed objects': { flags: { checkout: flag }, segments: { beta: segment } },
  'envelope fields beside the definitions': {
    flags: [flag],
    etag: 'abc',
    generatedAt: 1_700_000_000,
    meta: { key: 'prod-ruleset' },
    links: { self: { key: 'x', href: '/flags' } },
  },
  'every operator': { flags: [everyOperator], segments: [segment] },
  'every optional flag field': [flag, everyField],
  'explicit nulls for optional fields': [nullOptionals],
  'explicit nulls inside lifecycle': [nullLifecycleFields],
  'every lifecycle kind': [
    { ...flag, key: 'a', lifecycle: { kind: 'release' } },
    { ...flag, key: 'b', lifecycle: { kind: 'experiment' } },
    { ...flag, key: 'c', lifecycle: { kind: 'ops' } },
    { ...flag, key: 'd', lifecycle: { kind: 'permission' } },
  ],
  'a leap day expiry': [{ ...flag, lifecycle: { expiresOn: '2028-02-29' } }],
  'segments of every kind': {
    flags: [],
    segments: [
      { key: 'out', excluded: ['user-2'], included: [], rules: null },
      {
        key: 'staff',
        rules: [
          { id: 'email', conditions: [conditionByOperator.endsWith, conditionByOperator.gt] },
        ],
      },
    ],
  },
};
