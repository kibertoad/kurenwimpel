/**
 * Validation for flag definitions.
 *
 * Everything a control plane can express is checked here, up front: variant
 * references resolve, weights carry usable mass, values are OFREP-expressible.
 * Every failure the parser can catch is one the evaluator never has to handle
 * on a request.
 */

import type {
  FlagDefinition,
  FlagMetadata,
  Prerequisite,
  Rollout,
  RolloutBucket,
  TargetingRule,
  TrafficAllocation,
  VariantTarget,
} from '../model/flag.js';
import type { FlagValue } from '../model/json.js';
import { parseCondition } from './condition.js';
import {
  fail,
  isRecord,
  requireFiniteNumber,
  requireString,
  requireStringArray,
} from './primitives.js';

/**
 * Validates one definition.
 *
 * @throws {FlagParseError} when the shape is not a usable flag.
 */
export function parseFlagDefinition(raw: unknown): FlagDefinition {
  if (!isRecord(raw)) fail('flag must be an object');

  const key = requireString(raw['key'], 'key');
  const enabled = raw['enabled'];
  if (typeof enabled !== 'boolean') fail(`flag ${key}: enabled must be a boolean`);

  const variants = parseVariants(raw['variants'], key);
  const variantNames = Object.keys(variants);

  const defaultVariant = requireString(raw['defaultVariant'], `flag ${key}: defaultVariant`);
  const offVariant = requireString(raw['offVariant'], `flag ${key}: offVariant`);

  for (const [field, variant] of [
    ['defaultVariant', defaultVariant],
    ['offVariant', offVariant],
  ] as const) {
    if (!variantNames.includes(variant)) {
      fail(`flag ${key}: ${field} points at unknown variant ${variant}`);
    }
  }

  const prerequisites = parsePrerequisites(raw['prerequisites'], key);
  const targets = parseTargets(raw['targets'], key, variantNames);
  const allocation = parseAllocation(raw['allocation'], key);
  const rules = parseRules(raw['rules'], key, variantNames);
  const rollout = parseRollout(raw['rollout'], `flag ${key}`, variantNames);
  const metadata = parseMetadata(raw['metadata'], key);

  // A malformed salt or version must reject the flag, not be silently
  // dropped — losing a salt reshuffles every split of the flag.
  const salt = raw['salt'];
  if (salt !== undefined && salt !== null && (typeof salt !== 'string' || salt.length === 0)) {
    fail(`flag ${key}: salt must be a non-empty string`);
  }
  const version = raw['version'];
  if (
    version !== undefined &&
    version !== null &&
    (typeof version !== 'number' || !Number.isFinite(version))
  ) {
    fail(`flag ${key}: version must be a finite number`);
  }

  return {
    key,
    enabled,
    variants,
    defaultVariant,
    offVariant,
    ...(prerequisites === undefined ? {} : { prerequisites }),
    ...(targets === undefined ? {} : { targets }),
    ...(allocation === undefined ? {} : { allocation }),
    ...(rules === undefined ? {} : { rules }),
    ...(rollout === undefined ? {} : { rollout }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(typeof salt === 'string' ? { salt } : {}),
    ...(typeof version === 'number' ? { version } : {}),
  };
}

/**
 * Variant values must be expressible on the OFREP wire: boolean, string,
 * finite number, or a JSON object. A top-level `null` or array is rejected
 * here rather than discovered when the flag cannot be served over the
 * protocol — nest arrays inside an object instead.
 */
function parseVariants(raw: unknown, key: string): Record<string, FlagValue> {
  if (!isRecord(raw)) fail(`flag ${key}: variants must be an object`);

  const names = Object.keys(raw);
  if (names.length === 0) fail(`flag ${key}: needs at least one variant`);

  for (const name of names) {
    const value = raw[name];
    const usable =
      typeof value === 'boolean' ||
      typeof value === 'string' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      isRecord(value);

    if (!usable) {
      fail(
        `flag ${key}: variant ${name} must be a boolean, string, finite number, or JSON object` +
          ' — OFREP cannot carry a top-level null or array',
      );
    }
  }

  // Every value was checked against the FlagValue union just above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return raw as Record<string, FlagValue>;
}

function parsePrerequisites(raw: unknown, key: string): Prerequisite[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) fail(`flag ${key}: prerequisites must be an array`);

  return raw.map((entry: unknown, index: number): Prerequisite => {
    if (!isRecord(entry)) fail(`flag ${key}: prerequisite ${index} must be an object`);

    const flag = requireString(entry['flag'], `flag ${key}: prerequisite ${index} flag`);
    if (flag === key) fail(`flag ${key}: cannot be its own prerequisite`);

    const variants = requireStringArray(
      entry['variants'],
      `flag ${key}: prerequisite ${flag} variants`,
    );
    if (variants.length === 0) {
      fail(`flag ${key}: prerequisite ${flag} needs at least one variant`);
    }

    return { flag, variants };
  });
}

function parseTargets(
  raw: unknown,
  key: string,
  variantNames: readonly string[],
): VariantTarget[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) fail(`flag ${key}: targets must be an array`);

  const seen = new Set<string>();

  return raw.map((entry: unknown, index: number): VariantTarget => {
    if (!isRecord(entry)) fail(`flag ${key}: target ${index} must be an object`);

    const variant = requireString(entry['variant'], `flag ${key}: target ${index} variant`);
    if (!variantNames.includes(variant)) {
      fail(`flag ${key}: target points at unknown variant ${variant}`);
    }

    const keys = requireStringArray(entry['keys'], `flag ${key}: target ${variant} keys`);
    for (const targetKey of keys) {
      if (seen.has(targetKey)) {
        fail(`flag ${key}: targeting key "${targetKey}" appears in more than one target`);
      }
      seen.add(targetKey);
    }

    return { variant, keys };
  });
}

