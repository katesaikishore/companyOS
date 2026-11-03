import { execFile, spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join, relative } from 'node:path';
import { FACTS_VERSION, clipText, compress, embeddingText, extractFacts, type FileKind, type FileRecord, type TextEmbedder } from '@companyos/twin-core';

/**
 * The file search index, built inside the app: it walks Desktop, Documents, Downloads and Pictures, describes each file
 * (photos and PDFs through the Vision helper, Word, RTF and HTML through macOS's textutil, plain text read directly),
 * embeds it with the small local model, and finds the names it mentions for the knowledge graph. An unchanged file keeps
 * its record, so a pass after the first reads only what changed. Nothing leaves the device.
 */

/** Walked in this order, so the cap on files never cuts Downloads or Pictures short. */
export const INDEX_FOLDERS = ['Downloads', 'Pictures', 'Documents', 'Desktop'] as const;
const IMAGE_TYPES = new Set(['.jpg', '.jpeg', '.png', '.heic', '.webp', '.gif', '.tif', '.tiff']);
const DOCUMENT_TYPES = new Set(['.pdf', '.docx', '.doc', '.rtf', '.odt', '.html', '.htm', '.txt', '.md', '.csv']);
const TEXTUTIL_TYPES = new Set(['.docx', '.doc', '.rtf', '.odt', '.html', '.htm']);
const PLAIN_TYPES = new Set(['.txt', '.md', '.csv']);
/** Folders that hold tools and builds rather than the person's own files. */
const SKIPPED_FOLDERS = new Set(['node_modules', '.git', 'build', 'dist', 'venv', '.venv', '__pycache__', 'target', 'Library', 'Pods', 'DerivedData']);
const MAX_FILES = 20_000;
const MAX_DEPTH = 6;
const PLAIN_BYTES = 8 * 1024;
const MAX_TEXT_FILE_BYTES = 50 * 1024 * 1024;
const EMBED_BATCH = 64;
const TEXTUTIL_TIMEOUT_MS = 10_000;
/** The helper is stopped when it goes this long without an answer, so one stuck file cannot hold up the pass. */
const DESCRIBE_STALL_MS = 30_000;

export interface FileIndexProgress {
  running: boolean;
  /** Files in the index after the last pass. */
  files: number;
  images: number;
  documents: number;
  /** Files read in the current pass so far, and how many it will read. */
  done: number;
  total: number;
  indexedAt?: number;
  /** True when the embedding model was not available, so meaning is missing from search until the next pass. */
  noEmbeddings?: boolean;
}

interface Found {
  path: string;
  root: string;
  size: number;
  mtime: number;
  kind: FileKind;
  /**
   * True for a file whose content is only in iCloud: it has a size but no blocks on disk. Reading it would make macOS
   * download it, and the read waits until it arrives, so such a file is indexed by its name, folder and date only. Only
   * macOS is asked: Windows reports no blocks for every file.
   */
  cloudOnly: boolean;
}

function kindOf(path: string): FileKind {
  const ext = extname(path).toLowerCase();
  if (IMAGE_TYPES.has(ext)) return 'image';
  if (DOCUMENT_TYPES.has(ext)) return 'document';
  return 'other';
}

/**
 * Every file under the folders, skipping hidden folders, app bundles, build folders and anything past the depth or count.
 * It reads asynchronously, so the app's main process keeps answering while thousands of files are listed.
 */
export async function walkFolders(home = homedir(), folders: readonly string[] = INDEX_FOLDERS): Promise<Found[]> {
  const found: Found[] = [];
  const walk = async (folder: string, root: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || found.length >= MAX_FILES) return;
    let names: string[];
    try {
      names = await readdir(folder);
    } catch {
      return;
    }
    // A code project is the person's work, but its thousands of source files are not what file search is for.
    if (depth > 0 && (names.includes('.git') || names.includes('package.json'))) return;
    for (const name of names) {
      if (found.length >= MAX_FILES) return;
      // App bundles, and libraries that other apps manage (Photos, Music, iMovie), are not the person's own files. Reading
      // inside a Photos library also makes macOS ask for Photos access.
      if (name.startsWith('.') || SKIPPED_FOLDERS.has(name) || /\.(app|photoslibrary|musiclibrary|imovielibrary|tvlibrary|fcpbundle)$/i.test(name)) continue;
      const path = join(folder, name);
      let stats;
      try {
        stats = await stat(path);
      } catch {
        continue;
      }
      if (stats.isDirectory()) await walk(path, root, depth + 1);
      else if (stats.isFile()) found.push({ path, root, size: stats.size, mtime: stats.mtimeMs, kind: kindOf(path), cloudOnly: process.platform === 'darwin' && stats.size > 0 && stats.blocks === 0 });
    }
  };
  for (const folder of folders) {
    const root = join(home, folder);
    if (existsSync(root)) await walk(root, root, 0);
  }
  return found;
}

