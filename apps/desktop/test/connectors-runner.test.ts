import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CALENDAR_MAX_BYTES,
  CALENDAR_TOO_LARGE_MESSAGE,
  FOLDER_MAX_FILES,
  FOLDER_TOO_MANY_MESSAGE,
  IMPORT_FAILED_MESSAGE,
  MAIL_MAX_BYTES,
  SOURCE_MISSING_MESSAGE,
  MAIL_TOO_LARGE_MESSAGE,
  SOURCE_FILE_FAILED_MESSAGE,
  SOURCE_PATH_FILE_MESSAGE,
  SOURCE_PATH_KIND_MESSAGE,
  SOURCE_PATH_MISSING_MESSAGE,
  STORE_FAILED_MESSAGE,
  checkSourcePath,
  readFolderItems,
  runLocalSource,
} from '../src/main/connectors-runner';
import { FOLDER_READ_FAILED_MESSAGE, GIT_NOT_REPOSITORY_MESSAGE } from '../src/main/connectors-local';
import { fakeAgent, type FakeAgent } from './connectors-fake-agent';

/** A fixed clock: 15 June 2026, 12:00 UTC. */
const NOW = Date.UTC(2026, 5, 15, 12);
const DAY = 86_400_000;
const MB = 1024 * 1024;
/** Planted in a path. It must never reach an error message. */
const CANARY = 'CANARY_PATH_4471';

const made: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

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

const ID_ONE = 'connector-test-01';
const ID_TWO = 'connector-test-02';

function source(kind: string, path: string, id = ID_ONE) {
  return { id, kind, label: 'Test source', path, createdAt: NOW - DAY };
}

function agentWith(kind: string, path: string, id = ID_ONE): FakeAgent {
  return fakeAgent([source(kind, path, id)]);
}

describe('runLocalSource for a folder', () => {
  it('imports the supported files, skips hidden, large and other files, and sets lastImportedAt', async () => {
    const root = tempDir('twin-folder-');
    writeFileSync(join(root, 'a.md'), '# Alpha\nBody text');
    writeFileSync(join(root, 'b.txt'), 'Beta note');
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'c.html'), '<html><head><title>x</title></head><body><p>Gamma &amp; more</p><script>bad()</script></body></html>');
    writeFileSync(join(root, '.secret.md'), 'hidden');
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'config.md'), 'git internals');
    writeFileSync(join(root, 'image.png'), 'not text');
    writeFileSync(join(root, 'huge.txt'), '');
    truncateSync(join(root, 'huge.txt'), MB + 1);
    const agent = agentWith('folder', root);

    const outcome = await runLocalSource(source('folder', root), { agent, now: () => NOW });

    expect(outcome).toEqual({ ok: true, count: 3 });
    const titles = agent.itemsOf(ID_ONE).map(item => item.title).sort();
    expect(titles).toEqual(['a', 'b', 'c']);
    const page = agent.itemsOf(ID_ONE).find(item => item.title === 'c');
    expect(page?.text).toContain('Gamma & more');
    expect(page?.text).not.toContain('bad()');
    expect(page?.location).toBe('sub/c.html');
    expect(agent.sources()[0]?.lastImportedAt).toBe(NOW);
  });

  it('replaces the earlier items: a deleted file leaves nothing, and a changed file keeps one version', async () => {
    const root = tempDir('twin-folder-replace-');
    writeFileSync(join(root, 'a.md'), 'first version');
    writeFileSync(join(root, 'b.txt'), 'to be deleted');
    const agent = agentWith('folder', root);
    await runLocalSource(source('folder', root), { agent, now: () => NOW });
    expect(agent.itemsOf(ID_ONE)).toHaveLength(2);
    const firstId = agent.itemsOf(ID_ONE).find(item => item.title === 'a')?.sourceId;

    rmSync(join(root, 'b.txt'));
    writeFileSync(join(root, 'a.md'), 'second version');
    utimesSync(join(root, 'a.md'), new Date(NOW - 2 * DAY), new Date(NOW - 2 * DAY));
    const outcome = await runLocalSource(source('folder', root), { agent, now: () => NOW });

    expect(outcome).toEqual({ ok: true, count: 1 });
    const items = agent.itemsOf(ID_ONE);
    expect(items.map(item => item.title)).toEqual(['a']);
    expect(items[0]?.text).toBe('second version');
    expect(items[0]?.sourceId).toMatch(/^[0-9a-f]{32}$/);
    expect(items[0]?.sourceId).not.toBe(firstId);
  });

  it('keeps the earlier items and the last import time when the folder cannot be read', async () => {
    const root = tempDir('twin-folder-gone-');
    writeFileSync(join(root, 'a.md'), 'kept');
    const agent = agentWith('folder', root);
    await runLocalSource(source('folder', root), { agent, now: () => NOW });
    const before = agent.itemsOf(ID_ONE).length;
    rmSync(root, { recursive: true, force: true });

    const outcome = await runLocalSource(source('folder', root), { agent, now: () => NOW + DAY });

    expect(outcome).toEqual({ ok: false, message: FOLDER_READ_FAILED_MESSAGE });
    expect(agent.itemsOf(ID_ONE)).toHaveLength(before);
    expect(agent.sources()[0]?.lastImportedAt).toBe(NOW);
  });

  it('stores in batches of 200, so a large folder is written in several calls', async () => {
    const root = tempDir('twin-folder-batch-');
    for (let i = 0; i < 450; i += 1) writeFileSync(join(root, `note-${String(i).padStart(3, '0')}.txt`), `note ${i}`);
    const agent = agentWith('folder', root);

    const outcome = await runLocalSource(source('folder', root), { agent, now: () => NOW });

    expect(outcome).toEqual({ ok: true, count: 450 });
    expect(agent.ingestCalls).toBe(3);
    expect(agent.itemsOf(ID_ONE)).toHaveLength(450);
  });
});