function parseAllocation(raw: unknown, key: string): TrafficAllocation | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) fail(`flag ${key}: allocation must be an object`);

  const percent = requireFiniteNumber(raw['percent'], `flag ${key}: allocation percent`);
  if (percent < 0 || percent > 100) {
    fail(`flag ${key}: allocation percent must be between 0 and 100`);
  }

  const seed = raw['seed'];
  if (seed !== undefined && seed !== null && typeof seed !== 'string') {
    fail(`flag ${key}: allocation seed must be a string`);
  }
  return { percent, ...(typeof seed === 'string' ? { seed } : {}) };
}

function parseRules(
  raw: unknown,
  key: string,
  variantNames: readonly string[],
): TargetingRule[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) fail(`flag ${key}: rules must be an array`);

  return raw.map((entry: unknown, index: number): TargetingRule => {
    if (!isRecord(entry)) fail(`flag ${key}: rule ${index} must be an object`);

    const id = requireString(entry['id'], `flag ${key}: rule ${index} id`);
    const conditionsRaw = entry['conditions'];
    if (!Array.isArray(conditionsRaw)) {
      fail(`flag ${key}: rule ${id} needs a conditions array`);
    }

    const where = `flag ${key}: rule ${id}`;
    const conditions = conditionsRaw.map((condition: unknown) => parseCondition(condition, where));
    const rollout = parseRollout(entry['rollout'], where, variantNames);
    const variantRaw = entry['variant'];

    if (variantRaw !== undefined) {
      const name = requireString(variantRaw, `${where} variant`);
      if (!variantNames.includes(name)) {
        fail(`${where} points at unknown variant ${name}`);
      }
    }

    if (variantRaw === undefined && rollout === undefined) {
      fail(`${where} must declare a variant or a rollout`);
    }

    return {
      id,
      conditions,
      ...(typeof variantRaw === 'string' ? { variant: variantRaw } : {}),
      ...(rollout === undefined ? {} : { rollout }),
    };
  });
}

/** Accepts both wire forms of a split: a bare bucket array, or a split object. */
function parseRollout(
  raw: unknown,
  where: string,
  variantNames: readonly string[],
): Rollout | undefined {
  if (raw === undefined || raw === null) return undefined;

  if (Array.isArray(raw)) {
    if (raw.length === 0) return undefined;
    return parseBuckets(raw, where, variantNames);
  }

  if (!isRecord(raw)) fail(`${where}: rollout must be a bucket array or a split object`);

  const bucketsRaw = raw['buckets'];
  if (!Array.isArray(bucketsRaw) || bucketsRaw.length === 0) {
    fail(`${where}: rollout needs a non-empty buckets array`);
  }

  const buckets = parseBuckets(bucketsRaw, where, variantNames);

  // Malformed knobs reject the flag like every other field: silently dropping
  // a bucketBy or seed would quietly reassign the whole cohort.
  const bucketBy = raw['bucketBy'];
  if (
    bucketBy !== undefined &&
    bucketBy !== null &&
    (typeof bucketBy !== 'string' || bucketBy.length === 0)
  ) {
    fail(`${where}: rollout bucketBy must be a non-empty string`);
  }
  const seed = raw['seed'];
  if (seed !== undefined && seed !== null && typeof seed !== 'string') {
    fail(`${where}: rollout seed must be a string`);
  }

  return {
    buckets,
    ...(typeof bucketBy === 'string' ? { bucketBy } : {}),
    ...(typeof seed === 'string' ? { seed } : {}),
  };
}

function parseBuckets(
  raw: readonly unknown[],
  where: string,
  variantNames: readonly string[],
): RolloutBucket[] {
  let total = 0;

  const buckets = raw.map((entry: unknown, index: number): RolloutBucket => {
    if (!isRecord(entry)) fail(`${where}: rollout bucket ${index} must be an object`);

    const variant = requireString(entry['variant'], `${where}: rollout bucket ${index} variant`);
    if (!variantNames.includes(variant)) {
      fail(`${where}: rollout points at unknown variant ${variant}`);
    }

    const weight = entry['weight'];
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
      fail(`${where}: rollout bucket ${variant} needs a non-negative finite weight`);
    }

    total += weight;
    return { variant, weight };
  });

  // An all-zero split is legal — a parked experiment — and evaluation falls
  // through to the default variant. A non-finite total is not: it would send
  // every subject to the last bucket.
  if (!Number.isFinite(total)) {
    fail(`${where}: rollout weights must add up to a finite total`);
  }
  return buckets;
}

function parseMetadata(raw: unknown, key: string): FlagMetadata | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) fail(`flag ${key}: metadata must be an object`);

  for (const [field, value] of Object.entries(raw)) {
    if (typeof value !== 'boolean' && typeof value !== 'string' && typeof value !== 'number') {
      fail(`flag ${key}: metadata ${field} must be a boolean, string, or number`);
    }
  }

  // Every value was checked against the scalar union just above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return raw as FlagMetadata;
}
