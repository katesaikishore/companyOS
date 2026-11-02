import { TwinAgent, type CaptureHitView, type CaptureSearchRequest, type Pipe, type PipeGate, type PipeOutput } from '@companyos/twin-core';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PIPE_TICK_MS, PipeScheduler, removeLegacyPipeFiles } from '../src/main/pipes';

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
  outputs: Array<{ pipeId: string; output: PipeOutput }>;
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
    outputs: [] as Array<{ pipeId: string; output: PipeOutput }>,
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
    storeOutput: (pipeId, output) => {
      h.outputs.push({ pipeId, output });
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

  it('runs nothing for a pipe that is off, and keeps nothing for it', async () => {
    const h = harness([{ ...notify, enabled: false }, { ...write, enabled: false }]);
    await h.tick();
    h.advance(60 * MINUTE);
    await h.tick();
    expect(runs(h)).toHaveLength(0);
    expect(h.outputs).toHaveLength(0);
  });

  it('does not run a pipe that is turned off while the gates are being read', async () => {
    let now = START;
    let pipes: Pipe[] = [notify];
    const notices: string[] = [];
    const scheduler = new PipeScheduler({
      now: () => now,
      pipes: () => pipes,
      gate: async () => {
        pipes = [{ ...notify, enabled: false }];
        return OPEN;
      },
      search: () => [hit('Slack')],
      notify: text => notices.push(text),
      storeOutput: () => undefined,
    });
    await scheduler.tick();
    now += 15 * MINUTE;
    await scheduler.tick();
    expect(notices).toEqual([]);
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
    expect(h.outputs.some(entry => entry.pipeId === 'write-0001')).toBe(true);
    // The failed pipe waits a full interval before it is tried again.
    h.advance(10 * MINUTE);
    await h.tick();
    expect(h.reports).toHaveLength(1);
  });

  it('reports a failing store as a fixed sentence with no text, and does not throw', async () => {
    let now = START;
    const reports: string[] = [];
    const scheduler = new PipeScheduler({
      now: () => now,
      pipes: () => [write],
      gate: async () => OPEN,
      search: () => [hit('Slack')],
      notify: () => undefined,
      storeOutput: () => {
        throw new Error(`disk gone ${ITEM_TEXT}`);
      },
      report: message => reports.push(message),
    });
    await scheduler.tick();
    // The first sight starts the wait, so the pipe runs one interval later.
    now += 30 * MINUTE;
    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(reports).toHaveLength(1);
    expect(reports[0]).not.toContain('SCHEDCANARY');
  });

  it('reports a check that fails as a fixed sentence, and does not throw', async () => {
    const reports: string[] = [];
    const scheduler = new PipeScheduler({
      now: () => START,
      pipes: () => {
        throw new Error(`bad list ${ITEM_TEXT}`);
      },
      gate: async () => OPEN,
      search: () => [],
      notify: () => undefined,
      storeOutput: () => undefined,
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
      storeOutput: () => undefined,
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

describe('PipeScheduler: notices and kept runs', () => {
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

  it('hands a write pipe its matches for the store on each run, with no notice', async () => {
    const h = harness([write]);
    await h.tick();
    h.advance(30 * MINUTE);
    await h.tick();
    expect(h.notices).toHaveLength(0);
    expect(h.outputs).toHaveLength(1);
    expect(h.outputs[0].pipeId).toBe('write-0001');
    expect(h.outputs[0].output.ranAt).toBe(START + 30 * MINUTE);
    expect(h.outputs[0].output.items.map(item => item.app)).toEqual(['Slack', 'Chrome']);
    expect(h.outputs[0].output.items.every(item => item.kind === 'screen' && item.text === ITEM_TEXT && item.ts === START)).toBe(true);
  });

  it('hands a write pipe an empty run when nothing matched, so the newest run replaces the one before', async () => {
    const h = harness([write]);
    h.hits = [];
    await h.tick();
    h.advance(30 * MINUTE);
    await h.tick();
    expect(h.outputs).toEqual([{ pipeId: 'write-0001', output: { ranAt: START + 30 * MINUTE, items: [] } }]);
  });

  it('hands a notify pipe nothing for the store', async () => {
    const h = harness([notify]);
    await h.tick();
    h.advance(15 * MINUTE);
    await h.tick();
    expect(h.outputs).toHaveLength(0);
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

describe('a pipe run writes no file under the data folder', () => {
  const folders: string[] = [];
  function tempFolder(): string {
    const folder = mkdtempSync(join(tmpdir(), 'screen-memory-userdata-'));
    folders.push(folder);
    return folder;
  }
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  /** Every file under a folder, at any depth. */
  function filesUnder(folder: string): string[] {
    return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
      const path = join(folder, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    });
  }

  it('keeps a write pipe run in the encrypted store, and leaves no file that holds its text', async () => {
    const userData = tempFolder();
    let now = START;
    // The agent's folder inside the data folder, as the desktop app opens it.
    const agent = new TwinAgent({ dataDir: join(userData, 'twin'), dataKey: randomBytes(32), now: () => now });
    try {
      agent.updateConfig({ pipes: [write], screenCaptureEnabled: true });
      agent.ingestScreen({ ts: START + 5 * MINUTE, app: 'Pages', windowClass: 'document', text: ITEM_TEXT, mediaId: null });
      const scheduler = new PipeScheduler({
        now: () => now,
        pipes: () => agent.configuration.pipes,
        gate: async () => OPEN,
        search: request => agent.searchCapture(request),
        notify: () => undefined,
        storeOutput: (pipeId, output) => {
          agent.storePipeOutput(pipeId, output);
        },
      });
      await scheduler.tick();
      now += 30 * MINUTE;
      await scheduler.tick();
      expect(agent.pipeOutputSummary(write.id)).toEqual({ count: 1, ranAt: now });
    } finally {
      agent.close();
    }
    const files = filesUnder(userData);
    // Names are taken relative to the data folder, so the folder's own name does not matter.
    const names = files.map(file => relative(userData, file));
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter(name => name.endsWith('.md') || name.endsWith('.md.tmp') || name.split(sep).includes('pipes'))).toEqual([]);
    for (const file of files) expect(readFileSync(file).includes('SCHEDCANARY')).toBe(false);
  });

  it('removes the plain-text pipe files of an earlier version, and does nothing when there are none', async () => {
    const userData = tempFolder();
    mkdirSync(join(userData, 'pipes'));
    writeFileSync(join(userData, 'pipes', 'write-0001.md'), `# Notes\n- ${ITEM_TEXT}\n`);
    await removeLegacyPipeFiles(userData);
    expect(existsSync(join(userData, 'pipes'))).toBe(false);
    await expect(removeLegacyPipeFiles(userData)).resolves.toBeUndefined();
  });
});
