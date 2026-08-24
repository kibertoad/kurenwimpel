import { describe, expect, it } from 'vitest';

import { FeatureFlagClient, StaticProvider } from '../../src/index.js';
import type { EvaluationContext, FlagDefinition } from '../../src/index.js';

const flags: FlagDefinition[] = [
  {
    key: 'new-checkout',
    enabled: true,
    variants: { on: true, off: false },
    defaultVariant: 'on',
    offVariant: 'off',
  },
  {
    key: 'greeting',
    enabled: true,
    variants: { formal: 'Good day', casual: 'Hey' },
    defaultVariant: 'casual',
    offVariant: 'formal',
  },
  {
    key: 'rate-limit',
    enabled: true,
    variants: { standard: { perMinute: 60 } },
    defaultVariant: 'standard',
    offVariant: 'standard',
  },
];

/** Gated on an attribute that only ever arrives through the default context. */
const staffOnly: FlagDefinition = {
  key: 'staff',
  enabled: true,
  variants: { on: true, off: false },
  defaultVariant: 'off',
  offVariant: 'off',
  rules: [
    {
      id: 'internal',
      conditions: [{ attribute: 'service', operator: 'eq', value: 'billing' }],
      variant: 'on',
    },
  ],
};

async function makeClient(extra: FlagDefinition[] = []): Promise<FeatureFlagClient> {
  const client = new FeatureFlagClient({ provider: new StaticProvider([...flags, ...extra]) });
  await client.init();
  return client;
}

