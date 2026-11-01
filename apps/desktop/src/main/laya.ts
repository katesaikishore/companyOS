import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFileSync } from 'node:fs';
import { mkdir, open, rename, rm, stat, statfs } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { HUGGING_FACE_HOSTS, hostAllowed, type LayaBundleView, type NetworkEntry } from '@companyos/twin-core';
import type { Laya } from '@receptron/laya';

/**
 * The optional decision-model bundle (Laya, receptron/laya-onnx). It is five files, so it does not fit the single-file
 * model catalog. This module downloads it, checks every file against a pinned SHA-256 before the file is kept, and loads
 * it on demand. Nothing in the app asks it for a decision yet.
 *
 * The pins are in docs/research/laya-decision-layer.md, with how each was checked. A test compares the two.
 */

export const LAYA_MODEL_ID = 'laya-onnx';
export const LAYA_REPO = 'receptron/laya-onnx';
/** A commit, not `main`: the files cannot change under us. */
export const LAYA_REVISION = 'd42786bdff8a7550316339c5fbf8f46caa83ea1b';

export interface LayaFileSpec {
  /** Path inside the repository and inside the bundle folder, with `/` separators. */
  path: string;
  bytes: number;
  sha256: string;
}

export interface LayaBundleSpec {
  repo: string;
  revision: string;
  files: readonly LayaFileSpec[];
}

export const LAYA_BUNDLE: LayaBundleSpec = {
  repo: LAYA_REPO,
  revision: LAYA_REVISION,
  files: [
    { path: 'laya.onnx', bytes: 3807291, sha256: 'a874eb254b58b0fcb1e7ad56fbb188c29d64e08c9a46b689433e1f52c66dba1e' },
    { path: 'laya.onnx.data', bytes: 1685258240, sha256: '487746363a8da57bcadb4345352997d22a0fb90d70aa22c6856668d023242aba' },
    { path: 'laya_config.json', bytes: 355, sha256: 'c4fab3dd16b6ffdb432ae99334c77fca31e1b4beb0b81be76ca45f707709706a' },
    { path: 'tokenizer/tokenizer.json', bytes: 3583228, sha256: '6c8aaa9a542084f2457eab775d4eeb51f92a70c0fd9de28d5edb0ddec3c08d30' },
    { path: 'tokenizer/tokenizer_config.json', bytes: 308, sha256: '50044de60daaa73df97d262e15a40d4faf0160e7d742df64b377877a1320dd12' },
  ],
};

/** Free space required before a download starts, counting bytes of this bundle that are already on disk. */
export const LAYA_MIN_FREE_BYTES = 2_000_000_000;

/**
 * Where onnxruntime-node 1.31.1 ships a prebuilt binding (bin/napi-v6/<platform>/<arch>). There is none for Intel Macs,
 * so the bundle is not offered there.
 */
const SUPPORTED_TARGETS: readonly string[] = ['darwin/arm64', 'linux/x64', 'linux/arm64', 'win32/x64', 'win32/arm64'];

export function layaSupported(platform: string = process.platform, arch: string = process.arch): boolean {
  return SUPPORTED_TARGETS.includes(`${platform}/${arch}`);
}

export function totalBytes(spec: LayaBundleSpec): number {
  return spec.files.reduce((sum, file) => sum + file.bytes, 0);
}

/** Refuses a spec with an unpinned revision, a malformed digest, or a file name that could leave the bundle folder. */
export function assertLayaBundleSpec(spec: LayaBundleSpec): void {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(spec.repo)) throw new Error('The bundle repository is malformed.');
  if (!/^[0-9a-f]{40}$/.test(spec.revision)) throw new Error('The bundle revision must be a full commit hash.');
  if (spec.files.length === 0) throw new Error('The bundle has no files.');
  const seen = new Set<string>();
  for (const file of spec.files) {
    const segments = file.path.split('/');
    if (segments.some(segment => !/^[A-Za-z0-9._-]+$/.test(segment) || segment.startsWith('.'))) {
      throw new Error('A bundle file name is not safe.');
    }
    if (seen.has(file.path)) throw new Error('A bundle file is listed twice.');
    seen.add(file.path);
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('A bundle digest is malformed.');
    if (!Number.isInteger(file.bytes) || file.bytes <= 0) throw new Error('A bundle file size is malformed.');
  }
}

