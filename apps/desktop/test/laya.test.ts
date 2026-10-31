import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NetworkEntry, TwinAgent } from '@companyos/twin-core';
import { ModelManager } from '../src/main/models';
import {
  LAYA_BUNDLE,
  LAYA_MIN_FREE_BYTES,
  LAYA_MODEL_ID,
  LAYA_REVISION,
  LayaBundleManager,
  assertLayaBundleSpec,
  layaBundleDir,
  layaSupported,
  readLayaFixture,
  totalBytes,
  type LayaBundleSpec,
  type LayaManagerOptions,
  type LayaRuntime,
} from '../src/main/laya';
import { createRangeServer, type RangeServer } from './range-server.cjs';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** Deterministic bytes, so a failure can be reproduced. */
function bytesOf(label: string, length: number): Buffer {
  const out = Buffer.alloc(length);
  let block = createHash('sha256').update(label).digest();
  for (let at = 0; at < length; at += block.length) {
    block.copy(out, at, 0, Math.min(block.length, length - at));
    block = createHash('sha256').update(block).digest();
  }
  return out;
}

const REVISION = '0123456789abcdef0123456789abcdef01234567';
const SIZES: Record<string, number> = {
  'laya.onnx': 90_000,
  'laya.onnx.data': 600_000,
  'laya_config.json': 355,
  'tokenizer/tokenizer.json': 40_000,
  'tokenizer/tokenizer_config.json': 308,
};
const FILES: Record<string, Buffer> = Object.fromEntries(Object.entries(SIZES).map(([name, size]) => [name, bytesOf(name, size)]));
const SPEC: LayaBundleSpec = {
  repo: 'receptron/laya-onnx',
  revision: REVISION,
  files: Object.entries(FILES).map(([path, data]) => ({ path, bytes: data.length, sha256: sha256(data) })),
};
const TOTAL = totalBytes(SPEC);
const DATA = 'laya.onnx.data';

