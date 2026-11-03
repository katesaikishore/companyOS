import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { StepRefusedError } from '@companyos/twin-core';

/**
 * Gathers duplicate files to free space safely. Files in the scanned folders are grouped by size, then by a SHA-256 of
 * their contents. In each group of identical files the oldest copy stays where it is, and every other copy is moved into
 * the review folder, under the path it had below the home folder, so the person can look before deleting anything. A
 * manifest in the review folder lists every move, so it can be undone. Nothing is deleted.
 *
 * Only regular files that are on this disk are read. Hidden files and folders, app and other bundles, symbolic links, the
 * review folder itself, and code projects and their dependency folders are skipped, so no project loses a file. A file whose contents are only in iCloud has no blocks on disk; reading it would
 * download it and use the space being freed, so it is skipped too.
 */

/** How deep below each scanned folder the scan goes, and how many files it reads at most. */
const MAX_DEPTH = 6;
const MAX_FILES = 50_000;
/** Folders with these extensions are bundles macOS shows as one file, such as an app or a photo library. */
/** Files that mark a folder as a code project. A project's files are never moved, since moving one could break it. */
const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'setup.py', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'composer.json', 'Gemfile'];
/** Folders of installed dependencies, which hold many identical files on purpose. */
const DEPENDENCY_FOLDER = /^(node_modules|vendor|site-packages|bower_components|Pods)$/;
const BUNDLE = /\.(app|bundle|framework|photoslibrary|musiclibrary|tvlibrary|pkg|plugin|kext|xcodeproj|xcworkspace|lproj|rtfd|key|pages|numbers)$/i;

const MESSAGES = {
  outside: 'A folder is not inside your home folder, so nothing was moved.',
  missing: 'A folder to scan does not exist, so nothing was moved.',
  overlap: 'The review folder is inside a scanned folder, so nothing was moved.',
} as const;

interface Found {
  path: string;
  size: number;
  born: number;
}

/** "~/a/b" as an absolute path below home. */
function expand(home: string, path: string): string {
  return join(home, path.slice(2));
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep);
}

async function walk(folder: string, skip: string, depth: number, out: Found[]): Promise<void> {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch {
    return;
  }
  // A code project is left whole: none of its files is a candidate to move.
  if (entries.some(entry => PROJECT_MARKERS.includes(entry.name))) return;
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    if (entry.name.startsWith('.')) continue;
    const path = join(folder, entry.name);
    if (path === skip) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!BUNDLE.test(entry.name) && !DEPENDENCY_FOLDER.test(entry.name)) await walk(path, skip, depth + 1, out);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const info = await lstat(path);
      // An empty file is no space to free. A file with no blocks on disk is only in iCloud: reading it would download it.
      if (info.size === 0 || info.blocks === 0) continue;
      // The earlier of creation and last change: Linux does not always keep a creation time, and a copy keeps the
      // original's change time on some systems, so either alone can name the wrong copy as the oldest.
      const born = Math.min(info.birthtimeMs > 0 ? info.birthtimeMs : Number.POSITIVE_INFINITY, info.mtimeMs);
      out.push({ path, size: info.size, born });
    } catch {
      // A file that went away while the scan ran is skipped.
    }
  }
}

function hashOf(path: string): Promise<string | undefined> {
  return new Promise(resolve => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', () => resolve(undefined));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** A path in the review folder that is not taken yet: the original's place below home, with a number added if needed. */
async function freePath(into: string, home: string, from: string): Promise<string> {
  const target = join(into, relative(home, from));
  if (!(await exists(target))) return target;
  const ext = extname(target);
  const stem = target.slice(0, target.length - ext.length);
  for (let n = 2; ; n++) {
    const next = `${stem} (${n})${ext}`;
    if (!(await exists(next))) return next;
  }
}

interface Gathered {
  moved: number;
  bytes: number;
  manifest: string;
}

export async function gatherDuplicates(home: string, folders: readonly string[], into: string, now: () => Date = () => new Date()): Promise<Gathered> {
  const realHome = await realpath(home);
  const target = expand(realHome, into);
  if (!inside(realHome, target)) throw new StepRefusedError(MESSAGES.outside);
  const roots: string[] = [];
  for (const folder of folders) {
    const path = expand(realHome, folder);
    let real: string;
    try {
      real = await realpath(path);
      if (!(await stat(real)).isDirectory()) throw new Error('not a folder');
    } catch {
      throw new StepRefusedError(MESSAGES.missing);
    }
    // A folder that is a link to somewhere outside home is refused, as is one the review folder sits in.
    if (!inside(realHome, real)) throw new StepRefusedError(MESSAGES.outside);
    if (inside(real, target) || real === target) throw new StepRefusedError(MESSAGES.overlap);
    roots.push(real);
  }

  const files: Found[] = [];
  for (const root of roots) await walk(root, target, 0, files);

  const bySize = new Map<number, Found[]>();
  for (const file of files) bySize.set(file.size, [...(bySize.get(file.size) ?? []), file]);
  const groups: Found[][] = [];
  for (const same of bySize.values()) {
    if (same.length < 2) continue;
    const byHash = new Map<string, Found[]>();
    for (const file of same) {
      const hash = await hashOf(file.path);
      if (hash) byHash.set(hash, [...(byHash.get(hash) ?? []), file]);
    }
    for (const group of byHash.values()) if (group.length > 1) groups.push(group);
  }

  await mkdir(target, { recursive: true });
  const moves: Array<{ from: string; to: string; kept: string; size: number }> = [];
  let bytes = 0;
  for (const group of groups) {
    const ordered = [...group].sort((a, b) => a.born - b.born || a.path.localeCompare(b.path));
    const [keep, ...extra] = ordered;
    for (const copy of extra) {
      const to = await freePath(target, realHome, copy.path);
      await mkdir(dirname(to), { recursive: true });
      await rename(copy.path, to);
      // The postcondition, file by file: in the review folder, and gone from where it was.
      if (!(await exists(to)) || (await exists(copy.path))) throw new Error('A move could not be confirmed.');
      moves.push({ from: copy.path, to, kept: keep.path, size: copy.size });
      bytes += copy.size;
    }
  }
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const manifest = join(target, `duplicates-manifest-${stamp}.json`);
  await writeFile(
    manifest,
    JSON.stringify({ made: now().toISOString(), scanned: roots, moves, undo: 'Move each "to" back to its "from".' }, null, 1),
  );
  return { moved: moves.length, bytes, manifest: basename(manifest) };
}