describe('FeatureFlagClient', () => {
  it('is not ready before init and reports it on evaluation', () => {
    const client = new FeatureFlagClient({ provider: new StaticProvider(flags) });

    expect(client.ready).toBe(false);
    expect(client.getBoolean('new-checkout', false)).toBe(false);
    expect(client.getBooleanDetails('new-checkout', false).errorCode).toBe('PROVIDER_NOT_READY');
  });

  it('resolves typed values after init', async () => {
    const client = await makeClient();

    expect(client.getBoolean('new-checkout', false)).toBe(true);
    expect(client.getString('greeting', 'fallback')).toBe('Hey');
    expect(client.getObject('rate-limit', { perMinute: 1 })).toEqual({ perMinute: 60 });
  });

  it('falls back and reports FLAG_NOT_FOUND for unknown keys', async () => {
    const client = await makeClient();
    const details = client.getBooleanDetails('does-not-exist', true);

    expect(details.value).toBe(true);
    expect(details.errorCode).toBe('FLAG_NOT_FOUND');
    expect(details.reason).toBe('ERROR');
  });

  it('falls back on a type mismatch rather than returning the wrong shape', async () => {
    const client = await makeClient();
    const details = client.getBooleanDetails('greeting', false);

    expect(details.value).toBe(false);
    expect(details.errorCode).toBe('TYPE_MISMATCH');
  });

  it('rejects a non-finite number variant', async () => {
    const client = await makeClient([
      {
        key: 'broken-number',
        enabled: true,
        variants: { bad: Number.NaN },
        defaultVariant: 'bad',
        offVariant: 'bad',
      },
    ]);

    expect(client.getNumberDetails('broken-number', 5).errorCode).toBe('TYPE_MISMATCH');
  });

  it('merges the default context under the per-call context, flat', async () => {
    const provider = new StaticProvider([
      {
        key: 'regional',
        enabled: true,
        variants: { on: true, off: false },
        defaultVariant: 'off',
        offVariant: 'off',
        rules: [
          {
            id: 'eu-pro',
            conditions: [
              { attribute: 'region', operator: 'eq', value: 'eu' },
              { attribute: 'plan', operator: 'eq', value: 'pro' },
            ],
            variant: 'on',
          },
        ],
      },
    ]);

    const client = new FeatureFlagClient({ provider, defaultContext: { region: 'eu' } });
    await client.init();

    expect(client.getBoolean('regional', false, { plan: 'pro' })).toBe(true);
    // Per-call attributes win over the defaults.
    expect(client.getBoolean('regional', false, { plan: 'pro', region: 'us' })).toBe(false);
    // Naming an attribute as undefined clears the default for this one call —
    // the only way to say "this request has no region". Leaving it out inherits.
    expect(client.getBoolean('regional', false, { plan: 'pro', region: undefined })).toBe(false);
  });

  it('keeps an own __proto__ key in a JSON-parsed context out of targeting', async () => {
    const provider = new StaticProvider([
      {
        key: 'enterprise-only',
        enabled: true,
        variants: { on: true, off: false },
        defaultVariant: 'off',
        offVariant: 'off',
        rules: [
          {
            id: 'paid',
            conditions: [{ attribute: 'plan', operator: 'eq', value: 'enterprise' }],
            variant: 'on',
          },
        ],
      },
    ]);
    const client = new FeatureFlagClient({ provider, defaultContext: { region: 'eu' } });
    await client.init();

    // JSON.parse yields an own, enumerable '__proto__' key; merging it must
    // not install a prototype whose attributes targeting can then read.
    const hostile = JSON.parse(
      '{"targetingKey":"u1","__proto__":{"plan":"enterprise"}}',
    ) as EvaluationContext;

    expect(client.getBoolean('enterprise-only', false, hostile)).toBe(false);
  });

  it('reads an explicit null context as no context, not as a crash', async () => {
    // A JavaScript caller can pass null past the optional parameter. The
    // getters are documented never to throw, and `evaluateFlag` already
    // absorbs the same mistake one layer down; merging used to walk straight
    // into `Object.entries(null)`.
    const client = new FeatureFlagClient({
      provider: new StaticProvider([staffOnly]),
      defaultContext: { service: 'billing' },
    });
    await client.init();

    expect(client.getBoolean('staff', false, null as unknown as EvaluationContext)).toBe(true);
    expect(client.evaluate('staff', null as unknown as EvaluationContext).variant).toBe('on');
  });

  it('does not let a non-enumerable own attribute erase the default', async () => {
    // The two halves of the merge have to agree on what "the call said
    // something about this attribute" means. Deciding it with `Object.hasOwn`
    // while copying values with `Object.entries` let a non-enumerable own
    // property suppress the default without supplying anything in its place,
    // so targeting saw neither value.
    const context = {} as Record<string, string>;
    Object.defineProperty(context, 'service', { value: 'shipping', enumerable: false });

    const client = new FeatureFlagClient({
      provider: new StaticProvider([staffOnly]),
      defaultContext: { service: 'billing' },
    });
    await client.init();

    expect(client.getBoolean('staff', false, context)).toBe(true);
  });

  it('applies the default context when no per-call context is given', async () => {
    const client = new FeatureFlagClient({
      provider: new StaticProvider([staffOnly]),
      defaultContext: { service: 'billing' },
    });
    await client.init();

    expect(client.getBoolean('staff', false)).toBe(true);
  });

  it('does not follow a default context mutated after construction', async () => {
    // The default context's entries are walked once, at construction. Reading
    // the live object on the no-context path as well made the same flag answer
    // two ways in one process, deciding it on nothing but whether the call site
    // happened to pass a context.
    const defaults: Record<string, string> = { service: 'shipping' };
    const client = new FeatureFlagClient({
      provider: new StaticProvider([staffOnly]),
      defaultContext: defaults,
    });
    await client.init();

    defaults['service'] = 'billing';

    expect(client.getBoolean('staff', false)).toBe(false);
    expect(client.getBoolean('staff', false, { plan: 'pro' })).toBe(false);
  });

  it('resolves segment conditions against the snapshot segments', async () => {
    const provider = new StaticProvider(
      [
        {
          key: 'beta-feature',
          enabled: true,
          variants: { on: true, off: false },
          defaultVariant: 'off',
          offVariant: 'off',
          rules: [
            {
              id: 'beta',
              conditions: [{ operator: 'inSegment', segments: ['beta-testers'] }],
              variant: 'on',
            },
          ],
        },
      ],
      { segments: [{ key: 'beta-testers', included: ['user-in'] }] },
    );

    const client = new FeatureFlagClient({ provider });
    await client.init();

    expect(client.getBoolean('beta-feature', false, { targetingKey: 'user-in' })).toBe(true);
    expect(client.getBoolean('beta-feature', false, { targetingKey: 'user-out' })).toBe(false);
  });

  it('resolves prerequisites against the snapshot flags', async () => {
    const client = await makeClient([
      {
        key: 'dependent',
        enabled: true,
        variants: { on: true, off: false },
        defaultVariant: 'on',
        offVariant: 'off',
        prerequisites: [{ flag: 'greeting', variants: ['casual'] }],
      },
    ]);

    expect(client.getBooleanDetails('dependent', false).reason).toBe('STATIC');
  });
});
