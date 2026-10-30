import { mkdtempSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  AutomationSchema,
  EncryptedStore,
  TwinAgent,
  runAutomation,
  type Automation,
  type Executor,
  type PolicyContext,
  type Step,
} from '../src';

const ctx = (overrides: Partial<PolicyContext> = {}): PolicyContext => ({
  level: 3,
  maxLevel: 4,
  unattended: false,
  excludedApps: ['1password'],
  ...overrides,
});

/**
 * A fake desktop. Each open, focus or press call is recorded. After an open, the app in front is `landing(app)`, which
 * defaults to the app that was asked for. A press brings its app forward first, as a real adapter must.
 */
function fakeDesktop(landing: (app: string) => string = app => app) {
  let front: string | undefined;
  const calls: string[] = [];
  const executor: Executor = {
    focusApp: async app => {
      calls.push(`focus:${app}`);
      front = app;
      return true;
    },
    frontmostApp: async () => front,
    openUrl: async (app, url) => {
      calls.push(`url:${app}:${url}`);
      front = landing(app);
      return true;
    },
    openFile: async (app, path) => {
      calls.push(`file:${app}:${path}`);
      front = landing(app);
      return true;
    },
    pressShortcut: async (app, shortcut) => {
      calls.push(`key:${app}:${shortcut}`);
      front = app;
      return true;
    },
  };
  return { executor, calls };
}

function automation(steps: Step[], params: Automation['params'] = []): Automation {
  return AutomationSchema.parse({ id: 'auto_test', name: 'Test', version: 2, routineId: 'routine_test', params, steps });
}

const LINK: Step = { op: 'open_url', app: 'google chrome', url: 'https://docs.example.com/doc' };
const FILE: Step = { op: 'open_file', app: 'microsoft excel', path: '/Users/me/Documents/budget.xlsx' };
const CHORD: Step = { op: 'press_shortcut', app: 'microsoft excel', shortcut: 'cmd+shift+k' };

describe('open_url', () => {
  it('opens the canonical address in the browser and checks the browser is in front', async () => {
    const { executor, calls } = fakeDesktop();
    const approve = vi.fn(async () => true);
    const result = await runAutomation(
      automation([{ op: 'open_url', app: 'google chrome', url: 'https://Docs.Example.com/doc' }]),
      { mode: 'supervised', policy: ctx(), approve, settleMs: 0 },
      executor,
    );
    expect(result.status).toBe('completed');
    expect(calls).toEqual(['url:google chrome:https://docs.example.com/doc']);
    expect(result.postconditionsPassed).toBe(1);
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ op: 'open_url' }), expect.objectContaining({ decision: 'ask' }));
  });

  it('fails the run when the browser is not in front afterwards', async () => {
    const { executor } = fakeDesktop(() => 'slack');
    const result = await runAutomation(automation([LINK]), { mode: 'supervised', policy: ctx(), approve: async () => true, settleMs: 0 }, executor);
    expect(result.status).toBe('failed');
    expect(result.postconditionsFailed).toBe(1);
    expect(result.steps[0].outcome).toBe('check_failed');
  });

  it('opens a bound parameter value only when it was approved', async () => {
    const params = [
      {
        name: 'p1',
        options: ['https://docs.example.com/doc/a1', 'https://docs.example.com/doc/b2'],
        default: 'https://docs.example.com/doc/a1',
      },
    ];
    const auto = automation([{ op: 'open_url', app: 'google chrome', url: '$p1' }], params);
    const { executor, calls } = fakeDesktop();
    const result = await runAutomation(
      auto,
      { mode: 'supervised', policy: ctx(), values: { p1: 'https://docs.example.com/doc/b2' }, approve: async () => true, settleMs: 0 },
      executor,
    );
    expect(result.status).toBe('completed');
    expect(calls).toEqual(['url:google chrome:https://docs.example.com/doc/b2']);
  });

  it('runs nothing when the bound value was never approved', async () => {
    const params = [
      { name: 'p1', options: ['https://docs.example.com/doc/a1', 'https://docs.example.com/doc/b2'], default: 'https://docs.example.com/doc/a1' },
    ];
    const { executor, calls } = fakeDesktop();
    await expect(
      runAutomation(
        automation([{ op: 'open_url', app: 'google chrome', url: '$p1' }], params),
        { mode: 'supervised', policy: ctx(), values: { p1: 'https://evil.example.net/' }, approve: async () => true },
        executor,
      ),
    ).rejects.toThrow(/not an observed option/);
    expect(calls).toEqual([]);
  });

  it('never runs unattended, even at level 4', async () => {
    const { executor, calls } = fakeDesktop();
    const approve = vi.fn(async () => true);
    const result = await runAutomation(
      automation([LINK]),
      { mode: 'unattended', policy: ctx({ level: 4, unattended: true }), approve, settleMs: 0 },
      executor,
    );
    expect(result.status).toBe('blocked');
    expect(approve).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('counts a failed open as a failed step with no postcondition, and keeps the error text out of the result', async () => {
    const executor: Executor = {
      focusApp: async () => true,
      frontmostApp: async () => 'google chrome',
      openUrl: async () => {
        throw new Error('open: /Applications/Google Chrome.app: not found');
      },
    };
    const result = await runAutomation(automation([LINK]), { mode: 'supervised', policy: ctx(), approve: async () => true, settleMs: 0 }, executor);
    expect(result.status).toBe('failed');
    expect(result.steps[0].reason).toBe('The address could not be opened.');
    expect(result.postconditionsPassed + result.postconditionsFailed).toBe(0);
    expect(JSON.stringify(result)).not.toContain('not found');
  });

  it('waits briefly for the OS to bring the browser forward', async () => {
    let polls = 0;
    const executor: Executor = {
      focusApp: async () => true,
      frontmostApp: async () => (++polls < 3 ? 'finder' : 'google chrome'),
      openUrl: async () => true,
    };
    const result = await runAutomation(automation([LINK]), { mode: 'supervised', policy: ctx(), approve: async () => true, settleMs: 1000 }, executor);
    expect(result.status).toBe('completed');
    expect(polls).toBeGreaterThanOrEqual(3);
  });
});

