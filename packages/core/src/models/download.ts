import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ModelSpec } from './types';

/** Hugging Face serves files from huggingface.co and redirects to its CDN, which lives under hf.co. */
export const HUGGING_FACE_HOSTS: readonly string[] = ['huggingface.co', '.hf.co'];

export class DownloadError extends Error {
  constructor(
    message: string,
    readonly code: 'cancelled' | 'failed',
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

/** Refuses anything that is not an open, licensed, safely named model with a real digest. */
export function assertOpenModel(spec: ModelSpec): void {
  if (spec.license !== 'Apache-2.0' && spec.license !== 'MIT') throw new Error(`Licence ${spec.license} is not allowed.`);
  if (!/^[a-f0-9]{64}$/.test(spec.sha256)) throw new Error('The model digest is malformed.');
  if (!/^[A-Za-z0-9._-]+$/.test(spec.file) || spec.file.startsWith('.')) throw new Error('The model file name is not safe.');
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(spec.repo)) throw new Error('The model repository is malformed.');
  if (!Number.isInteger(spec.sizeBytes) || spec.sizeBytes <= 0) throw new Error('The model size is malformed.');
}

export function modelUrl(spec: ModelSpec): string {
  return `https://huggingface.co/${spec.repo}/resolve/main/${spec.file}`;
}

/** Exact host match, or suffix match when the entry starts with a dot. */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const name = host.toLowerCase();
  return allowed.some(entry => (entry.startsWith('.') ? name.endsWith(entry) : name === entry));
}

export interface DownloadOptions {
  spec: ModelSpec;
  destinationDir: string;
  allowedHosts: readonly string[];
  /** Production is https only. Tests against a local server switch this off explicitly. */
  requireHttps?: boolean;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (receivedBytes: number, totalBytes: number) => void;
  maxRedirects?: number;
}

export interface DownloadResult {
  path: string;
  bytes: number;
  sha256: string;
  /** Every host contacted, in order, including redirects. */
  hosts: string[];
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** True when the file on disk is exactly the model: right size and right digest. */
export async function verifyModelFile(path: string, spec: ModelSpec): Promise<boolean> {
  try {
    const info = await stat(path);
    if (info.size !== spec.sizeBytes) return false;
    return (await sha256OfFile(path)) === spec.sha256;
  } catch {
    return false;
  }
}

/**
 * Downloads one model. Every hop, including redirects, must be https (unless disabled for tests) and on the allowlist.
 * The bytes go to a temporary file, and only a file with the exact size and digest is moved into place.
 */
export async function downloadModel(options: DownloadOptions): Promise<DownloadResult> {
  const { spec, destinationDir, allowedHosts, signal } = options;
  assertOpenModel(spec);
  const requireHttps = options.requireHttps ?? true;
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRedirects = options.maxRedirects ?? 5;

  const hosts: string[] = [];
  let url = modelUrl(spec);
  let response: Response | undefined;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const target = new URL(url);
    if (requireHttps && target.protocol !== 'https:') throw new DownloadError('Only https downloads are allowed.', 'failed');
    if (!hostAllowed(target.hostname, allowedHosts)) {
      throw new DownloadError(`${target.hostname} is not on the download allowlist.`, 'failed');
    }
    hosts.push(target.hostname);
    try {
      response = await fetchImpl(url, { redirect: 'manual', signal });
    } catch (error) {
      if (signal?.aborted) throw new DownloadError('Download cancelled.', 'cancelled');
      throw new DownloadError('The download could not start. Check your connection.', 'failed');
    }
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      url = new URL(location, url).toString();
      response = undefined;
      continue;
    }
    break;
  }
  if (!response) throw new DownloadError('Too many redirects.', 'failed');
  if (!response.ok || !response.body) throw new DownloadError(`The server answered with HTTP ${response.status}.`, 'failed');

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 0 && declared !== spec.sizeBytes) {
    throw new DownloadError('The file on the server is not the expected size.', 'failed');
  }

  await mkdir(destinationDir, { recursive: true, mode: 0o700 });
  const partPath = join(destinationDir, `${spec.file}.part`);
  const finalPath = join(destinationDir, spec.file);
  const hash = createHash('sha256');
  const handle = await open(partPath, 'w', 0o600);
  let received = 0;
  try {
    for await (const chunk of Readable.fromWeb(response.body as never)) {
      // Honour cancellation between chunks too, because a body that is already streaming is not stopped by abort alone.
      if (signal?.aborted) throw new DownloadError('Download cancelled.', 'cancelled');
      const bytes = chunk as Buffer;
      received += bytes.length;
      if (received > spec.sizeBytes) throw new DownloadError('The file is larger than expected.', 'failed');
      hash.update(bytes);
      await handle.write(bytes);
      options.onProgress?.(received, spec.sizeBytes);
    }
  } catch (error) {
    await handle.close();
    await rm(partPath, { force: true });
    if (error instanceof DownloadError) throw error;
    if (signal?.aborted) throw new DownloadError('Download cancelled.', 'cancelled');
    throw new DownloadError('The download was interrupted.', 'failed');
  }
  await handle.close();

  if (received !== spec.sizeBytes) {
    await rm(partPath, { force: true });
    throw new DownloadError('The download ended early.', 'failed');
  }
  const digest = hash.digest('hex');
  if (digest !== spec.sha256) {
    await rm(partPath, { force: true });
    throw new DownloadError('The file failed its checksum and was discarded.', 'failed');
  }
  await rename(partPath, finalPath);
  return { path: finalPath, bytes: received, sha256: digest, hosts };
}
