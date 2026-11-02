import type { CaptureHitView, CaptureSearchRequest, Pipe, PipeGate } from '@companyos/twin-core';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PIPE_TICK_MS, PipeScheduler, pipeOutputFolder, pruneOutputs, writePipeOutput } from '../src/main/pipes';

const MINUTE = 60_000;
const START = Date.UTC(2026, 10, 2, 9, 0);
const OPEN: PipeGate = { automationsEnabled: true, paused: false, locked: false, idle: false, secureInput: false };
/** Stored text the fake search returns. The tests check that it never reaches a notice. */
const ITEM_TEXT = 'SCHEDCANARY 4417 budget words';

const notify: Pipe = {
  id: 'notify-0001',
  name: 'Standup',
  query: 'budget',
  intervalMinutes: 15,
  action: 'notify',
  enabled: true,
};
const write: Pipe = { ...notify, id: 'write-0001', name: 'Notes', action: 'write', intervalMinutes: 30 };

function hit(app: string, snippet: string = ITEM_TEXT): CaptureHitView {
  return { kind: 'screen', id: 'b'.repeat(32), ts: START, app, snippet };
}

interface Harness {
  scheduler: PipeScheduler;
  pipes: Pipe[];
  gate: PipeGate;
  hits: CaptureHitView[];
  searches: CaptureSearchRequest[];
  notices: string[];
  writes: Map<string, string>;
  pruned: string[][];
  reports: string[];
  pipesCalls: number;
  gateCalls: number;
  advance(ms: number): void;
  tick(): Promise<void>;
}

/** The searches that are a run. A run searches the screen first, so each run has one screen search. */
function runs(h: Harness): CaptureSearchRequest[] {
  return h.searches.filter(request => request.kind === 'screen');
}