describe('open_file', () => {
  it('asks for the exact path, and opens only that file when approved', async () => {
    const { executor, calls } = fakeDesktop();
    const approve = vi.fn(async () => true);
    const result = await runAutomation(automation([FILE]), { mode: 'supervised', policy: ctx(), approve, settleMs: 0 }, executor);
    expect(result.status).toBe('completed');
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'open_file', path: '/Users/me/Documents/budget.xlsx' }),
      expect.objectContaining({ decision: 'ask' }),
    );
    expect(calls).toEqual(['file:microsoft excel:/Users/me/Documents/budget.xlsx']);
  });

  it('opens nothing when the person refuses', async () => {
    const { executor, calls } = fakeDesktop();
    const result = await runAutomation(automation([FILE]), { mode: 'supervised', policy: ctx(), approve: async () => false, settleMs: 0 }, executor);
    expect(result.status).toBe('blocked');
    expect(calls).toEqual([]);
  });

  it('is blocked before anyone is asked when unattended, since no person approves that run', async () => {
    const { executor, calls } = fakeDesktop();
    const approve = vi.fn(async () => true);
    const result = await runAutomation(
      automation([FILE]),
      { mode: 'unattended', policy: ctx({ level: 4, unattended: true }), approve, settleMs: 0 },
      executor,
    );
    expect(result.status).toBe('blocked');
    expect(approve).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('is blocked, not failed, on a system with no file adapter', async () => {
    const executor: Executor = { focusApp: async () => true, frontmostApp: async () => undefined };
    const approve = vi.fn(async () => true);
    const result = await runAutomation(automation([FILE]), { mode: 'supervised', policy: ctx(), approve, settleMs: 0 }, executor);
    expect(result.status).toBe('blocked');
    expect(result.steps[0].reason).toBe('This system cannot open files yet.');
    expect(approve).not.toHaveBeenCalled();
  });
});

