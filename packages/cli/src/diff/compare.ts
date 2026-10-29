/** Structural equality for parsed JSON, independent of object key order. */
export function sameJson(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export interface SetDelta {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export function setDelta(before: Iterable<string>, after: Iterable<string>): SetDelta {
  const old = new Set(before);
  const next = new Set(after);
  return {
    added: [...next].filter((item) => !old.has(item)),
    removed: [...old].filter((item) => !next.has(item)),
  };
}

/** Pairs entries of two keyed lists, in the order of `after` then the ones only `before` has. */
export function pairByKey<T>(
  before: readonly T[],
  after: readonly T[],
  keyOf: (entry: T) => string,
): { readonly key: string; readonly before?: T; readonly after?: T }[] {
  const old = new Map(before.map((entry) => [keyOf(entry), entry]));
  const next = new Map(after.map((entry) => [keyOf(entry), entry]));
  const keys = [...new Set([...next.keys(), ...old.keys()])];

  return keys.map((key) => {
    const pair: { key: string; before?: T; after?: T } = { key };
    const was = old.get(key);
    const now = next.get(key);
    if (was !== undefined) pair.before = was;
    if (now !== undefined) pair.after = now;
    return pair;
  });
}