/**
 * The folder one revision of the bundle lives in: <root>/<owner>--<repo>/<revision>. This is the layout the @receptron/laya
 * package uses for its own cache, so a bundle fetched by that package is found here too.
 */
export function layaBundleDir(rootDir: string, spec: LayaBundleSpec = LAYA_BUNDLE): string {
  return join(rootDir, spec.repo.replace('/', '--'), spec.revision);
}

/** What a loaded model offers. The Laya class itself, so the types stay in step with the package. */
export type LayaRuntime = Laya;

export interface LayaProgressEvent {
  status: LayaBundleView['status'];
  file?: string;
  receivedBytes: number;
  totalBytes: number;
}

export interface LayaManagerOptions {
  /** The folder that holds every bundle revision. Delete everything removes it, so it lives inside the models folder. */
  rootDir: string;
  /** Called with each ledger entry. The desktop app passes the engine's recorder. */
  record: (entry: NetworkEntry) => void;
  /** Called when the status or the byte count changes, so open pages refresh. */
  onChange?: () => void;
  /** Tests give a small bundle and a local server. Production uses the pinned bundle on Hugging Face. */
  spec?: LayaBundleSpec;
  baseUrl?: string;
  allowedHosts?: readonly string[];
  requireHttps?: boolean;
  fetchImpl?: typeof fetch;
  minFreeBytes?: number;
  /** Free bytes on the volume that holds `dir`, or undefined when it cannot be measured. */
  freeBytes?: (dir: string) => Promise<number | undefined>;
  /** Loads the runtime from a verified bundle folder. Tests replace it. */
  loadRuntime?: (bundleDir: string) => Promise<LayaRuntime>;
  now?: () => number;
  supported?: boolean;
}

/** The options a test may change: where the bundle comes from and how large it is. Nothing else about the manager is open to a test. */
export type LayaTestOptions = Pick<LayaManagerOptions, 'spec' | 'baseUrl' | 'allowedHosts' | 'requireHttps' | 'minFreeBytes' | 'supported'>;

/**
 * Test-only. Reads a JSON file that points the download at a local server with a small bundle, so the end-to-end test can
 * run the real setup step without fetching 1.7 GB. The server must be on the loopback address. The caller ignores this in
 * a packaged build.
 */
export function readLayaFixture(path: string): LayaTestOptions {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { baseUrl?: unknown; spec?: LayaBundleSpec; minFreeBytes?: unknown };
  const base = new URL(String(raw.baseUrl));
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw new Error('A Laya fixture must be a local http server.');
  if (!raw.spec) throw new Error('A Laya fixture needs a bundle.');
  assertLayaBundleSpec(raw.spec);
  return {
    spec: raw.spec,
    baseUrl: base.origin,
    allowedHosts: ['127.0.0.1'],
    requireHttps: false,
    minFreeBytes: typeof raw.minFreeBytes === 'number' ? raw.minFreeBytes : 1,
    supported: true,
  };
}

type FailureKind = 'cancelled' | 'interrupted' | 'rejected' | 'failed';

/** `interrupted` and `failed` keep the partial file, so a resume continues it. `rejected` has already deleted it. */
class BundleError extends Error {
  constructor(
    message: string,
    readonly kind: FailureKind,
  ) {
    super(message);
    this.name = 'BundleError';
  }
}

const PROGRESS_INTERVAL_MS = 100;
const MAX_REDIRECTS = 5;

const decimalGb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;

async function sha256OfFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) {
    if (signal?.aborted) throw new BundleError('Cancelled.', 'cancelled');
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

async function sizeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
}

/** Free space on the volume that holds `dir`, measured at the nearest folder that exists. */
async function measureFreeBytes(dir: string): Promise<number | undefined> {
  let probe = dir;
  for (;;) {
    try {
      const info = await statfs(probe);
      return Number(info.bavail) * Number(info.bsize);
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return undefined;
      probe = parent;
    }
  }
}

