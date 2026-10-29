import { requireEnv } from './target.js';
import type { TargetDeps } from './target.js';

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

export interface KvKey {
  readonly name: string;
  readonly metadata?: unknown;
}

interface Envelope<T> {
  readonly success?: boolean;
  readonly errors?: readonly { readonly code?: number; readonly message?: string }[];
  readonly result?: T;
  readonly result_info?: { readonly cursor?: string };
}

/** The slice of the Workers KV REST API a publisher needs. */
export class KvApi {
  readonly #base: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(
    deps: TargetDeps,
    options: { accountId: string; namespaceId: string; tokenEnv: string },
  ) {
    this.#token = requireEnv(deps, options.tokenEnv, 'kv target');
    this.#fetch = deps.fetch;
    const account = encodeURIComponent(options.accountId);
    const namespace = encodeURIComponent(options.namespaceId);
    this.#base = `${CLOUDFLARE_API}/accounts/${account}/storage/kv/namespaces/${namespace}`;
  }

  /** The key's metadata, or `undefined` when the key does not exist. */
  async metadata(key: string): Promise<unknown> {
    const response = await this.#request('GET', `/metadata/${encodeURIComponent(key)}`);
    if (response.status === 404) return undefined;
    return (await this.#envelope<unknown>(response, 'read metadata of', key)).result;
  }

  /** The key's value, or `undefined` when the key does not exist. */
  async get(key: string): Promise<string | undefined> {
    const response = await this.#request('GET', `/values/${encodeURIComponent(key)}`);
    if (response.status === 404) return undefined;
    if (!response.ok) await this.#envelope(response, 'read', key);
    return response.text();
  }

  async put(key: string, value: string, metadata: object): Promise<void> {
    const body = new FormData();
    body.set('value', value);
    body.set('metadata', JSON.stringify(metadata));
    const response = await this.#request('PUT', `/values/${encodeURIComponent(key)}`, body);
    await this.#envelope(response, 'write', key);
  }

  /** Every key under `prefix`, following the cursor across pages. */
  async list(prefix: string, cursor?: string): Promise<KvKey[]> {
    const query = new URLSearchParams({ prefix, limit: '1000' });
    if (cursor !== undefined) query.set('cursor', cursor);
    const response = await this.#request('GET', `/keys?${query.toString()}`);
    const page = await this.#envelope<KvKey[]>(response, 'list', prefix);

    const keys = page.result ?? [];
    const next = page.result_info?.cursor;
    if (next === undefined || next === '') return keys;
    return [...keys, ...(await this.list(prefix, next))];
  }

  async deleteMany(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    const response = await this.#request('POST', '/bulk/delete', JSON.stringify(keys));
    await this.#envelope(response, 'delete', keys.join(', '));
  }

  #request(method: string, path: string, body?: string | FormData): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.#token}` };
    if (typeof body === 'string') headers['content-type'] = 'application/json';
    return this.#fetch(`${this.#base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
  }

  async #envelope<T>(response: Response, action: string, key: string): Promise<Envelope<T>> {
    const text = await response.text();
    let envelope: Envelope<T> = {};
    try {
      // The documented response envelope; every field is optional and read defensively.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      envelope = JSON.parse(text) as Envelope<T>;
    } catch {
      // Not JSON: reported below by status.
    }
    if (response.ok && envelope.success !== false) return envelope;

    const reasons = (envelope.errors ?? []).map((error) => `${error.code}: ${error.message}`);
    const detail = reasons.length > 0 ? reasons.join('; ') : text.slice(0, 200);
    throw new Error(`Cloudflare API: cannot ${action} ${key}: HTTP ${response.status} ${detail}`);
  }
}