/** The first bytes of a plain text file. */
function readPlain(path: string): Promise<string> {
  return new Promise(resolve => {
    let text = '';
    const stream = createReadStream(path, { encoding: 'utf8', start: 0, end: PLAIN_BYTES - 1 });
    stream.on('data', chunk => (text += chunk));
    stream.on('error', () => resolve(''));
    stream.on('end', () => resolve(text));
  });
}

/** A document's text through macOS's textutil, or nothing when it cannot be converted in time. */
function readWithTextutil(path: string): Promise<string> {
  return new Promise(resolve => {
    // -noload keeps textutil from fetching the images and styles an HTML file links to, so indexing sends nothing anywhere.
    execFile('/usr/bin/textutil', ['-convert', 'txt', '-noload', '-stdout', '--', path], { timeout: TEXTUTIL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (_error, stdout) => resolve(stdout ?? ''));
  });
}

/** Photos and PDFs through the Vision helper's describe mode: one helper for the pass, one path per line. */
function describeWithHelper(helper: string, paths: readonly string[], onEach: () => void): Promise<Map<string, Record<string, unknown>>> {
  return new Promise(resolve => {
    const results = new Map<string, Record<string, unknown>>();
    if (paths.length === 0 || !existsSync(helper)) return resolve(results);
    const child = spawn(helper, ['--describe'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buffered = '';
    let watchdog = setTimeout(() => child.kill(), DESCRIBE_STALL_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => child.kill(), DESCRIBE_STALL_MS);
      buffered += chunk;
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        try {
          const row = JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>;
          if (typeof row.path === 'string') results.set(row.path, row);
        } catch {
          // A line that is not JSON describes nothing.
        }
        onEach();
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
      }
    });
    child.on('error', () => resolve(results));
    child.on('exit', () => {
      clearTimeout(watchdog);
      resolve(results);
    });
    child.stdin.on('error', () => undefined);
    // A path with a line break cannot be sent one per line, so it is left out.
    child.stdin.end(paths.filter(path => !/[\r\n]/.test(path)).join('\n') + '\n');
  });
}

export interface FileIndexOptions {
  helper: string;
  embedder: TextEmbedder;
  /** The records from the last pass. */
  previous: () => FileRecord[];
  save: (records: FileRecord[]) => void;
  onProgress: (progress: FileIndexProgress) => void;
  home?: string;
}

/**
 * One pass over the folders. Unchanged files keep their records; the rest are described, given their facts and embedded.
 * A record whose facts were read by other rules (FACTS_VERSION) counts as changed, so the first pass after a change to the
 * rules reads every file again.
 * Reading a file only in iCloud would make macOS download it, so such a file is kept by its name until it is on this Mac.
 */
