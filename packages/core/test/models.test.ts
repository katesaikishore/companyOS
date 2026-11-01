import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CATALOG,
  DownloadError,
  assertOpenModel,
  buildHardwareProfile,
  classifyFit,
  downloadModel,
  findModel,
  hostAllowed,
  parseLspciGpuNames,
  parseWindowsGpuNames,
  planSetup,
  pickGpu,
  requiredMemoryBytes,
  type HardwareProfile,
  type ModelSpec,
  vendorFromName,
  verifyModelFile,
} from '../src';
import { tempFolders } from './temp-folders';

const temps = tempFolders();

const GIB = 1024 ** 3;

function hardware(overrides: Partial<HardwareProfile> = {}): HardwareProfile {
  return {
    platform: 'linux',
    arch: 'x64',
    cpuModel: 'Test CPU',
    cpuCores: 8,
    memoryBytes: 16 * GIB,
    unifiedMemory: false,
    gpu: { vendor: 'none' },
    freeDiskBytes: 200 * GIB,
    notes: [],
    ...overrides,
  };
}

describe('catalog', () => {
  it('lists only open, licensed, unique models with well-formed digests', () => {
    const ids = CATALOG.map(model => model.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const model of CATALOG) {
      expect(['Apache-2.0', 'MIT']).toContain(model.license);
      expect(model.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(() => assertOpenModel(model)).not.toThrow();
    }
  });

  it('always has one chat ladder and one embedding model', () => {
    expect(CATALOG.filter(model => model.role === 'chat').length).toBe(5);
    expect(CATALOG.filter(model => model.role === 'embedding').length).toBe(1);
    expect(findModel('qwen3-4b')?.file).toBe('Qwen3-4B-Q4_K_M.gguf');
  });

  it('refuses a non-open licence, an unsafe file name, and a malformed digest', () => {
    const base = CATALOG[0];
    expect(() => assertOpenModel({ ...base, license: 'Llama-community' as never })).toThrow(/not allowed/);
    expect(() => assertOpenModel({ ...base, file: '../evil.gguf' })).toThrow(/not safe/);
    expect(() => assertOpenModel({ ...base, sha256: 'abc' })).toThrow(/digest/);
  });
});

describe('planSetup', () => {
  it('recommends the 1.7B model on a 16 GB Linux laptop, the best measured fit for names', () => {
    const plan = planSetup(hardware());
    expect(plan.chat?.spec.id).toBe('qwen3-1.7b');
    expect(plan.chat?.fit).toBe('good');
    // The 4B model fits this laptop, but it was measured worse at naming, so it is an alternative only.
    expect(plan.alternatives.find(entry => entry.spec.id === 'qwen3-4b')?.fit).toBe('good');
    expect(plan.alternatives.find(entry => entry.spec.id === 'qwen3-4b')?.spec.recommended).toBe(false);
    expect(plan.alternatives.find(entry => entry.spec.id === 'qwen3-8b')?.fit).toBe('tight');
    expect(plan.alternatives.find(entry => entry.spec.id === 'qwen3-14b')?.fit).toBe('too_large');
    // Only chat models are planned. The embedding model stays in the catalogue, but setup does not offer it.
    expect(plan).not.toHaveProperty('embedding');
    expect([plan.chat?.spec, ...plan.alternatives.map(entry => entry.spec)].every(spec => spec?.role === 'chat')).toBe(true);
  });

  it('plans from a catalogue that has no embedding model', () => {
    expect(() => planSetup(hardware(), CATALOG.filter(model => model.role === 'chat'))).not.toThrow();
  });

  it('uses more of unified memory on Apple silicon', () => {
    const plan = planSetup(hardware({ platform: 'darwin', arch: 'arm64', unifiedMemory: true, gpu: { vendor: 'apple' }, memoryBytes: 8 * GIB }));
    expect(plan.memoryBudgetBytes).toBe(Math.floor(8 * GIB * 0.6));
    // The 1.7B model's measured peak is above the comfort line on this budget, so the comfortable 0.6B model is recommended.
    expect(plan.alternatives.find(entry => entry.spec.id === 'qwen3-1.7b')?.fit).toBe('tight');
    expect(plan.chat?.spec.id).toBe('qwen3-0.6b');
  });

  it('falls back to a tight fit when nothing is comfortable', () => {
    const plan = planSetup(hardware({ memoryBytes: 4 * GIB }));
    expect(plan.chat?.spec.id).toBe('qwen3-0.6b');
    expect(plan.chat?.fit).toBe('tight');
  });

  it('recommends no chat model below the memory floor, and says so', () => {
    const plan = planSetup(hardware({ memoryBytes: 2 * GIB }));
    expect(plan.chat).toBeUndefined();
    expect(plan.warnings.join(' ')).toMatch(/rule-based labels/);
  });

  it('respects free disk space', () => {
    const plan = planSetup(hardware({ freeDiskBytes: 2 * GIB }));
    expect(plan.alternatives.find(entry => entry.spec.id === 'qwen3-1.7b')?.fit).toBe('too_large');
    expect(plan.alternatives.find(entry => entry.spec.id === 'qwen3-1.7b')?.reason).toMatch(/disk/);
    expect(plan.warnings.join(' ')).toMatch(/10 GB/);
  });

  it('warns about few cores and about slow CPU-only responses', () => {
    const plan = planSetup(hardware({ cpuCores: 2 }));
    expect(plan.warnings.join(' ')).toMatch(/few CPU cores/i);
    expect(plan.alternatives.find(entry => entry.spec.id === 'qwen3-4b')?.reason).toMatch(/slow/);
  });

  it('is deterministic for the same hardware', () => {
    expect(planSetup(hardware())).toEqual(planSetup(hardware()));
  });

  it('classifies fit against the 75% comfort line', () => {
    expect(classifyFit(70, 100)).toBe('good');
    expect(classifyFit(90, 100)).toBe('tight');
    expect(classifyFit(101, 100)).toBe('too_large');
    expect(requiredMemoryBytes({ ...CATALOG[0], sizeBytes: 0, measuredPeakBytes: undefined })).toBe(GIB);
    // A measured peak is used when it is larger than the estimate.
    expect(requiredMemoryBytes({ ...CATALOG[0], sizeBytes: 0, measuredPeakBytes: 3 * GIB })).toBe(3 * GIB);
  });
});

describe('hardware parsing', () => {
  it('reads one Windows adapter, several adapters, and garbage', () => {
    expect(parseWindowsGpuNames('{"Name":"NVIDIA GeForce RTX 4060"}')).toEqual(['NVIDIA GeForce RTX 4060']);
    expect(parseWindowsGpuNames('[{"Name":"Intel(R) UHD Graphics"},{"Name":"NVIDIA RTX A1000"}]')).toEqual([
      'Intel(R) UHD Graphics',
      'NVIDIA RTX A1000',
    ]);
    expect(parseWindowsGpuNames('not json')).toEqual([]);
    expect(parseWindowsGpuNames('')).toEqual([]);
  });

  it('reads display controllers from lspci output', () => {
    const text = [
      '00:02.0 VGA compatible controller: Intel Corporation Alder Lake-P Integrated Graphics Controller (rev 0c)',
      '00:14.0 USB controller: Intel Corporation Alder Lake USB 3.2',
      '01:00.0 3D controller: NVIDIA Corporation GA107M [GeForce RTX 3050 Mobile]',
    ].join('\n');
    expect(parseLspciGpuNames(text)).toEqual([
      'Intel Corporation Alder Lake-P Integrated Graphics Controller (rev 0c)',
      'NVIDIA Corporation GA107M [GeForce RTX 3050 Mobile]',
    ]);
  });

  it('prefers a discrete GPU and names vendors', () => {
    expect(vendorFromName('AMD Radeon 780M')).toBe('amd');
    expect(vendorFromName('Intel Iris Xe')).toBe('intel');
    expect(vendorFromName('Mystery Card 9000')).toBe('other');
    expect(pickGpu(['Intel UHD', 'NVIDIA RTX 4060']).vendor).toBe('nvidia');
    expect(pickGpu([])).toEqual({ vendor: 'none' });
  });

  it('treats Apple silicon as unified and notes unmeasured discrete GPU memory', () => {
    const mac = buildHardwareProfile({ platform: 'darwin', arch: 'arm64', cpuModel: 'Apple M3', cpuCores: 8, memoryBytes: 16 * GIB, gpuNames: [], freeDiskBytes: 300 * GIB });
    expect(mac.unifiedMemory).toBe(true);
    expect(mac.gpu.vendor).toBe('apple');
    const pc = buildHardwareProfile({ platform: 'win32', arch: 'x64', cpuModel: 'Ryzen', cpuCores: 8, memoryBytes: 16 * GIB, gpuNames: ['NVIDIA RTX 4060'], freeDiskBytes: 300 * GIB });
    expect(pc.unifiedMemory).toBe(false);
    expect(pc.notes.join(' ')).toMatch(/not measured/);
  });

  it('matches hosts exactly, or by suffix for dotted entries', () => {
    expect(hostAllowed('huggingface.co', ['huggingface.co', '.hf.co'])).toBe(true);
    expect(hostAllowed('cas-bridge.xethub.hf.co', ['huggingface.co', '.hf.co'])).toBe(true);
    expect(hostAllowed('evil-hf.co', ['.hf.co'])).toBe(false);
    expect(hostAllowed('localhost', ['huggingface.co', '.hf.co'])).toBe(false);
  });
});

describe('downloadModel', () => {
  const payload = Buffer.from('companyOS test model bytes '.repeat(4000));
  const digest = createHash('sha256').update(payload).digest('hex');
  const modelPath = '/example/test-model/resolve/main/test-model.gguf';

  const spec = (overrides: Partial<ModelSpec> = {}): ModelSpec => ({
    id: 'test-model',
    name: 'Test model',
    role: 'chat',
    params: '1B',
    quantization: 'Q8_0',
    license: 'Apache-2.0',
    repo: 'example/test-model',
    file: 'test-model.gguf',
    sizeBytes: payload.length,
    sha256: digest,
    summary: 'test',
    ...overrides,
  });

  /**
   * A fake network. It answers by URL and records every host it is asked for, so tests can prove that
   * a disallowed host was never contacted. No real network is used.
   */
  function fakeNetwork(routes: Record<string, () => Response>) {
    const contacted: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      contacted.push(url.origin);
      const key = `${url.origin}${url.pathname}`;
      const route = routes[key];
      if (!route) return new Response('not found', { status: 404 });
      return route();
    }) as typeof fetch;
    return { fetchImpl, contacted };
  }

  const serve = (body: Buffer, declared = body.length) => () =>
    new Response(new Uint8Array(body), { status: 200, headers: { 'content-length': String(declared) } });
  const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } });
  const origin = 'https://huggingface.co';

  it('downloads, verifies the digest, and moves the file into place', async () => {
    const dir = temps.folder('twin-model-');
    const { fetchImpl } = fakeNetwork({ [`${origin}${modelPath}`]: serve(payload) });
    const progress: number[] = [];
    const result = await downloadModel({
      spec: spec(),
      destinationDir: dir,
      allowedHosts: ['huggingface.co'],
      fetchImpl,
      onProgress: received => progress.push(received),
    });
    expect(result.sha256).toBe(digest);
    expect(result.bytes).toBe(payload.length);
    expect(readdirSync(dir)).toEqual(['test-model.gguf']);
    expect(progress.at(-1)).toBe(payload.length);
    expect(await verifyModelFile(result.path, spec())).toBe(true);
  });

  it('discards a file whose digest does not match', async () => {
    const dir = temps.folder('twin-model-');
    const { fetchImpl } = fakeNetwork({ [`${origin}${modelPath}`]: serve(payload) });
    await expect(
      downloadModel({ spec: spec({ sha256: '0'.repeat(64) }), destinationDir: dir, allowedHosts: ['huggingface.co'], fetchImpl }),
    ).rejects.toThrow(/checksum/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('discards a file that ends early', async () => {
    const dir = temps.folder('twin-model-');
    const { fetchImpl } = fakeNetwork({ [`${origin}${modelPath}`]: serve(payload.subarray(0, 1000), payload.length) });
    await expect(downloadModel({ spec: spec(), destinationDir: dir, allowedHosts: ['huggingface.co'], fetchImpl })).rejects.toThrow(/ended early/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses a redirect to a host that is not on the allowlist, and never contacts it', async () => {
    const dir = temps.folder('twin-model-');
    const { fetchImpl, contacted } = fakeNetwork({
      [`${origin}${modelPath}`]: redirect('https://evil.example.com/payload.gguf'),
      'https://evil.example.com/payload.gguf': serve(payload),
    });
    await expect(downloadModel({ spec: spec(), destinationDir: dir, allowedHosts: ['huggingface.co'], fetchImpl })).rejects.toThrow(/allowlist/);
    expect(contacted).toEqual([origin]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('follows a redirect that stays on an allowed host', async () => {
    const dir = temps.folder('twin-model-');
    const cdn = 'https://cas-bridge.xethub.hf.co/blob';
    const { fetchImpl, contacted } = fakeNetwork({
      [`${origin}${modelPath}`]: redirect(`${cdn}`),
      [cdn]: serve(payload),
    });
    const result = await downloadModel({ spec: spec(), destinationDir: dir, allowedHosts: ['huggingface.co', '.hf.co'], fetchImpl });
    expect(result.hosts).toEqual(['huggingface.co', 'cas-bridge.xethub.hf.co']);
    expect(contacted).toEqual([origin, 'https://cas-bridge.xethub.hf.co']);
  });

  it('refuses a redirect down to plain http', async () => {
    const dir = temps.folder('twin-model-');
    const { fetchImpl, contacted } = fakeNetwork({ [`${origin}${modelPath}`]: redirect('http://huggingface.co/insecure.gguf') });
    await expect(downloadModel({ spec: spec(), destinationDir: dir, allowedHosts: ['huggingface.co'], fetchImpl })).rejects.toThrow(/https/);
    expect(contacted).toEqual([origin]);
  });

  it('cancels cleanly between chunks and leaves no partial file', async () => {
    const dir = temps.folder('twin-model-');
    const chunked = () => {
      const chunk = payload.subarray(0, Math.floor(payload.length / 4));
      const stream = new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(chunk));
          controller.enqueue(new Uint8Array(chunk));
          controller.enqueue(new Uint8Array(chunk));
          controller.enqueue(new Uint8Array(chunk));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-length': String(payload.length) } });
    };
    const { fetchImpl } = fakeNetwork({ [`${origin}${modelPath}`]: chunked });
    const controller = new AbortController();
    await expect(
      downloadModel({
        spec: spec(),
        destinationDir: dir,
        allowedHosts: ['huggingface.co'],
        fetchImpl,
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('reports a server error as a failure with its HTTP status', async () => {
    const dir = temps.folder('twin-model-');
    const { fetchImpl } = fakeNetwork({});
    const error = await downloadModel({ spec: spec(), destinationDir: dir, allowedHosts: ['huggingface.co'], fetchImpl }).catch(e => e);
    expect(error).toBeInstanceOf(DownloadError);
    expect(error.message).toMatch(/HTTP 404/);
  });

  it('refuses hosts that are not on the allowlist before any request', async () => {
    const dir = temps.folder('twin-model-');
    const { fetchImpl, contacted } = fakeNetwork({});
    await expect(downloadModel({ spec: spec(), destinationDir: dir, allowedHosts: ['127.0.0.1'], fetchImpl })).rejects.toThrow(/allowlist/);
    expect(contacted).toEqual([]);
  });
});
