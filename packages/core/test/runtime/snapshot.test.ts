import { describe, expect, it } from 'vitest';

import { createSnapshot, parseRuleset } from '../../src/index.js';
import type { FlagDefinition } from '../../src/index.js';

describe('createSnapshot resolves duplicates the way the parser does', () => {
  const first: FlagDefinition = {
    key: 'dup',
    enabled: true,
    variants: { on: true, off: false },
    defaultVariant: 'on',
    offVariant: 'off',
  };
  const second: FlagDefinition = { ...first, enabled: false };

  it('keeps the first of two flags sharing a key', () => {
    // The parser keeps the first and reports the rest; this used to keep the
    // last, so a provider merging a bootstrap with a fetched ruleset got the
    // opposite answer from each half of the same pipeline.
    expect(createSnapshot([first, second]).flags.get('dup')?.enabled).toBe(true);
    expect(createSnapshot([second, first]).flags.get('dup')?.enabled).toBe(false);
  });

  it('agrees with parseRuleset on the same input', () => {
    const parsed = parseRuleset([first, second]);

    expect(parsed.flags).toHaveLength(1);
    expect(createSnapshot([first, second]).flags.get('dup')?.enabled).toBe(
      parsed.flags[0]?.enabled,
    );
  });

  it('keeps the first of two segments sharing a key', () => {
    const snapshot = createSnapshot([], {}, [
      { key: 'beta', included: ['first'] },
      { key: 'beta', included: ['second'] },
    ]);

    expect(snapshot.segments.get('beta')?.included).toEqual(new Set(['first']));
  });
});
