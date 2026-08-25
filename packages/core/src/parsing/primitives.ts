/**
 * Shared validation primitives for definitions arriving as untrusted JSON.
 *
 * A control plane is just another network dependency: a malformed payload must
 * degrade to "this one definition is ignored", never to a crashed request
 * handler or a silently wrong rollout.
 */

export interface FlagParseIssue {
  /** The key of the definition when it could be read, otherwise its index in the input. */
  readonly at: string;
  readonly message: string;
}

/**
 * How much of the payload a parse failure costs.
 *
 * `definition` is the default and covers almost everything: the flag or
 * segment is dropped and reported.
 *
 * `rule` is the one survivable failure — an operator a newer control plane
 * knows and this version does not. It says nothing about the rest of the
 * definition, and rejecting the whole thing over it answers FLAG_NOT_FOUND for
 * every SDK and sends each one to its own hardcoded default, which is the
 * worse of the two failures by the same argument `references.ts` makes for
 * keeping a dangling reference. A rule carrying such an operator could never
 * have matched anyway, so the rule is dropped and reported and the definition
 * goes on being served — exactly what evaluation would have decided had the
 * rule survived.
 */
export type ParseFailureScope = 'definition' | 'rule';

export class FlagParseError extends Error {
  override readonly name = 'FlagParseError';

  /** See {@link ParseFailureScope}. */
  readonly scope: ParseFailureScope;

  constructor(message: string, scope: ParseFailureScope = 'definition') {
    super(message);
    this.scope = scope;
  }
}

export function fail(message: string): never {
  throw new FlagParseError(message);
}

/**
 * Raised rather than returned so {@link parseCondition} keeps its documented
 * contract for direct callers: every unusable condition still throws a
 * {@link FlagParseError}. The rule-level callers are the ones that look at
 * `scope` and absorb it.
 */
export function failUnsupportedOperator(message: string): never {
  throw new FlagParseError(message, 'rule');
}

/** Whether a thrown value is the one parse failure a rule can be dropped for. */
export function isDroppedRule(error: unknown): error is FlagParseError {
  return error instanceof FlagParseError && error.scope === 'rule';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a value is a definition: a record carrying a string `key`.
 *
 * The one answer to that question, shared by the parser — which uses it to
 * recognise a definition collection shipped under a misspelled document key —
 * and by `evaluateFlag`, which uses it to decide whether it was handed
 * anything it can even name an error under. Written out twice, the two copies
 * had already drifted: the evaluator's own `typeof value === 'object'` test
 * accepted an array whose `key` element happened to be a string, because it
 * did not exclude arrays the way {@link isRecord} does.
 */
export function isKeyedDefinition(value: unknown): value is { readonly key: string } {
  return isRecord(value) && typeof value['key'] === 'string';
}

export function isScalarList(value: unknown): value is (string | number)[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === 'string' || typeof item === 'number')
  );
}

/**
 * How deep a value may nest before the parser calls it broken: far past any
 * real flag payload, and short enough that walking it cannot exhaust the stack
 * on the way to finding out.
 */
const MAX_JSON_DEPTH = 100;

/**
 * The first thing inside a value that JSON cannot carry, named against the
 * path it sits at — or `undefined` when the whole value is expressible.
 *
 * Only the top level of a variant used to be checked, so the finite-number
 * rule stopped at the surface: `{ perMinute: Infinity }` parsed clean and
 * reached the OFREP wire as `{"perMinute":null}`, which is the failure the
 * same check on `metadata` says out loud it exists to prevent — "an
 * unserveable annotation discovered at the protocol layer rather than here,
 * where the operator can still be told which field it was". `undefined`, a
 * function, and a symbol are worse still: `JSON.stringify` drops the key
 * outright, so the served object is missing a field rather than holding a null
 * one. A bigint throws.
 *
 * Iterative, and depth-bounded rather than cycle-checked. A control plane
 * cannot ship a cycle — JSON has none — but a compiled-in definition handed
 * straight to `parseFlagDefinition` can, and one bound catches both that and a
 * payload nested past anything a stack will hold. A value repeated at two
 * places is not a cycle and stays legal; it is walked twice, exactly as
 * `cloneJson` copies it twice.
 */
