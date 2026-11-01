import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { DownloadError, hostAllowed } from './download';
import type { NetworkEntry } from './types';

/**
 * A pinned set of files from one Hugging Face commit, such as the speech model. Each file has its size and SHA-256 written
 * down, and nothing is kept unless it matches. scripts/pin-whisper.mjs prints these values.
 */

export interface BundleFileSpec {
  /** Path inside the repository and inside the bundle folder, with `/` separators. */
  path: string;
  bytes: number;
  sha256: string;
}

export interface BundleSpec {
  /** The id the installed-model record and the ledger use for this bundle. */
  id: string;
  /** Hugging Face repository, as owner/name. */
  repo: string;
  /** A commit, not a branch, so the files cannot change under us. */
  revision: string;
  license: 'Apache-2.0' | 'MIT';
  files: readonly BundleFileSpec[];
}

const HUGGING_FACE_ORIGIN = 'https://huggingface.co';
const MAX_REDIRECTS = 5;

/** Refuses a spec with a branch for a revision, an unsafe file path, a malformed digest, or a licence that is not open. */
export function assertBundleSpec(spec: BundleSpec): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(spec.id)) throw new Error('The bundle id is malformed.');
  if (spec.license !== 'Apache-2.0' && spec.license !== 'MIT') throw new Error(`Licence ${spec.license} is not allowed.`);
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

/** The folder one revision of a bundle lives in: <root>/<owner>--<name>/<revision>, the same layout the Laya bundle uses. */
export function bundleDirectory(rootDir: string, spec: BundleSpec): string {
  return join(rootDir, spec.repo.replace('/', '--'), spec.revision);
}

export function bundleTotalBytes(spec: BundleSpec): number {
  return spec.files.reduce((sum, file) => sum + file.bytes, 0);
}

/** One digest for the whole bundle: the revision and every file's path, size and digest. Stored as the installed-model digest. */
export function bundleDigest(spec: BundleSpec): string {
  const hash = createHash('sha256').update(`${spec.revision}\n`);
  for (const file of spec.files) hash.update(`${file.path} ${file.bytes} ${file.sha256}\n`);
  return hash.digest('hex');
}

