import { describe, expect, it } from 'vitest';
import { GIT_LOG_FILE_LIMIT, parseGitLog } from '../../src/connectors/git-log';

const US = '\x1f';
const RS = '\x1e';
const NUL = '\0';

const HASH_ONE = 'a1'.repeat(20);
const HASH_TWO = 'b2'.repeat(20);
const HASH_THREE = 'c3'.repeat(20);

/**
 * The output of `git log -z --date=iso-strict --pretty=format:%H%x1f%aI%x1f%s%x1e --name-only`, as the desktop app
 * receives it: each header ends with RS and a newline, each file name ends with NUL, and a NUL separates two commits.
 */
function fixture(commits: Array<{ hash: string; date: string; subject: string; files: string[] }>): string {
  return commits
    .map((commit) => `${commit.hash}${US}${commit.date}${US}${commit.subject}${RS}\n${commit.files.map((f) => `${f}${NUL}`).join('')}`)
    .join(NUL);
}

describe('parseGitLog: two commits', () => {
  it('reads the hash as the sourceId, the subject as the title, the date as ts and the changed files as the text', () => {
    const output = fixture([
      {
        hash: HASH_ONE,
        date: '2026-03-05T10:00:00+01:00',
        subject: 'Add the plan',
        files: ['docs/plan.md', 'docs/notes.txt'],
      },
      { hash: HASH_TWO, date: '2026-03-04T09:30:00+00:00', subject: 'Fix the parser', files: ['src/parser.ts'] },
    ]);
    expect(parseGitLog(output)).toEqual([
      {
        source: 'git',
        sourceId: HASH_ONE,
        ts: Date.UTC(2026, 2, 5, 9),
        title: 'Add the plan',
        text: 'docs/plan.md\ndocs/notes.txt',
      },
      {
        source: 'git',
        sourceId: HASH_TWO,
        ts: Date.UTC(2026, 2, 4, 9, 30),
        title: 'Fix the parser',
        text: 'src/parser.ts',
      },
    ]);
  });

  it('keeps file names that contain spaces, and reads a SHA-256 hash of 64 characters', () => {
    const hash256 = 'd4'.repeat(32);
    const output = fixture([
      { hash: hash256, date: '2026-03-06T08:00:00Z', subject: 'Spaces', files: ['my notes/sp ace.md'] },
    ]);
    const [item] = parseGitLog(output);
    expect(item?.sourceId).toBe(hash256);
    expect(item?.text).toBe('my notes/sp ace.md');
  });
});

describe('parseGitLog: the file limit', () => {
  it('lists at most 50 file names per commit, and says how many more changed files were not listed', () => {
    const files = Array.from({ length: 53 }, (_, index) => `src/file-${String(index).padStart(2, '0')}.ts`);
    const output = fixture([{ hash: HASH_THREE, date: '2026-03-07T12:00:00Z', subject: 'Big change', files }]);
    const [item] = parseGitLog(output);
    const lines = item?.text.split('\n') ?? [];
    expect(GIT_LOG_FILE_LIMIT).toBe(50);
    expect(lines).toHaveLength(51);
    expect(lines[0]).toBe('src/file-00.ts');
    expect(lines[49]).toBe('src/file-49.ts');
    expect(lines[50]).toBe('3 more changed files not listed.');
  });

  it('does not mention a rest when a commit has exactly 50 files, and uses the singular for one more', () => {
    const fifty = Array.from({ length: 50 }, (_, index) => `f${index}.md`);
    const fiftyOne = [...fifty, 'extra.md'];
    const [exact] = parseGitLog(fixture([{ hash: HASH_ONE, date: '2026-03-07T12:00:00Z', subject: 'Exact', files: fifty }]));
    const [plusOne] = parseGitLog(fixture([{ hash: HASH_ONE, date: '2026-03-07T12:00:00Z', subject: 'Plus one', files: fiftyOne }]));
    expect(exact?.text).not.toContain('not listed');
    expect(plusOne?.text.endsWith('1 more changed file not listed.')).toBe(true);
  });
});

describe('parseGitLog: edge cases', () => {
  it('gives an empty text to a commit that changed no files, such as a merge', () => {
    const [item] = parseGitLog(fixture([{ hash: HASH_ONE, date: '2026-03-07T12:00:00Z', subject: 'Merge', files: [] }]));
    expect(item?.title).toBe('Merge');
    expect(item?.text).toBe('');
  });

  it('returns nothing for empty output', () => {
    expect(parseGitLog('')).toEqual([]);
  });

  it('skips a commit whose date cannot be read, and keeps the others', () => {
    const output = fixture([
      { hash: HASH_ONE, date: 'not-a-date', subject: 'Broken date', files: ['a.md'] },
      { hash: HASH_TWO, date: '2026-03-04T09:30:00Z', subject: 'Fine', files: ['b.md'] },
    ]);
    expect(parseGitLog(output).map((item) => item.title)).toEqual(['Fine']);
  });
});
