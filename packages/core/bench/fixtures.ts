/**
 * Ruleset builders shared by every benchmark, including the workerd one in
 * `packages/cloudflare/bench`. Everything here returns plain wire-form JSON, so
 * a benchmark can serialise it and time the same path a provider takes.
 */

import type { FlagDefinition, SegmentDefinition } from '../src/index.js';

export const CONTEXT = { targetingKey: 'user-4242', country: 'DE', plan: 'pro', age: 34 };

const MIB = 1024 * 1024;

export function trivialFlag(key: string): FlagDefinition {
  return {
    key,
    enabled: true,
    variants: { on: true, off: false },
    defaultVariant: 'on',
    offVariant: 'off',
  };
}

/** Twenty rules that all miss for {@link CONTEXT}, then a 50/50 rollout. */
export function ruleHeavyFlag(key: string, ruleCount = 20): FlagDefinition {
  const rules = Array.from({ length: ruleCount }, (_unused, index) => ({
    id: `rule-${index}`,
    conditions: [
      { attribute: 'country', operator: 'in' as const, value: ['US', 'CA', `X${index}`] },
      { attribute: 'age', operator: 'gte' as const, value: 18 },
    ],
    variant: 'on',
  }));
  return {
    ...trivialFlag(key),
    rules,
    rollout: [
      { variant: 'on', weight: 50 },
      { variant: 'off', weight: 50 },
    ],
  };
}

/** `${prefix}-0` requires `${prefix}-1`, which requires `${prefix}-2`, and so on. */
export function prerequisiteChain(prefix: string, depth: number): FlagDefinition[] {
  return Array.from({ length: depth + 1 }, (_unused, index) => {
    const flag = trivialFlag(`${prefix}-${index}`);
    if (index === depth) return flag;
    return { ...flag, prerequisites: [{ flag: `${prefix}-${index + 1}`, variants: ['on'] }] };
  });
}

export function largeSegment(key: string, size: number): SegmentDefinition {
  return { key, included: Array.from({ length: size }, (_unused, index) => `user-${index}`) };
}

export function segmentFlag(key: string, segment: string): FlagDefinition {
  return {
    ...trivialFlag(key),
    defaultVariant: 'off',
    rules: [
      {
        id: 'members',
        conditions: [{ operator: 'inSegment', segments: [segment] }],
        variant: 'on',
      },
    ],
  };
}

export interface RulesetDocument {
  readonly flags: FlagDefinition[];
  readonly segments: SegmentDefinition[];
}

/**
 * A mixed ruleset: one flag in ten carries twenty rules, the rest are trivial,
 * and every flag has a handful of individual targets.
 */
export function mixedRuleset(flagCount: number): RulesetDocument {
  const flags = Array.from({ length: flagCount }, (_unused, index) => {
    const key = `flag-${index}`;
    const flag = index % 10 === 0 ? ruleHeavyFlag(key) : trivialFlag(key);
    return { ...flag, targets: [{ variant: 'off', keys: [`blocked-${index}`, `qa-${index}`] }] };
  });
  return { flags, segments: [] };
}

export function segmentRuleset(segmentSize: number): RulesetDocument {
  return {
    flags: [segmentFlag('beta', 'testers')],
    segments: [largeSegment('testers', segmentSize)],
  };
}

/** The serialised rulesets the snapshot-build benchmarks time, labelled with their size. */
export function snapshotPayloads(): ReadonlyMap<string, string> {
  const documents: [string, RulesetDocument][] = [
    ['1 000 flags', mixedRuleset(1000)],
    ['20 000 flags', mixedRuleset(20_000)],
    ['one 100 000-key segment', segmentRuleset(100_000)],
  ];
  return new Map(
    documents.map(([label, document]) => {
      const payload = JSON.stringify(document);
      return [`${label}, ${(payload.length / MIB).toFixed(2)} MiB`, payload];
    }),
  );
}
