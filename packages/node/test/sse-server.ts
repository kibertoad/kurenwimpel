import { createServer } from 'node:http';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SseServer {
  readonly port: number;
  /** Request headers of every connection so far, in order. */
  readonly connections: IncomingHttpHeaders[];
  readonly open: number;
  send(text: string): void;
  close(): Promise<void>;
}

/** A bare SSE endpoint that holds every GET open and writes only what a test sends. */
export async function sseServer(port = 0, status = 200): Promise<SseServer> {
  const clients = new Set<ServerResponse>();
  const connections: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    connections.push(req.headers);
    res.writeHead(status, { 'content-type': 'text/event-stream' });
    if (status !== 200) {
      res.end();
      return;
    }
    res.flushHeaders();
    clients.add(res);
    res.on('close', () => clients.delete(res));
  });
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    port: (server.address() as AddressInfo).port,
    connections,
    get open() {
      return clients.size;
    },
    send(text) {
      for (const client of clients) client.write(text);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        // A second close only reports that the first one happened.
        server.close(() => {
          resolve();
        });
      }),
  };
}
