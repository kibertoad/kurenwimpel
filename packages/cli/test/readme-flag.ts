/**
 * The README's "Example definition", verbatim; `readme-example.test.ts` keeps the two in step.
 * Imports no source module, so Stryker never runs that check in a sandbox without the README.
 */
export const README_FLAG = {
  key: 'new-checkout',
  enabled: true,
  variants: { on: true, off: false },
  defaultVariant: 'off',
  offVariant: 'off',
  metadata: { experiment: 'checkout-q3' },
  lifecycle: { owner: 'team-checkout', kind: 'experiment', expiresOn: '2027-03-31' },
  prerequisites: [{ flag: 'new-backend', variants: ['on'] }],
  targets: [{ variant: 'on', keys: ['qa-account-1'] }],
  allocation: { percent: 20 },
  rules: [
    {
      id: 'internal-staff',
      conditions: [{ operator: 'inSegment', segments: ['employees'] }],
      variant: 'on',
    },
    {
      id: 'recent-app',
      conditions: [{ attribute: 'appVersion', operator: 'semverGte', value: '2.4.0' }],
      rollout: [
        { variant: 'on', weight: 50 },
        { variant: 'off', weight: 50 },
      ],
    },
  ],
};
