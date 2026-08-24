/**
 * Parsing whole rulesets: the payload a provider fetches.
 *
 * Batch parsing keeps the definitions that validate and collects issues for
 * the ones that do not — one bad flag must not take down the whole ruleset.
 */

import type { FlagDefinition } from '../model/flag.js';
import type { SegmentDefinition } from '../model/segment.js';
import { parseFlagDefinition } from './flag.js';
import { isRecord } from './primitives.js';
import type { FlagParseIssue } from './primitives.js';
import { parseSegmentDefinition } from './segment.js';

export interface ParseFlagsResult {
  readonly flags: FlagDefinition[];
  readonly issues: FlagParseIssue[];
}

export interface ParseSegmentsResult {
  readonly segments: SegmentDefinition[];
  readonly issues: FlagParseIssue[];
}

/**
 * The full document form a control plane ships: flags and the segments they
 * reference, parsed together so one payload carries everything a snapshot
 * needs.
 */
export interface ParseRulesetResult {
  readonly flags: FlagDefinition[];
  readonly segments: SegmentDefinition[];
  readonly issues: FlagParseIssue[];
}

/** Accepts an array of definitions or a key-to-definition object. */
export function parseFlagDefinitions(raw: unknown): ParseFlagsResult {
  const { entries, issues } = collectEntries(raw, 'flags');
  const flags = parseEach(entries, issues, parseFlagDefinition);
  return { flags, issues };
}

/** Accepts an array of definitions or a key-to-definition object. */
export function parseSegmentDefinitions(raw: unknown): ParseSegmentsResult {
  const { entries, issues } = collectEntries(raw, 'segments');
  const segments = parseEach(entries, issues, parseSegmentDefinition);
  return { segments, issues };
}

/**
 * Parses a whole ruleset payload. Three shapes are accepted:
 *
 * - an array of flag definitions;
 * - a key-to-definition object of flags (the legacy shape);
 * - a document `{ flags, segments }`, recognised by either property, where
 *   each side is again an array or a key-to-definition object.
 *
 * A key-to-definition object cannot itself use `flags` or `segments` as flag
 * keys — the document form wins that ambiguity.
 */
export function parseRuleset(raw: unknown): ParseRulesetResult {
  if (isRecord(raw) && ('flags' in raw || 'segments' in raw)) {
    const flagsPart =
      raw['flags'] === undefined ? { flags: [], issues: [] } : parseFlagDefinitions(raw['flags']);
    const segmentsPart =
      raw['segments'] === undefined
        ? { segments: [], issues: [] }
        : parseSegmentDefinitions(raw['segments']);

    return {
      flags: flagsPart.flags,
      segments: segmentsPart.segments,
      issues: [...flagsPart.issues, ...segmentsPart.issues],
    };
  }

  const { flags, issues } = parseFlagDefinitions(raw);
  return { flags, segments: [], issues };
}

interface CollectedEntries {
  readonly entries: [string, unknown][];
  readonly issues: FlagParseIssue[];
}

function collectEntries(raw: unknown, what: 'flags' | 'segments'): CollectedEntries {
  if (Array.isArray(raw)) {
    return {
      entries: raw.map((entry: unknown, index: number): [string, unknown] => [
        `${what}[${index}]`,
        entry,
      ]),
      issues: [],
    };
  }

  if (isRecord(raw)) {
    return { entries: Object.entries(raw), issues: [] };
  }

  return {
    entries: [],
    issues: [{ at: what, message: `expected an array or object of ${what}` }],
  };
}

function parseEach<T>(
  entries: readonly [string, unknown][],
  issues: FlagParseIssue[],
  parse: (raw: unknown) => T,
): T[] {
  const parsed: T[] = [];

  for (const [at, entry] of entries) {
    try {
      parsed.push(parse(entry));
    } catch (error) {
      issues.push({
        at: isRecord(entry) && typeof entry['key'] === 'string' ? entry['key'] : at,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return parsed;
}
