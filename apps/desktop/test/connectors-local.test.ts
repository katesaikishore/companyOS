import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { parseGitLog } from '../../../packages/core/src/connectors/git-log';
import {
  FOLDER_READ_FAILED_MESSAGE,
  GIT_NOT_REPOSITORY_MESSAGE,
  GIT_LOG_MAX_COMMITS,
  listFolderFiles,
  readGitLog,
  resolveGitExecutable,
} from '../src/main/connectors-local';

/** Every git call made through execFile, with its arguments and working folder. */
const execCalls = vi.hoisted(() => [] as Array<{ args: string[]; cwd: string | undefined }>);

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (...params: unknown[]) => {
      const [, args, options] = params as [string, string[], { cwd?: string }];
      execCalls.push({ args: [...args], cwd: options.cwd });
      return (actual.execFile as (...values: unknown[]) => unknown)(...params);
    },
  };
});

const made: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** Runs git in a folder with a fixed author, so the test does not depend on the machine's git identity. */
function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Twin Test',
      GIT_AUTHOR_EMAIL: 'twin-test@example.invalid',
      GIT_COMMITTER_NAME: 'Twin Test',
      GIT_COMMITTER_EMAIL: 'twin-test@example.invalid',
    },
  });
}

describe('readGitLog with a real repository', () => {
  it('reads the history of one commit with two files, and parseGitLog gives its subject and file names', async () => {
    const repo = tempDir('twin-git-');
    git(repo, ['init', '-q']);
    writeFileSync(join(repo, 'notes.md'), '# Notes\n');
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, 'docs', 'plan.txt'), 'plan\n');
    git(repo, ['add', '-A']);
    git(repo, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Add notes and plan']);

    const items = parseGitLog(await readGitLog(repo));
    expect(items).toHaveLength(1);
    expect(items[0]?.source).toBe('git');
    expect(items[0]?.title).toBe('Add notes and plan');
    expect(items[0]?.sourceId).toMatch(/^[0-9a-f]{40}$/);
    expect((items[0]?.text ?? '').split('\n').sort()).toEqual(['docs/plan.txt', 'notes.md']);
  });

  it('gives an empty history for a repository with no commits yet', async () => {
    const repo = tempDir('twin-empty-');
    git(repo, ['init', '-q']);
    expect(await readGitLog(repo)).toBe('');
  });

  it('rejects a folder that is not a repository, with the fixed sentence', async () => {
    const plain = tempDir('twin-plain-');
    await expect(readGitLog(plain)).rejects.toMatchObject({ message: GIT_NOT_REPOSITORY_MESSAGE });
  });

  it('rejects a path that does not exist, with the same fixed sentence', async () => {
    const missing = join(tempDir('twin-gone-'), 'missing');
    await expect(readGitLog(missing)).rejects.toMatchObject({ message: GIT_NOT_REPOSITORY_MESSAGE });
  });

  it('rejects an empty path without running git in the application folder', async () => {
    await expect(readGitLog('   ')).rejects.toMatchObject({ message: GIT_NOT_REPOSITORY_MESSAGE });
  });

  it('names the repository with -C, runs git from a folder other than the repository, and caps the history', async () => {
    const repo = tempDir('twin-git-args-');
    git(repo, ['init', '-q']);
    writeFileSync(join(repo, 'a.md'), 'a');
    git(repo, ['add', '-A']);
    git(repo, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'One']);
    execCalls.length = 0;

    await readGitLog(repo);

    const log = execCalls.find((call) => call.args.includes('log'));
    expect(log?.args.slice(0, 2)).toEqual(['-C', repo]);
    expect(log?.args).toContain(`--max-count=${GIT_LOG_MAX_COMMITS}`);
    expect(GIT_LOG_MAX_COMMITS).toBe(5000);
    expect(execCalls.length).toBeGreaterThan(0);
    expect(execCalls.every((call) => call.cwd !== repo)).toBe(true);
  });
});

describe('resolveGitExecutable', () => {
  it('keeps the plain name outside Windows', () => {
    expect(resolveGitExecutable('linux', '/usr/bin', () => true)).toBe('git');
    expect(resolveGitExecutable('darwin', '/usr/bin', () => true)).toBe('git');
  });

  it('takes the first absolute PATH folder that holds git.exe, and skips relative and empty entries', () => {
    const found = new Set(['relative\\git.exe', 'C:\\Program Files\\Git\\cmd\\git.exe', 'D:\\Tools\\git.exe']);
    const path = ['relative', '', 'C:\\Repo', '"C:\\Program Files\\Git\\cmd"', 'D:\\Tools'].join(';');
    expect(resolveGitExecutable('win32', path, (file) => found.has(file))).toBe('C:\\Program Files\\Git\\cmd\\git.exe');
  });

  it('falls back to the plain name when no PATH folder holds git.exe, or PATH is not set', () => {
    expect(resolveGitExecutable('win32', 'C:\\Git', () => false)).toBe('git');
    expect(resolveGitExecutable('win32', undefined, () => true)).toBe('git');
  });
});

describe('listFolderFiles', () => {
  it('skips dot directories and dot files, and does not follow symbolic links', async () => {
    const root = tempDir('twin-folder-');
    mkdirSync(join(root, 'sub'));
    mkdirSync(join(root, '.hidden'));
    writeFileSync(join(root, 'visible.md'), 'a');
    writeFileSync(join(root, 'sub', 'nested.txt'), 'bb');
    writeFileSync(join(root, '.hidden', 'secret.md'), 'c');
    writeFileSync(join(root, '.dot.md'), 'd');
    symlinkSync(join(root, 'visible.md'), join(root, 'alias.md'));
    symlinkSync(join(root, 'sub'), join(root, 'linked-dir'));

    const { files: entries, truncated } = await listFolderFiles(root);
    expect(entries.map((entry) => entry.relativePath)).toEqual(['sub/nested.txt', 'visible.md']);
    expect(entries.find((entry) => entry.relativePath === 'visible.md')?.size).toBe(1);
    expect(entries.every((entry) => entry.mtimeMs > 0)).toBe(true);
    expect(truncated).toBe(false);
  });

  it('stops after the entry limit, and says the walk was truncated', async () => {
    const root = tempDir('twin-limit-');
    for (let index = 0; index < 10; index += 1) writeFileSync(join(root, `f${index}.md`), 'x');
    const listing = await listFolderFiles(root, { limit: 4 });
    expect(listing.files).toHaveLength(4);
    expect(listing.truncated).toBe(true);
  });

  it('walks folders in name order, so a limit ends the walk in the same place every time', async () => {
    const root = tempDir('twin-order-');
    mkdirSync(join(root, 'z-dir'));
    mkdirSync(join(root, 'a-dir'));
    writeFileSync(join(root, 'z-dir', 'one.md'), 'z');
    writeFileSync(join(root, 'a-dir', 'two.md'), 'a');

    const cut = await listFolderFiles(root, { limit: 3 });
    expect(cut.files.map((entry) => entry.relativePath)).toEqual(['a-dir/two.md']);
    expect(cut.truncated).toBe(true);

    const whole = await listFolderFiles(root, { limit: 4 });
    expect(whole.files.map((entry) => entry.relativePath)).toEqual(['a-dir/two.md', 'z-dir/one.md']);
    expect(whole.truncated).toBe(false);
  });

  it('rejects with a fixed sentence when the folder itself cannot be read', async () => {
    const missing = join(tempDir('twin-gone-'), 'missing');
    await expect(listFolderFiles(missing)).rejects.toMatchObject({ message: FOLDER_READ_FAILED_MESSAGE });
  });
});