export function jsonDefect(value: unknown): string | undefined {
  const stack: { readonly value: unknown; readonly path: string; readonly depth: number }[] = [
    { value, path: '', depth: 0 },
  ];

  while (stack.length > 0) {
    const { value: current, path, depth } = stack.pop()!;

    if (depth > MAX_JSON_DEPTH) {
      return `nests more than ${MAX_JSON_DEPTH} levels deep at ${pathName(path)}`;
    }

    if (Array.isArray(current)) {
      for (const [index, item] of (current as readonly unknown[]).entries()) {
        stack.push({ value: item, path: `${path}[${index}]`, depth: depth + 1 });
      }
      continue;
    }

    if (isRecord(current)) {
      for (const field of Object.keys(current)) {
        stack.push({
          value: current[field],
          path: path === '' ? field : `${path}.${field}`,
          depth: depth + 1,
        });
      }
      continue;
    }

    if (isJsonScalar(current)) continue;
    return `holds ${describeUnserveable(current)} at ${pathName(path)}`;
  }

  return undefined;
}

function isJsonScalar(value: unknown): boolean {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  return typeof value === 'number' && Number.isFinite(value);
}

/** What to call the value in the message: `NaN` and `Infinity` by name. */
function describeUnserveable(value: unknown): string {
  if (typeof value === 'number') return String(value);
  return value === undefined ? 'undefined' : `a ${typeof value}`;
}

function pathName(path: string): string {
  return path === '' ? 'its root' : path;
}

/**
 * A frozen deep copy of a validated JSON value.
 *
 * A snapshot promises an immutable, point-in-time view, and that promise has
 * two sides.
 *
 * Copying keeps the parsed definition from aliasing the caller's JSON, so
 * whoever still holds the decoded payload cannot change what a live snapshot
 * serves — a provider that caches a response body, a `StaticProvider` handed a
 * live config object, a fixture shared across tests.
 *
 * Freezing keeps the promise on the way out. Variant values and metadata are
 * the two things that travel out of the snapshot on every evaluation result,
 * and they travel by reference: handing back a mutable object would let one
 * caller writing to what it was handed rewrite the flag for every evaluation
 * after it, process-wide. The model types are `readonly` throughout, so this
 * only makes the declared contract true at runtime — and it costs the request
 * path nothing, which a copy per evaluation would not.
 *
 * Hand-rolled rather than `structuredClone`: core does not commit consumers to
 * a platform global (see the TextEncoder note in `bucketing.ts`), and it copies
 * a value it does not understand — a function, a symbol — straight through
 * rather than throwing on it, which is what lets the callers decide what is
 * serveable.
 *
 * The one thing it does refuse is a value nested past
 * {@link MAX_JSON_DEPTH} — a cycle, or a payload deeper than the stack can
 * hold. It refuses it as a {@link FlagParseError}, the failure every caller of
 * the parser already catches, rather than as the `RangeError` an unbounded
 * recursion would raise from underneath a documented `@throws
 * {FlagParseError}`. `references.ts` walks its own graph iteratively for the
 * same reason: "the parser must not put its own stack at risk finding out".
 */
export function cloneJson<T>(value: T): T {
  return cloneAtDepth(value, 0);
}

function cloneAtDepth<T>(value: T, depth: number): T {
  if (depth > MAX_JSON_DEPTH) {
    fail(`value nests more than ${MAX_JSON_DEPTH} levels deep`);
  }

  if (Array.isArray(value)) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return Object.freeze(value.map((item: unknown) => cloneAtDepth(item, depth + 1))) as T;
  }

  if (isRecord(value)) {
    const copy: Record<string, unknown> = {};
    for (const field of Object.keys(value)) {
      // Defined rather than assigned: `copy['__proto__'] = x` would run the
      // inherited setter and silently drop the key instead of copying it.
      Object.defineProperty(copy, field, {
        value: cloneAtDepth(value[field], depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return Object.freeze(copy) as T;
  }

  return value;
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * A validated string array, copied rather than handed back by reference.
 *
 * Every list this validates ends up inside a parsed definition — a target's
 * keys, a prerequisite's variant list, a segment's included and excluded keys,
 * the segments an `inSegment` condition names — so returning the caller's own
 * array would leave the definition aliasing the decoded payload. Pushing onto
 * that array afterwards would change who an already-snapshotted rule matches.
 * The no-alias half of {@link cloneJson}, at the one other shape the parser
 * keeps from its input.
 */
export function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === 'string')) {
    fail(`${field} must be an array of strings`);
  }
  return [...value];
}

export function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${field} must be a finite number`);
  }
  return value;
}

/**
 * An optional scalar: absent, or an explicit JSON `null`, reads as `undefined`.
 * Anything else still has to be valid — a malformed salt, seed, or bucketBy
 * rejects the definition rather than being silently dropped, because dropping
 * one quietly reshuffles or reassigns a whole cohort.
 */
export function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, field);
}

/** The {@link optionalString} rule, for a number field. */
export function optionalFiniteNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requireFiniteNumber(value, field);
}