/**
 * Loads @receptron/laya, which is an ES module, from this CommonJS build. The import() itself is in import-module.cjs.
 * The package is named by its resolved file, so the path also works from inside app.asar.
 */
async function loadFromPackage(bundleDir: string): Promise<LayaRuntime> {
  const requireFromHere = createRequire(join(__dirname, 'laya.js'));
  const importModule = requireFromHere('./import-module.cjs') as (specifier: string) => Promise<typeof import('@receptron/laya')>;
  const { Laya: LayaClass } = await importModule(pathToFileURL(requireFromHere.resolve('@receptron/laya')).href);
  // modelDir makes the package read local files only. It sends no request.
  return LayaClass.load({ modelDir: bundleDir });
}

/**
 * Downloads, checks, stores and loads the Laya bundle.
 *
 * - Each file is fetched from the pinned commit with HTTP Range, so a partial file is continued, not restarted.
 * - A file is renamed into place only after its size and SHA-256 match the pin. A mismatch deletes the partial file.
 * - Cancel and a lost connection keep the partial file. Resume (install again) continues it.
 * - Every request goes to the ledger, one entry per file. No Hugging Face token is ever sent.
 */
export class LayaBundleManager {
  private readonly spec: LayaBundleSpec;
  private readonly baseUrl: string;
  private readonly allowedHosts: readonly string[];
  private readonly requireHttps: boolean;
  private readonly minFreeBytes: number;
  private readonly total: number;
  private readonly supported: boolean;
  private readonly bundleDir: string;

  private status: LayaBundleView['status'] = 'not_installed';
  private file: string | undefined;
  private received = 0;
  private message: string | undefined;
  private partial = false;

  private controller: AbortController | undefined;
  private running: Promise<void> | undefined;
  private wiping = false;
  private lastEmit = 0;
  private readonly listeners = new Set<(event: LayaProgressEvent) => void>();

  private runtime: Promise<LayaRuntime> | undefined;
  /** Files whose digest was checked in this process, by size and modification time. A changed file is checked again. */
  private readonly verified = new Map<string, string>();

  constructor(private readonly options: LayaManagerOptions) {
    this.spec = options.spec ?? LAYA_BUNDLE;
    assertLayaBundleSpec(this.spec);
    this.baseUrl = (options.baseUrl ?? 'https://huggingface.co').replace(/\/+$/, '');
    this.allowedHosts = options.allowedHosts ?? HUGGING_FACE_HOSTS;
    this.requireHttps = options.requireHttps ?? true;
    this.minFreeBytes = options.minFreeBytes ?? LAYA_MIN_FREE_BYTES;
    this.total = totalBytes(this.spec);
    this.supported = options.supported ?? layaSupported();
    this.bundleDir = layaBundleDir(options.rootDir, this.spec);
  }

  /** The folder the verified files are in. */
  get directory(): string {
    return this.bundleDir;
  }

  view(): LayaBundleView {
    return {
      status: this.status,
      file: this.file,
      receivedBytes: this.received,
      totalBytes: this.total,
      requiredFreeBytes: this.minFreeBytes,
      repo: this.spec.repo,
      revision: this.spec.revision,
      message: this.message,
      hasPartial: this.partial,
      supported: this.supported,
    };
  }