describe('the pinned bundle', () => {
  it('matches the pins in the design document, file by file', () => {
    const doc = readFileSync(join(__dirname, '../../../docs/research/laya-decision-layer.md'), 'utf8');
    expect(doc).toContain(LAYA_REVISION);
    for (const file of LAYA_BUNDLE.files) {
      const row = doc.split('\n').find(line => line.startsWith(`| \`${file.path}\` |`));
      expect(row, `${file.path} has a row in the pins table`).toBeDefined();
      const cells = row!.split('|').map(cell => cell.trim().replace(/`/g, ''));
      expect(Number(cells[2])).toBe(file.bytes);
      expect(cells[3]).toBe(file.sha256);
    }
  });

  it('is the five files, about 1.69 GB, at a commit and not at main', () => {
    expect(LAYA_BUNDLE.files.map(file => file.path)).toEqual([
      'laya.onnx',
      'laya.onnx.data',
      'laya_config.json',
      'tokenizer/tokenizer.json',
      'tokenizer/tokenizer_config.json',
    ]);
    expect(totalBytes(LAYA_BUNDLE)).toBe(1_692_649_422);
    expect(LAYA_BUNDLE.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(() => assertLayaBundleSpec(LAYA_BUNDLE)).not.toThrow();
  });

  it('refuses a spec that is not pinned, or that names a file outside the folder', () => {
    const file = SPEC.files[0];
    expect(() => assertLayaBundleSpec({ ...SPEC, revision: 'main' })).toThrow(/commit/);
    expect(() => assertLayaBundleSpec({ ...SPEC, files: [{ ...file, path: '../escape' }] })).toThrow(/not safe/);
    expect(() => assertLayaBundleSpec({ ...SPEC, files: [{ ...file, path: '/abs' }] })).toThrow(/not safe/);
    expect(() => assertLayaBundleSpec({ ...SPEC, files: [{ ...file, path: '.hidden' }] })).toThrow(/not safe/);
    expect(() => assertLayaBundleSpec({ ...SPEC, files: [file, file] })).toThrow(/twice/);
    expect(() => assertLayaBundleSpec({ ...SPEC, files: [{ ...file, sha256: 'abc' }] })).toThrow(/digest/);
    expect(() => assertLayaBundleSpec({ ...SPEC, files: [{ ...file, bytes: 0 }] })).toThrow(/size/);
    expect(() => assertLayaBundleSpec({ ...SPEC, repo: 'no-owner' })).toThrow(/repository/);
  });

  it('lives where the @receptron/laya package keeps its own cache, so one folder serves both', () => {
    expect(layaBundleDir('/root')).toBe(join('/root', 'receptron--laya-onnx', LAYA_REVISION));
  });

  it('is offered only where onnxruntime-node ships a binding', () => {
    expect(layaSupported('darwin', 'arm64')).toBe(true);
    expect(layaSupported('linux', 'x64')).toBe(true);
    expect(layaSupported('linux', 'arm64')).toBe(true);
    expect(layaSupported('win32', 'x64')).toBe(true);
    expect(layaSupported('win32', 'arm64')).toBe(true);
    expect(layaSupported('darwin', 'x64')).toBe(false);
    expect(layaSupported('freebsd', 'x64')).toBe(false);
  });
});

describe('LayaBundleManager', () => {
  let base: string;
  let root: string;
  let server: RangeServer;
  let entries: NetworkEntry[];
  let managers: LayaBundleManager[];

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'laya-test-'));
    root = join(base, 'models', 'laya');
    entries = [];
    managers = [];
    server = await createRangeServer(FILES, { revision: REVISION, chunkBytes: 16_384 });
  });

  afterEach(async () => {
    for (const manager of managers) {
      manager.cancel();
      await manager.unload();
    }
    await server.close();
    rmSync(base, { recursive: true, force: true });
  });

  function make(overrides: Partial<LayaManagerOptions> = {}): LayaBundleManager {
    const manager = new LayaBundleManager({
      rootDir: root,
      record: entry => entries.push(entry),
      spec: SPEC,
      baseUrl: server.url,
      allowedHosts: ['127.0.0.1'],
      requireHttps: false,
      minFreeBytes: 1_000_000,
      freeBytes: async () => 10_000_000_000,
      supported: true,
      ...overrides,
    });
    managers.push(manager);
    return manager;
  }

  const dir = (): string => layaBundleDir(root, SPEC);
  const settled = (manager: LayaBundleManager) =>
    vi.waitFor(() => expect(['installed', 'failed', 'cancelled']).toContain(manager.view().status), { timeout: 20_000, interval: 5 });
  const run = async (manager: LayaBundleManager): Promise<void> => {
    manager.install();
    await settled(manager);
  };
  const filesUnder = (path: string): string[] =>
    existsSync(path)
      ? readdirSync(path, { withFileTypes: true }).flatMap(entry =>
          entry.isDirectory() ? filesUnder(join(path, entry.name)) : [join(path, entry.name)],
        )
      : [];
  const requestsFor = (name: string) => server.requests.filter(request => request.url.endsWith(`/${name}`));

  describe('install', () => {
    it('downloads the five files from the pinned commit, keeps each only after its digest matches, and ends installed', async () => {
      const manager = make();
      expect(manager.view()).toMatchObject({ status: 'not_installed', totalBytes: TOTAL, hasPartial: false, revision: REVISION });
      await run(manager);

      expect(manager.view()).toMatchObject({ status: 'installed', receivedBytes: TOTAL, message: undefined, hasPartial: false });
      for (const file of SPEC.files) expect(readFileSync(join(dir(), file.path)).equals(FILES[file.path])).toBe(true);
      expect(filesUnder(dir()).filter(path => path.endsWith('.part'))).toEqual([]);
      for (const request of server.requests) {
        expect(request.method).toBe('GET');
        expect(request.url.startsWith(`/receptron/laya-onnx/resolve/${REVISION}/`)).toBe(true);
        expect(request.url).not.toContain('main');
      }
    });

    it('sends no credential and asks for the bytes uncompressed', async () => {
      await run(make());
      expect(server.requests).toHaveLength(5);
      for (const request of server.requests) {
        expect(request.headers.authorization).toBeUndefined();
        expect(request.headers.cookie).toBeUndefined();
        expect(request.headers['accept-encoding']).toBe('identity');
        expect(request.headers.range).toBeUndefined();
      }
    });

    it('writes one ledger entry per file with host, file name and bytes', async () => {
      await run(make());
      expect(entries).toHaveLength(5);
      expect(entries.map(entry => entry.file)).toEqual(SPEC.files.map(file => file.path));
      for (const entry of entries) {
        expect(entry).toMatchObject({ purpose: 'model_download', modelId: LAYA_MODEL_ID, host: '127.0.0.1', outcome: 'ok', sha256Verified: true });
        expect(entry.path).toBe(`/receptron/laya-onnx/resolve/${REVISION}/${entry.file}`);
        expect(entry.bytes).toBe(FILES[entry.file!].length);
      }
      expect(JSON.stringify(entries)).not.toMatch(/bearer|authorization|hf_[A-Za-z0-9]{8}/i);
    });

    it('reports progress as events and as a byte count that only grows', async () => {
      const manager = make();
      const events: Array<{ status: string; file?: string; receivedBytes: number }> = [];
      const stop = manager.subscribe(event => events.push(event));
      const changes = vi.fn();
      const counted = make({ onChange: changes });
      await run(manager);
      stop();
      await run(counted);

      expect(events.length).toBeGreaterThan(5);
      const received = events.map(event => event.receivedBytes);
      expect(received).toEqual([...received].sort((a, b) => a - b));
      expect(received.at(-1)).toBe(TOTAL);
      expect(events.at(-1)).toMatchObject({ status: 'installed', totalBytes: TOTAL });
      expect(new Set(events.map(event => event.status))).toEqual(new Set(['downloading', 'verifying', 'installed']));
      expect(events.find(event => event.status === 'downloading' && event.file === DATA)).toBeDefined();
      expect(changes).toHaveBeenCalled();
    });

    it('does nothing when it is already installed or already running', async () => {
      const manager = make();
      manager.install();
      manager.install();
      await settled(manager);
      expect(requestsFor('laya.onnx')).toHaveLength(1);
      manager.install();
      expect(manager.view().status).toBe('installed');
      expect(server.requests).toHaveLength(5);
    });

    it('follows a redirect to another host and records the host that served the bytes', async () => {
      await server.close();
      server = await createRangeServer(FILES, { revision: REVISION, redirect: true });
      server.rules.push(({ via, name }) => (via === 'resolve' ? { redirectTo: `http://localhost:${server.port}/cdn/${name}` } : undefined));
      await run(make({ allowedHosts: ['127.0.0.1', 'localhost'] }));

      expect(entries).toHaveLength(5);
      expect(entries.every(entry => entry.host === 'localhost' && entry.outcome === 'ok')).toBe(true);
      expect(requestsFor(DATA).map(request => request.url.split('/')[1])).toEqual(['receptron', 'cdn']);
    });

    it('refuses a redirect to a host that is not on the allowlist, and writes nothing', async () => {
      server.rules.push(({ via, name }) => (via === 'resolve' ? { redirectTo: `http://localhost:${server.port}/cdn/${name}` } : undefined));
      const manager = make();
      await run(manager);

      expect(manager.view().status).toBe('failed');
      expect(manager.view().message).toMatch(/localhost is not on the download allowlist/);
      expect(filesUnder(dir())).toEqual([]);
      expect(entries).toEqual([expect.objectContaining({ file: 'laya.onnx', outcome: 'failed', sha256Verified: false, bytes: 0 })]);
    });

    it('refuses plain http when https is required', async () => {
      const manager = make({ requireHttps: true });
      await run(manager);
      expect(manager.view()).toMatchObject({ status: 'failed', message: 'Only https downloads are allowed.' });
      expect(server.requests).toHaveLength(0);
    });
  });

  describe('resume', () => {
    it('keeps a truncated download, then continues it with a Range request and ends with the right bytes', async () => {
      let firstData = true;
      server.rules.push(({ name }) => {
        if (name !== DATA || !firstData) return undefined;
        firstData = false;
        return { truncateAt: 250_000 };
      });
      const manager = make();
      await run(manager);

      expect(manager.view().status).toBe('failed');
      expect(manager.view().message).toMatch(/connection was lost/i);
      const part = join(dir(), `${DATA}.part`);
      const kept = statSync(part).size;
      expect(kept).toBeGreaterThan(0);
      expect(kept).toBeLessThan(SIZES[DATA]);
      expect(existsSync(join(dir(), DATA))).toBe(false);
      expect(manager.view()).toMatchObject({ hasPartial: true });
      // The bytes already fetched count towards progress, so the bar does not fall back to zero.
      expect(manager.view().receivedBytes).toBe(SIZES['laya.onnx'] + kept);
      expect(entries.at(-1)).toMatchObject({ file: DATA, outcome: 'failed', sha256Verified: false, bytes: kept });

      await run(manager);

      expect(manager.view()).toMatchObject({ status: 'installed', receivedBytes: TOTAL, hasPartial: false });
      expect(readFileSync(join(dir(), DATA)).equals(FILES[DATA])).toBe(true);
      expect(existsSync(part)).toBe(false);
      const second = requestsFor(DATA).at(-1)!;
      expect(second.headers.range).toBe(`bytes=${kept}-`);
      // The finished file was not fetched again, and the second attempt asked for the rest only.
      expect(requestsFor('laya.onnx')).toHaveLength(1);
      expect(entries.map(entry => entry.file)).toEqual(['laya.onnx', DATA, DATA, 'laya_config.json', 'tokenizer/tokenizer.json', 'tokenizer/tokenizer_config.json']);
      const resumed = entries.find(entry => entry.file === DATA && entry.outcome === 'ok')!;
      expect(resumed.bytes).toBe(SIZES[DATA] - kept);
      expect(resumed.sha256Verified).toBe(true);
    });

    it('restarts the file when the server ignores the Range header', async () => {
      let first = true;
      server.rules.push(({ name }) => {
        if (name === DATA && first) {
          first = false;
          return { truncateAt: 200_000 };
        }
        return name === DATA ? { ignoreRange: true } : undefined;
      });
      const manager = make();
      await run(manager);
      expect(manager.view().status).toBe('failed');
      await run(manager);

      expect(manager.view().status).toBe('installed');
      expect(readFileSync(join(dir(), DATA)).equals(FILES[DATA])).toBe(true);
      expect(requestsFor(DATA).at(-1)!.headers.range).toMatch(/^bytes=\d+-$/);
    });

    it('starts again from zero when the server refuses the offset with 416', async () => {
      let first = true;
      server.rules.push(({ name, ranged }) => {
        if (name === DATA && first) {
          first = false;
          return { truncateAt: 150_000 };
        }
        return name === DATA && ranged ? { status: 416 } : undefined;
      });
      const manager = make();
      await run(manager);
      await run(manager);

      expect(manager.view().status).toBe('installed');
      expect(readFileSync(join(dir(), DATA)).equals(FILES[DATA])).toBe(true);
      const attempts = requestsFor(DATA);
      expect(attempts.at(-1)!.headers.range).toBeUndefined();
    });

    it('rejects a range answer for the wrong part of the file, and deletes the partial file', async () => {
      let first = true;
      server.rules.push(({ name, ranged }) => {
        if (name === DATA && first) {
          first = false;
          return { truncateAt: 150_000 };
        }
        return name === DATA && ranged ? { badRange: `bytes 0-${SIZES[DATA] - 1}/${SIZES[DATA]}` } : undefined;
      });
      const manager = make();
      await run(manager);
      expect(existsSync(join(dir(), `${DATA}.part`))).toBe(true);
      await run(manager);

      expect(manager.view().status).toBe('failed');
      expect(manager.view().message).toMatch(/different part of the file/);
      expect(existsSync(join(dir(), `${DATA}.part`))).toBe(false);
      expect(existsSync(join(dir(), DATA))).toBe(false);

      // With the fault gone, a new attempt begins at zero and finishes.
      server.rules.length = 0;
      await run(manager);
      expect(manager.view().status).toBe('installed');
    });

    it('finishes a part file that is already complete without a request for it', async () => {
      mkdirSync(dir(), { recursive: true });
      writeFileSync(join(dir(), `${DATA}.part`), FILES[DATA]);
      const manager = make();
      await manager.reconcile();
      expect(manager.view()).toMatchObject({ status: 'not_installed', hasPartial: true, receivedBytes: SIZES[DATA] });
      await run(manager);

      expect(manager.view().status).toBe('installed');
      expect(requestsFor(DATA)).toHaveLength(0);
      expect(entries.find(entry => entry.file === DATA)).toBeUndefined();
      expect(readFileSync(join(dir(), DATA)).equals(FILES[DATA])).toBe(true);
    });

    it('rejects a complete part file whose bytes are wrong, and deletes it', async () => {
      mkdirSync(dir(), { recursive: true });
      const bad = Buffer.from(FILES[DATA]);
      bad[10] ^= 1;
      writeFileSync(join(dir(), `${DATA}.part`), bad);
      const manager = make();
      await run(manager);

      expect(manager.view()).toMatchObject({ status: 'failed', message: expect.stringMatching(/failed its checksum and was discarded/) });
      expect(existsSync(join(dir(), `${DATA}.part`))).toBe(false);
      expect(existsSync(join(dir(), DATA))).toBe(false);
      expect(requestsFor(DATA)).toHaveLength(0);
    });

    it('drops a part file that is larger than the file should be', async () => {
      mkdirSync(dir(), { recursive: true });
      writeFileSync(join(dir(), `${DATA}.part`), Buffer.alloc(SIZES[DATA] + 5));
      const manager = make();
      await run(manager);
      expect(manager.view().status).toBe('installed');
      expect(requestsFor(DATA)[0].headers.range).toBeUndefined();
    });
  });

  describe('checks', () => {
    it('rejects a corrupted file with the right size, deletes it, and records an unverified failure', async () => {
      server.rules.push(({ name }) => (name === DATA ? { corrupt: true } : undefined));
      const manager = make();
      await run(manager);

      expect(manager.view()).toMatchObject({ status: 'failed', message: expect.stringMatching(/laya\.onnx\.data failed its checksum and was discarded/) });
      expect(existsSync(join(dir(), DATA))).toBe(false);
      expect(existsSync(join(dir(), `${DATA}.part`))).toBe(false);
      expect(manager.view().hasPartial).toBe(false);
      expect(entries.at(-1)).toMatchObject({ file: DATA, outcome: 'failed', sha256Verified: false, bytes: SIZES[DATA] });
      // The earlier file was good and stays. The next attempt fetches only what is missing.
      expect(existsSync(join(dir(), 'laya.onnx'))).toBe(true);

      server.rules.length = 0;
      await run(manager);
      expect(manager.view().status).toBe('installed');
      expect(requestsFor('laya.onnx')).toHaveLength(1);
      expect(requestsFor(DATA)).toHaveLength(2);
    });

    it('rejects a file whose declared size is not the pinned size, before keeping any bytes', async () => {
      server.rules.push(({ name }) => (name === DATA ? { extra: Buffer.from('x') } : undefined));
      const manager = make();
      await run(manager);

      expect(manager.view()).toMatchObject({ status: 'failed', message: 'The file on the server is not the expected size.' });
      expect(existsSync(join(dir(), `${DATA}.part`))).toBe(false);
      expect(existsSync(join(dir(), DATA))).toBe(false);
      expect(entries.at(-1)).toMatchObject({ file: DATA, outcome: 'failed', sha256Verified: false, bytes: 0 });
    });

    it('rejects a file that is shorter than the pin, even when the server is consistent about it', async () => {
      server.rules.push(({ name }) => (name === 'tokenizer/tokenizer.json' ? { shorten: 1000 } : undefined));
      const manager = make();
      await run(manager);
      expect(manager.view()).toMatchObject({ status: 'failed', message: 'The file on the server is not the expected size.' });
      expect(existsSync(join(dir(), 'tokenizer', 'tokenizer.json'))).toBe(false);
    });

    it('rejects a streamed body that runs past the pinned size, and deletes the partial file', async () => {
      server.rules.push(({ name }) => (name === DATA ? { extra: Buffer.alloc(40_000, 7), noLength: true } : undefined));
      const manager = make();
      await run(manager);

      expect(manager.view()).toMatchObject({ status: 'failed', message: 'The file is larger than expected.' });
      expect(existsSync(join(dir(), `${DATA}.part`))).toBe(false);
      expect(existsSync(join(dir(), DATA))).toBe(false);
    });

    it('rejects an HTTP error and keeps nothing', async () => {
      server.rules.push(({ name }) => (name === 'laya_config.json' ? { status: 503 } : undefined));
      const manager = make();
      await run(manager);
      expect(manager.view()).toMatchObject({ status: 'failed', message: 'The server answered with HTTP 503.' });
      expect(existsSync(join(dir(), 'laya_config.json'))).toBe(false);
      expect(entries.at(-1)).toMatchObject({ file: 'laya_config.json', outcome: 'failed' });
    });

    it('replaces a file on disk that has the right size but the wrong bytes', async () => {
      mkdirSync(dir(), { recursive: true });
      writeFileSync(join(dir(), 'laya.onnx'), Buffer.alloc(SIZES['laya.onnx'], 1));
      const manager = make();
      await manager.reconcile();
      expect(manager.view().status).toBe('not_installed');
      await run(manager);

      expect(manager.view().status).toBe('installed');
      expect(readFileSync(join(dir(), 'laya.onnx')).equals(FILES['laya.onnx'])).toBe(true);
      expect(requestsFor('laya.onnx')).toHaveLength(1);
    });

    it('checks the files again on verify(), and removes one that no longer matches', async () => {
      const manager = make();
      await run(manager);
      expect(await manager.verify()).toBe(true);

      const path = join(dir(), 'laya_config.json');
      const bad = Buffer.from(FILES['laya_config.json']);
      bad[0] ^= 1;
      writeFileSync(path, bad);
      expect(await manager.verify()).toBe(false);
      expect(existsSync(path)).toBe(false);
    });
  });

  describe('disk space', () => {
    it('refuses to start below the minimum, says so, and sends nothing', async () => {
      const manager = make({ minFreeBytes: LAYA_MIN_FREE_BYTES, freeBytes: async () => 1_500_000_000 });
      await run(manager);

      expect(manager.view().status).toBe('failed');
      expect(manager.view().message).toBe('Not enough free disk space. The decision model needs about 2.0 GB free, and this device has 1.5 GB.');
      expect(server.requests).toHaveLength(0);
      expect(entries).toEqual([]);
      expect(existsSync(dir())).toBe(false);
    });

    it('counts what is already on disk, so a resume needs less room', async () => {
      mkdirSync(dir(), { recursive: true });
      writeFileSync(join(dir(), `${DATA}.part`), FILES[DATA].subarray(0, 400_000));
      const manager = make({ minFreeBytes: 1_000_000, freeBytes: async () => 700_000 });
      await run(manager);
      expect(manager.view().status).toBe('installed');
    });

    it('goes ahead when the free space cannot be measured', async () => {
      const manager = make({ freeBytes: async () => undefined });
      await run(manager);
      expect(manager.view().status).toBe('installed');
    });

    it('asks for 2 GB by default, which is more than the bundle', () => {
      const manager = new LayaBundleManager({ rootDir: root, record: () => undefined });
      expect(manager.view().requiredFreeBytes).toBe(LAYA_MIN_FREE_BYTES);
      expect(LAYA_MIN_FREE_BYTES).toBe(2_000_000_000);
      expect(LAYA_MIN_FREE_BYTES).toBeGreaterThan(totalBytes(LAYA_BUNDLE));
    });

    it('is not offered where the runtime has no build', () => {
      const manager = make({ supported: false });
      expect(manager.view().supported).toBe(false);
      expect(() => manager.install()).toThrow(/not available on this system/);
    });
  });

  describe('cancel', () => {
    it('stops a stalled download, keeps the partial file, records the cancellation, and resumes later', async () => {
      let stall = true;
      server.rules.push(({ name }) => (name === DATA && stall ? { stallAt: 200_000 } : undefined));
      const manager = make();
      manager.install();
      await vi.waitFor(() => expect(manager.view().receivedBytes).toBeGreaterThan(SIZES['laya.onnx'] + 100_000), { timeout: 10_000, interval: 5 });
      expect(manager.view().status).toBe('downloading');
      manager.cancel();
      await settled(manager);

      expect(manager.view()).toMatchObject({ status: 'cancelled', message: undefined, hasPartial: true });
      const kept = statSync(join(dir(), `${DATA}.part`)).size;
      expect(kept).toBeGreaterThan(0);
      expect(manager.view().receivedBytes).toBe(SIZES['laya.onnx'] + kept);
      expect(entries.at(-1)).toMatchObject({ file: DATA, outcome: 'cancelled', sha256Verified: false, bytes: kept });
      expect(existsSync(join(dir(), DATA))).toBe(false);

      stall = false;
      await run(manager);
      expect(manager.view().status).toBe('installed');
      expect(requestsFor(DATA).at(-1)!.headers.range).toBe(`bytes=${kept}-`);
      expect(readFileSync(join(dir(), DATA)).equals(FILES[DATA])).toBe(true);
    });

    it('does nothing when no download is running', () => {
      const manager = make();
      expect(() => manager.cancel()).not.toThrow();
      expect(manager.view().status).toBe('not_installed');
    });
  });

  describe('reconcile', () => {
    it('reads an installed bundle at launch without any request', async () => {
      await run(make());
      const requests = server.requests.length;
      const fresh = make();
      await fresh.reconcile();
      expect(fresh.view()).toMatchObject({ status: 'installed', receivedBytes: TOTAL, hasPartial: false });
      expect(server.requests).toHaveLength(requests);
    });

    it('reports a partial download and an empty folder', async () => {
      const manager = make();
      await manager.reconcile();
      expect(manager.view()).toMatchObject({ status: 'not_installed', receivedBytes: 0, hasPartial: false });

      mkdirSync(dir(), { recursive: true });
      writeFileSync(join(dir(), `${DATA}.part`), Buffer.alloc(1234));
      await manager.reconcile();
      expect(manager.view()).toMatchObject({ status: 'not_installed', receivedBytes: 1234, hasPartial: true });
    });

    it('does not call it installed when a file is missing or the wrong size', async () => {
      await run(make());
      writeFileSync(join(dir(), 'laya_config.json'), 'short');
      const manager = make();
      await manager.reconcile();
      expect(manager.view().status).toBe('not_installed');
    });
  });

  describe('load', () => {
    const fakeRuntime = (): LayaRuntime & { closed: boolean } => {
      const runtime = { closed: false, close: vi.fn(async () => void (runtime.closed = true)) };
      return runtime as unknown as LayaRuntime & { closed: boolean };
    };

    it('does not touch the model until it is asked for it', async () => {
      const loadRuntime = vi.fn(async () => fakeRuntime());
      const manager = make({ loadRuntime });
      await run(manager);
      await manager.reconcile();
      expect(loadRuntime).not.toHaveBeenCalled();
    });

    it('refuses to load a bundle that is not installed', async () => {
      const loadRuntime = vi.fn(async () => fakeRuntime());
      const manager = make({ loadRuntime });
      await expect(manager.load()).rejects.toThrow(/not installed/);
      expect(loadRuntime).not.toHaveBeenCalled();
    });

    it('checks every file before loading, once, and loads from the bundle folder', async () => {
      const runtime = fakeRuntime();
      const loadRuntime = vi.fn(async () => runtime);
      const manager = make({ loadRuntime });
      await run(manager);

      const [first, second] = await Promise.all([manager.load(), manager.load()]);
      expect(first).toBe(runtime);
      expect(second).toBe(runtime);
      expect(loadRuntime).toHaveBeenCalledTimes(1);
      expect(loadRuntime).toHaveBeenCalledWith(dir());

      await manager.unload();
      expect(runtime.closed).toBe(true);
      await manager.load();
      expect(loadRuntime).toHaveBeenCalledTimes(2);
    });

    it('does not load a bundle that was changed after it was installed', async () => {
      const loadRuntime = vi.fn(async () => fakeRuntime());
      const manager = make({ loadRuntime });
      await run(manager);
      const path = join(dir(), 'tokenizer', 'tokenizer_config.json');
      const bad = Buffer.from(FILES['tokenizer/tokenizer_config.json']);
      bad[3] ^= 1;
      writeFileSync(path, bad);

      await expect(manager.load()).rejects.toThrow(/failed its checksum/);
      expect(loadRuntime).not.toHaveBeenCalled();
      expect(manager.view().status).toBe('failed');
      expect(existsSync(path)).toBe(false);

      // Installing again fetches only the file that was removed.
      const before = server.requests.length;
      await run(manager);
      expect(manager.view().status).toBe('installed');
      expect(server.requests.length - before).toBe(1);
    });
  });

  describe('remove and wipe', () => {
    it('remove deletes the bundle, a partial download and an older revision, and closes a loaded model', async () => {
      const runtime = { close: vi.fn(async () => undefined) } as unknown as LayaRuntime;
      const manager = make({ loadRuntime: async () => runtime });
      await run(manager);
      await manager.load();
      const older = join(root, 'receptron--laya-onnx', 'f'.repeat(40));
      mkdirSync(older, { recursive: true });
      writeFileSync(join(older, 'laya.onnx.data.part'), 'old');

      await manager.remove();

      expect(existsSync(root)).toBe(false);
      expect(runtime.close).toHaveBeenCalledTimes(1);
      expect(manager.view()).toMatchObject({ status: 'not_installed', receivedBytes: 0, hasPartial: false });
      // It can be installed again afterwards.
      await run(manager);
      expect(manager.view().status).toBe('installed');
    });

    it('wipe cancels a running download, waits for it, removes the folder and refuses new work', async () => {
      server.rules.push(({ name }) => (name === DATA ? { stallAt: 100_000 } : undefined));
      const manager = make();
      manager.install();
      await vi.waitFor(() => expect(manager.view().receivedBytes).toBeGreaterThan(SIZES['laya.onnx'] + 50_000), { timeout: 10_000, interval: 5 });

      await manager.wipe();

      expect(existsSync(root)).toBe(false);
      expect(() => manager.install()).toThrow('The models are being deleted.');
      await expect(manager.load()).rejects.toThrow('The models are being deleted.');
      // Nothing is written back once wipe has returned.
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(existsSync(root)).toBe(false);
      expect(existsSync(join(base, 'models', 'laya'))).toBe(false);
    });

    it('is removed with the models folder by Delete everything, with no other step', async () => {
      await run(make());
      const modelsDir = join(base, 'models');
      writeFileSync(join(modelsDir, 'Qwen3-0.6B-Q8_0.gguf'), 'model');
      const agent = { configuration: { installedModels: [] }, recordNetworkCall: vi.fn(), markModelInstalled: vi.fn(), removeModelRecord: vi.fn() };
      const models = new ModelManager({ modelsDir, agent: agent as unknown as TwinAgent, onChange: vi.fn() });

      await models.wipe();

      expect(existsSync(modelsDir)).toBe(false);
      expect(existsSync(dirname(dirname(dir())))).toBe(false);
    });
  });

  describe('the fixture file', () => {
    it('accepts a local server and refuses anything else', () => {
      const file = join(base, 'fixture.json');
      writeFileSync(file, JSON.stringify({ baseUrl: server.url, spec: SPEC, minFreeBytes: 5 }));
      expect(readLayaFixture(file)).toMatchObject({ baseUrl: server.url, allowedHosts: ['127.0.0.1'], requireHttps: false, minFreeBytes: 5, supported: true });

      for (const baseUrl of ['https://huggingface.co', 'http://example.com', 'http://localhost:1234', 'not a url']) {
        writeFileSync(file, JSON.stringify({ baseUrl, spec: SPEC }));
        expect(() => readLayaFixture(file)).toThrow();
      }
      writeFileSync(file, JSON.stringify({ baseUrl: server.url, spec: { ...SPEC, revision: 'main' } }));
      expect(() => readLayaFixture(file)).toThrow(/commit/);
    });
  });
});

/**
 * Opt-in: uses the real bundle already on this machine, never the network. COMPANYOS_REAL_LAYA=1 runs it, and
 * COMPANYOS_LAYA_CACHE names the folder that holds receptron--laya-onnx/<commit> (default /home/user/laya-cache).
 * It only reads. It never calls remove or wipe, which would delete that folder.
 */
describe.skipIf(!process.env.COMPANYOS_REAL_LAYA)('the real bundle already on this machine', () => {
  const cache = process.env.COMPANYOS_LAYA_CACHE ?? '/home/user/laya-cache';

  it('verifies against the pinned digests and loads through the package, then answers one question', async () => {
    const record = vi.fn();
    const manager = new LayaBundleManager({ rootDir: cache, record, fetchImpl: (() => Promise.reject(new Error('no network in this test'))) as typeof fetch });
    await manager.reconcile();
    expect(manager.view()).toMatchObject({ status: 'installed', totalBytes: 1_692_649_422 });
    expect(await manager.verify()).toBe(true);

    const laya = await manager.load();
    try {
      const result = await laya.systemOne(
        { ticket: 'My invoice shows a charge I did not expect. Please check it and tell me why.' },
        {
          department: { type: 'choice', instructions: 'Which team should handle this ticket?', criteria: ['billing', 'support', 'sales'] },
        },
      );
      const answer = result.answers.department;
      expect(['billing', 'support', 'sales']).toContain(answer.choice);
      const sum = Object.values(answer.probabilities).reduce((total, value) => total + value, 0);
      expect(sum).toBeGreaterThan(0.99);
      expect(sum).toBeLessThan(1.01);
      console.info(`[real laya] answer=${answer.choice} confidence=${answer.answer_confidence} tokens=${result.usage.input_tokens}`);
    } finally {
      await manager.unload();
    }
    expect(record).not.toHaveBeenCalled();
  }, 180_000);
});
