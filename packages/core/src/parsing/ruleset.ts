/**
 * Parsing whole rulesets: the payload a provider fetches.
 *
 * Batch parsing keeps the definitions that validate and collects issues for
 * the ones that do not — one bad flag must not take down the whole ruleset.
 */

import type { FlagDefinition } from '../model/flag.js';
import type { SegmentDefinition } from '../model/segment.js';
import { parseFlagDefinition } from './flag.js';
import { isKeyedDefinition, isRecord } from './primitives.js';
import type { FlagParseIssue } from './primitives.js';
import { checkCrossReferences } from './references.js';
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
  const flags = parseEach(entries, issues, parseFlagDefinition, 'flag');
  return { flags, issues };
}

/** Accepts an array of definitions or a key-to-definition object. */
export function parseSegmentDefinitions(raw: unknown): ParseSegmentsResult {
  const { entries, issues } = collectEntries(raw, 'segments');
  const segments = parseEach(entries, issues, parseSegmentDefinition, 'segment');
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
 * keys — the document form wins that ambiguity, and says so: anything else in
 * the document that could have been a definition collection is reported rather
 * than dropped. See {@link checkDocumentKeys}.
 *
 * References between the two sides are checked once both are parsed; see
 * {@link checkCrossReferences}.
 */
export function parseRuleset(raw: unknown): ParseRulesetResult {
  if (isRecord(raw) && ('flags' in raw || 'segments' in raw)) {
    // An explicit `null` reads as absent, the rule every optional field in the
    // parser follows. A control plane that serialises an empty segment set as
    // null should not draw a parse issue on every refresh.
    const rawFlags = raw['flags'] ?? undefined;
    const rawSegments = raw['segments'] ?? undefined;

    const flagsPart = rawFlags === undefined ? emptyFlags() : parseFlagDefinitions(rawFlags);
    const segmentsPart =
      rawSegments === undefined ? emptySegments() : parseSegmentDefinitions(rawSegments);

    return combine(flagsPart, segmentsPart, rawSegments !== undefined, checkDocumentKeys(raw));
  }

  return combine(parseFlagDefinitions(raw), emptySegments(), false, []);
}

/**
 * Reports document keys that are neither `flags` nor `segments` but hold
 * something shaped like a collection of definitions.
 *
 * This is the diagnostic for a typo. `segmnets: [...]` used to parse clean:
 * the segments vanished, and because the document then looked like it declared
 * no segment side at all, {@link checkCrossReferences} skipped the
 * dangling-segment check too — so every `inSegment` rule matched nobody, with
 * zero issues to explain why. A flag keyed `flags` or `segments` in the legacy
 * object form disappeared the same way.
 *
 * Only a value that would actually parse as a collection of definitions is
 * reported. A control plane is free to ship `version`, `etag`, a timestamp —
 * or a nested `metadata`, `links`, `pagination` envelope — alongside, and
 * drawing an issue on every refresh, every thirty seconds, for a field that
 * could never have held the missing definitions is noise rather than a
 * finding, with nothing the operator can do about it short of flattening the
 * document.
 */
function checkDocumentKeys(raw: Record<string, unknown>): FlagParseIssue[] {
  const issues: FlagParseIssue[] = [];

  for (const key of Object.keys(raw)) {
    if (key === 'flags' || key === 'segments') continue;
    if (!holdsDefinitions(raw[key])) continue;

    issues.push({
      at: key,
      message: `unrecognised top-level key "${key}" — a ruleset document declares "flags" and "segments"`,
    });
  }

  return issues;
}

/**
 * Whether a value is what a misplaced or shadowed definition would look like:
 * one definition, a non-empty array of them, or a non-empty key-to-definition
 * object.
 *
 * Every form carries the key on the definition itself — the legacy object form
 * is parsed by its values, not by its property names — so a key is necessary.
 * It is not sufficient, and treating it as though it were is what made this
 * report the very envelopes the doc comment above promises to leave alone: a
 * `links: { self: { key: "..." } }` or a `meta: { key: "prod-ruleset" }` drew
 * "unrecognised top-level key" on every refresh, every thirty seconds, with
 * nothing the operator could do about it. A definition also declares something
 * to be a definition *of* — see {@link DEFINITION_FIELDS}.
 */
function holdsDefinitions(value: unknown): boolean {
  if (looksLikeDefinition(value)) return true;
  if (isRecord(value)) return holdsDefinitions(Object.values(value));
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((entry: unknown) => looksLikeDefinition(entry));
}

/**
 * The fields that only a flag or a segment declares. A keyed object carrying
 * none of them is metadata, not a definition that lost its way.
 *
 * The one shape this misses is a segment declaring nothing but its key — every
 * other field of a segment is optional — which the content check in
 * `parseSegmentDefinition` would reject anyway, and which is indistinguishable
 * from an envelope carrying a name. Silence is the right answer there: this is
 * a diagnostic for a typo, and a diagnostic nobody can act on is worse than
 * none.
 */
const DEFINITION_FIELDS = [
  'variants',
  'defaultVariant',
  'offVariant',
  'enabled',
  'targets',
  'prerequisites',
  'allocation',
  'rollout',
  'rules',
  'included',
  'excluded',
] as const;

function looksLikeDefinition(value: unknown): boolean {
  return isKeyedDefinition(value) && DEFINITION_FIELDS.some((field) => field in value);
}

function emptyFlags(): ParseFlagsResult {
  return { flags: [], issues: [] };
}

function emptySegments(): ParseSegmentsResult {
  return { segments: [], issues: [] };
}

function combine(
  flagsPart: ParseFlagsResult,
  segmentsPart: ParseSegmentsResult,
  segmentsKnown: boolean,
  documentIssues: readonly FlagParseIssue[],
): ParseRulesetResult {
  return {
    flags: flagsPart.flags,
    segments: segmentsPart.segments,
    issues: [
      ...documentIssues,
      ...flagsPart.issues,
      ...segmentsPart.issues,
      ...checkCrossReferences(flagsPart.flags, segmentsPart.segments, segmentsKnown),
    ],
  };
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

/**
 * `parse` is handed a sink for the defects that do not cost the definition. The
 * sink is local to each entry and merged only once the definition survives, so
 * a flag that goes on to be rejected does not also leave a warning about a
 * field nobody will ever read.
 */
function parseEach<T extends { readonly key: string }>(
  entries: readonly [string, unknown][],
  issues: FlagParseIssue[],
  parse: (raw: unknown, warnings: FlagParseIssue[]) => T,
  noun: 'flag' | 'segment',
): T[] {
  const parsed: T[] = [];
  const seen = new Set<string>();

  for (const [at, entry] of entries) {
    const warnings: FlagParseIssue[] = [];

    try {
      const definition = parse(entry, warnings);

      // A snapshot is indexed by key, so a repeat silently deletes the
      // definition before it. Keep the first and report the rest: which of two
      // definitions of one key ends up live must not come down to array order.
      if (seen.has(definition.key)) {
        issues.push({
          at: definition.key,
          message: `${noun} ${definition.key} is defined more than once`,
        });
        continue;
      }

      seen.add(definition.key);
      issues.push(...warnings);
      parsed.push(definition);
    } catch (error) {
      issues.push({
        at: isKeyedDefinition(entry) ? entry.key : at,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return parsed;
}
