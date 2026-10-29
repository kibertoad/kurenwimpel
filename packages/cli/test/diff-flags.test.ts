import { parseRuleset } from '@kurenwimpel/core';
import { describe, expect, it } from 'vitest';

import { diffRuleset } from '../src/index.js';
import type { Change } from '../src/index.js';
import { checkout, readmeRuleset } from './fixtures.js';
import type { TestFlag, TestRule } from './fixtures.js';

const EVEN = [
  { variant: 'on', weight: 50 },
  { variant: 'off', weight: 50 },
];

/** The changes to the README flag after `edit` is applied to a copy of its ruleset. */
function changesAfter(edit: (flag: TestFlag, rules: TestRule[]) => void): Change[] {
  const before = readmeRuleset();
  const after = readmeRuleset();
  const { flag, rules } = checkout(after);
  edit(flag, rules);

  const diff = diffRuleset(parseRuleset(before), parseRuleset(after));
  return diff.flags.find((entry) => entry.key === 'new-checkout')?.changes.slice() ?? [];
}

function kinds(changes: readonly Change[]): string[] {
  return changes.map((item) => item.kind);
}

describe('diff, per flag', () => {
  it('reports nothing for an identical ruleset', () => {
    const diff = diffRuleset(parseRuleset(readmeRuleset()), parseRuleset(readmeRuleset()));
    expect(diff).toEqual({ flags: [], segments: [], reshuffles: false });
  });

  it('flags the kill switch', () => {
    const changes = changesAfter((flag) => {
      flag.enabled = false;
    });
    expect(changes).toEqual([
      expect.objectContaining({
        kind: 'kill-switch',
        at: 'enabled',
        from: true,
        to: false,
        reshuffles: false,
      }),
    ]);
  });

  it('calls a larger allocation widened', () => {
    const changes = changesAfter((flag) => {
      flag.allocation = { percent: 50 };
    });
    expect(changes).toEqual([
      expect.objectContaining({ kind: 'allocation-widened', from: 20, to: 50, reshuffles: false }),
    ]);
  });

  it('calls a smaller allocation narrowed', () => {
    const changes = changesAfter((flag) => {
      flag.allocation = { percent: 5 };
    });
    expect(changes).toEqual([
      expect.objectContaining({ kind: 'allocation-narrowed', from: 20, to: 5 }),
    ]);
  });

  it('reads a removed allocation as widened to everyone', () => {
    const changes = changesAfter((flag) => {
      delete flag.allocation;
    });
    expect(changes).toEqual([expect.objectContaining({ kind: 'allocation-widened', to: 100 })]);
  });

  it('calls a reweighting with the same total a shift that reshuffles nobody', () => {
    const changes = changesAfter((_flag, rules) => {
      rules[1]!.rollout = [
        { variant: 'on', weight: 70 },
        { variant: 'off', weight: 30 },
      ];
    });
    expect(changes).toEqual([
      expect.objectContaining({
        kind: 'rollout-shifted',
        at: 'rules[recent-app].rollout',
        from: 'on 50 / off 50',
        to: 'on 70 / off 30',
        reshuffles: false,
      }),
    ]);
  });

  it('calls a reweighting with a new total a reshuffle', () => {
    const changes = changesAfter((_flag, rules) => {
      rules[1]!.rollout = [
        { variant: 'on', weight: 80 },
        { variant: 'off', weight: 50 },
      ];
    });
    expect(changes).toEqual([
      expect.objectContaining({ kind: 'rollout-reshuffled', reshuffles: true }),
    ]);
    expect(changes[0]?.summary).toContain('total 100 to 130');
  });

  it('ignores a zero-weight bucket, which moves no boundary', () => {
    const changes = changesAfter((_flag, rules) => {
      rules[1]!.rollout = [...EVEN, { variant: 'on', weight: 0 }];
    });
    expect(changes).toEqual([]);
  });

  it.each([
    ['seed', { seed: 'iteration-2' }, 'rules[recent-app].rollout.seed'],
    ['bucketBy', { bucketBy: 'accountId' }, 'rules[recent-app].rollout.bucketBy'],
  ])('calls a changed rollout %s a reshuffle', (_name, extra, at) => {
    const changes = changesAfter((_flag, rules) => {
      rules[1]!.rollout = { buckets: EVEN, ...extra };
    });
    expect(changes).toEqual([
      expect.objectContaining({ kind: 'bucketing-changed', at, reshuffles: true }),
    ]);
  });

  it('calls a changed salt a reshuffle', () => {
    const changes = changesAfter((flag) => {
      flag.salt = 'checkout-v2';
    });
    expect(changes).toEqual([
      expect.objectContaining({
        kind: 'bucketing-changed',
        at: 'salt',
        from: 'new-checkout',
        to: 'checkout-v2',
        reshuffles: true,
      }),
    ]);
  });

  it('calls a changed allocation seed a reshuffle', () => {
    const changes = changesAfter((flag) => {
      flag.allocation = { percent: 20, seed: 'second-draw' };
    });
    expect(changes).toEqual([
      expect.objectContaining({ kind: 'bucketing-changed', at: 'allocation.seed' }),
    ]);
  });

  it('reports a flag-level rollout being added', () => {
    const added = changesAfter((flag) => {
      flag.rollout = [{ variant: 'on', weight: 1 }];
    });
    expect(added).toEqual([expect.objectContaining({ kind: 'rollout-added', to: 'on 1' })]);
  });
});