  /** Progress events: at most one every 100 ms while bytes arrive, and one for every change of status or file. */
  subscribe(listener: (event: LayaProgressEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Reads the folder at launch: installed when every file is there at its pinned size, otherwise a partial download may remain. */
  async reconcile(): Promise<void> {
    if (this.running || this.wiping) return;
    const disk = await this.scanDisk();
    this.partial = disk.partialBytes > 0;
    this.received = disk.bytes;
    this.message = undefined;
    this.file = undefined;
    this.status = disk.complete ? 'installed' : 'not_installed';
    this.emit(true);
  }

  /** Starts, or resumes, the download. Returns at once. Progress is in view() and in the subscribe events. */
  install(): void {
    if (this.wiping) throw new Error('The models are being deleted.');
    if (!this.supported) throw new Error('The decision model is not available on this system.');
    if (this.running || this.status === 'installed') return;
    const controller = new AbortController();
    this.controller = controller;
    this.status = 'downloading';
    this.message = undefined;
    this.emit(true);
    this.running = this.run(controller.signal);
  }

  /** Stops the download. The partial file stays, so install() continues from there. */
  cancel(): void {
    this.controller?.abort();
  }

  /** Deletes the bundle, any partial file and any older revision. Stops a running download first. */
  async remove(): Promise<void> {
    await this.stopAndDelete();
    this.emit(true);
  }

  /** Delete everything uses this. Nothing can start afterwards, because the folder is about to go. */
  async wipe(): Promise<void> {
    this.wiping = true;
    await this.stopAndDelete();
    this.emit(true);
  }

  /** True when every file is present and its SHA-256 matches the pin. A file that fails is deleted, so a resume refetches it. */
  async verify(signal?: AbortSignal): Promise<boolean> {
    let ok = true;
    for (const file of this.spec.files) {
      if ((await this.checkWhole(file, signal)) !== 'ok') ok = false;
    }
    return ok;
  }

  /**
   * Checks one finished file. A file with the wrong size or digest is deleted. A digest already checked in this
   * process is trusted while the file's size and modification time stay the same.
   */
  private async checkWhole(file: LayaFileSpec, signal?: AbortSignal): Promise<'ok' | 'bad' | 'missing'> {
    const path = join(this.bundleDir, file.path);
    const info = await stat(path).catch(() => undefined);
    if (!info) return 'missing';
    if (info.size !== file.bytes) {
      await rm(path, { force: true });
      return 'bad';
    }
    const stamp = `${info.size}:${info.mtimeMs}`;
    if (this.verified.get(path) === stamp) return 'ok';
    if ((await sha256OfFile(path, signal)) === file.sha256) {
      this.verified.set(path, stamp);
      return 'ok';
    }
    this.verified.delete(path);
    await rm(path, { force: true });
    return 'bad';
  }

  /**
   * Loads the model, once. The files are checked first, and the package is imported only now, so a launch that never
   * needs the model never loads onnxruntime. A failed check marks the bundle as failed and deletes the bad file.
   */
  load(): Promise<LayaRuntime> {
    if (this.wiping) return Promise.reject(new Error('The models are being deleted.'));
    this.runtime ??= this.loadOnce().catch(error => {
      this.runtime = undefined;
      throw error;
    });
    return this.runtime;
  }

  /** The loaded model when it is installed and loads, otherwise undefined. Never throws. */
  async readyRuntime(): Promise<LayaRuntime | undefined> {
    if (this.status !== 'installed') return undefined;
    return this.load().catch(() => undefined);
  }

  /** Frees the model's memory. The next answer loads it again from the checked files. */
  async release(): Promise<void> {
    const pending = this.runtime;
    this.runtime = undefined;
    if (pending) await pending.then(runtime => runtime.close(), () => undefined);
  }

  /** Releases the loaded model, if any. */
  async unload(): Promise<void> {
    const pending = this.runtime;
    this.runtime = undefined;
    if (pending) await pending.then(runtime => runtime.close(), () => undefined);
  }

  private async loadOnce(): Promise<LayaRuntime> {
    if (this.status !== 'installed') throw new Error('The decision model is not installed.');
    if (!(await this.verify())) {
      this.status = 'failed';
      this.message = 'A decision model file failed its checksum and was removed. Download it again.';
      this.received = (await this.scanDisk()).bytes;
      this.emit(true);
      throw new Error(this.message);
    }
    return (this.options.loadRuntime ?? loadFromPackage)(this.bundleDir);
  }

  private async stopAndDelete(): Promise<void> {
    this.controller?.abort();
    await this.running?.catch(() => undefined);
    await this.unload();
    await rm(this.options.rootDir, { recursive: true, force: true });
    this.verified.clear();
    this.status = 'not_installed';
    this.file = undefined;
    this.received = 0;
    this.message = undefined;
    this.partial = false;
  }

  private emit(force: boolean): void {
    const now = (this.options.now ?? Date.now)();
    if (!force && now - this.lastEmit < PROGRESS_INTERVAL_MS) return;
    this.lastEmit = now;
    const event: LayaProgressEvent = { status: this.status, file: this.file, receivedBytes: this.received, totalBytes: this.total };
    // A listener that throws must not stop a download, and this runs where nothing can catch it.
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Ignored on purpose.
      }
    }
    try {
      this.options.onChange?.();
    } catch {
      // Ignored on purpose, for the same reason.
    }
  }

