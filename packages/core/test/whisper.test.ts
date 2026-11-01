import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertBundleSpec,
  bundleDigest,
  bundleSizesMatch,
  bundleTotalBytes,
  downloadBundle,
  verifyBundle,
  type BundleFileSpec,
  type BundleSpec,
} from '../src/models/bundle-download';
import type { NetworkEntry } from '../src/models/types';
import { WHISPER_BUNDLE, whisperDirectory } from '../src/models/whisper';
import { tempFolders } from './temp-folders';

const temps = tempFolders();

const REVISION = 'a'.repeat(40);
const ORIGIN = 'https://huggingface.co';
const REPO_PATH = '/example/test-bundle/resolve/' + REVISION;

const payloads: Record<string, Buffer> = {
  'config.json': Buffer.from('{"model_type":"test"}'),
  'onnx/encoder.onnx': Buffer.from('encoder bytes '.repeat(3000)),
};

const digestOf = (body: Buffer): string => createHash('sha256').update(body).digest('hex');

function specFrom(overrides: Partial<BundleSpec> = {}, bodies: Record<string, Buffer> = payloads): BundleSpec {
  const files: BundleFileSpec[] = Object.entries(bodies).map(([path, body]) => ({ path, bytes: body.length, sha256: digestOf(body) }));
  return { id: 'test-bundle', repo: 'example/test-bundle', revision: REVISION, license: 'MIT', files, ...overrides };
}

/**
 * A fake network. It answers by URL and records every URL it is asked for, so a test can prove that a refused host was never
 * contacted. Nothing leaves the test process.
 */
function fakeNetwork(routes: Record<string, () => Response>) {
  const contacted: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    contacted.push(url.origin + url.pathname);
    const route = routes[url.origin + url.pathname];
    if (!route) return new Response('not found', { status: 404 });
    return route();
  }) as typeof fetch;
  return { fetchImpl, contacted };
}

const serve = (body: Buffer, declared = body.length) => () =>
  new Response(new Uint8Array(body), { status: 200, headers: { 'content-length': String(declared) } });
const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } });

function routesFor(overrides: Record<string, () => Response> = {}, bodies: Record<string, Buffer> = payloads) {
  const routes: Record<string, () => Response> = {};
  for (const [path, body] of Object.entries(bodies)) routes[`${ORIGIN}${REPO_PATH}/${path}`] = serve(body);
  return { ...routes, ...overrides };
}

describe('pinned Whisper bundle', () => {
  it('is a well formed, open, commit-pinned bundle with the files the speech runtime loads', () => {
    expect(() => assertBundleSpec(WHISPER_BUNDLE)).not.toThrow();
    expect(WHISPER_BUNDLE.id).toBe('whisper-tiny-en');
    expect(WHISPER_BUNDLE.license).toBe('Apache-2.0');
    expect(WHISPER_BUNDLE.revision).toMatch(/^[0-9a-f]{40}$/);
    const paths = WHISPER_BUNDLE.files.map(file => file.path);
    for (const required of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx']) {
      expect(paths).toContain(required);
    }
    expect(bundleTotalBytes(WHISPER_BUNDLE)).toBeGreaterThan(40_000_000);
  });

  it('keeps the bundle in a folder named for the repository and the commit, under the models folder', () => {
    expect(whisperDirectory('/models')).toBe(join('/models', 'onnx-community--whisper-tiny.en', WHISPER_BUNDLE.revision));
  });
});

describe('assertBundleSpec', () => {
  it('refuses a licence that is not open, a branch instead of a commit, an unsafe path, and a malformed digest', () => {
    expect(() => assertBundleSpec(specFrom({ license: 'Llama-community' as never }))).toThrow(/not allowed/);
    expect(() => assertBundleSpec(specFrom({ revision: 'main' }))).toThrow(/full commit hash/);
    expect(() => assertBundleSpec(specFrom({ files: [{ path: '../evil.bin', bytes: 1, sha256: 'a'.repeat(64) }] }))).toThrow(/not safe/);
    expect(() => assertBundleSpec(specFrom({ files: [{ path: 'a.bin', bytes: 1, sha256: 'abc' }] }))).toThrow(/digest/);
  });
});

