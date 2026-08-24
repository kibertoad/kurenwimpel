/**
 * Semantic version comparison, for canary releases keyed off an app version.
 *
 * A trimmed-down SemVer 2.0.0: numeric core, prerelease precedence, build
 * metadata ignored. Tolerant where it helps a caller — a leading `v` and a
 * short core (`"2"`, `"2.1"`) are accepted — and strict where it matters:
 * anything else fails to parse and the condition that needed it fails closed.
 */

// Linear-time by construction: no nested quantifiers over the same characters.
const VERSION_PATTERN =
  /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*))?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/u;

const NUMERIC_IDENTIFIER = /^\d+$/u;

export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Dot-separated prerelease identifiers; numeric ones already as numbers. */
  readonly prerelease: readonly (string | number)[];
}

/** Parses a version string, or returns `undefined` when it is not one. */
export function parseVersion(input: string): ParsedVersion | undefined {
  const match = VERSION_PATTERN.exec(input);
  if (match === null) return undefined;

  const prerelease =
    match[4] === undefined
      ? []
      : match[4]
          .split('.')
          .map((identifier) =>
            NUMERIC_IDENTIFIER.test(identifier) ? Number(identifier) : identifier,
          );

  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    prerelease,
  };
}

/**
 * SemVer precedence: negative when `a < b`, zero when equal, positive when
 * `a > b`. Returns `undefined` when either side does not parse — the caller
 * decides what a non-version means, and for conditions that is "no match".
 */
export function compareVersions(a: string, b: string): number | undefined {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === undefined || right === undefined) return undefined;

  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;

  return comparePrerelease(left.prerelease, right.prerelease);
}

/** A release outranks any prerelease; two prereleases compare identifier by identifier. */
function comparePrerelease(
  left: readonly (string | number)[],
  right: readonly (string | number)[],
): number {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;

  const shared = Math.min(left.length, right.length);

  for (let index = 0; index < shared; index++) {
    const order = compareIdentifiers(left[index]!, right[index]!);
    if (order !== 0) return order;
  }

  // All shared identifiers equal: the longer prerelease has higher precedence.
  return left.length - right.length;
}

/** Numeric identifiers compare numerically and rank below alphanumeric ones. */
function compareIdentifiers(left: string | number, right: string | number): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'number') return -1;
  if (typeof right === 'number') return 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