  /** What is on disk: whole files at their pinned size, and the size of each partial file. */
  private async scanDisk(): Promise<{ complete: boolean; bytes: number; partialBytes: number }> {
    let bytes = 0;
    let partialBytes = 0;
    let complete = true;
    for (const file of this.spec.files) {
      const path = join(this.bundleDir, file.path);
      const whole = await sizeOf(path);
      if (whole === file.bytes) {
        bytes += file.bytes;
        continue;
      }
      complete = false;
      const part = await sizeOf(`${path}.part`);
      if (part !== undefined) {
        bytes += Math.min(part, file.bytes);
        partialBytes += part;
      }
    }
    return { complete, bytes, partialBytes };
  }

  private async run(signal: AbortSignal): Promise<void> {
    let outcome: { status: LayaBundleView['status']; message?: string };
    try {
      const disk = await this.scanDisk();
      this.received = disk.bytes;
      this.partial = disk.partialBytes > 0;
      await this.checkFreeSpace(disk.bytes);

      await mkdir(this.bundleDir, { recursive: true, mode: 0o700 });
      for (const file of this.spec.files) {
        if (signal.aborted) throw new BundleError('Cancelled.', 'cancelled');
        await this.ensureFile(file, signal);
      }
      outcome = { status: 'installed' };
    } catch (error) {
      if (error instanceof BundleError && error.kind === 'cancelled') outcome = { status: 'cancelled' };
      else {
        const message = error instanceof BundleError ? error.message : 'The download failed. Check your connection and the free disk space.';
        outcome = { status: 'failed', message };
      }
    }
    const disk = outcome.status === 'installed' ? undefined : await this.scanDisk().catch(() => undefined);

    // Nothing below awaits, so the page never sees a final status with the old byte count, and a new install() can start
    // as soon as the status is final.
    this.running = undefined;
    this.controller = undefined;
    this.status = outcome.status;
    this.message = outcome.message;
    this.file = undefined;
    if (disk) {
      this.received = disk.bytes;
      this.partial = disk.partialBytes > 0;
    } else if (outcome.status === 'installed') {
      this.received = this.total;
      this.partial = false;
    }
    this.emit(true);
  }

  private async checkFreeSpace(onDiskBytes: number): Promise<void> {
    const free = await (this.options.freeBytes ?? measureFreeBytes)(this.bundleDir);
    // Unknown free space is not a reason to refuse. A full disk still stops the download with its own message.
    if (free === undefined) return;
    if (free + onDiskBytes < this.minFreeBytes) {
      throw new BundleError(
        `Not enough free disk space. The decision model needs about ${decimalGb(this.minFreeBytes)} free, and this device has ${decimalGb(free)}.`,
        'failed',
      );
    }
  }

