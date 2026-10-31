import { mkdtempSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  AutomationSchema,
  EncryptedStore,
  StepRefusedError,
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

describe('an executor that blocks its own focus and key steps', () => {
  const blockedFor = (reason: string | undefined): Executor => ({
    focusApp: async () => true,
    frontmostApp: async () => 'microsoft excel',
    pressShortcut: async () => true,
    blockedReason: () => reason,
  });

  it('blocks a key press with its own reason, before anyone is asked', async () => {
    const approve = vi.fn(async () => true);
    const result = await runAutomation(
      automation([CHORD]),
      { mode: 'supervised', policy: ctx(), approve, settleMs: 0 },
      blockedFor('The agent-desktop program is not set.'),
    );
    expect(result.status).toBe('blocked');
    expect(result.steps[0].reason).toBe('The agent-desktop program is not set.');
    expect(approve).not.toHaveBeenCalled();
  });

  it('blocks a focus step with its own reason, and runs nothing', async () => {
    const focusApp = vi.fn(async () => true);
    const result = await runAutomation(
      automation([{ op: 'focus_app', app: 'microsoft excel' }]),
      { mode: 'supervised', policy: ctx(), settleMs: 0 },
      { focusApp, frontmostApp: async () => undefined, blockedReason: () => 'The agent-desktop program is not set.' },
    );
    expect(result.status).toBe('blocked');
    expect(result.steps[0].reason).toBe('The agent-desktop program is not set.');
    expect(focusApp).not.toHaveBeenCalled();
  });

  it('runs the steps as usual when the executor reports no block', async () => {
    const approve = vi.fn(async () => true);
    const result = await runAutomation(
      automation([CHORD]),
      { mode: 'supervised', policy: ctx(), approve, settleMs: 0 },
      blockedFor(undefined),
    );
    expect(result.status).toBe('completed');
    expect(approve).toHaveBeenCalledTimes(1);
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

  it('presses nothing when the person declines', async () => {
    const { executor, calls } = fakeDesktop();
    const result = await runAutomation(
      automation([CHORD]),
      { mode: 'supervised', policy: ctx(), approve: async () => false, settleMs: 0 },
      executor,
    );
    expect(result.status).toBe('blocked');
    expect(result.steps[0].reason).toBe('Not approved.');
    expect(calls).toEqual([]);
  });

  it('asks again for every key press in one run', async () => {
    const { executor, calls } = fakeDesktop();
    const approve = vi.fn(async () => true);
    const result = await runAutomation(automation([CHORD, CHORD]), { mode: 'supervised', policy: ctx(), approve, settleMs: 0 }, executor);
    expect(result.status).toBe('completed');
    expect(approve).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(['key:microsoft excel:cmd+shift+k', 'key:microsoft excel:cmd+shift+k']);
  });

  it('a press the adapter reports as failed stops the run with the press reason', async () => {
    const { executor } = fakeDesktop();
    const refused: Executor = { ...executor, pressShortcut: async () => false };
    const result = await runAutomation(automation([CHORD]), { mode: 'supervised', policy: ctx(), approve: async () => true, settleMs: 0 }, refused);
    expect(result.status).toBe('failed');
    expect(result.steps[0]).toMatchObject({ outcome: 'failed', reason: 'The shortcut could not be pressed.' });
  });

  it('a press that throws is an ordinary failure, and the error text is not kept', async () => {
    const { executor } = fakeDesktop();
    const throws: Executor = {
      ...executor,
      pressShortcut: async () => {
        throw new Error('osascript: keystroke text');
      },
    };
    const result = await runAutomation(automation([CHORD]), { mode: 'supervised', policy: ctx(), approve: async () => true, settleMs: 0 }, throws);
    expect(result.status).toBe('failed');
    expect(result.steps[0].reason).toBe('The shortcut could not be pressed.');
  });

  it('a stop request before the press sends nothing', async () => {
    const { executor, calls } = fakeDesktop();
    const result = await runAutomation(
      automation([CHORD]),
      { mode: 'supervised', policy: ctx(), approve: async () => true, shouldStop: () => true, settleMs: 0 },
      executor,
    );
    expect(result.status).toBe('blocked');
    expect(calls).toEqual([]);
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

describe('a refusal the executor explains', () => {
  const FOCUS: Step = { op: 'focus_app', app: 'microsoft excel' };
  const WHY = 'More than one window of this app is open. Choose a window, then try again.';
  const request = { mode: 'supervised' as const, policy: ctx(), approve: async () => true, settleMs: 0 };

  it('keeps the message of a StepRefusedError from a focus as failureReason, and the generic reason stays', async () => {
    const { executor } = fakeDesktop();
    const refusing: Executor = {
      ...executor,
      focusApp: async () => {
        throw new StepRefusedError(WHY);
      },
    };
    const result = await runAutomation(automation([FOCUS]), request, refusing);
    expect(result.status).toBe('failed');
    expect(result.steps[0]).toEqual({
      index: 0,
      op: 'focus_app',
      app: 'microsoft excel',
      outcome: 'failed',
      reason: 'The app could not be focused.',
      failureReason: WHY,
    });
  });

  it('keeps the message of a StepRefusedError from a press as failureReason', async () => {
    const { executor } = fakeDesktop();
    const refusing: Executor = {
      ...executor,
      pressShortcut: async () => {
        throw new StepRefusedError(WHY);
      },
    };
    const result = await runAutomation(automation([CHORD]), request, refusing);
    expect(result.status).toBe('failed');
    expect(result.steps[0]).toMatchObject({ outcome: 'failed', reason: 'The shortcut could not be pressed.', failureReason: WHY });
  });

  it('is a plain Error whose message is the refusal', () => {
    const error = new StepRefusedError(WHY);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(WHY);
  });

  it('does not keep the text of any other thrown error, and sets no failureReason field', async () => {
    const { executor } = fakeDesktop();
    const throwsPlain: Executor = {
      ...executor,
      focusApp: async () => {
        throw new Error('/Users/me/secret-path osascript');
      },
    };
    const focus = await runAutomation(automation([FOCUS]), request, throwsPlain);
    expect(focus.steps[0]).toEqual({
      index: 0,
      op: 'focus_app',
      app: 'microsoft excel',
      outcome: 'failed',
      reason: 'The app could not be focused.',
    });
    expect(focus.steps[0]).not.toHaveProperty('failureReason');
    expect(JSON.stringify(focus)).not.toMatch(/secret-path/);

    const throwsPress: Executor = {
      ...executor,
      pressShortcut: async () => {
        throw new Error('osascript: keystroke text');
      },
    };
    const press = await runAutomation(automation([CHORD]), request, throwsPress);
    expect(press.steps[0]).not.toHaveProperty('failureReason');
  });

  it('sets no failureReason when the executor returns false, or when the step succeeds', async () => {
    const { executor } = fakeDesktop();
    const returnsFalse: Executor = { ...executor, focusApp: async () => false };
    const failed = await runAutomation(automation([FOCUS]), request, returnsFalse);
    expect(failed.steps[0]).not.toHaveProperty('failureReason');
    expect(failed.steps[0].reason).toBe('The app could not be focused.');

    const done = await runAutomation(automation([FOCUS]), request, executor);
    expect(done.status).toBe('completed');
    expect(done.steps[0]).not.toHaveProperty('failureReason');
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