describe('diff, rules', () => {
  it('reports added rules', () => {
    const changes = changesAfter((_flag, rules) => {
      rules.unshift({ id: 'beta', conditions: [], variant: 'on' });
    });
    expect(changes).toEqual([
      expect.objectContaining({ kind: 'rules-added', added: 1, to: ['beta'] }),
    ]);
  });

  it('reports removed rules', () => {
    const changes = changesAfter((_flag, rules) => {
      rules.pop();
    });
    expect(changes).toEqual([
      expect.objectContaining({ kind: 'rules-removed', removed: 1, from: ['recent-app'] }),
    ]);
  });

  it('reports a reorder, since the first match wins', () => {
    const changes = changesAfter((_flag, rules) => {
      rules.reverse();
    });
    expect(changes).toEqual([
      expect.objectContaining({
        kind: 'rules-reordered',
        from: ['internal-staff', 'recent-app'],
        to: ['recent-app', 'internal-staff'],
      }),
    ]);
  });

  it('does not call an insertion a reorder', () => {
    const changes = changesAfter((_flag, rules) => {
      rules.splice(1, 0, { id: 'middle', conditions: [], variant: 'off' });
    });
    expect(kinds(changes)).toEqual(['rules-added']);
  });

  it('reports a rule whose conditions changed', () => {
    const changes = changesAfter((_flag, rules) => {
      rules[1]!.conditions = [{ attribute: 'appVersion', operator: 'semverGte', value: '2.5.0' }];
    });
    expect(changes).toEqual([
      expect.objectContaining({ kind: 'rule-changed', at: 'rules[recent-app]' }),
    ]);
  });
});

describe('diff, the rest of a definition', () => {
  it('counts individual targets added, removed and moved', () => {
    const changes = changesAfter((flag) => {
      flag.targets = [
        { variant: 'off', keys: ['qa-account-1'] },
        { variant: 'on', keys: ['qa-account-2', 'qa-account-3'] },
      ];
    });
    expect(changes).toEqual([
      expect.objectContaining({ kind: 'targets-changed', added: 2, removed: 0, changed: 1 }),
    ]);
  });

  it('reports variants, default and off variant, prerequisites and metadata', () => {
    const changes = changesAfter((flag) => {
      flag.variants = { on: true, off: false, dark: true };
      flag.defaultVariant = 'on';
      flag.offVariant = 'dark';
      flag.prerequisites = [];
      flag.metadata = { experiment: 'checkout-q4' };
    });
    expect(kinds(changes)).toEqual([
      'variants-changed',
      'default-variant-changed',
      'off-variant-changed',
      'prerequisites-changed',
      'metadata-changed',
    ]);
    expect(changes[0]).toMatchObject({ added: 1, removed: 0, changed: 0 });
  });

  it('reports flags added and removed without per-field changes', () => {
    const before = readmeRuleset();
    const after = readmeRuleset();
    after.flags[1]!.key = 'new-backend-v2';

    const diff = diffRuleset(parseRuleset(before), parseRuleset(after));
    expect(diff.flags).toEqual([
      { key: 'new-backend-v2', status: 'added', changes: [] },
      { key: 'new-backend', status: 'removed', changes: [] },
    ]);
  });
});
