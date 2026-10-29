import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { OfrepHandler } from '../src/index.js';

export interface RunningServer {
  readonly url: string;
  close(): Promise<void>;
}

/** A minimal node:http to Fetch bridge, enough to put the handler on a real socket. */
export async function listen(handler: OfrepHandler): Promise<RunningServer> {
  const server = createServer((req, res) => {
    void bridge(handler, req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}

async function bridge(
  handler: OfrepHandler,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value);
  }

  const disconnected = new AbortController();
  res.on('close', () => {
    disconnected.abort();
  });
  const response = await handler(
    new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, {
      method: req.method ?? 'GET',
      headers,
      signal: disconnected.signal,
      ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
    }),
  );

  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body === null) {
    res.end();
    return;
  }
  // Streamed chunk by chunk so an event stream reaches the socket as it is written.
  for await (const chunk of response.body) res.write(chunk);
  res.end();
}