describe('runLocalSource for a folder: encodings and limits', () => {
  it('reads a Windows-1252 text file and a UTF-8 file, each in its own encoding', async () => {
    const root = tempDir('twin-folder-enc-');
    writeFileSync(join(root, 'latin.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x6e, 0x6f, 0x74, 0x65])); // "café note"
    writeFileSync(join(root, 'utf.txt'), 'naïve café', 'utf8');

    const items = await readFolderItems(root);

    expect(items.find(item => item.title === 'latin')?.text).toBe('café note');
    expect(items.find(item => item.title === 'utf')?.text).toBe('naïve café');
  });

  it('refuses a folder with more supported files than the limit', async () => {
    const root = tempDir('twin-folder-count-');
    for (const name of ['a.md', 'b.md', 'c.md']) writeFileSync(join(root, name), 'text');
    await expect(readFolderItems(root, { maxFiles: 2 })).rejects.toMatchObject({ message: FOLDER_TOO_MANY_MESSAGE });
  });

  it('refuses a folder the walk could not finish, instead of reading part of it', async () => {
    const root = tempDir('twin-folder-scan-');
    mkdirSync(join(root, 'sub'));
    for (const name of ['a.md', 'b.md', 'c.md']) writeFileSync(join(root, name), 'text');
    await expect(readFolderItems(root, { scanLimit: 2 })).rejects.toMatchObject({ message: FOLDER_TOO_MANY_MESSAGE });
    await expect(readFolderItems(root)).resolves.toHaveLength(3);
  });

  it('refuses a folder whose text is over the character cap, and accepts one that fits', async () => {
    const root = tempDir('twin-folder-chars-');
    for (const name of ['a.md', 'b.md', 'c.md']) writeFileSync(join(root, name), 'abcdef');
    await expect(readFolderItems(root, { maxChars: 17 })).rejects.toMatchObject({ message: FOLDER_TOO_MANY_MESSAGE });
    await expect(readFolderItems(root, { maxChars: 18 })).resolves.toHaveLength(3);
  });

  it('keeps the earlier items when a folder has more supported files than one import reads', async () => {
    const root = tempDir('twin-folder-many-');
    writeFileSync(join(root, 'a.md'), 'kept');
    const agent = agentWith('folder', root);
    await runLocalSource(source('folder', root), { agent, now: () => NOW });
    for (let index = 0; index <= FOLDER_MAX_FILES; index += 1) {
      writeFileSync(join(root, `more-${String(index).padStart(4, '0')}.txt`), 'x');
    }

    const outcome = await runLocalSource(source('folder', root), { agent, now: () => NOW + DAY });

    expect(outcome).toEqual({ ok: false, message: FOLDER_TOO_MANY_MESSAGE });
    expect(agent.itemsOf(ID_ONE).map(item => item.title)).toEqual(['a']);
    expect(agent.sources()[0]?.lastImportedAt).toBe(NOW);
  }, 30_000);
});

describe('runLocalSource for a Git repository', () => {
  it('reads the history of a real repository: one item per commit, with its subject and files', async () => {
    const repo = tempDir('twin-runner-git-');
    git(repo, ['init', '-q']);
    writeFileSync(join(repo, 'notes.md'), '# Notes\n');
    git(repo, ['add', '-A']);
    git(repo, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'First commit']);
    writeFileSync(join(repo, 'plan.txt'), 'plan\n');
    git(repo, ['add', '-A']);
    git(repo, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Second commit']);
    const agent = agentWith('git', repo);

    const outcome = await runLocalSource(source('git', repo), { agent, now: () => NOW });

    expect(outcome).toEqual({ ok: true, count: 2 });
    const titles = agent.itemsOf(ID_ONE).map(item => item.title).sort();
    expect(titles).toEqual(['First commit', 'Second commit']);
    expect(agent.itemsOf(ID_ONE).every(item => item.source === 'git')).toBe(true);
  });

  it('refuses a folder that is not a repository, with the fixed sentence, and changes nothing', async () => {
    const plain = tempDir('twin-runner-plain-');
    const agent = agentWith('git', plain);

    const outcome = await runLocalSource(source('git', plain), { agent, now: () => NOW });

    expect(outcome).toEqual({ ok: false, message: GIT_NOT_REPOSITORY_MESSAGE });
    expect(agent.itemsOf(ID_ONE)).toHaveLength(0);
    expect(agent.sources()[0]?.lastImportedAt).toBeUndefined();
  });
});

describe('runLocalSource for a calendar file', () => {
  const ICS = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//twin test//EN',
    'BEGIN:VEVENT',
    'UID:one@example.invalid',
    'DTSTART:20260616T090000Z',
    'DTEND:20260616T100000Z',
    'SUMMARY:Planning',
    'LOCATION:Room 4',
    'DESCRIPTION:Quarter plan',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:old@example.invalid',
    'DTSTART:20250101T090000Z',
    'DTEND:20250101T100000Z',
    'SUMMARY:Ancient',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:far@example.invalid',
    'DTSTART:20280101T090000Z',
    'DTEND:20280101T100000Z',
    'SUMMARY:Too far',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:soon@example.invalid',
    'DTSTART:20260701T090000Z',
    'DTEND:20260701T100000Z',
    'SUMMARY:Next month',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');

  it('keeps the events from 180 days back to 365 days ahead', async () => {
    const dir = tempDir('twin-ics-');
    const file = join(dir, 'calendar.ics');
    writeFileSync(file, ICS);
    const agent = agentWith('calendar', file);

    const outcome = await runLocalSource(source('calendar', file), { agent, now: () => NOW });

    expect(outcome).toEqual({ ok: true, count: 2 });
    const items = agent.itemsOf(ID_ONE);
    expect(items.map(item => item.title).sort()).toEqual(['Next month', 'Planning']);
    expect(items.find(item => item.title === 'Planning')?.location).toBe('Room 4');
    expect(items.find(item => item.title === 'Planning')?.text).toContain('Quarter plan');
  });

  it('refuses a file over 10 MB without reading it, and keeps the earlier items', async () => {
    const dir = tempDir('twin-ics-big-');
    const file = join(dir, 'big.ics');
    writeFileSync(file, ICS);
    const agent = agentWith('calendar', file);
    await runLocalSource(source('calendar', file), { agent, now: () => NOW });
    const before = agent.itemsOf(ID_ONE).length;
    truncateSync(file, CALENDAR_MAX_BYTES + 1);

    const outcome = await runLocalSource(source('calendar', file), { agent, now: () => NOW });

    expect(outcome).toEqual({ ok: false, message: CALENDAR_TOO_LARGE_MESSAGE });
    expect(agent.itemsOf(ID_ONE)).toHaveLength(before);
  });
});

describe('runLocalSource for a mail archive', () => {
  function message(index: number): string {
    return [
      `From sender${index}@example.invalid Mon Jun 01 10:00:00 2026`,
      `Message-ID: <note-${index}@example.invalid>`,
      'Date: Mon, 01 Jun 2026 10:00:00 +0000',
      `From: Sender ${index} <sender${index}@example.invalid>`,
      `Subject: Note ${index}`,
      '',
      `Body of note ${index}.`,
      '',
    ].join('\n');
  }

  it('reads the messages, keeps the subject and text, and never stores a sender address', async () => {
    const dir = tempDir('twin-mbox-');
    const file = join(dir, 'archive.mbox');
    writeFileSync(file, message(1) + message(2));
    const agent = agentWith('mail', file);

    const outcome = await runLocalSource(source('mail', file), { agent, now: () => NOW });

    expect(outcome).toEqual({ ok: true, count: 2 });
    const items = agent.itemsOf(ID_ONE);
    expect(items.map(item => item.title).sort()).toEqual(['Note 1', 'Note 2']);
    expect(items.find(item => item.title === 'Note 1')?.text).toContain('Body of note 1.');
    expect(JSON.stringify(items)).not.toContain('sender1@example.invalid');
  });

  it('reads at most 5000 messages', async () => {
    const dir = tempDir('twin-mbox-cap-');
    const file = join(dir, 'large.mbox');
    const parts: string[] = [];
    for (let i = 1; i <= 5002; i += 1) parts.push(message(i));
    writeFileSync(file, parts.join(''));
    const agent = agentWith('mail', file);

    const outcome = await runLocalSource(source('mail', file), { agent, now: () => NOW });

    expect(outcome).toEqual({ ok: true, count: 5000 });
  });

  it('reads a Windows-1252 message body as Windows-1252', async () => {
    const dir = tempDir('twin-mbox-enc-');
    const file = join(dir, 'latin.mbox');
    const head = [
      'From sender1@example.invalid Mon Jun 01 10:00:00 2026',
      'Message-ID: <latin-1@example.invalid>',
      'Date: Mon, 01 Jun 2026 10:00:00 +0000',
      'From: Sender 1 <sender1@example.invalid>',
      'Subject: Latin note',
      '',
      'Un caf',
    ].join('\n');
    writeFileSync(file, Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from([0xe9]), Buffer.from('.\n', 'utf8')]));
    const agent = agentWith('mail', file);

    await runLocalSource(source('mail', file), { agent, now: () => NOW });

    expect(agent.itemsOf(ID_ONE).find(item => item.title === 'Latin note')?.text).toContain('Un café.');
  });

  it('refuses a file over 50 MB, with the fixed sentence', async () => {
    const dir = tempDir('twin-mbox-big-');
    const file = join(dir, 'huge.mbox');
    writeFileSync(file, message(1));
    truncateSync(file, MAIL_MAX_BYTES + 1);
    const agent = agentWith('mail', file);

    const outcome = await runLocalSource(source('mail', file), { agent, now: () => NOW });

    expect(outcome).toEqual({ ok: false, message: MAIL_TOO_LARGE_MESSAGE });
  });
});

