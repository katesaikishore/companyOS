import { execFile, type ExecFileException } from 'node:child_process';
import { statSync, type Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath, win32 } from 'node:path';

/**
 * The file-system and Git side of the local connectors. The core parsers (folder, git-log) read what this module finds.
 * Nothing here opens a network connection, and no error message carries a path, a file name or Git output.
 */

/**
 * A file found in a folder. The shape matches the core FolderEntry. It is repeated here because the desktop main build
 * cannot import the core sources, and the two are compared by shape, not by name.
 */
export interface LocalFolderEntry {
  /** The path inside the folder, with "/" between segments. */
  relativePath: string;
  mtimeMs: number;
  size: number;
}

/** What a folder walk found. `truncated` is true when the entry budget ended the walk before it had visited everything. */
export interface FolderListing {
  files: LocalFolderEntry[];
  truncated: boolean;
}

/** The most directory entries one listing visits, files and folders together. */
export const FOLDER_SCAN_LIMIT = 20_000;

/** The most commits one history read takes. Git lists the newest first, so a longer history keeps its latest commits. */
export const GIT_LOG_MAX_COMMITS = 5000;

export const FOLDER_READ_FAILED_MESSAGE = 'The folder could not be read.';
export const GIT_NOT_REPOSITORY_MESSAGE = 'This folder is not a Git repository, or Git is not available.';
export const GIT_LOG_FAILED_MESSAGE = 'The Git history could not be read.';
export const GIT_LOG_LIMIT_MESSAGE = 'The Git history took too long to read, or is too large.';

/**
 * The arguments of the history read. The core parseGitLog reads exactly this output. The -c option turns off signature
 * lines, which a user's own configuration could otherwise add between the commits. The read stops at GIT_LOG_MAX_COMMITS,
 * so a longer history is imported in part: its newest 5,000 commits.
 */
export const GIT_LOG_ARGS: readonly string[] = [
  '-c',
  'log.showSignature=false',
  'log',
  `--max-count=${GIT_LOG_MAX_COMMITS}`,
  '-z',
  '--date=iso-strict',
  '--pretty=format:%H%x1f%aI%x1f%s%x1e',
  '--name-only',
];

const GIT_TIMEOUT_MS = 20_000;
const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * Walks a folder and lists its regular files. Dot directories and dot files are skipped, symbolic links are not followed,
 * and the walk stops after `limit` entries (FOLDER_SCAN_LIMIT by default). Folders are walked in name order, so a limit that
 * ends the walk ends it at the same place every time. Files come back sorted by relativePath.
 * Rejects with FOLDER_READ_FAILED_MESSAGE when the folder itself cannot be read; an unreadable subfolder is skipped.
 */
export async function listFolderFiles(root: string, options: { limit?: number } = {}): Promise<FolderListing> {
  const limit = options.limit ?? FOLDER_SCAN_LIMIT;
  const found: LocalFolderEntry[] = [];
  const pending: Array<{ abs: string; rel: string }> = [{ abs: root, rel: '' }];
  let visited = 0;
  let truncated = false;

  walk: while (pending.length > 0) {
    if (visited >= limit) {
      truncated = true;
      break;
    }
    const dir = pending.pop();
    if (!dir) break;
    let dirents: Dirent[];
    try {
      dirents = await readdir(dir.abs, { withFileTypes: true });
    } catch {
      if (dir.abs === root) throw new Error(FOLDER_READ_FAILED_MESSAGE);
      continue;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const subfolders: Array<{ abs: string; rel: string }> = [];
    for (const dirent of dirents) {
      if (visited >= limit) {
        truncated = true;
        break walk;
      }
      visited += 1;
      if (dirent.name.startsWith('.') || dirent.isSymbolicLink()) continue;
      const abs = join(dir.abs, dirent.name);
      const rel = dir.rel === '' ? dirent.name : `${dir.rel}/${dirent.name}`;
      if (dirent.isDirectory()) {
        subfolders.push({ abs, rel });
        continue;
      }
      if (!dirent.isFile()) continue;
      try {
        const info = await stat(abs);
        found.push({ relativePath: rel, mtimeMs: info.mtimeMs, size: info.size });
      } catch {
        // A file that cannot be read right now is skipped.
      }
    }
    // The stack is popped from its end, so the first subfolder in name order is pushed last.
    for (const sub of subfolders.reverse()) pending.push(sub);
  }

  return {
    files: found.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0)),
    truncated,
  };
}

/**
 * Returns the Git history of a repository, in the format parseGitLog reads. The path is checked first with
 * `git rev-parse --is-inside-work-tree`. A repository with no commits gives an empty string.
 *
 * Git runs with the argument array above, never through a shell, with the repository named by -C, a 20 second timeout and a
 * 16 MB output limit. Rejects with GIT_NOT_REPOSITORY_MESSAGE when the path is not a repository or Git is not installed.
 */
export async function readGitLog(repoPath: string): Promise<string> {
  if (typeof repoPath !== 'string' || repoPath.trim() === '') throw new Error(GIT_NOT_REPOSITORY_MESSAGE);

  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], repoPath).catch(() => '');
  if (inside.trim() !== 'true') throw new Error(GIT_NOT_REPOSITORY_MESSAGE);

  const hasCommits = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], repoPath).then(
    () => true,
    () => false,
  );
  if (!hasCommits) return '';

  try {
    return await runGit(GIT_LOG_ARGS, repoPath);
  } catch (error) {
    throw new Error(isLimitError(error) ? GIT_LOG_LIMIT_MESSAGE : GIT_LOG_FAILED_MESSAGE);
  }
}

/**
 * The program to run for git. On Windows it is the first git.exe on PATH, by absolute path, since a bare "git" is looked up
 * in the working folder before PATH. Relative PATH entries are skipped for the same reason. Elsewhere, or when no git.exe is
 * found, it is "git".
 */
export function resolveGitExecutable(
  platform: NodeJS.Platform,
  pathValue: string | undefined,
  isFileAt: (path: string) => boolean,
): string {
  if (platform !== 'win32') return 'git';
  for (const raw of (pathValue ?? '').split(';')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (dir === '' || !win32.isAbsolute(dir)) continue;
    const candidate = win32.join(dir, 'git.exe');
    if (isFileAt(candidate)) return candidate;
  }
  return 'git';
}

/**
 * Runs git with an argument array. The repository is named with -C and the program runs in the temporary folder, so a file in
 * the repository folder is never run as git. The output is returned as text.
 */
function runGit(args: readonly string[], repoPath: string): Promise<string> {
  return new Promise((resolveRun, reject) => {
    execFile(
      resolveGitExecutable(process.platform, process.env.PATH, isFile),
      ['-C', resolvePath(repoPath), ...args],
      {
        cwd: tmpdir(),
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolveRun(stdout);
      },
    );
  });
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** True when the command was stopped by its timeout or ran past its output limit. */
function isLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { killed, code } = error as ExecFileException;
  return killed === true || code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
}
