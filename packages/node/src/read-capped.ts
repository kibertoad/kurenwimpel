/** Default `maxBytes` for the HTTP provider: 10 MiB. */
export const DEFAULT_HTTP_MAX_BYTES = 10 * 1024 * 1024;

export function assertMaxBytes(maxBytes: number): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError(`maxBytes must be a positive integer, got ${maxBytes}`);
  }
  return maxBytes;
}

/**
 * Decodes a UTF-8 body, failing as soon as it grows past `maxBytes` so an
 * oversized payload is never held in memory whole. Leaving the loop early
 * cancels the stream.
 */
export async function readCapped(
  body: AsyncIterable<Uint8Array> | null,
  maxBytes: number,
  tooLarge: () => Error,
): Promise<string> {
  if (body === null) return '';
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) throw tooLarge();
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}