describe('runLocalSource failures and limits', () => {
  it('refuses a cloud kind, since it is not read on this device', async () => {
    const agent = agentWith('github', '/not/used');

    const outcome = await runLocalSource(source('github', '/not/used'), { agent, now: () => NOW });

    expect(outcome).toEqual({ ok: false, message: IMPORT_FAILED_MESSAGE });
  });

  it('reports a missing calendar file with the fixed sentence, and never the path', async () => {
    const path = join(tempDir('twin-missing-'), `${CANARY}.ics`);
    const agent = agentWith('calendar', path);

    const outcome = await runLocalSource(source('calendar', path), { agent, now: () => NOW });

    expect(outcome).toEqual({ ok: false, message: SOURCE_FILE_FAILED_MESSAGE });
    expect(JSON.stringify(outcome)).not.toContain(CANARY);
  });

  it('reports a failed store with its own sentence, and does not mark the source as imported', async () => {
    const root = tempDir('twin-store-fail-');
    writeFileSync(join(root, 'a.md'), 'text');
    const agent = agentWith('folder', root);
    agent.failIngest = true;

    const outcome = await runLocalSource(source('folder', root), { agent, now: () => NOW });

    expect(outcome).toEqual({ ok: false, message: STORE_FAILED_MESSAGE });
    expect(agent.sources()[0]?.lastImportedAt).toBeUndefined();
  });

  it('stores nothing when the source was removed while it was being read', async () => {
    const root = tempDir('twin-removed-');
    writeFileSync(join(root, 'a.md'), 'text');
    const agent = agentWith('folder', root);
    agent.beforeIngest = () => agent.updateConfig({ connectors: [] });

    const outcome = await runLocalSource(source('folder', root), { agent, now: () => NOW });

    expect(outcome).toEqual({ ok: false, message: SOURCE_MISSING_MESSAGE });
    expect(agent.itemsOf(ID_ONE)).toHaveLength(0);
  });

  it('stores nothing for a source that is not saved, before it reads or writes anything', async () => {
    const root = tempDir('twin-unsaved-');
    writeFileSync(join(root, 'a.md'), 'text');
    const agent = fakeAgent([]);

    const outcome = await runLocalSource(source('folder', root), { agent, now: () => NOW });

    expect(outcome).toEqual({ ok: false, message: SOURCE_MISSING_MESSAGE });
    expect(agent.ingestCalls).toBe(0);
  });

  it('keeps the other source untouched', async () => {
    const root = tempDir('twin-two-');
    writeFileSync(join(root, 'a.md'), 'text');
    const agent = fakeAgent([source('folder', root, ID_ONE), source('folder', root, ID_TWO)]);
    await runLocalSource(source('folder', root, ID_ONE), { agent, now: () => NOW });

    expect(agent.itemsOf(ID_TWO)).toHaveLength(0);
    expect(agent.sources().find(item => item.id === ID_TWO)?.lastImportedAt).toBeUndefined();
  });
});

