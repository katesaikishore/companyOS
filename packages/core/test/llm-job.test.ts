import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONFIG,
  NAMING_TIMING,
  RoutineNamingJob,
  mineRoutines,
  normalizeSignal,
  segment,
  type InstalledModel,
  type NamingModel,
  type Routine,
  type TwinEvent,
} from '../src';
import { workdays } from './fixtures';

afterEach(() => {
  vi.useRealTimers();
});

function minedRoutines(): Routine[] {
  const events = workdays(10)
    .map(signal => normalizeSignal(signal, { excludedApps: DEFAULT_CONFIG.excludedApps, watchBrowsers: true }))
    .filter((event): event is TwinEvent => event !== null);
  return mineRoutines(segment(events, DEFAULT_CONFIG.idleGapMs));
}

const installed = (id: string): InstalledModel => ({ id, sha256: 'a'.repeat(64), bytes: 1, installedAt: 1 });

/** A fake model that counts what it is asked, and answers from a script. */
function fakeModel(answer: (call: number) => unknown): NamingModel & { calls: number; warms: number; stops: number } {
  const model = {
    calls: 0,
    warms: 0,
    stops: 0,
    complete: async () => {
      model.calls++;
      return answer(model.calls);
    },
    warm: async () => {
      model.warms++;
    },
    stop: () => {
      model.stops++;
    },
  };
  return model;
}

interface HarnessOptions {
  answer?: (call: number) => unknown;
  installed?: boolean;
  verified?: boolean;
  allowed?: boolean;
  routines?: () => Routine[];
  warmFails?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const renames: Array<{ id: string; name: string }> = [];
  const opened: string[] = [];
  const verified: string[] = [];
  const counters = { changes: 0 };
  const state = { allowed: options.allowed ?? true, routines: minedRoutines() };
  const model = fakeModel(options.answer ?? (() => ({ name: 'Monthly invoice check' })));
  if (options.warmFails) {
    model.warm = async () => {
      throw new Error('could not load');
    };
  }
  const job = new RoutineNamingJob({
    routines: options.routines ?? (() => state.routines),
    rename: (id, name) => renames.push({ id, name }),
    installed: () => (options.installed === false ? [] : [installed('qwen3-4b')]),
    preferredModelId: async () => 'qwen3-4b',
    modelPath: spec => `/models/${spec.file}`,
    verify: async spec => {
      verified.push(spec.id);
      return options.verified ?? true;
    },
    openModel: path => {
      opened.push(path);
      return model;
    },
    allowed: () => state.allowed,
    changed: () => {
      counters.changes++;
    },
  });
  return { job, model, renames, opened, verified, state, counters };
}

describe('RoutineNamingJob', () => {
  it('names each routine with the model, tells the engine, and loads the model once', async () => {
    const h = harness();
    const routines = h.state.routines;
    expect(routines.length).toBeGreaterThan(0);

    await h.job.pass();

    expect(h.renames.map(rename => rename.id)).toEqual(routines.map(routine => routine.id));
    expect(h.renames.every(rename => rename.name === 'Monthly invoice check')).toBe(true);
    expect(h.model.warms).toBe(1);
    expect(h.opened).toEqual(['/models/Qwen3-4B-Q4_K_M.gguf']);
    expect(h.counters.changes).toBe(1);
  });

  it('does nothing without an installed chat model', async () => {
    const h = harness({ installed: false });
    await h.job.pass();
    expect(h.opened).toEqual([]);
    expect(h.model.calls).toBe(0);
    expect(h.renames).toEqual([]);
  });

  it('loads nothing and names nothing while model work is not allowed', async () => {
    const h = harness({ allowed: false });
    await h.job.pass();
    expect(h.opened).toEqual([]);
    expect(h.model.calls).toBe(0);

    h.state.allowed = true;
    await h.job.pass();
    expect(h.renames.length).toBeGreaterThan(0);
  });

  it('asks about each routine once while its apps stay the same', async () => {
    const h = harness();
    await h.job.pass();
    const first = h.model.calls;
    await h.job.pass();
    expect(h.model.calls).toBe(first);
  });

  it('names a routine again when the apps it was seen with change', async () => {
    const h = harness();
    await h.job.pass();
    const before = h.model.calls;

    const changed = structuredClone(h.state.routines);
    changed[0].steps[0].options = [...changed[0].steps[0].options, 'libreoffice calc'];
    h.state.routines = changed;
    await h.job.pass();

    expect(h.model.calls).toBe(before + 1);
  });

  it('keeps the rule-based name for output that is not a valid name, and does not ask again', async () => {
    const h = harness({ answer: () => ({ name: '' }) });
    await h.job.pass();
    expect(h.renames).toEqual([]);
    const asked = h.model.calls;
    expect(asked).toBe(h.state.routines.length);
    await h.job.pass();
    expect(h.model.calls).toBe(asked);
  });

  it('stops a pass when the model fails, and schedules another pass', async () => {
    vi.useFakeTimers();
    const h = harness({
      answer: call => {
        if (call === 1) throw new Error('model busy');
        return { name: 'Recovered name' };
      },
    });
    await h.job.pass();
    expect(h.model.calls).toBe(1);
    expect(h.renames).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
    await h.job.pass();
    expect(h.renames.length).toBeGreaterThan(0);
  });

  it('schedules a pass soon when model work is not allowed', async () => {
    vi.useFakeTimers();
    const h = harness({ allowed: false });
    await h.job.pass();
    expect(vi.getTimerCount()).toBe(1);
    expect(NAMING_TIMING.retryMs).toBeLessThan(NAMING_TIMING.passIntervalMs);
  });

  it('does not open a model whose file does not verify', async () => {
    const h = harness({ verified: false });
    await h.job.pass();
    expect(h.verified).toEqual(['qwen3-4b']);
    expect(h.opened).toEqual([]);
    expect(h.renames).toEqual([]);
  });

  it('checks a model file once, however many passes run', async () => {
    const h = harness();
    await h.job.pass();
    await h.job.pass();
    expect(h.verified).toEqual(['qwen3-4b']);
  });

  it('keeps the rule-based names when the model cannot be loaded', async () => {
    const h = harness({ warmFails: true });
    await h.job.pass();
    expect(h.renames).toEqual([]);
    expect(h.model.calls).toBe(0);
  });

  it('refuses a pass that starts while another is running', async () => {
    const h = harness();
    await Promise.all([h.job.pass(), h.job.pass()]);
    expect(h.model.warms).toBe(1);
  });

  it('never throws, even when the engine cannot list its routines', async () => {
    const h = harness({
      routines: () => {
        throw new Error('routine data is malformed');
      },
    });
    await expect(h.job.pass()).resolves.toBeUndefined();
    expect(h.renames).toEqual([]);
  });

  it('stop() frees the model and ends passing', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.job.start();
    expect(vi.getTimerCount()).toBe(1);
    await h.job.pass();
    expect(h.model.stops).toBe(0);

    h.job.stop();
    expect(h.model.stops).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    const asked = h.model.calls;
    await h.job.pass();
    expect(h.model.calls).toBe(asked);
  });
});
