import { describe, expect, it } from 'vitest';
import { compileMenuAutomation, runAutomation, StepRefusedError, type Automation, type Executor } from '../src';

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
