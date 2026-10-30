import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { MAX_REQUEST_CHARS, parseVisitRequest, socketPathProblem, tokensMatch } from '@companyos/twin-core';

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

const REQUEST_TIMEOUT_MS = 5000;

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
    const request = parseVisitRequest(line);
    if (!request) return { ok: false, error: 'bad_request' };
    if (!tokensMatch(request.token, this.token)) return { ok: false, error: 'unauthorized' };
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
  const problem = socketPathProblem(options.socketPath);
  if (problem) throw new Error(problem);
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

function reply(value: { ok: boolean; error?: string }): string {
  return `${JSON.stringify(value)}\n`;
}
