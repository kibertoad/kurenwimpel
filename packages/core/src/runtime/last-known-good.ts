/**
 * Last-known-good rulesets: the copy a provider boots from when its live source
 * is unreachable on the first load.
 */

import type { FlagParseIssue } from '../parsing/primitives.js';
import { parseRuleset } from '../parsing/ruleset.js';
import type { ProviderLoadContext } from './provider.js';
import { createSnapshot } from './snapshot.js';
import type { FlagSnapshot, SnapshotMeta } from './snapshot.js';

/** A raw ruleset payload as it was fetched, before parsing. */
export interface StoredRuleset {
  readonly raw: unknown;
  readonly version?: string;
  /** Epoch millis the payload was fetched from the live source. */
  readonly fetchedAt: number;
}

/** Persists the last ruleset that loaded successfully. */
export interface LastKnownGoodStore {
  /** Resolves `null` when nothing has been stored yet. */
  read(): Promise<StoredRuleset | null>;
  write(ruleset: StoredRuleset): Promise<void>;
}

export interface RulesetSourceOptions {
  /** Written after every successful live parse, read when the first load fails. */
  readonly lastKnownGood?: LastKnownGoodStore | undefined;
  readonly onParseIssues?: ((issues: readonly FlagParseIssue[]) => void) | undefined;
  readonly context?: ProviderLoadContext | undefined;
}

/** Whether a value read back from a store has the shape of a {@link StoredRuleset}. */
export function isStoredRuleset(value: unknown): value is StoredRuleset {
  if (typeof value !== 'object' || value === null || !('raw' in value)) return false;
  const fetchedAt = 'fetchedAt' in value ? value.fetchedAt : undefined;
  const version = 'version' in value ? value.version : undefined;
  return (
    typeof fetchedAt === 'number' &&
    Number.isFinite(fetchedAt) &&
    (version === undefined || typeof version === 'string')
  );
}

/**
 * Parses a raw payload into a snapshot and, for a live payload, hands the raw
 * form to the store. The write is not awaited, so a slow store never delays a
 * refresh; a failed write goes to `context.reportError` with operation `store`.
 */
export function snapshotFromRuleset(
  raw: unknown,
  meta: SnapshotMeta = {},
  options: RulesetSourceOptions = {},
): FlagSnapshot {
  const { flags, segments, issues } = parseRuleset(raw);
  reportIssues(issues, options);

  const snapshot = createSnapshot(flags, meta, segments);
  if (snapshot.origin === 'live' && options.lastKnownGood !== undefined) {
    persist(options.lastKnownGood, { raw, snapshot }, options.context);
  }
  return snapshot;
}

/**
 * Runs a provider's live load and covers its two last-known-good cases.
 *
 * A failed first load is answered from the store with an `origin: 'fallback'`
 * snapshot, and the original error is still reported. A store that is empty,
 * unreadable or corrupt changes nothing: the original error is rethrown.
 *
 * An "unchanged" answer against a fallback snapshot confirms the stored copy,
 * so it comes back re-marked as live instead of `null`.
 */
export async function loadWithFallback(
  previous: FlagSnapshot | undefined,
  load: () => Promise<FlagSnapshot | null>,
  options: RulesetSourceOptions = {},
): Promise<FlagSnapshot | null> {
  let loaded: FlagSnapshot | null;
  try {
    loaded = await load();
  } catch (error) {
    if (previous !== undefined) throw error;
    const fallback = await readFallback(options);
    if (fallback === null) throw error;
    options.context?.reportError(error, 'load');
    return fallback;
  }

  if (loaded === null && previous?.origin === 'fallback') {
    return { ...previous, origin: 'live', fetchedAt: Date.now() };
  }
  return loaded;
}

async function readFallback(options: RulesetSourceOptions): Promise<FlagSnapshot | null> {
  const store = options.lastKnownGood;
  if (store === undefined) return null;

  try {
    const stored: unknown = await store.read();
    if (!isStoredRuleset(stored)) return null;

    const { flags, segments, issues } = parseRuleset(stored.raw);
    // A payload that yields nothing but issues is not a ruleset that ever loaded.
    if (flags.length === 0 && issues.length > 0) return null;
    reportIssues(issues, options);

    const meta: SnapshotMeta = {
      origin: 'fallback',
      fetchedAt: stored.fetchedAt,
      ...(stored.version === undefined ? {} : { version: stored.version }),
    };
    return createSnapshot(flags, meta, segments);
  } catch {
    return null;
  }
}

function reportIssues(issues: readonly FlagParseIssue[], options: RulesetSourceOptions): void {
  options.context?.reportParseIssues?.(issues);
  if (issues.length > 0) options.onParseIssues?.(issues);
}

function persist(
  store: LastKnownGoodStore,
  { raw, snapshot }: { raw: unknown; snapshot: FlagSnapshot },
  context: ProviderLoadContext | undefined,
): void {
  const ruleset: StoredRuleset = {
    raw,
    fetchedAt: snapshot.fetchedAt,
    ...(snapshot.version === undefined ? {} : { version: snapshot.version }),
  };
  // `then` turns a synchronous throw from a hand-written store into a rejection.
  Promise.resolve()
    .then(() => store.write(ruleset))
    .catch((error: unknown) => context?.reportError(error, 'store'));
}