describe('checkSourcePath', () => {
  it('accepts a folder for folder and Git, and refuses a file for them', async () => {
    const root = tempDir('twin-check-');
    const file = join(root, 'a.md');
    writeFileSync(file, 'x');
    expect(await checkSourcePath('folder', root)).toBeUndefined();
    expect(await checkSourcePath('git', root)).toBeUndefined();
    expect(await checkSourcePath('folder', file)).toBe(SOURCE_PATH_KIND_MESSAGE);
    expect(await checkSourcePath('git', file)).toBe(SOURCE_PATH_KIND_MESSAGE);
  });

  it('accepts a file for calendar and mail, refuses a folder, and refuses a file over its limit', async () => {
    const root = tempDir('twin-check-files-');
    const ics = join(root, 'cal.ics');
    const mbox = join(root, 'mail.mbox');
    writeFileSync(ics, 'x');
    writeFileSync(mbox, 'x');
    expect(await checkSourcePath('calendar', ics)).toBeUndefined();
    expect(await checkSourcePath('mail', mbox)).toBeUndefined();
    expect(await checkSourcePath('calendar', root)).toBe(SOURCE_PATH_FILE_MESSAGE);
    truncateSync(ics, CALENDAR_MAX_BYTES + 1);
    truncateSync(mbox, MAIL_MAX_BYTES + 1);
    expect(await checkSourcePath('calendar', ics)).toBe(CALENDAR_TOO_LARGE_MESSAGE);
    expect(await checkSourcePath('mail', mbox)).toBe(MAIL_TOO_LARGE_MESSAGE);
  });

  it('reports a path that does not exist, and never echoes it', async () => {
    const missing = join(tempDir('twin-check-missing-'), `${CANARY}`);
    const problem = await checkSourcePath('folder', missing);
    expect(problem).toBe(SOURCE_PATH_MISSING_MESSAGE);
    expect(problem).not.toContain(CANARY);
  });
});