export async function indexFiles(options: FileIndexOptions): Promise<FileIndexProgress> {
  const previous = new Map(options.previous().map(record => [record.path, record]));
  const found = await walkFolders(options.home);
  const fresh = found.filter(file => {
    const old = previous.get(file.path);
    // A file that was only in iCloud and is on this Mac now, because it was opened, is read for the first time.
    return !old || old.mtime !== file.mtime || old.size !== file.size || !old.vector || old.factsVersion !== FACTS_VERSION || (old.cloudOnly === true && !file.cloudOnly);
  });
  const progress: FileIndexProgress = { running: true, files: found.length, images: 0, documents: 0, done: 0, total: fresh.length };
  options.onProgress({ ...progress });
  const tick = () => {
    progress.done += 1;
    if (progress.done % 25 === 0) options.onProgress({ ...progress });
  };

  const described = await describeWithHelper(
    options.helper,
    fresh.filter(file => !file.cloudOnly && (file.kind === 'image' || extname(file.path).toLowerCase() === '.pdf')).map(file => file.path),
    tick,
  );
  const records: FileRecord[] = [];
  for (const file of fresh) {
    const ext = extname(file.path).toLowerCase();
    const row = described.get(file.path);
    let text = '';
    if (typeof row?.text === 'string') text = row.text;
    else if (file.cloudOnly) text = '';
    else if (file.size <= MAX_TEXT_FILE_BYTES && PLAIN_TYPES.has(ext)) text = await readPlain(file.path);
    else if (file.size <= MAX_TEXT_FILE_BYTES && TEXTUTIL_TYPES.has(ext)) text = await readWithTextutil(file.path);
    if (!row) tick();
    const name = basename(file.path);
    const folder = [basename(file.root), ...relative(file.root, file.path).split(/[\\/]/).slice(0, -1)].join('/');
    const record: FileRecord = { path: file.path, name, folder, kind: file.kind, size: file.size, mtime: file.mtime, text: clipText(text) };
    if (file.cloudOnly) record.cloudOnly = true;
    if (typeof row?.width === 'number' && typeof row.height === 'number') {
      record.width = row.width;
      record.height = row.height;
      record.faces = Array.isArray(row.faces) ? (row.faces as number[][]) : [];
      record.labels = Array.isArray(row.labels) ? (row.labels as Array<{ label?: unknown }>).map(label => String(label.label ?? '')).filter(Boolean) : [];
    }
    // The facts are read from all the text, before the record keeps only its start.
    record.facts = extractFacts({ name, folder, text });
    record.factsVersion = FACTS_VERSION;
    records.push(record);
  }

  // Meaning: embedded in batches. Without the model the records are kept without vectors and searched by name and graph.
  try {
    for (let start = 0; start < records.length; start += EMBED_BATCH) {
      const batch = records.slice(start, start + EMBED_BATCH);
      const vectors = await options.embedder.embed(batch.map(embeddingText));
      batch.forEach((record, index) => Object.assign(record, compress(vectors[index])));
    }
  } catch {
    progress.noEmbeddings = true;
  }

  const updated = new Map(records.map(record => [record.path, record]));
  const kept = found.map(file => updated.get(file.path) ?? previous.get(file.path)).filter((record): record is FileRecord => record !== undefined);
  options.save(kept);
  return {
    ...progress,
    running: false,
    files: kept.length,
    images: kept.filter(record => record.kind === 'image').length,
    documents: kept.filter(record => record.kind === 'document').length,
    done: fresh.length,
    indexedAt: Date.now(),
  };
}

/** How long one query embedding may take, which covers loading the model again after Ollama unloaded it. */
const QUERY_EMBED_CALL_MS = 15_000;
const QUERY_CACHE = 64;
/** At most this many query embeddings wait on the model at once, so a stuck Ollama cannot gather calls while someone types. */
const QUERY_PENDING = 4;

/**
 * Query embeddings by their words, newest last, so typing a query again, or backing up while typing, costs nothing. A
 * search waits only a short time for a new one and then ranks without meaning, but the call is left to finish and its
 * answer is kept. Ollama stops loading a model when its caller hangs up, so cancelling the call would keep a model it
 * unloaded, after Ollama restarts or half an hour idle, from ever loading again.
 */
export class QueryVectors {
  private readonly vectors = new Map<string, number[]>();
  private readonly pending = new Map<string, Promise<number[] | undefined>>();
  /** Raised by clear, so a call that answers afterwards keeps nothing. */
  private generation = 0;

  constructor(private readonly embedder: TextEmbedder) {}

  /** The vector of these words, or nothing when the model has not answered within the wait. */
  async get(words: string, waitMs: number): Promise<number[] | undefined> {
    const known = this.vectors.get(words);
    if (known) return known;
    const call = this.pending.get(words) ?? this.start(words);
    if (!call) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<undefined>(resolve => {
      timer = setTimeout(() => resolve(undefined), waitMs);
    });
    try {
      return await Promise.race([call, waited]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Forgets every vector, and the answers of calls still running. */
  clear(): void {
    this.vectors.clear();
    this.pending.clear();
    this.generation += 1;
  }

  private start(words: string): Promise<number[] | undefined> | undefined {
    if (this.pending.size >= QUERY_PENDING) return undefined;
    const generation = this.generation;
    const call: Promise<number[] | undefined> = this.embedder
      .embed([words], AbortSignal.timeout(QUERY_EMBED_CALL_MS))
      .then(
        ([vector]) => {
          if (generation !== this.generation || !vector) return undefined;
          this.vectors.set(words, vector);
          if (this.vectors.size > QUERY_CACHE) this.vectors.delete(this.vectors.keys().next().value as string);
          return vector;
        },
        () => undefined,
      )
      .finally(() => {
        if (this.pending.get(words) === call) this.pending.delete(words);
      });
    this.pending.set(words, call);
    return call;
  }
}
