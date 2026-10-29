export const ACTOR = { type: 'user', id: 'oidc|42', displayName: 'Ada' } as const;

export const AT = '2026-11-03T09:00:00Z';

export const FLAG_DEFINITION = {
  key: 'new-checkout',
  enabled: true,
  variants: { on: true, off: false },
  defaultVariant: 'off',
  offVariant: 'off',
  rollout: { variants: [{ variant: 'on', weight: 5000 }] },
};

export const SEGMENT_DEFINITION = {
  key: 'beta-testers',
  included: ['user-1', 'user-2'],
  rules: [{ id: 'staff', conditions: [] }],
};

export const SCHEDULE_ENTRY = {
  id: 'checkout-ramp-50',
  at: AT,
  flag: 'new-checkout',
  set: { rollout: { variants: [{ variant: 'on', weight: 5000 }] } },
};

export const REVISION = 'a'.repeat(64);

export const ENVIRONMENT = {
  key: 'production',
  name: 'Production',
  protected: true,
  requiredApprovals: 1,
  target: { type: 'kv', namespaceId: '0f2a' },
  roleBindings: [{ group: 'checkout-approvers', role: 'approver' }],
  source: 'service',
  version: 3,
  createdAt: AT,
  updatedAt: AT,
};

export const CHANGE_REQUEST = {
  id: 'cr_1',
  title: 'Ramp checkout to 50%',
  status: 'open',
  author: ACTOR,
  operations: [{ op: 'putFlag', definition: FLAG_DEFINITION, expectedVersion: 4 }],
  reviews: [],
  version: 1,
  createdAt: AT,
  updatedAt: AT,
};

export const BEARER = { authorization: 'Bearer eyJ.token' };