  /** Leaves `file` complete and verified in the bundle folder, or throws. */
  private async ensureFile(file: LayaFileSpec, signal: AbortSignal): Promise<void> {
    const finalPath = join(this.bundleDir, file.path);
    const partPath = `${finalPath}.part`;
    await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });

    // A whole file from an earlier run is checked again, because disks fail and folders get edited.
    if ((await sizeOf(finalPath)) !== undefined) {
      this.setFile(file.path, 'verifying');
      if ((await this.checkWhole(file, signal)) === 'ok') return;
      this.received = (await this.scanDisk()).bytes;
    }

    this.setFile(file.path, 'downloading');
    let offset = (await sizeOf(partPath)) ?? 0;
    if (offset > file.bytes) {
      await rm(partPath, { force: true });
      offset = 0;
      this.received = (await this.scanDisk()).bytes;
    }
    // A complete part file is what a crash between the last byte and the rename leaves. It needs no request.
    const transfer = offset < file.bytes ? await this.fetchInto(file, partPath, offset, signal) : undefined;
    await this.verifyAndPlace(file, partPath, finalPath, signal, transfer);
  }

  private setFile(path: string, status: 'downloading' | 'verifying'): void {
    this.file = path;
    this.status = status;
    this.emit(true);
  }

  /**
   * Checks the finished part file against the pin and moves it into place. The ledger entry for the transfer is written
   * here, because only now is its checksum known.
   */
  private async verifyAndPlace(
    file: LayaFileSpec,
    partPath: string,
    finalPath: string,
    signal: AbortSignal,
    transfer: Transfer | undefined,
  ): Promise<void> {
    this.setFile(file.path, 'verifying');
    let digest: string;
    try {
      digest = await sha256OfFile(partPath, signal);
    } catch (error) {
      if (transfer) this.recordFile(file, 'cancelled', transfer.fetched, false, transfer.host);
      throw error;
    }
    if (digest !== file.sha256) {
      await rm(partPath, { force: true });
      if (transfer) this.recordFile(file, 'failed', transfer.fetched, false, transfer.host);
      throw new BundleError(`${file.path} failed its checksum and was discarded.`, 'rejected');
    }
    await rename(partPath, finalPath);
    if (transfer) this.recordFile(file, 'ok', transfer.fetched, true, transfer.host);
  }

  private urlFor(file: LayaFileSpec): string {
    const path = file.path.split('/').map(encodeURIComponent).join('/');
    return `${this.baseUrl}/${this.spec.repo}/resolve/${this.spec.revision}/${path}`;
  }

  private firstHost(): string {
    return new URL(this.baseUrl).hostname;
  }

  private recordFile(file: LayaFileSpec, outcome: NetworkEntry['outcome'], bytes: number, verified: boolean, host: string): void {
    this.options.record({
      ts: (this.options.now ?? Date.now)(),
      purpose: 'model_download',
      modelId: LAYA_MODEL_ID,
      file: file.path,
      host,
      path: new URL(this.urlFor(file)).pathname,
      bytes,
      sha256Verified: verified,
      outcome,
    });
  }

  /**
   * Sends a GET, with a Range header when `offset` is above zero, and follows redirects by hand so every hop is checked
   * against the https and host rules. No credential is sent, and the body is never compressed, so the byte ranges are exact.
   */
  private async open(url: string, offset: number, signal: AbortSignal): Promise<{ response: Response; hosts: string[] }> {
    const hosts: string[] = [];
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let target = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const parsed = new URL(target);
      if (this.requireHttps && parsed.protocol !== 'https:') throw new BundleError('Only https downloads are allowed.', 'failed');
      if (!hostAllowed(parsed.hostname, this.allowedHosts)) {
        throw new BundleError(`${parsed.hostname} is not on the download allowlist.`, 'failed');
      }
      hosts.push(parsed.hostname);
      const headers: Record<string, string> = { 'Accept-Encoding': 'identity' };
      if (offset > 0) headers.Range = `bytes=${offset}-`;
      let response: Response;
      try {
        response = await fetchImpl(target, { redirect: 'manual', signal, headers });
      } catch {
        if (signal.aborted) throw new BundleError('Cancelled.', 'cancelled');
        throw new BundleError('The download could not start. Check your connection, then resume.', 'interrupted');
      }
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel().catch(() => undefined);
        target = new URL(location, target).toString();
        continue;
      }
      return { response, hosts };
    }
    throw new BundleError('Too many redirects.', 'failed');
  }

  /**
   * Downloads the rest of one file into its `.part` file and returns when every byte is on disk. It does not check the
   * digest. The server must answer a ranged request with 206 and the range that was asked for. A server that ignores the
   * range sends the whole file, and the partial file is started again.
   */
  private async fetchInto(file: LayaFileSpec, partPath: string, startOffset: number, signal: AbortSignal): Promise<Transfer> {
    let offset = startOffset;
    /** Bytes of the other files, so this file's progress can be added to them. */
    const others = this.received - startOffset;

    for (let attempt = 0; attempt < 2; attempt++) {
      let opened: { response: Response; hosts: string[] };
      try {
        opened = await this.open(this.urlFor(file), offset, signal);
      } catch (error) {
        const cancelled = error instanceof BundleError && error.kind === 'cancelled';
        this.recordFile(file, cancelled ? 'cancelled' : 'failed', 0, false, this.firstHost());
        throw error;
      }
      const { response, hosts } = opened;
      const host = hosts.at(-1) ?? this.firstHost();
      /** Records a failed call, drops the response body, and returns the error to throw. */
      const refuse = async (message: string, kind: FailureKind, removePart: boolean): Promise<BundleError> => {
        await response.body?.cancel().catch(() => undefined);
        if (removePart) await rm(partPath, { force: true });
        this.recordFile(file, 'failed', 0, false, host);
        return new BundleError(message, kind);
      };

      if (response.status === 416) {
        // The server does not accept our offset, so the partial file cannot be trusted. Start again from the beginning.
        if (offset === 0) throw await refuse('The server refused the download.', 'failed', false);
        await response.body?.cancel().catch(() => undefined);
        await rm(partPath, { force: true });
        this.recordFile(file, 'failed', 0, false, host);
        offset = 0;
        this.received = others;
        continue;
      }
      const body = response.body;
      if (!response.ok || !body) throw await refuse(`The server answered with HTTP ${response.status}.`, 'failed', false);

      const declared = response.headers.has('content-length') ? Number(response.headers.get('content-length')) : undefined;
      let resume = false;
      if (response.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(response.headers.get('content-range') ?? '');
        const sane =
          range !== null &&
          Number(range[1]) === offset &&
          Number(range[2]) + 1 === file.bytes &&
          (range[3] === '*' || Number(range[3]) === file.bytes);
        if (!sane) throw await refuse('The server sent a different part of the file than was asked for.', 'rejected', true);
        if (declared !== undefined && declared !== file.bytes - offset) {
          throw await refuse('The file on the server is not the expected size.', 'rejected', true);
        }
        resume = true;
      } else {
        // 200 is the whole file, whatever was asked for. Any partial file is overwritten.
        if (declared !== undefined && declared !== file.bytes) {
          throw await refuse('The file on the server is not the expected size.', 'rejected', true);
        }
        offset = 0;
        this.received = others;
      }

      const handle = await open(partPath, resume ? 'a' : 'w', 0o600);
      let fetched = 0;
      /** Closes the file and writes the ledger entry for a transfer that stopped before its checksum could be checked. */
      const stop = async (outcome: NetworkEntry['outcome']): Promise<void> => {
        await handle.close();
        this.recordFile(file, outcome, fetched, false, host);
      };
      try {
        for await (const chunk of Readable.fromWeb(body as never)) {
          if (signal.aborted) throw new BundleError('Cancelled.', 'cancelled');
          const bytes = chunk as Buffer;
          if (offset + fetched + bytes.length > file.bytes) throw new BundleError('The file is larger than expected.', 'rejected');
          try {
            await handle.write(bytes);
          } catch {
            throw new BundleError('The file could not be written. Check the free disk space, then resume.', 'failed');
          }
          fetched += bytes.length;
          this.received = others + offset + fetched;
          this.emit(false);
        }
      } catch (error) {
        const kind = error instanceof BundleError ? error.kind : signal.aborted ? 'cancelled' : 'interrupted';
        await stop(kind === 'cancelled' ? 'cancelled' : 'failed');
        if (kind === 'rejected') await rm(partPath, { force: true });
        if (error instanceof BundleError) throw error;
        throw new BundleError(
          kind === 'cancelled' ? 'Cancelled.' : 'The connection was lost. Resume to continue the download.',
          kind,
        );
      }
      await handle.close();
      if (offset + fetched < file.bytes) {
        this.recordFile(file, 'failed', fetched, false, host);
        throw new BundleError('The download ended early. Resume to continue it.', 'interrupted');
      }
      return { fetched, host };
    }
    throw new BundleError('The server did not accept the download.', 'failed');
  }
}

/** One finished network transfer of a file, waiting for its checksum. */
interface Transfer {
  fetched: number;
  host: string;
}