function harness(pipes: Pipe[], options: { search?: (request: CaptureSearchRequest) => CaptureHitView[] } = {}): Harness {
  let now = START;
  const h = {
    pipes,
    gate: OPEN,
    hits: [hit('Slack'), hit('Chrome')] as CaptureHitView[],
    searches: [] as CaptureSearchRequest[],
    notices: [] as string[],
    writes: new Map<string, string>(),
    pruned: [] as string[][],
    reports: [] as string[],
    pipesCalls: 0,
    gateCalls: 0,
  } as Harness;
  // Filters by kind, as the engine does. A pipe with no kind is searched once for each kind, so one run is two searches.
  const search = options.search ?? (request => {
    h.searches.push(request);
    return h.hits.filter(hit => request.kind === undefined || hit.kind === request.kind);
  });
  h.scheduler = new PipeScheduler({
    now: () => now,
    pipes: () => {
      h.pipesCalls += 1;
      return h.pipes;
    },
    gate: async () => {
      h.gateCalls += 1;
      return h.gate;
    },
    search,
    notify: text => h.notices.push(text),
    writeOutput: async (pipeId, markdown) => {
      h.writes.set(pipeId, markdown);
    },
    pruneOutputs: async keep => {
      h.pruned.push([...keep]);
    },
    report: message => h.reports.push(message),
  });
  h.advance = ms => {
    now += ms;
  };
  h.tick = () => h.scheduler.tick();
  return h;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('PipeScheduler: due logic', () => {
  it('waits one interval after it first sees a pipe, then runs it', async () => {
    const h = harness([notify]);
    await h.tick();
    h.advance(14 * MINUTE);
    await h.tick();
    expect(runs(h)).toHaveLength(0);
    h.advance(MINUTE);
    await h.tick();
    expect(runs(h)).toHaveLength(1);
    // The first window starts just after the time the pipe was first seen, not at the start of the stored history.
    expect(runs(h)[0]).toMatchObject({ text: 'budget', from: START + 1, to: START + 15 * MINUTE });
  });

  it('runs again one interval after its last run, with a window from that run', async () => {
    const h = harness([notify]);
    await h.tick();
    h.advance(15 * MINUTE);
    await h.tick();
    h.advance(14 * MINUTE);
    await h.tick();
    expect(runs(h)).toHaveLength(1);
    h.advance(MINUTE);
    await h.tick();
    expect(runs(h)).toHaveLength(2);
    expect(runs(h)[1]).toMatchObject({ from: START + 15 * MINUTE + 1, to: START + 30 * MINUTE });
  });

  it('runs nothing for a pipe that is off, and keeps no file for it', async () => {
    const h = harness([{ ...notify, enabled: false }]);
    await h.tick();
    h.advance(60 * MINUTE);
    await h.tick();
    expect(runs(h)).toHaveLength(0);
    expect(h.pruned.every(keep => keep.length === 0)).toBe(true);
  });
});

describe('PipeScheduler: gates and failures', () => {
  it('holds a due pipe while a gate is closed, and runs it at the first check that is open', async () => {
    const h = harness([notify]);
    await h.tick();
    h.advance(15 * MINUTE);
    h.gate = { ...OPEN, paused: true };
    await h.tick();
    expect(runs(h)).toHaveLength(0);
    expect(h.notices).toHaveLength(0);
    h.gate = OPEN;
    await h.tick();
    expect(runs(h)).toHaveLength(1);
    // Nothing ran during the wait, so the window still starts at the first sight of the pipe.
    expect(runs(h)[0].from).toBe(START + 1);
  });

  it('holds pipes while secure input cannot be checked, and while a password field may have focus', async () => {
    const h = harness([notify]);
    await h.tick();
    h.advance(15 * MINUTE);
    h.gate = { ...OPEN, secureInput: 'unknown' };
    await h.tick();
    h.gate = { ...OPEN, secureInput: true };
    await h.tick();
    expect(runs(h)).toHaveLength(0);
    h.gate = OPEN;
    await h.tick();
    expect(runs(h)).toHaveLength(1);
  });

  it('does not read the gates at all while no pipe is due', async () => {
    const h = harness([notify]);
    await h.tick();
    await h.tick();
    expect(h.gateCalls).toBe(0);
  });

  it('logs a failing pipe as a fixed sentence with no text, and the other pipes still run', async () => {
    const h = harness([{ ...notify, query: 'broken' }, write], {
      search: request => {
        if (request.text === 'broken') throw new Error(`failed on ${ITEM_TEXT}`);
        return [hit('Slack')];
      },
    });
    await h.tick();
    h.advance(30 * MINUTE);
    await h.tick();
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).not.toContain('SCHEDCANARY');
    expect(h.reports[0]).not.toContain('4417');
    expect(h.writes.has('write-0001')).toBe(true);
    // The failed pipe waits a full interval before it is tried again.
    h.advance(10 * MINUTE);
    await h.tick();
    expect(h.reports).toHaveLength(1);
  });

  it('reports a check that fails as a fixed sentence, and does not throw', async () => {
    const reports: string[] = [];
    const scheduler = new PipeScheduler({
      now: () => START,
      pipes: () => [notify],
      gate: async () => OPEN,
      search: () => [],
      notify: () => undefined,
      writeOutput: async () => undefined,
      pruneOutputs: async () => {
        throw new Error('disk gone SCHEDCANARY');
      },
      report: message => reports.push(message),
    });
    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(reports).toHaveLength(1);
    expect(reports[0]).not.toContain('SCHEDCANARY');
  });

  it('does not start a second check while one is still running', async () => {
    let now = START;
    let release: () => void = () => undefined;
    const waiting = new Promise<PipeGate>(resolve => {
      release = () => resolve(OPEN);
    });
    const gate = vi.fn(() => waiting);
    const scheduler = new PipeScheduler({
      now: () => now,
      pipes: () => [notify],
      gate,
      search: () => [],
      notify: () => undefined,
      writeOutput: async () => undefined,
      pruneOutputs: async () => undefined,
    });
    await scheduler.tick();
    now += 15 * MINUTE;
    const first = scheduler.tick();
    // The first check is waiting on the gate, so this one returns at once and reads nothing.
    await scheduler.tick();
    release();
    await first;
    expect(gate).toHaveBeenCalledTimes(1);
  });
});

