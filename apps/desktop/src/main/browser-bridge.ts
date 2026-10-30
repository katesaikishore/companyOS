import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';

/** A visit the browser extension reported: the browser and the template of its active tab, never a full URL. */
export interface BrowserVisit {
  browser: 'chrome' | 'edge';
  template: string;
}

/** The app name the engine records for each browser. The classifier treats both as browsers. */
export const BROWSER_APP_NAMES: Readonly<Record<BrowserVisit['browser'], string>> = {
  chrome: 'Google Chrome',
  edge: 'Microsoft Edge',
};

export interface BrowserBridgeOptions {
  /** The per-install socket inside the app's data folder. Unix socket on macOS and Linux. */
  socketPath: string;
  /** Holds the bridge token. The file is mode 0600, and a new token is written on every start. */
  tokenPath: string;
  /** Called once for each valid, authorised visit. The caller hands it to the engine. */
  onVisit: (visit: BrowserVisit) => void;
}

const MAX_REQUEST_CHARS = 1024;
const REQUEST_TIMEOUT_MS = 5000;
/** Unix socket paths are limited to about 104 bytes on macOS. Longer paths fail with a clear error. */
const MAX_SOCKET_PATH_BYTES = 100;
const REQUEST_FIELDS = new Set(['browser', 'template', 'token', 'type']);
/** A host, then up to four path segments, each a plain lowercase word or :id. Matches what urlTemplate returns. */
const TEMPLATE_PATTERN = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*(?:\/(?::id|[a-z]{1,12})){0,4}$/;

interface Request extends BrowserVisit {
  token: string;
}

/**
 * Accepts visits from the native messaging host over a local socket. The socket is mode 0600 inside a 0700 folder,
 * and every request must carry the token. The bridge checks the shape of each request before it does anything.
 */
export class BrowserBridge {
  private server: Server | undefined;

  constructor(
    private readonly options: BrowserBridgeOptions,
    private readonly token: string,
  ) {}

  /** Creates the socket and starts accepting requests. Use startBrowserBridge rather than calling this directly. */
  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer(socket => this.serve(socket));
      server.once('error', reject);
      server.listen(this.options.socketPath, () => {
        server.removeListener('error', reject);
        try {
          chmodSync(this.options.socketPath, 0o600);
        } catch (error) {
          server.close();
          reject(error);
          return;
        }
        // Errors after startup must not crash the app. A failed request simply gets no reply.
        server.on('error', () => undefined);
        this.server = server;
        resolve();
      });
    });
  }

  /** Stops listening and removes the socket and the token, so the host can no longer authenticate. */
  stop(): void {
    this.server?.close();
    this.server = undefined;
    rmSync(this.options.socketPath, { force: true });
    rmSync(this.options.tokenPath, { force: true });
  }

  private serve(socket: Socket): void {
    socket.setEncoding('utf8');
    let received = '';
    let answered = false;
    const timer = setTimeout(() => socket.destroy(), REQUEST_TIMEOUT_MS);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => clearTimeout(timer));
    socket.on('data', (chunk: string) => {
      if (answered) return;
      received += chunk;
      const end = received.indexOf('\n');
      if (end < 0) {
        if (received.length > MAX_REQUEST_CHARS) {
          answered = true;
          socket.end(reply({ ok: false, error: 'bad_request' }));
        }
        return;
      }
      answered = true;
      clearTimeout(timer);
      socket.end(reply(this.handle(received.slice(0, end))));
    });
  }

  private handle(line: string): { ok: boolean; error?: string } {
    const request = parseRequest(line);
    if (!request) return { ok: false, error: 'bad_request' };
    if (!sameToken(request.token, this.token)) return { ok: false, error: 'unauthorized' };
    try {
      this.options.onVisit({ browser: request.browser, template: request.template });
    } catch {
      return { ok: false, error: 'rejected' };
    }
    return { ok: true };
  }
}

/**
 * Creates the data folder, writes a fresh token, clears a socket left by a crash, and starts listening.
 * Any failure removes the token again, so no token outlives a bridge that is not running.
 */
export async function startBrowserBridge(options: BrowserBridgeOptions): Promise<BrowserBridge> {
  if (Buffer.byteLength(options.socketPath) > MAX_SOCKET_PATH_BYTES) {
    throw new Error('The browser bridge socket path is too long for this system.');
  }
  const folder = dirname(options.socketPath);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o700);

  const token = randomBytes(32).toString('hex');
  writeFileSync(options.tokenPath, token, { mode: 0o600 });
  chmodSync(options.tokenPath, 0o600);
  rmSync(options.socketPath, { force: true });

  const bridge = new BrowserBridge(options, token);
  try {
    await bridge.listen();
  } catch (error) {
    rmSync(options.tokenPath, { force: true });
    throw error;
  }
  return bridge;
}

/** Returns the request only when it has exactly the expected fields and valid values. Anything else is refused. */
function parseRequest(line: string): Request | undefined {
  if (line.length > MAX_REQUEST_CHARS) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).some(key => !REQUEST_FIELDS.has(key))) return undefined;

  const browser = fields.browser === 'chrome' ? 'chrome' : fields.browser === 'edge' ? 'edge' : undefined;
  const { template, token, type } = fields;
  if (type !== 'visit' || !browser) return undefined;
  if (typeof template !== 'string' || template.length > 300 || !TEMPLATE_PATTERN.test(template)) return undefined;
  if (typeof token !== 'string' || token.length > 128) return undefined;
  return { browser, template, token };
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function reply(value: { ok: boolean; error?: string }): string {
  return `${JSON.stringify(value)}\n`;
}
