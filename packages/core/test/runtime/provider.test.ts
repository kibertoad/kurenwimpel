import { describe, expect, it } from 'vitest';

import { StaticProvider } from '../../src/index.js';
import type { FlagDefinition } from '../../src/index.js';

const flag = (key: string, overrides: Partial<FlagDefinition> = {}): FlagDefinition => ({
  key,
  enabled: true,
  variants: { on: true, off: false },
  defaultVariant: 'on',
  offVariant: 'off',
  ...overrides,
});

describe('StaticProvider', () => {
  it('is named for what it is', () => {
    // The name reaches every ClientErrorInfo and every "not loaded yet"
    // message, so an operator reading an alert can tell which source it was.
    expect(new StaticProvider().name).toBe('static');
  });

  it('holds an empty ruleset when constructed bare', async () => {
    const snapshot = await new StaticProvider().load();
    expect(snapshot?.flags.size).toBe(0);
    expect(snapshot?.segments.size).toBe(0);
  });

  it('snapshots the definitions and the meta it was handed', async () => {
    const provider = new StaticProvider([flag('a')], { version: 'v1', fetchedAt: 123 });
    const snapshot = await provider.load();

    expect(snapshot?.flags.get('a')?.key).toBe('a');
    expect(snapshot?.version).toBe('v1');
    expect(snapshot?.fetchedAt).toBe(123);
  });

  it('compiles the segments it was handed, so segment rules resolve', async () => {
    const provider = new StaticProvider([flag('a')], {
      segments: [{ key: 'beta', included: ['u1'] }],
    });

    const snapshot = await provider.load();
    expect(snapshot?.segments.get('beta')?.included.has('u1')).toBe(true);
  });

  it('serves the replaced definitions, segments included, on the next load', async () => {
    const provider = new StaticProvider([flag('a')]);
    provider.replace([flag('b')], { segments: [{ key: 'beta', included: ['u1'] }] });

    const snapshot = await provider.load();
    expect(snapshot?.flags.has('a')).toBe(false);
    expect(snapshot?.flags.has('b')).toBe(true);
    expect(snapshot?.segments.get('beta')?.included.has('u1')).toBe(true);
  });
});
