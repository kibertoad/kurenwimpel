# @kurenwimpel/ofrep-server

Serves the [OpenFeature Remote Evaluation Protocol][ofrep] from a
`FeatureFlagClient`, so any OFREP provider (Go, Java, Python, the browser web SDK)
can read kurenwimpel flags without a bespoke SDK.

The handler is written against the Fetch API only. The same function runs on
Cloudflare Workers, Bun, and Node 22 behind any Fetch adapter. Every response
it produces is checked in the test suite against the contract in
[`@kurenwimpel/ofrep`](../ofrep/README.md), which is itself checked against the
vendored specification.

[ofrep]: https://openfeature.dev/docs/reference/other-technologies/ofrep/

```sh
pnpm add @kurenwimpel/ofrep-server
```

## Usage

```ts
import { createOfrepHandler } from '@kurenwimpel/ofrep-server';

const handler = createOfrepHandler({
  client: () => flags, // a FeatureFlagClient, or a promise of one
  authorize: (request) =>
    request.headers.get('authorization') === `Bearer ${process.env.OFREP_TOKEN}`,
  bulkFilter: (flag) => flag.metadata?.audience !== 'server',
});

// Bun
Bun.serve({ fetch: handler });

// Node, through any Fetch adapter (srvx, @hono/node-server, @whatwg-node/server...)
serve({ fetch: handler });
```

On Workers, `createOfrepWorker` in `@kurenwimpel/cloudflare` wires this handler to a
KV-backed client:

```ts
import { createOfrepWorker, KvFlagProvider } from '@kurenwimpel/cloudflare';

export default createOfrepWorker<Env>({
  provider: (env) => new KvFlagProvider({ namespace: env.FLAGS }),
  authorize: (request, env) => request.headers.get('x-api-key') === env.OFREP_API_KEY,
});
```

## Options

| Option        | Required | What it does                                                                                                                          |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `client`      | yes      | Returns the `FeatureFlagClient` to evaluate with. Awaited once per request.                                                           |
| `authorize`   | yes      | `true` lets the request through and `false` answers 401. `{ status: 403 }` and `{ status: 429, retryAfter }` answer with that status. |
| `bulkFilter`  | no       | Return `false` to keep a flag out of the bulk route.                                                                                  |
| `basePath`    | no       | Prefix in front of `/ofrep/v1`, for a handler mounted below the root.                                                                 |
| `onError`     | no       | Receives every error that became a 500, and failures reading the client while a change stream is open.                                |
| `eventStream` | no       | Serves the [change stream](#change-stream) and advertises it in bulk responses.                                                       |

## Routes

| Route                                | Answers                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `POST /ofrep/v1/evaluate/flags/:key` | 200 success, 404 unknown flag, 400 evaluation failure or bad body, 401/403/429, 500           |
| `POST /ofrep/v1/evaluate/flags`      | 200 with every flag, 304 for a matching `If-None-Match`, 400 bad body, 401/403/429, 500       |
| `GET /ofrep/v1/event-stream`         | With `eventStream` set: an SSE stream of change notifications, 401/403/429                    |
| anything else                        | 404 with no body, or 405 for the wrong method on an OFREP path, so the handler can be mounted |

A single-flag evaluation emits an impression through the client's `onImpression`,
because it is an exposure. A bulk evaluation does not: a client-side SDK fetches
every flag on page load, and counting that as exposure would put everyone in every
experiment.

The bulk ETag is a hash of the snapshot version (its load time when the provider
stamps none) and the context with its keys sorted. A client that has not loaded a
ruleset yet answers 500 on both routes rather than an empty flag list, which an SDK
would read as "every flag is gone".

Error codes follow the core's mapping (`toOfrepErrorCode`): an evaluation that fails
answers 400 with an `evaluationFailure` body, so the OpenFeature SDK on the other end
sees the exact code; an unknown key answers 404 with `flagNotFound`.

## Change stream

With `eventStream` set, the handler serves Server-Sent Events on a `GET` route and
every 200 bulk response advertises it, so OFREP providers can refetch on change
instead of polling:

```ts
const handler = createOfrepHandler({
  client: () => flags,
  authorize,
  eventStream: { path: '/ofrep/v1/event-stream' },
});
```

```json
"eventStreams": [{ "type": "sse", "endpoint": { "requestUri": "/ofrep/v1/event-stream" }, "inactivityDelaySec": 120 }]
```

The stream carries notifications only. When the client's snapshot version changes,
each open connection receives `data: {"type":"refetchEvaluation","lastModified":<seconds>}`,
and the provider refetches through the bulk route as usual. The client has no change
hook and refreshes on its own schedule, so while at least one stream is open the
handler compares the snapshot version every `versionCheckIntervalMs`. A comment
heartbeat goes out every `heartbeatIntervalMs` to keep proxies from closing an idle
connection.

| Option                   | Default                  | What it does                                                       |
| ------------------------ | ------------------------ | ------------------------------------------------------------------ |
| `path`                   | `/ofrep/v1/event-stream` | Route of the stream, below `basePath`. Advertised as `requestUri`. |
| `inactivityDelaySec`     | 120                      | Advertised to providers as `inactivityDelaySec`.                   |
| `heartbeatIntervalMs`    | 30 000                   | Gap between heartbeats. Must be shorter than `inactivityDelaySec`. |
| `versionCheckIntervalMs` | 250                      | How often an open stream compares the snapshot version.            |

A change therefore reaches a connected client within the time this server's client
takes to load it, plus `versionCheckIntervalMs` and one refetch. `authorize` runs on
the stream route like on the others. The bridge in front of the handler has to pass
the response body through as it is written and abort `request.signal` when the
caller disconnects; most Fetch adapters for Node do both.

The stream runs on Node and Bun. On Workers each isolate holds only its own
connections, so fan-out across isolates needs a Durable Object, which is not built
yet.

## Security

An OFREP endpoint hands out flag values, variant names and flag metadata to whoever
can call it. Treat it as an API, not as a static asset.

- **`authorize` is required.** There is no default that lets requests through. Check
  a bearer token or API key (the two schemes OFREP defines), and answer 403 when a
  valid caller asks for something it may not see. Rate limiting belongs here too:
  return `{ status: 429, retryAfter }` and the client SDK backs off.
- **The bulk route serves every flag** in the ruleset unless `bulkFilter` says
  otherwise. Browser SDKs call it with a key that ships in page source, so treat that
  key as public and use `bulkFilter` to keep server-only flags (kill switches for
  internal systems, flags whose names reveal unreleased work) out of it. The
  single-flag route ignores `bulkFilter`; it is for server-side callers, so give them
  a different credential and let `authorize` tell the two apart.
- **Segment contents never leave the server.** Responses carry the evaluated value,
  the variant name, the reason and the flag's `metadata`. Targeting rules, rule ids,
  segment membership lists and failed prerequisites are not serialised. Anything you
  put in a flag's `metadata` is published, so keep it to labels.
- **Callers choose their own context.** OFREP evaluates whatever context the caller
  sends, so a client can claim any `targetingKey` or attribute. Do not gate access
  control on a flag a caller can evaluate for an identity it does not hold; derive
  sensitive attributes on the server instead.
- **500 bodies stay generic.** The real error goes to `onError`; the caller sees
  `Internal server error` or `Flags have not been loaded yet`.
- **Request size and CORS are the host's job.** The handler reads the whole body, so
  cap it in the platform or framework in front of it. It sets no CORS headers; a
  browser SDK on another origin needs them added by the wrapping server.