describe('PipeScheduler: notices and files', () => {
  it('shows a notice with the count and app names, and never the stored text', async () => {
    const h = harness([notify]);
    await h.tick();
    h.advance(15 * MINUTE);
    await h.tick();
    expect(h.notices).toEqual(['Standup: 2 new matches in Slack, Chrome.']);
    for (const secret of ['SCHEDCANARY', '4417', 'budget words']) expect(h.notices.join('\n')).not.toContain(secret);
  });

  it('shows no notice when nothing matched', async () => {
    const h = harness([notify]);
    h.hits = [];
    await h.tick();
    h.advance(15 * MINUTE);
    await h.tick();
    expect(runs(h)).toHaveLength(1);
    expect(h.notices).toHaveLength(0);
  });

  it('writes a write pipe to its file on each run, with no notice', async () => {
    const h = harness([write]);
    await h.tick();
    h.advance(30 * MINUTE);
    await h.tick();
    expect(h.notices).toHaveLength(0);
    expect(h.writes.get('write-0001')).toContain(ITEM_TEXT);
    expect(h.pruned.at(-1)).toEqual(['write-0001']);
  });

  it('keeps the files of enabled write pipes only, and prunes the rest on every check', async () => {
    const off = { ...write, id: 'write-0002', enabled: false };
    const h = harness([write, off, notify]);
    await h.tick();
    expect(h.pruned).toEqual([['write-0001']]);
    h.pipes = [];
    await h.tick();
    expect(h.pruned).toEqual([['write-0001'], []]);
  });

  it('forgets a removed pipe, so one added again with the same id waits from its new first sight', async () => {
    const h = harness([notify]);
    await h.tick();
    h.advance(15 * MINUTE);
    await h.tick();
    expect(runs(h)).toHaveLength(1);
    h.pipes = [];
    await h.tick();
    h.advance(MINUTE);
    h.pipes = [notify];
    await h.tick();
    h.advance(14 * MINUTE);
    await h.tick();
    expect(runs(h)).toHaveLength(1);
  });
});

describe('PipeScheduler: timer', () => {
  it('checks once each minute while started, and checks nothing after stop', async () => {
    vi.useFakeTimers();
    const h = harness([]);
    h.scheduler.start();
    await vi.advanceTimersByTimeAsync(PIPE_TICK_MS * 3);
    expect(h.pipesCalls).toBe(3);
    h.scheduler.stop();
    await vi.advanceTimersByTimeAsync(PIPE_TICK_MS * 5);
    expect(h.pipesCalls).toBe(3);
  });

  it('starts only once, however many times start is called', async () => {
    vi.useFakeTimers();
    const h = harness([]);
    h.scheduler.start();
    h.scheduler.start();
    await vi.advanceTimersByTimeAsync(PIPE_TICK_MS);
    expect(h.pipesCalls).toBe(1);
    h.scheduler.stop();
  });
});

describe('pipe files in the data folder', () => {
  const folders: string[] = [];
  function tempFolder(): string {
    const folder = mkdtempSync(join(tmpdir(), 'pipes-test-'));
    folders.push(folder);
    return folder;
  }
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  it('keeps the pipes folder inside the data folder', () => {
    const userData = tempFolder();
    expect(pipeOutputFolder(userData)).toBe(join(userData, 'pipes'));
  });

  it('writes one file per pipe, replaces it on the next run, and leaves no temporary file behind', async () => {
    const folder = join(tempFolder(), 'pipes');
    await writePipeOutput(folder, 'write-0001', '# first\n');
    await writePipeOutput(folder, 'write-0001', '# second\n');
    expect(readFileSync(join(folder, 'write-0001.md'), 'utf8')).toBe('# second\n');
    expect(readdirSync(folder)).toEqual(['write-0001.md']);
    if (process.platform !== 'win32') expect(statSync(join(folder, 'write-0001.md')).mode & 0o777).toBe(0o600);
  });

  it('refuses an id that could leave the folder, and writes nothing', async () => {
    const root = tempFolder();
    const folder = join(root, 'pipes');
    await expect(writePipeOutput(folder, '../escape-me', 'x')).rejects.toThrow(/file name/);
    await expect(writePipeOutput(folder, 'a/b/c/d/e/f/g/h', 'x')).rejects.toThrow(/file name/);
    expect(existsSync(join(root, 'escape-me.md'))).toBe(false);
  });

  it('removes files that the kept ids do not name, and does nothing when the folder is missing', async () => {
    const folder = join(tempFolder(), 'pipes');
    await expect(pruneOutputs(folder, new Set())).resolves.toBeUndefined();
    await writePipeOutput(folder, 'keep-0001', 'kept');
    await writePipeOutput(folder, 'drop-0001', 'dropped');
    writeFileSync(join(folder, 'drop-0001.md.tmp'), 'half');
    mkdirSync(join(folder, 'stray'));
    await pruneOutputs(folder, new Set(['keep-0001']));
    expect(readdirSync(folder)).toEqual(['keep-0001.md']);
    await pruneOutputs(folder, new Set());
    expect(readdirSync(folder)).toEqual([]);
  });
});
