const REFETCH_EVALUATION = 'refetchEvaluation';

/**
 * Splits a `text/event-stream` into the `data` of each event. Comments and the
 * `event`, `id` and `retry` fields are dropped: OFREP routes on the JSON type
 * inside `data`.
 */
export class SseDataReader {
  #buffer = '';
  #data: string[] = [];

  /** Feeds decoded text and returns the events it completed. */
  push(text: string): string[] {
    const lines = (this.#buffer + text).split(/\r\n|\r|\n/u);
    this.#buffer = lines.pop() ?? '';

    const events: string[] = [];
    for (const line of lines) {
      if (line === '') {
        if (this.#data.length > 0) events.push(this.#data.join('\n'));
        this.#data = [];
      } else if (line.startsWith('data:')) {
        const value = line.slice('data:'.length);
        this.#data.push(value.startsWith(' ') ? value.slice(1) : value);
      }
    }
    return events;
  }
}

/** Whether an event's `data` asks for a refetch. Unknown types are ignored, as OFREP requires. */
export function isRefetchEvent(data: string): boolean {
  try {
    const parsed: unknown = JSON.parse(data);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      'type' in parsed &&
      parsed.type === REFETCH_EVALUATION
    );
  } catch {
    return false;
  }
}
