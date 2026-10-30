import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  TwinAgent,
  compileRoutine,
  effectsOf,
  evaluateStep,
  mineRoutines,
  normalizeSignal,
  resolveApp,
  runAutomation,
  segment,
  type Automation,
  type Executor,
  type PolicyContext,
  type TwinEvent,
} from '../src';
import { at, workdays } from './fixtures';

const EXCLUDED = ['1password'];
const ctx = (overrides: Partial<PolicyContext> = {}): PolicyContext => ({
  level: 3,
  maxLevel: 4,
  unattended: false,
  excludedApps: EXCLUDED,
  ...overrides,
});

function compiled(): Automation {
  const events: TwinEvent[] = workdays(10)
    .map((signal, index) => normalizeSignal(signal, { excludedApps: EXCLUDED, watchBrowsers: true, newId: () => `e${index}` }))
    .filter((event): event is TwinEvent => event !== null);
  const routine = mineRoutines(segment(events, 60 * 60_000)).find(r => r.steps.length === 4);
  if (!routine) throw new Error('fixture routine not found');
  return compileRoutine(routine);
}

function fakeExecutor(frontmost: () => string | undefined): Executor & { focus: ReturnType<typeof vi.fn> } {
  let current: string | undefined;
  const focus = vi.fn(async (app: string) => {
    current = app;
    return true;
  });
  return { focus, focusApp: focus, frontmostApp: async () => frontmost() ?? current };
}

describe('compileRoutine', () => {
  it('turns each position into a focus and a postcondition check', () => {
    const automation = compiled();
    expect(automation.steps).toHaveLength(8);
    expect(automation.steps[0]).toEqual({ op: 'focus_app', app: '$p0' });
    expect(automation.steps[1]).toEqual({ op: 'check_focus', app: '$p0' });
    expect(automation.steps[2]).toEqual({ op: 'focus_app', app: 'microsoft outlook' });
  });

  it('makes only variable positions parameters', () => {
    const automation = compiled();
    expect(automation.params.map(p => p.name)).toEqual(['p0']);
    expect(automation.params[0].default).toBe('microsoft excel');
  });

  it('classifies effects across all options', () => {
    expect(effectsOf(compiled()).sort()).toEqual(['external_effect', 'read_only']);
  });
});

describe('resolveApp', () => {
  const params = [{ name: 'p0', options: ['microsoft excel', 'libreoffice calc'], default: 'microsoft excel' }];

  it('uses an observed option and rejects anything else', () => {
    expect(resolveApp('$p0', params, { p0: 'libreoffice calc' })).toBe('libreoffice calc');
    expect(() => resolveApp('$p0', params, { p0: 'rm -rf' })).toThrow(/not an observed option/);
    expect(() => resolveApp('$p9', params, {})).toThrow(/Unknown parameter/);
  });
});

describe('evaluateStep', () => {
  const focusSlack = { op: 'focus_app' as const, app: 'slack' };
  const focusSheet = { op: 'focus_app' as const, app: 'microsoft excel' };

  it('always denies excluded apps', () => {
    expect(evaluateStep({ op: 'focus_app', app: '1password' }, ctx({ level: 4, unattended: true }))).toMatchObject({
      decision: 'deny',
    });
  });

  it('draft level never executes', () => {
    expect(evaluateStep(focusSheet, ctx({ level: 2 })).decision).toBe('deny');
  });

  it('asks before any external effect, supervised', () => {
    expect(evaluateStep(focusSlack, ctx({ level: 3 }))).toMatchObject({ decision: 'ask', effect: 'external_effect' });
  });

  it('allows local read-only steps at level 3 with a person present', () => {
    expect(evaluateStep(focusSheet, ctx({ level: 3 })).decision).toBe('allow');
  });

  it('denies unattended runs below level 4, and any unattended external effect', () => {
    expect(evaluateStep(focusSheet, ctx({ level: 3, unattended: true })).decision).toBe('deny');
    expect(evaluateStep(focusSlack, ctx({ level: 4, unattended: true })).decision).toBe('deny');
    expect(evaluateStep(focusSheet, ctx({ level: 4, unattended: true })).decision).toBe('allow');
  });

  it('keeps level 5 out of this version', () => {
    expect(evaluateStep(focusSheet, ctx({ level: 5, maxLevel: 5 })).decision).toBe('deny');
  });
});

