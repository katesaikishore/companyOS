/** A fake provider on 127.0.0.1 for the connector tests. Each test supplies the handler, and the server keeps every request it saw. */
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ConfiguredProvider, CloudProviderId } from '../../src/main/connectors-cloud/providers';
import { configureProvider } from '../../src/main/connectors-cloud/providers';

export interface FakeRequest {
  method: string;
  path: string;
  search: URLSearchParams;
  headers: IncomingHttpHeaders;
  /** The form body, for POST requests. */
  form: URLSearchParams;
}

export interface FakeReply {
  status?: number;
  headers?: Record<string, string>;
  /** Sent as JSON when present. */
  json?: unknown;
  text?: string;
}

export type FakeHandler = (request: FakeRequest) => FakeReply;

export interface FakeProvider {
  origin: string;
  requests: FakeRequest[];
  close(): Promise<void>;
}

export async function startFakeProvider(handler: FakeHandler): Promise<FakeProvider> {
  const requests: FakeRequest[] = [];
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
      const request: FakeRequest = {
        method: incoming.method ?? 'GET',
        path: url.pathname,
        search: url.searchParams,
        headers: incoming.headers,
        form: new URLSearchParams(Buffer.concat(chunks).toString('utf8')),
      };
      requests.push(request);
      const reply = handler(request);
      const isJson = reply.json !== undefined;
      outgoing.writeHead(reply.status ?? 200, {
        'Content-Type': isJson ? 'application/json' : 'text/plain; charset=utf-8',
        Connection: 'close',
        ...reply.headers,
      });
      outgoing.end(isJson ? JSON.stringify(reply.json) : (reply.text ?? ''));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** The provider's real endpoints, redirected to the fake origin, with a test client id. */
export function testProvider(id: CloudProviderId, origin: string, clientId = 'test-client-id'): ConfiguredProvider {
  const configured = configureProvider(id, { [id]: clientId });
  const apiBase = id === 'googleCalendar' ? `${origin}/calendar/v3` : origin;
  return {
    ...configured,
    authorizationUrl: `${origin}/authorize`,
    tokenUrl: `${origin}/token`,
    apiBase,
  };
}

/** Adds query parameters to a URL. Used to play the browser's redirect back to the loopback listener. */
export function withParams(url: string, params: Record<string, string>): string {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return target.href;
}
