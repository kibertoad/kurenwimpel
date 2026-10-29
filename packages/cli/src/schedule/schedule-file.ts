import { isRecord } from '../json.js';

/** One change to make to a flag at a set time. */
export interface ScheduleEntry {
  /** Unique within the file. Restricted to `[A-Za-z0-9._-]` so it is safe in a commit message. */
  readonly id: string;
  /** ISO 8601 with an explicit UTC offset, as written in the file. */
  readonly at: string;
  readonly flag: string;
  /** Top-level fields of the flag definition to replace. A `null` value removes the field. */
  readonly set: Readonly<Record<string, unknown>>;
}

/** A problem with a schedule entry, or with what applying it does to the ruleset. */
export interface ScheduleIssue {
  /** The entry's id, `[<index>]` when it has no usable one, or `$` for the file as a whole. */
  readonly entry: string;
  readonly message: string;
}

export interface ParsedSchedule {
  /** The entries that are well formed, in file order. */
  readonly entries: readonly ScheduleEntry[];
  readonly issues: readonly ScheduleIssue[];
  /** The file's array as read, so rewriting it keeps each entry as it was written. */
  readonly raw: readonly unknown[];
}

const ENTRY_FIELDS = ['id', 'at', 'flag', 'set'];
const ID = /^[\w.-]+$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u;

/** Milliseconds since the epoch, or `undefined` for anything but a date and time with an offset. */
export function parseTimestamp(text: string): number | undefined {
  if (!TIMESTAMP.test(text)) return undefined;
  const time = Date.parse(text);
  return Number.isNaN(time) ? undefined : time;
}

/** Validates a parsed schedule file. */
export function parseSchedule(raw: unknown): ParsedSchedule {
  if (!Array.isArray(raw)) {
    return {
      entries: [],
      issues: [{ entry: '$', message: 'must be an array of entries' }],
      raw: [],
    };
  }

  const entries: ScheduleEntry[] = [];
  const issues: ScheduleIssue[] = [];
  for (const [index, value] of raw.entries()) {
    const entry = entryOf(value);
    const label = labelOf(value, index);
    if (typeof entry === 'string') {
      issues.push({ entry: label, message: entry });
    } else if (entries.some((earlier) => earlier.id === entry.id)) {
      issues.push({ entry: `[${index}]`, message: `id ${entry.id} is already used` });
    } else {
      entries.push(entry);
    }
  }
  return { entries, issues, raw };
}

/** The entries in the order they take effect: by time, then by position in the file. */
export function inTimeOrder(entries: readonly ScheduleEntry[]): ScheduleEntry[] {
  return entries.toSorted((left, right) => timeOf(left) - timeOf(right));
}

export function timeOf(entry: ScheduleEntry): number {
  return Date.parse(entry.at);
}

function entryOf(value: unknown): ScheduleEntry | string {
  if (!isRecord(value)) return 'must be an object';
  const extra = Object.keys(value).find((name) => !ENTRY_FIELDS.includes(name));
  if (extra !== undefined) {
    return `${extra} is not a known field (expected ${ENTRY_FIELDS.join(', ')})`;
  }

  const { id, at, flag, set } = value;
  if (typeof id !== 'string' || !ID.test(id)) {
    return 'id must be a non-empty string of letters, digits, ".", "_" and "-"';
  }
  if (typeof at !== 'string' || parseTimestamp(at) === undefined) {
    return 'at must be a date and time with a UTC offset, such as 2026-11-03T09:00:00Z';
  }
  if (typeof flag !== 'string' || flag.length === 0) return 'flag must be a non-empty string';
  if (!isRecord(set) || Object.keys(set).length === 0) {
    return 'set must be an object with at least one field';
  }
  if (Object.hasOwn(set, 'key')) return 'set cannot change the key of a flag';
  return { id, at, flag, set };
}

function labelOf(value: unknown, index: number): string {
  if (isRecord(value) && typeof value['id'] === 'string' && ID.test(value['id'])) {
    return value['id'];
  }
  return `[${index}]`;
}
