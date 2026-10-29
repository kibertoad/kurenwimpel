export interface FakeEntry {
  value: string;
  metadata: Record<string, unknown> | undefined;
}

export interface RecordedRequest {
  readonly method: string;
  /** The path below the namespace, decoded: `/values/flags:current`. */
  readonly path: string;
}

export const TOKEN = 'test-token';
export const ACCOUNT = 'acc-1';
export const NAMESPACE = 'ns-1';

const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/storage/kv/namespaces/${NAMESPACE}`;

/** The URL of whatever `fetch` was called with. */
export function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/**
 * An in-memory Workers KV namespace behind the REST routes the kv target uses.
 * Lists one key per page so cursor handling is exercised.
 */
export class FakeKvApi {
  readonly entries = new Map<string, FakeEntry>();
  readonly requests: RecordedRequest[] = [];

  readonly fetch = (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(urlOf(input));
    const method = init.method ?? 'GET';
    const authorization = new Headers(init.headers).get('authorization');
    if (!url.href.startsWith(BASE)) return json(404, { success: false, errors: [] });
    if (authorization !== `Bearer ${TOKEN}`) {
      return json(401, {
        success: false,
        errors: [{ code: 10000, message: 'Authentication error' }],
      });
    }

    const path = decodeURIComponent(url.pathname.slice(new URL(BASE).pathname.length));
    this.requests.push({ method, path });
    return this.#route(method, path, url.searchParams, init.body);
  };

  writes(): RecordedRequest[] {
    return this.requests.filter((request) => request.method !== 'GET');
  }

  #route(method: string, path: string, query: URLSearchParams, body: unknown): Promise<Response> {
    const [, kind = '', ...rest] = path.split('/');
    const key = rest.join('/');
    const entry = this.entries.get(key);

    if (method === 'GET' && kind === 'metadata') {
      return entry === undefined
        ? notFound()
        : json(200, { success: true, result: entry.metadata ?? null });
    }
    if (method === 'GET' && kind === 'values') {
      return entry === undefined ? notFound() : Promise.resolve(new Response(entry.value));
    }
    if (method === 'PUT' && kind === 'values' && body instanceof FormData) {
      const value = body.get('value');
      const metadata = body.get('metadata');
      this.entries.set(key, {
        value: typeof value === 'string' ? value : '',
        metadata: typeof metadata === 'string' ? JSON.parse(metadata) : undefined,
      });
      return json(200, { success: true, result: null });
    }
    if (method === 'GET' && kind === 'keys') return this.#list(query);
    if (method === 'POST' && path === '/bulk/delete' && typeof body === 'string') {
      for (const name of JSON.parse(body) as string[]) this.entries.delete(name);
      return json(200, { success: true, result: null });
    }
    return json(405, { success: false, errors: [{ code: 1, message: 'unexpected route' }] });
  }

  #list(query: URLSearchParams): Promise<Response> {
    const prefix = query.get('prefix') ?? '';
    const names = [...this.entries.keys()].filter((name) => name.startsWith(prefix)).toSorted();
    const offset = Number(query.get('cursor') ?? '0');
    const name = names[offset];
    const result = name === undefined ? [] : [{ name, metadata: this.entries.get(name)?.metadata }];
    const cursor = offset + 1 < names.length ? String(offset + 1) : '';
    return json(200, { success: true, result, result_info: { count: result.length, cursor } });
  }
}

function json(status: number, body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function notFound(): Promise<Response> {
  return json(404, { success: false, errors: [{ code: 10009, message: 'key not found' }] });
}
