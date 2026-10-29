import { conditionByOperator, flag, segment } from './accepted-fixtures.js';

const withRule = (rule: Record<string, unknown>): unknown => [
  { ...flag, rules: [{ id: 'r', conditions: [], variant: 'on', ...rule }] },
];

const withCondition = (condition: Record<string, unknown>): unknown => ({
  flags: [withFlagCondition(condition)],
  segments: [segment],
});

const withFlagCondition = (condition: Record<string, unknown>): unknown => ({
  ...flag,
  rules: [{ id: 'r', conditions: [condition], variant: 'on' }],
});

const withSegment = (fields: Record<string, unknown>): unknown => ({
  segments: [{ key: 'seg', ...fields }],
});

/** Documents `parseRuleset` reports an issue for, by shape alone; each must fail the schema. */
export const rejected: Record<string, unknown> = {
  'a string payload': 'flags',
  'flags that are not a collection': { flags: 5 },
  'a flag that is not an object': [true],
  'a flag without a key': [{ ...flag, key: undefined }],
  'an empty key': [{ ...flag, key: '' }],
  'enabled as a string': [{ ...flag, enabled: 'yes' }],
  'no variants': [{ ...flag, variants: undefined }],
  'an empty variant map': [{ ...flag, variants: {} }],
  'a null variant value': [{ ...flag, variants: { on: null, off: false } }],
  'an array variant value': [{ ...flag, variants: { on: [1], off: false } }],
  'a missing defaultVariant': [{ ...flag, defaultVariant: undefined }],
  'a numeric offVariant': [{ ...flag, offVariant: 0 }],
  'prerequisites as an object': [{ ...flag, prerequisites: {} }],
  'a prerequisite with no variants': [
    flag,
    { ...flag, key: 'b', prerequisites: [{ flag: 'checkout', variants: [] }] },
  ],
  'a target listing a key twice': [{ ...flag, targets: [{ variant: 'on', keys: ['a', 'a'] }] }],
  'a target without keys': [{ ...flag, targets: [{ variant: 'on' }] }],
  'allocation over 100': [{ ...flag, allocation: { percent: 101 } }],
  'allocation without percent': [{ ...flag, allocation: { seed: 's' } }],
  'an empty allocation seed': [{ ...flag, allocation: { percent: 5, seed: '' } }],
  'a negative weight': [{ ...flag, rollout: [{ variant: 'on', weight: -1 }] }],
  'a bucket without a weight': [{ ...flag, rollout: [{ variant: 'on' }] }],
  'a split without buckets': [{ ...flag, rollout: { seed: 's' } }],
  'metadata holding an object': [{ ...flag, metadata: { owner: { team: 'growth' } } }],
  'an empty salt': [{ ...flag, salt: '' }],
  'lifecycle as a string': [{ ...flag, lifecycle: 'release' }],
  'an unknown lifecycle kind': [{ ...flag, lifecycle: { kind: 'temporary' } }],
  'an empty lifecycle owner': [{ ...flag, lifecycle: { owner: '' } }],
  'a numeric lifecycle owner': [{ ...flag, lifecycle: { owner: 42 } }],
  'an expiry with a time': [{ ...flag, lifecycle: { expiresOn: '2027-01-31T00:00:00Z' } }],
  'an expiry in month 13': [{ ...flag, lifecycle: { expiresOn: '2027-13-01' } }],
  'lifecycle tags as a string': [{ ...flag, lifecycle: { tags: 'checkout' } }],
  'a numeric lifecycle tag': [{ ...flag, lifecycle: { tags: [1] } }],
  'a string version': [{ ...flag, version: '7' }],
  'rules as an object': [{ ...flag, rules: {} }],
  'a rule without an id': withRule({ id: undefined }),
  'a rule without conditions': withRule({ conditions: undefined }),
  'a rule with neither variant nor rollout': withRule({ variant: undefined }),
  'a rule with an empty rollout and no variant': withRule({ variant: null, rollout: [] }),
  'a rule with an empty split and no variant': withRule({
    variant: undefined,
    rollout: { buckets: [] },
  }),
  'a condition without an operator': withCondition({ attribute: 'plan', value: 1 }),
  'an unknown operator': withCondition({ attribute: 'plan', operator: 'matches', value: '.*' }),
  'a condition without an attribute': withCondition({ operator: 'eq', value: 1 }),
  'eq with an array': withCondition({ attribute: 'plan', operator: 'eq', value: ['a'] }),
  'eq without a value': withCondition({ attribute: 'plan', operator: 'eq' }),
  'in with a scalar': withCondition({ attribute: 'plan', operator: 'in', value: 'pro' }),
  'in with a boolean member': withCondition({ attribute: 'plan', operator: 'in', value: [true] }),
  'contains with a number': withCondition({ attribute: 'plan', operator: 'contains', value: 1 }),
  'gt with a string': withCondition({ attribute: 'seats', operator: 'gt', value: '10' }),
  'a malformed semver': withCondition({ attribute: 'app', operator: 'semverGte', value: '2.x' }),
  'inSegment with no segments': withCondition({ operator: 'inSegment', segments: [] }),
  'notInSegment without segments': withCondition({ operator: 'notInSegment' }),
  'a segment with no criteria': withSegment({}),
  'a segment with only empty lists': withSegment({ included: [], excluded: [], rules: [] }),
  'a segment with an empty key': { segments: [{ ...segment, key: '' }] },
  'a segment list of numbers': withSegment({ included: [1] }),
  'a segment rule with no conditions': withSegment({ rules: [{ id: 'r', conditions: [] }] }),
  'a segment rule using inSegment': withSegment({
    rules: [{ id: 'r', conditions: [conditionByOperator.inSegment] }],
  }),
  'a misspelled segments key': { flags: [flag], segmnets: [segment] },
  'a flag collection under another key': { segments: [], legacy: { checkout: flag } },
  'a newer schemaVersion': { schemaVersion: 2, flags: [flag] },
  'a string schemaVersion': { schemaVersion: '1', flags: [flag] },
  'a zero schemaVersion': { schemaVersion: 0, flags: [flag] },
  '$schema in a key-to-flag object': { $schema: 'x', checkout: flag },
};
