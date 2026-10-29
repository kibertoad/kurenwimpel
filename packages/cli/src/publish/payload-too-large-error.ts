/** The payload exceeds the target's limit. Nothing was written. */
export class PayloadTooLargeError extends Error {
  override readonly name = 'PayloadTooLargeError';
  readonly bytes: number;
  readonly limit: number;

  constructor(bytes: number, limit: number, target: string) {
    super(`the ruleset is ${bytes} bytes; ${target} accepts at most ${limit}`);
    this.bytes = bytes;
    this.limit = limit;
  }
}
