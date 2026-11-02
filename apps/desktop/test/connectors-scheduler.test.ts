import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FOLDER_READ_FAILED_MESSAGE, GIT_NOT_REPOSITORY_MESSAGE } from '../src/main/connectors-local';
import {
  CALENDAR_MAX_BYTES,
  SOURCE_PATH_KIND_MESSAGE,
  STORE_FAILED_MESSAGE,
  runLocalSource,
} from '../src/main/connectors-runner';
import {
  CHECK_INTERVAL_MS,
  IMPORT_INTERVAL_MS,
  LocalConnectorService,
  SOURCE_FULL_MESSAGE,
  SOURCE_MISSING_MESSAGE,
  SOURCE_SAVE_MESSAGE,
  TASK_TIMEOUT_MESSAGE,
  TASK_TIMEOUT_MS,
  isImportDue,
  type ImportGate,
} from '../src/main/connectors-scheduler';
import { fakeAgent, type FakeAgent, type FakeSource } from './connectors-fake-agent';

/** Passes every call through to the real runner. A test can make one call never return, to model a stuck read. */
vi.mock('../src/main/connectors-runner', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/main/connectors-runner')>();
  return { ...actual, runLocalSource: vi.fn(actual.runLocalSource) };
});

const HOUR = 60 * 60_000;
/** A fixed start: 15 June 2026, 12:00 UTC. */
const START = Date.UTC(2026, 5, 15, 12);
const OPEN: ImportGate = { paused: false, locked: false, idle: false };
const made: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Waits for a condition the import makes true. The import reads files, so it takes a few turns of the event loop. */
async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('The condition did not hold in time.');
}

function folderWith(files: Record<string, string>): string {
  const root = tempDir('twin-sched-');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  return root;
}

function folderSource(id: string, path: string, extra: Partial<FakeSource> = {}): FakeSource {
  return { id, kind: 'folder', label: 'Notes', path, createdAt: START - 24 * HOUR, ...extra };
}

const ID = 'sched-source-0001';