describe('press_shortcut', () => {
  it('is blocked on a system with no key adapter, before anyone is asked', async () => {
    const executor: Executor = { focusApp: async () => true, frontmostApp: async () => 'microsoft excel' };
    const approve = vi.fn(async () => true);
    const result = await runAutomation(automation([CHORD]), { mode: 'supervised', policy: ctx(), approve, settleMs: 0 }, executor);
    expect(result.status).toBe('blocked');
    expect(result.steps[0].reason).toBe('This system cannot press shortcuts yet.');
    expect(approve).not.toHaveBeenCalled();
  });

  it('presses the chord after approval and checks the app is still in front', async () => {
    const { executor, calls } = fakeDesktop();
    const approve = vi.fn(async () => true);
    const result = await runAutomation(automation([CHORD]), { mode: 'supervised', policy: ctx(), approve, settleMs: 0 }, executor);
    expect(result.status).toBe('completed');
    expect(calls).toEqual(['key:microsoft excel:cmd+shift+k']);
    expect(result.postconditionsPassed).toBe(1);
  });

  it('fails when pressing the chord moves focus to another app', async () => {
    const { executor } = fakeDesktop();
    const moved: Executor = { ...executor, frontmostApp: async () => 'slack' };
    const result = await runAutomation(automation([{ op: 'focus_app', app: 'microsoft excel' }, CHORD]), { mode: 'supervised', policy: ctx(), approve: async () => true, settleMs: 0 }, moved);
    expect(result.status).toBe('failed');
  });

  it('never runs unattended, even at level 4', async () => {
    const { executor, calls } = fakeDesktop();
    const result = await runAutomation(
      automation([CHORD]),
      { mode: 'unattended', policy: ctx({ level: 4, unattended: true }), approve: async () => true, settleMs: 0 },
      executor,
    );
    expect(result.status).toBe('blocked');
    expect(calls).toEqual([]);
  });
});

describe('shared run behaviour', () => {
  it('dry run never calls the new executor methods, and names each approval', async () => {
    const { executor, calls } = fakeDesktop();
    const result = await runAutomation(automation([LINK, FILE, CHORD]), { mode: 'dry_run', policy: ctx({ level: 2 }) }, executor);
    expect(result.status).toBe('dry_run');
    expect(calls).toEqual([]);
    expect(result.steps.map(step => step.outcome)).toEqual(['dry_run', 'dry_run', 'dry_run']);
    expect(result.steps[1].reason).toBe('Opening a file needs your confirmation for this exact file.');
  });

  it('a stop request cancels an open step before it starts', async () => {
    const { executor, calls } = fakeDesktop();
    const result = await runAutomation(
      automation([LINK]),
      { mode: 'supervised', policy: ctx(), approve: async () => true, shouldStop: () => true, settleMs: 0 },
      executor,
    );
    expect(result.status).toBe('blocked');
    expect(calls).toEqual([]);
  });

  it('runs a version 1 focus and check automation as before', async () => {
    const legacy = AutomationSchema.parse({
      id: 'auto_legacy',
      name: 'Legacy',
      version: 1,
      routineId: 'legacy',
      params: [],
      steps: [
        { op: 'focus_app', app: 'microsoft excel' },
        { op: 'check_focus', app: 'microsoft excel' },
      ],
    });
    const { executor } = fakeDesktop();
    const result = await runAutomation(legacy, { mode: 'supervised', policy: ctx(), approve: async () => true }, executor);
    expect(result.status).toBe('completed');
    expect(result.postconditionsPassed).toBe(1);
  });
});

describe('demotion through the agent', () => {
  function storedAgent(auto: Automation, level: 3 | 4): { agent: TwinAgent } {
    const dir = mkdtempSync(join(tmpdir(), 'twin-run-'));
    const key = randomBytes(32);
    const store = new EncryptedStore(dir, key);
    store.replaceAll('automations', [auto]);
    store.replaceAll('autonomy', [{ automationId: auto.id, level, effects: ['external_effect'], runs: [] }]);
    const agent = new TwinAgent({ dataDir: dir, dataKey: key });
    agent.updateConfig({ maxAutonomyLevel: 4 });
    return { agent };
  }

  it('drops the automation to level 3 when an open step fails its postcondition', async () => {
    const auto = automation([LINK]);
    const { agent } = storedAgent(auto, 4);
    const { executor } = fakeDesktop(() => 'slack');
    const result = await agent.run(auto.id, { mode: 'supervised', approve: async () => true }, executor);
    expect(result.status).toBe('failed');
    const state = agent.automations()[0].state;
    expect(state.level).toBe(3);
    expect(state.runs.at(-1)).toMatchObject({ status: 'failed', postconditionsFailed: 1 });
  });

  it('does not demote on a blocked step, because a block is not evidence against the automation', async () => {
    const auto = automation([CHORD]);
    const { agent } = storedAgent(auto, 3);
    const executor: Executor = { focusApp: async () => true, frontmostApp: async () => 'microsoft excel' };
    const result = await agent.run(auto.id, { mode: 'supervised', approve: async () => true }, executor);
    expect(result.status).toBe('blocked');
    const state = agent.automations()[0].state;
    expect(state.level).toBe(3);
    expect(state.runs).toEqual([]);
  });
});
