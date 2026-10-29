export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** A JSON value as one line, for "from X to Y" text. */
export function inline(value: unknown): string {
  return value === undefined ? 'unset' : JSON.stringify(value);
}