function harness(sources: FakeSource[], gate: ImportGate = { ...OPEN }) {
  const agent = fakeAgent(sources);
  let now = START;
  const reports: string[] = [];
  const gateState = { ...gate };
  let gateReads = 0;
  const service = new LocalConnectorService({
    agent,
    now: () => now,
    gate: () => {
      gateReads += 1;
      return { ...gateState };
    },
    report: message => reports.push(message),
  });
  return {
    agent,
    service,
    reports,
    gateState,
    gateReads: () => gateReads,
    setNow: (value: number) => {
      now = value;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('isImportDue', () => {
  it('is due when a source was never read or tried', () => {
    expect(isImportDue({}, undefined, START)).toBe(true);
  });

  it('waits six hours from the last read, and is due at exactly six hours', () => {
    expect(isImportDue({ lastImportedAt: START - 6 * HOUR + 1 }, undefined, START)).toBe(false);
    expect(isImportDue({ lastImportedAt: START - 6 * HOUR }, undefined, START)).toBe(true);
  });

  it('waits from a failed try, so a source that failed is not read again in a loop', () => {
    expect(isImportDue({}, START - HOUR, START)).toBe(false);
    expect(isImportDue({}, START - 6 * HOUR, START)).toBe(true);
  });

  it('is due when the clock has moved back past the last read', () => {
    expect(isImportDue({ lastImportedAt: START + 3 * HOUR }, undefined, START)).toBe(true);
  });
});

describe('the scheduled check and its gates', () => {
  it('imports a due source when no gate holds it, and then waits six hours', async () => {
    const root = folderWith({ 'a.md': 'alpha' });
    const h = harness([folderSource(ID, root, { lastImportedAt: START - 7 * HOUR })]);

    await h.service.tick();
    await waitFor(() => h.agent.itemsOf(ID).length === 1);
    expect(h.agent.sources()[0]?.lastImportedAt).toBe(START);

    h.advance(5 * HOUR);
    await h.service.tick();
    expect(h.agent.ingestCalls).toBe(1);

    h.advance(HOUR);
    await h.service.tick();
    await waitFor(() => h.agent.ingestCalls === 2);
  });

  it('does not read at all while capture is paused, the screen is locked, or the person is away', async () => {
    const root = folderWith({ 'a.md': 'alpha' });
    for (const hold of ['paused', 'locked', 'idle'] as const) {
      const h = harness([folderSource(ID, root, { lastImportedAt: START - 7 * HOUR })], { ...OPEN, [hold]: true });
      await h.service.tick();
      expect(h.agent.ingestCalls).toBe(0);
      expect(h.agent.sources()[0]?.lastImportedAt).toBe(START - 7 * HOUR);
    }
  });

  it('takes the held import at the first check the gate allows, not six hours later', async () => {
    const root = folderWith({ 'a.md': 'alpha' });
    const h = harness([folderSource(ID, root, { lastImportedAt: START - 7 * HOUR })], { ...OPEN, paused: true });
    await h.service.tick();
    expect(h.agent.ingestCalls).toBe(0);

    h.gateState.paused = false;
    h.advance(30 * 60_000);
    await h.service.tick();
    await waitFor(() => h.agent.ingestCalls === 1);
  });

  it('reads the gate again before each source, so a pause between two sources holds the second', async () => {
    const first = folderWith({ 'a.md': 'alpha' });
    const second = folderWith({ 'b.md': 'beta' });
    const h = harness([
      folderSource('sched-source-0001', first, { lastImportedAt: START - 7 * HOUR }),
      folderSource('sched-source-0002', second, { lastImportedAt: START - 7 * HOUR }),
    ]);
    h.agent.beforeIngest = () => {
      h.gateState.paused = true;
    };

    await h.service.tick();
    await waitFor(() => h.agent.itemsOf('sched-source-0001').length === 1);
    expect(h.agent.itemsOf('sched-source-0002')).toHaveLength(0);
    expect(h.agent.ingestCalls).toBe(1);
  });

  it('does not run a second check while one is still running', async () => {
    const root = folderWith({ 'a.md': 'alpha' });
    const h = harness([folderSource(ID, root, { lastImportedAt: START - 7 * HOUR })]);
    const one = h.service.tick();
    const two = h.service.tick();
    await Promise.all([one, two]);
    expect(h.gateReads()).toBe(1);
    await waitFor(() => h.agent.ingestCalls === 1);
  });

  it('waits after a failed read before it tries again, and reports only a fixed sentence', async () => {
    const root = folderWith({ 'a.md': 'alpha' });
    const h = harness([folderSource(ID, root, { lastImportedAt: START - 7 * HOUR })]);
    rmSync(root, { recursive: true, force: true });

    await h.service.tick();
    await waitFor(() => h.reports.length === 1);
    expect(h.reports[0]).toBe(FOLDER_READ_FAILED_MESSAGE);

    h.advance(HOUR);
    await h.service.tick();
    expect(h.reports).toHaveLength(1);

    h.advance(5 * HOUR);
    await h.service.tick();
    await waitFor(() => h.reports.length === 2);
  });

  it('starts a timer that checks every thirty minutes, and stops it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const root = folderWith({ 'a.md': 'alpha' });
    const h = harness([folderSource(ID, root, { lastImportedAt: START - 7 * HOUR })], { ...OPEN, paused: true });

    h.service.start();
    vi.advanceTimersByTime(CHECK_INTERVAL_MS - 1);
    expect(h.gateReads()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(h.gateReads()).toBe(1);

    h.service.stop();
    vi.advanceTimersByTime(CHECK_INTERVAL_MS * 4);
    expect(h.gateReads()).toBe(1);
  });

  it('uses the six-hour interval the scheduler documents', () => {
    expect(IMPORT_INTERVAL_MS).toBe(6 * HOUR);
    expect(CHECK_INTERVAL_MS).toBe(30 * 60_000);
  });
});

describe('the task queue', () => {
  const OTHER = 'sched-source-0002';
  /** Lets the queued work start: its time limit is set on the first turn after it is queued. */
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));

  it('stops an import that never returns, so the next action still runs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const one = folderWith({ 'a.md': 'alpha' });
    const two = folderWith({ 'b.md': 'beta' });
    const h = harness([folderSource(ID, one), folderSource(OTHER, two)]);
    vi.mocked(runLocalSource).mockImplementationOnce(() => new Promise<never>(() => {}));

    const stuck = h.service.importNow(ID).then(
      () => 'stored',
      (error: Error) => error.message,
    );
    const next = h.service.importNow(OTHER);
    await settle();
    await vi.advanceTimersByTimeAsync(TASK_TIMEOUT_MS);

    await expect(stuck).resolves.toBe(TASK_TIMEOUT_MESSAGE);
    await expect(next).resolves.toBe(1);
  });

  it('clears the check flag when an import never returns, so the next check runs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const root = folderWith({ 'a.md': 'alpha' });
    const h = harness([folderSource(ID, root, { lastImportedAt: START - 7 * HOUR })]);
    vi.mocked(runLocalSource).mockImplementationOnce(() => new Promise<never>(() => {}));

    const first = h.service.tick();
    await settle();
    await vi.advanceTimersByTimeAsync(TASK_TIMEOUT_MS);
    await first;
    expect(h.reports).toEqual([TASK_TIMEOUT_MESSAGE]);

    h.advance(IMPORT_INTERVAL_MS);
    const readsBefore = h.gateReads();
    await h.service.tick();
    expect(h.gateReads()).toBe(readsBefore + 1);
    expect(h.agent.itemsOf(ID)).toHaveLength(1);
  });
});

