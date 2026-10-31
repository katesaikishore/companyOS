import { COLLECTIONS, EncryptedStore } from '@companyos/twin-core';
import childProcess from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { join, relative, sep } from 'node:path';
import tls from 'node:tls';
import { format, inspect } from 'node:util';
import { vi } from 'vitest';
import type { Surface } from './canaries';

/** Every file under a folder, depth first. */
export function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

function posixPath(path: string): string {
  return path.split(sep).join('/');
}

/**
 * Everything the app left on disk under its data folder, as the attacker would see it. Files inside the encrypted
 * store are read three ways: raw bytes, each base64 line decoded, and each record decrypted with the data key.
 */
export function diskSurfaces(root: string, storeDir: string, key: Buffer): Surface[] {
  const files = listFiles(root);
  const surfaces: Surface[] = [{ name: 'disk:names', text: files.map(path => posixPath(relative(root, path))).join('\n') }];
  for (const path of files) {
    const text = readFileSync(path).toString('latin1');
    if (!path.startsWith(storeDir + sep)) {
      surfaces.push({ name: `disk:raw:${posixPath(relative(root, path))}`, text });
      continue;
    }
    const name = posixPath(relative(storeDir, path));
    surfaces.push({ name: `store:raw:${name}`, text });
    if (name.endsWith('.log')) {
      const decoded = text
        .split('\n')
        .filter(line => line.length > 0)
        .map(line => Buffer.from(line, 'base64').toString('latin1'))
        .join('\n');
      surfaces.push({ name: `store:decoded:${name}`, text: decoded });
    }
  }
  const store = new EncryptedStore(storeDir, key);
  try {
    for (const collection of COLLECTIONS) {
      surfaces.push({ name: `store:decrypted:${collection}`, text: JSON.stringify(store.readAll(collection), null, 2) });
    }
  } finally {
    // Windows will not delete the store's files while this handle is open.
    store.close();
  }
  return surfaces;
}

/**
 * Collects everything written to the console and to stdout or stderr while it is installed. Output stays in
 * memory and is never printed, so a canary cannot leak through the test run itself.
 */
export class ConsoleCapture {
  private readonly lines: string[] = [];
  private readonly spies: Array<{ mockRestore: () => void }> = [];

  constructor() {
    for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
      this.spies.push(
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          this.lines.push(format(...args));
        }),
      );
    }
    for (const stream of [process.stdout, process.stderr]) {
      this.spies.push(
        vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown) => {
          this.lines.push(String(chunk));
          return true;
        }) as never),
      );
    }
  }

  text(): string {
    return this.lines.join('\n');
  }

  restore(): void {
    for (const spy of this.spies) spy.mockRestore();
  }
}

/** Everything an error carries: name, message, stack, cause and any own or hidden property. */
export function errorText(error: unknown): string {
  return inspect(error, { depth: 8, showHidden: true, getters: true, breakLength: Number.POSITIVE_INFINITY });
}

/** What fetch accepts as its first argument, taken from fetch itself so it works with the Node types only. */
type FetchInput = Parameters<typeof fetch>[0];

function urlOf(input: FetchInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * A fetch stand-in. It writes each request, its method and its headers to the outbound log, then answers with
 * whatever the test chooses. The download code takes it through its fetchImpl option.
 */
export function recordingFetch(outbound: string[], respond: (url: string) => Response): typeof fetch {
  return (async (input: FetchInput, init?: RequestInit) => {
    const headers = JSON.stringify([...new Headers(init?.headers ?? {}).entries()]);
    outbound.push(`${init?.method ?? 'GET'} ${urlOf(input)} ${headers}`);
    return respond(urlOf(input));
  }) as typeof fetch;
}

/**
 * Refuses every network and process call the suite did not plan: the global fetch, the http, https, net and tls
 * connect functions, and child_process. Each attempt is written to the outbound log, marked UNEXPECTED, and fails.
 * The one planned call, the model download, goes through its own recorder instead. No process is planned.
 * Returns a function that puts the originals back.
 */
export function refuseOutbound(outbound: string[]): () => void {
  const restores: Array<() => void> = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    outbound.push(`UNEXPECTED fetch ${init?.method ?? 'GET'} ${urlOf(input)}`);
    throw new Error('This test does not allow network calls.');
  }) as typeof fetch;
  restores.push(() => {
    globalThis.fetch = originalFetch;
  });

  const guarded: Array<[string, object, string]> = [
    ['http', http, 'request'],
    ['http', http, 'get'],
    ['https', https, 'request'],
    ['https', https, 'get'],
    ['net', net, 'connect'],
    ['net', net, 'createConnection'],
    ['tls', tls, 'connect'],
    ['child_process', childProcess, 'spawn'],
    ['child_process', childProcess, 'exec'],
    ['child_process', childProcess, 'execFile'],
    ['child_process', childProcess, 'fork'],
  ];
  for (const [module, target, method] of guarded) {
    const spy = vi.spyOn(target as Record<string, (...args: unknown[]) => unknown>, method).mockImplementation(() => {
      outbound.push(`UNEXPECTED ${module}.${method}`);
      throw new Error('This test does not allow network or process calls.');
    });
    restores.push(() => spy.mockRestore());
  }

  return () => {
    for (const restore of restores) restore();
  };
}
