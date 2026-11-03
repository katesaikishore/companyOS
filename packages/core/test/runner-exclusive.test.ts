import { describe, expect, it } from 'vitest';
import { AutomationSchema, compileMenuAutomation, runAutomation, StepRefusedError, type Automation, type Executor } from '../src';

const POLICY = { level: 3 as const, maxLevel: 4 as const, unattended: false, excludedApps: [] };

function menuAutomation(): Automation {
  return compileMenuAutomation({ name: 'Select all', app: 'TextEdit', menu: ['Edit', 'Select All'] }, 'menu-exclusive');
}

/** An executor that writes what happens, in order, including when it enters and leaves its exclusive section. */
function tracing(events: string[], overrides: Partial<Executor> = {}): Executor {
  return {
    focusApp: async app => {
      events.push(`focus:${app}`);
      return true;
    },
    frontmostApp: async () => 'TextEdit',
    chooseMenu: async (_app, menu) => {
      events.push(`menu:${menu.join('>')}`);
      return true;
    },
    exclusive: async work => {
      events.push('enter');
      try {
        return await work();
      } finally {
        events.push('leave');
      }
    },
    ...overrides,
  };
}

describe('the exclusive section around each step', () => {
  it('asks for approval outside it, then refocuses the app and chooses the menu inside it', async () => {
    const events: string[] = [];
    const result = await runAutomation(
      menuAutomation(),
      {
        mode: 'supervised',
        policy: POLICY,
        approve: async () => {
          events.push('approve');
          return true;
        },
      },
      tracing(events),
    );
    expect(result.status).toBe('completed');
    expect(events).toEqual([
      'enter',
      'focus:TextEdit',
      'leave',
      'approve',
      'enter',
      'focus:TextEdit',
      'menu:Edit>Select All',
      'leave',
    ]);
  });

  it('blocks a step when a stop was pressed while it waited for the section, and chooses nothing', async () => {
    const events: string[] = [];
    let stopped = false;
    const executor = tracing(events, {
      exclusive: async work => {
        // Another run held the input; the person pressed stop meanwhile.
        if (events.includes('focus:TextEdit')) stopped = true;
        return work();
      },
    });
    const result = await runAutomation(
      menuAutomation(),
      { mode: 'supervised', policy: POLICY, approve: async () => true, shouldStop: () => stopped },
      executor,
    );
    expect(result.status).toBe('blocked');
    expect(result.steps.at(-1)?.reason).toBe('Automations were stopped.');
    expect(events.some(event => event.startsWith('menu:'))).toBe(false);
  });

  it('blocks a step when the policy changed to deny while it waited', async () => {
    let level: 2 | 3 = 3;
    const events: string[] = [];
    const executor = tracing(events, {
      exclusive: async work => {
        if (events.includes('focus:TextEdit')) level = 2;
        return work();
      },
    });
    const result = await runAutomation(
      menuAutomation(),
      { mode: 'supervised', policy: POLICY, approve: async () => true, currentLevel: () => level },
      executor,
    );
    expect(result.status).toBe('blocked');
    expect(events.some(event => event.startsWith('menu:'))).toBe(false);
  });

  it('blocks rather than fails when the app cannot be brought forward before its menu', async () => {
    let calls = 0;
    const executor = tracing([], {
      focusApp: async () => {
        calls++;
        if (calls === 2) throw new StepRefusedError('More than one window of this app is open.');
        return true;
      },
    });
    const result = await runAutomation(menuAutomation(), { mode: 'supervised', policy: POLICY, approve: async () => true }, executor);
    expect(result.status).toBe('blocked');
    expect(result.steps.at(-1)?.failureReason).toBe('More than one window of this app is open.');
  });

  it('runs every step the same way when the executor has no exclusive section', async () => {
    const events: string[] = [];
    const executor = tracing(events);
    delete executor.exclusive;
    const result = await runAutomation(menuAutomation(), { mode: 'supervised', policy: POLICY, approve: async () => true }, executor);
    expect(result.status).toBe('completed');
    expect(events).toEqual(['focus:TextEdit', 'focus:TextEdit', 'menu:Edit>Select All']);
  });
});

describe('a focus and the check after it', () => {
  const focusThenCheck = (id: string, app: string): Automation =>
    AutomationSchema.parse({
      id,
      name: id,
      version: 1,
      routineId: `r-${id}`,
      params: [],
      steps: [
        { op: 'focus_app', app },
        { op: 'check_focus', app },
      ],
    });

  /** One desktop with one app in front, and a first-come, first-served lock like the app's input lock. */
  function desktop(): Executor {
    let front = '';
    let tail: Promise<unknown> = Promise.resolve();
    return {
      focusApp: async app => {
        front = app;
        return true;
      },
      frontmostApp: async () => front,
      exclusive: work => {
        const turn = tail.then(work);
        tail = turn.catch(() => undefined);
        return turn;
      },
    };
  }

  it('hold one turn, so a run started beside it cannot move focus between them', async () => {
    const executor = desktop();
    const [notes, safari] = await Promise.all([
      runAutomation(focusThenCheck('a', 'Notes'), { mode: 'supervised', policy: POLICY }, executor),
      runAutomation(focusThenCheck('b', 'Safari'), { mode: 'supervised', policy: POLICY }, executor),
    ]);
    expect([notes.status, safari.status]).toEqual(['completed', 'completed']);
    expect(notes.steps.map(step => [step.index, step.outcome])).toEqual([
      [0, 'executed'],
      [1, 'passed'],
    ]);
  });

  it('still fails the run when a different app is in front after the focus', async () => {
    const executor: Executor = { ...desktop(), frontmostApp: async () => 'Finder' };
    const result = await runAutomation(focusThenCheck('a', 'Notes'), { mode: 'supervised', policy: POLICY }, executor);
    expect(result.status).toBe('failed');
    expect(result.steps.map(step => step.outcome)).toEqual(['executed', 'check_failed']);
    expect(result.postconditionsFailed).toBe(1);
  });
});