describe('the actions', () => {
  it('reads a source now even while capture is paused, because the person asked for it', async () => {
    const root = folderWith({ 'a.md': 'alpha', 'b.md': 'beta' });
    const h = harness([folderSource(ID, root)], { ...OPEN, paused: true, locked: true, idle: true });

    await expect(h.service.importNow(ID)).resolves.toBe(2);
    expect(h.service.lastCounts()).toEqual({ [ID]: 2 });
  });

  it('refuses to read a source that is not saved, with a fixed sentence', async () => {
    const h = harness([]);
    await expect(h.service.importNow(ID)).rejects.toThrow(SOURCE_MISSING_MESSAGE);
  });

  it('adds a folder: one read, a label from its name, and the time it was read', async () => {
    const root = folderWith({ 'a.md': 'alpha', 'b.txt': 'beta' });
    const h = harness([]);

    await expect(h.service.addSource('folder', root)).resolves.toBe(2);

    const [added] = h.agent.sources();
    expect(added?.id).toMatch(/^[0-9a-f]{32}$/);
    expect(added?.kind).toBe('folder');
    expect(added?.path).toBe(root);
    expect(added?.label).toBe(root.split(/[\\/]/).pop());
    expect(added?.createdAt).toBe(START);
    expect(added?.lastImportedAt).toBe(START);
    expect(h.agent.itemsOf(added?.id ?? '')).toHaveLength(2);
  });

  it('labels a mail archive by its file name', async () => {
    const dir = tempDir('twin-label-');
    const mbox = join(dir, 'Inbox');
    writeFileSync(mbox, '');
    const h = harness([]);
    await h.service.addSource('mail', mbox);
    expect(h.agent.sources()[0]?.label).toBe('Inbox');
  });

  it('does not keep a source whose first read fails, and leaves no items behind', async () => {
    const plain = folderWith({ 'a.md': 'alpha' });
    const h = harness([]);

    await expect(h.service.addSource('git', plain)).rejects.toThrow(GIT_NOT_REPOSITORY_MESSAGE);
    expect(h.agent.sources()).toHaveLength(0);
  });

  it('does not keep a source whose items cannot be stored, and says so with its own sentence', async () => {
    const root = folderWith({ 'a.md': 'alpha' });
    const h = harness([]);
    h.agent.failIngest = true;

    await expect(h.service.addSource('folder', root)).rejects.toThrow(STORE_FAILED_MESSAGE);
    expect(h.agent.sources()).toHaveLength(0);
  });

  it('refuses a path of the wrong kind before saving anything', async () => {
    const root = folderWith({ 'a.md': 'alpha' });
    const h = harness([]);
    await expect(h.service.addSource('folder', join(root, 'a.md'))).rejects.toThrow(SOURCE_PATH_KIND_MESSAGE);
    expect(h.agent.sources()).toHaveLength(0);
  });

  it('refuses a calendar file over its size limit before saving anything', async () => {
    const dir = tempDir('twin-big-cal-');
    const ics = join(dir, 'big.ics');
    writeFileSync(ics, '');
    truncateSync(ics, CALENDAR_MAX_BYTES + 1);
    const h = harness([]);
    await expect(h.service.addSource('calendar', ics)).rejects.toThrow('The calendar file is larger than 10 MB');
    expect(h.agent.sources()).toHaveLength(0);
  });

  it('refuses a twenty-first source with a fixed sentence', async () => {
    const twenty = Array.from({ length: 20 }, (_, index) => folderSource(`sched-fill-${String(index).padStart(4, '0')}`, '/unused'));
    const root = folderWith({ 'a.md': 'alpha' });
    const h = harness(twenty);
    await expect(h.service.addSource('folder', root)).rejects.toThrow(SOURCE_FULL_MESSAGE);
    expect(h.agent.sources()).toHaveLength(20);
  });

  it('reports a failed save with a fixed sentence, whatever the engine said', async () => {
    const root = folderWith({ 'a.md': 'alpha' });
    const h = harness([]);
    h.agent.updateConfig = () => {
      throw new Error(`invalid value at ${root}`);
    };
    const failure = h.service.addSource('folder', root);
    await expect(failure).rejects.toThrow(SOURCE_SAVE_MESSAGE);
    await expect(failure).rejects.not.toThrow(root);
  });

  it('removes a source with its items, and leaves the other sources as they were', async () => {
    const one = folderWith({ 'a.md': 'alpha' });
    const two = folderWith({ 'b.md': 'beta' });
    const h = harness([folderSource(ID, one), folderSource('sched-source-0002', two)]);
    await h.service.importNow(ID);
    await h.service.importNow('sched-source-0002');

    await h.service.removeSource(ID);

    expect(h.agent.sources().map(source => source.id)).toEqual(['sched-source-0002']);
    expect(h.agent.itemsOf(ID)).toHaveLength(0);
    expect(h.agent.itemsOf('sched-source-0002')).toHaveLength(1);
    expect(h.service.lastCounts()).toEqual({ 'sched-source-0002': 1 });
  });

  it('rejects removing a source that is not saved', async () => {
    const h = harness([]);
    await expect(h.service.removeSource(ID)).rejects.toThrow(SOURCE_MISSING_MESSAGE);
  });

  it('waits for an import that is running before it removes the source, so no item is left behind', async () => {
    const root = folderWith({ 'a.md': 'alpha', 'b.md': 'beta' });
    const h = harness([folderSource(ID, root)]);

    const importing = h.service.importNow(ID);
    const removing = h.service.removeSource(ID);
    await Promise.allSettled([importing, removing]);

    expect(h.agent.sources()).toHaveLength(0);
    expect(h.agent.itemsOf(ID)).toHaveLength(0);
  });
});