describe('downloadBundle', () => {
  it('downloads every file, checks each digest, and writes one ledger entry per file', async () => {
    const dir = temps.folder('whisper-bundle-');
    const spec = specFrom();
    const { fetchImpl } = fakeNetwork(routesFor());
    const entries: NetworkEntry[] = [];

    const result = await downloadBundle({ spec, destinationDir: dir, allowedHosts: ['huggingface.co'], fetchImpl, record: entry => entries.push(entry) });

    expect(result.bytes).toBe(bundleTotalBytes(spec));
    expect(result.digest).toBe(bundleDigest(spec));
    expect(await verifyBundle(spec, dir)).toBe(true);
    expect(entries).toHaveLength(2);
    expect(entries.map(entry => entry.file).sort()).toEqual(['config.json', 'onnx/encoder.onnx']);
    for (const entry of entries) {
      expect(entry).toMatchObject({ purpose: 'model_download', modelId: 'test-bundle', host: 'huggingface.co', outcome: 'ok', sha256Verified: true });
    }
    expect(existsSync(join(dir, 'onnx', 'encoder.onnx.part'))).toBe(false);
  });

  it('keeps a file that is already whole and verified, and requests only the rest', async () => {
    const dir = temps.folder('whisper-bundle-');
    const spec = specFrom();
    writeFileSync(join(dir, 'config.json'), payloads['config.json']);
    const { fetchImpl, contacted } = fakeNetwork(routesFor());
    const entries: NetworkEntry[] = [];

    await downloadBundle({ spec, destinationDir: dir, allowedHosts: ['huggingface.co'], fetchImpl, record: entry => entries.push(entry) });

    expect(contacted).toEqual([`${ORIGIN}${REPO_PATH}/onnx/encoder.onnx`]);
    expect(entries.map(entry => entry.file)).toEqual(['onnx/encoder.onnx']);
  });

  it('rejects a file whose digest does not match, and leaves neither the file nor a partial file behind', async () => {
    const dir = temps.folder('whisper-bundle-');
    const spec = specFrom();
    const tampered = Buffer.alloc(payloads['onnx/encoder.onnx'].length, 'x');
    const { fetchImpl } = fakeNetwork(routesFor({ [`${ORIGIN}${REPO_PATH}/onnx/encoder.onnx`]: serve(tampered) }));
    const entries: NetworkEntry[] = [];

    await expect(
      downloadBundle({ spec, destinationDir: dir, allowedHosts: ['huggingface.co'], fetchImpl, record: entry => entries.push(entry) }),
    ).rejects.toThrow(/checksum/);

    expect(existsSync(join(dir, 'onnx', 'encoder.onnx'))).toBe(false);
    expect(existsSync(join(dir, 'onnx', 'encoder.onnx.part'))).toBe(false);
    expect(await verifyBundle(spec, dir)).toBe(false);
    expect(entries.find(entry => entry.file === 'onnx/encoder.onnx')).toMatchObject({ outcome: 'failed', sha256Verified: false });
  });

  it('refuses a redirect to a host that is not on the allowlist, and never contacts that host', async () => {
    const dir = temps.folder('whisper-bundle-');
    const spec = specFrom();
    const { fetchImpl, contacted } = fakeNetwork(
      routesFor({ [`${ORIGIN}${REPO_PATH}/onnx/encoder.onnx`]: redirect('https://evil.example.com/steal.onnx') }),
    );

    await expect(downloadBundle({ spec, destinationDir: dir, allowedHosts: ['huggingface.co', '.hf.co'], fetchImpl })).rejects.toThrow(/allowlist/);

    expect(contacted.some(url => url.includes('evil.example.com'))).toBe(false);
  });

  it('refuses a redirect down to plain http', async () => {
    const dir = temps.folder('whisper-bundle-');
    const spec = specFrom();
    const { fetchImpl } = fakeNetwork(routesFor({ [`${ORIGIN}${REPO_PATH}/onnx/encoder.onnx`]: redirect('http://huggingface.co/insecure.onnx') }));

    await expect(downloadBundle({ spec, destinationDir: dir, allowedHosts: ['huggingface.co'], fetchImpl })).rejects.toThrow(/https/);
  });

  it('refuses a file whose declared size differs from the pin, before any byte is kept', async () => {
    const dir = temps.folder('whisper-bundle-');
    const spec = specFrom();
    const encoder = payloads['onnx/encoder.onnx'];
    const { fetchImpl, contacted } = fakeNetwork(routesFor({ [`${ORIGIN}${REPO_PATH}/onnx/encoder.onnx`]: serve(encoder, encoder.length + 5) }));
    const entries: NetworkEntry[] = [];

    await expect(
      downloadBundle({ spec, destinationDir: dir, allowedHosts: ['huggingface.co'], fetchImpl, record: entry => entries.push(entry) }),
    ).rejects.toThrow(/expected size/);

    expect(contacted.filter(url => url.endsWith('onnx/encoder.onnx'))).toHaveLength(1);
    expect(existsSync(join(dir, 'onnx', 'encoder.onnx.part'))).toBe(false);
    expect(entries.find(entry => entry.file === 'onnx/encoder.onnx')).toMatchObject({ outcome: 'failed', bytes: 0 });
  });

  it('does nothing and makes no request once cancelled', async () => {
    const dir = temps.folder('whisper-bundle-');
    const spec = specFrom();
    const { fetchImpl, contacted } = fakeNetwork(routesFor());
    const controller = new AbortController();
    controller.abort();

    await expect(downloadBundle({ spec, destinationDir: dir, allowedHosts: ['huggingface.co'], fetchImpl, signal: controller.signal })).rejects.toThrow(/cancelled/);

    expect(contacted).toEqual([]);
  });
});

describe('verifyBundle and bundleSizesMatch', () => {
  it('detects a file that was changed in place, and a file that was truncated', async () => {
    const dir = temps.folder('whisper-bundle-');
    const spec = specFrom();
    const { fetchImpl } = fakeNetwork(routesFor());
    await downloadBundle({ spec, destinationDir: dir, allowedHosts: ['huggingface.co'], fetchImpl });
    expect(await verifyBundle(spec, dir)).toBe(true);

    // Same size, different bytes: the size check passes, the digest check does not.
    writeFileSync(join(dir, 'config.json'), Buffer.alloc(payloads['config.json'].length, 'z'));
    expect(await bundleSizesMatch(spec, dir)).toBe(true);
    expect(await verifyBundle(spec, dir)).toBe(false);

    writeFileSync(join(dir, 'onnx', 'encoder.onnx'), Buffer.from('short'));
    expect(await bundleSizesMatch(spec, dir)).toBe(false);
  });
});