describe('runAutomation', () => {
  it('dry run never calls the executor and previews approvals', async () => {
    const executor = fakeExecutor(() => undefined);
    const result = await runAutomation(compiled(), { mode: 'dry_run', policy: ctx({ level: 2 }) }, executor);
    expect(result.status).toBe('dry_run');
    expect(executor.focus).not.toHaveBeenCalled();
    expect(result.steps.some(s => s.reason.includes('external_effect needs your confirmation'))).toBe(true);
  });

  it('supervised run blocks when an approval is refused', async () => {
    const executor = fakeExecutor(() => undefined);
    const result = await runAutomation(
      compiled(),
      { mode: 'supervised', policy: ctx(), values: {}, approve: async () => false },
      executor,
    );
    expect(result.status).toBe('blocked');
  });

  it('supervised run completes when each ask is approved and postconditions pass', async () => {
    const executor = fakeExecutor(() => undefined);
    const approve = vi.fn(async () => true);
    const result = await runAutomation(compiled(), { mode: 'supervised', policy: ctx(), approve }, executor);
    expect(result.status).toBe('completed');
    expect(approve).toHaveBeenCalledTimes(2);
    expect(result.postconditionsPassed).toBe(4);
    expect(result.postconditionsFailed).toBe(0);
  });

  it('stops and records a failed postcondition', async () => {
    const executor: Executor = {
      focusApp: async () => true,
      frontmostApp: async () => 'some other app',
    };
    const result = await runAutomation(compiled(), { mode: 'supervised', policy: ctx(), approve: async () => true }, executor);
    expect(result.status).toBe('failed');
    expect(result.postconditionsFailed).toBe(1);
  });

  it('unattended run never asks, and blocks anything that needs a person', async () => {
    const executor = fakeExecutor(() => undefined);
    const result = await runAutomation(
      compiled(),
      { mode: 'unattended', policy: ctx({ level: 4, unattended: true }) },
      executor,
    );
    expect(result.status).toBe('blocked');
  });
});

describe('run safety', () => {
  it('checks parameter values before the first step, so a bad value runs nothing', async () => {
    const executor = fakeExecutor(() => undefined);
    await expect(
      runAutomation(compiled(), { mode: 'supervised', policy: ctx(), values: { p0: 'rm -rf' }, approve: async () => true }, executor),
    ).rejects.toThrow(/not an observed option/);
    expect(executor.focus).not.toHaveBeenCalled();
  });

  it('treats an executor error as a failed step, not an exception', async () => {
    const executor: Executor = {
      focusApp: async () => {
        throw new Error('Command failed: powershell.exe -EncodedCommand ...');
      },
      frontmostApp: async () => undefined,
    };
    const result = await runAutomation(compiled(), { mode: 'supervised', policy: ctx(), approve: async () => true }, executor);
    expect(result.status).toBe('failed');
    expect(result.steps.at(-1)?.reason).toBe('The app could not be focused.');
  });
});

describe('long routine names', () => {
  it('compiles a six-step routine whose window classes make a name over 80 characters, and the agent still lists it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'twin-long-name-'));
    const agent = new TwinAgent({ dataDir: dir, dataKey: randomBytes(32), now: () => at(10, 12) });
    try {
      // Spreadsheet and document alternate, so no two neighbours share a window class and every step is kept.
      const apps = ['Microsoft Excel', 'Microsoft Word', 'Microsoft Excel', 'Microsoft Word', 'Microsoft Excel', 'Microsoft Word'];
      for (let day = 0; day < 10; day++) {
        apps.forEach((app, index) => agent.ingest({ kind: 'focus', ts: at(day, 9, index * 5), app }));
      }
      const routine = agent.analyze().routines.find(candidate => candidate.steps.length === 6);
      expect(routine).toBeDefined();

      const compiled = compileRoutine(routine!);
      expect(compiled.name.length).toBeLessThanOrEqual(80);
      expect(compiled.name.endsWith('…')).toBe(true);
      expect(agent.suggestions().some(suggestion => suggestion.routine.steps.length === 6)).toBe(true);
    } finally {
      agent.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