export function bundleUrl(spec: BundleSpec, file: BundleFileSpec, baseUrl: string = HUGGING_FACE_ORIGIN): string {
  const path = file.path.split('/').map(encodeURIComponent).join('/');
  return `${baseUrl.replace(/\/+$/, '')}/${spec.repo}/resolve/${spec.revision}/${path}`;
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** True when the file on disk has exactly the pinned size and digest. Any read error counts as not matching. */
export async function fileMatches(path: string, file: BundleFileSpec): Promise<boolean> {
  try {
    const info = await stat(path);
    if (info.size !== file.bytes) return false;
    return (await sha256OfFile(path)) === file.sha256;
  } catch {
    return false;
  }
}

/** True when every file of the bundle is in the folder with its digest. Hashes every file, so it is the check before use. */
export async function verifyBundle(spec: BundleSpec, directory: string): Promise<boolean> {
  for (const file of spec.files) {
    if (!(await fileMatches(join(directory, file.path), file))) return false;
  }
  return true;
}

/** True when every file is present at its pinned size. Cheap, so it can run at launch. It does not hash the files. */
export async function bundleSizesMatch(spec: BundleSpec, directory: string): Promise<boolean> {
  for (const file of spec.files) {
    const info = await stat(join(directory, file.path)).catch(() => undefined);
    if (!info || info.size !== file.bytes) return false;
  }
  return true;
}

export interface BundleDownloadOptions {
  spec: BundleSpec;
  /** The bundle folder. Each file is written to its own path inside it. */
  destinationDir: string;
  allowedHosts: readonly string[];
  /** Production is https only. Tests against a local server switch this off explicitly. */
  requireHttps?: boolean;
  /** Hugging Face by default. Tests point this at a local server. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Bytes received so far across every file, and the bundle's total. */
  onProgress?: (receivedBytes: number, totalBytes: number) => void;
  /** Called once for each file that was requested, after its transfer ends. Model downloads go to the ledger through this. */
  record?: (entry: NetworkEntry) => void;
  maxRedirects?: number;
}

export interface BundleDownloadResult {
  directory: string;
  bytes: number;
  /** As bundleDigest() gives it. */
  digest: string;
}

/**
 * Downloads every file of a bundle that is not already whole and verified. Each file follows the same rules as
 * downloadModel: every hop, including redirects, must be https and on the allowlist; a declared size that differs is
 * refused; the bytes go to a `.part` file; and the file is renamed into place only after its SHA-256 matches the pin.
 * One ledger entry is recorded for each file requested.
 */
export async function downloadBundle(options: BundleDownloadOptions): Promise<BundleDownloadResult> {
  const { spec, destinationDir, signal } = options;
  assertBundleSpec(spec);
  const total = bundleTotalBytes(spec);
  let done = 0;
  await mkdir(destinationDir, { recursive: true, mode: 0o700 });
  for (const file of spec.files) {
    if (signal?.aborted) throw new DownloadError('Download cancelled.', 'cancelled');
    const finalPath = join(destinationDir, file.path);
    if (!(await fileMatches(finalPath, file))) {
      await transferFile(options, file, finalPath, (received: number) => options.onProgress?.(done + received, total));
    }
    done += file.bytes;
    options.onProgress?.(done, total);
  }
  return { directory: destinationDir, bytes: total, digest: bundleDigest(spec) };
}

/** Downloads one file into its `.part` file, checks it, and moves it into place. Writes the ledger entry, pass or fail. */
async function transferFile(
  options: BundleDownloadOptions,
  file: BundleFileSpec,
  finalPath: string,
  onBytes: (received: number) => void,
): Promise<void> {
  const { spec, signal } = options;
  const requireHttps = options.requireHttps ?? true;
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const firstUrl = bundleUrl(spec, file, options.baseUrl);
  const partPath = `${finalPath}.part`;
  const hosts: string[] = [];
  let received = 0;
  let verified = false;
  let outcome: NetworkEntry['outcome'] = 'failed';

  try {
    let url = firstUrl;
    let response: Response | undefined;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const target = new URL(url);
      if (requireHttps && target.protocol !== 'https:') throw new DownloadError('Only https downloads are allowed.', 'failed');
      if (!hostAllowed(target.hostname, options.allowedHosts)) {
        throw new DownloadError(`${target.hostname} is not on the download allowlist.`, 'failed');
      }
      hosts.push(target.hostname);
      try {
        // Identity encoding, so the declared size is the size of the bytes that are written.
        response = await fetchImpl(url, { redirect: 'manual', signal, headers: { 'Accept-Encoding': 'identity' } });
      } catch {
        if (signal?.aborted) throw new DownloadError('Download cancelled.', 'cancelled');
        throw new DownloadError('The download could not start. Check your connection.', 'failed');
      }
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel().catch(() => undefined);
        url = new URL(location, url).toString();
        response = undefined;
        continue;
      }
      break;
    }
    if (!response) throw new DownloadError('Too many redirects.', 'failed');
    if (!response.ok || !response.body) throw new DownloadError(`The server answered with HTTP ${response.status}.`, 'failed');

    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) !== file.bytes) {
      await response.body.cancel().catch(() => undefined);
      throw new DownloadError(`${file.path} is not the expected size on the server.`, 'failed');
    }

    await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
    const hash = createHash('sha256');
    const handle = await open(partPath, 'w', 0o600);
    try {
      for await (const chunk of Readable.fromWeb(response.body as never)) {
        if (signal?.aborted) throw new DownloadError('Download cancelled.', 'cancelled');
        const bytes = chunk as Buffer;
        received += bytes.length;
        if (received > file.bytes) throw new DownloadError(`${file.path} is larger than expected.`, 'failed');
        hash.update(bytes);
        await handle.write(bytes);
        onBytes(received);
      }
    } finally {
      await handle.close();
    }
    if (received !== file.bytes) throw new DownloadError(`${file.path} ended early.`, 'failed');
    if (hash.digest('hex') !== file.sha256) throw new DownloadError(`${file.path} failed its checksum and was discarded.`, 'failed');
    await rename(partPath, finalPath);
    verified = true;
    outcome = 'ok';
  } catch (error) {
    await rm(partPath, { force: true });
    if (signal?.aborted || (error instanceof DownloadError && error.code === 'cancelled')) outcome = 'cancelled';
    if (error instanceof DownloadError) throw error;
    throw new DownloadError(`${file.path} could not be downloaded.`, 'failed');
  } finally {
    options.record?.({
      ts: Date.now(),
      purpose: 'model_download',
      modelId: spec.id,
      file: file.path,
      host: hosts.at(-1) ?? new URL(firstUrl).hostname,
      path: new URL(firstUrl).pathname,
      bytes: received,
      sha256Verified: verified,
      outcome,
    });
  }
}
