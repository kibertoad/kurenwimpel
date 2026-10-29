import { createSnapshot, parseRuleset } from '../src/index.js';
import type { FlagSnapshot } from '../src/index.js';

/** What a provider does with a fetched payload: parse the JSON, validate it, build the snapshot. */
export function buildSnapshot(payload: string): FlagSnapshot {
  const { flags, segments } = parseRuleset(JSON.parse(payload));
  return createSnapshot(flags, {}, segments);
}
