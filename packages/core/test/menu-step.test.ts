import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  AutomationSchema,
  MenuAutomationInputSchema,
  StepRefusedError,
  StepSchema,
  TwinAgent,
  compileMenuAutomation,
  describeStep,
  effectOfOp,
  effectsOf,
  isAllowedMenuPath,
  runAutomation,
  type Automation,
  type Executor,
} from '../src';
import { tempFolders } from './temp-folders';

const temps = tempFolders();

const CLEAN_UP = ['View', 'Clean Up By', 'Name'];

function menuAutomation(menu: string[] = CLEAN_UP): Automation {
  return compileMenuAutomation({ name: 'Arrange the Desktop', app: 'Finder', menu }, 'menu-test');
}

/** An executor whose app is always in front, with a chooseMenu that answers as told. */
function executor(chooseMenu?: Executor['chooseMenu']): Executor {
  return {
    focusApp: async () => true,
    frontmostApp: async () => 'Finder',
    ...(chooseMenu ? { chooseMenu } : {}),
  };
}

const POLICY = { level: 3 as const, maxLevel: 4 as const, unattended: false, excludedApps: [] };

describe('the choose_menu step', () => {
  it('accepts a path of two to four labels as the app shows them', () => {
    expect(StepSchema.safeParse({ op: 'choose_menu', app: 'Finder', menu: CLEAN_UP }).success).toBe(true);
    expect(StepSchema.safeParse({ op: 'choose_menu', app: 'TextEdit', menu: ['File', 'Save As…'] }).success).toBe(true);
  });

  it('refuses a path too short or too long, a label that could read as a flag or holds a quote, and a shell', () => {
    expect(StepSchema.safeParse({ op: 'choose_menu', app: 'Finder', menu: ['View'] }).success).toBe(false);
    expect(StepSchema.safeParse({ op: 'choose_menu', app: 'Finder', menu: ['a', 'b', 'c', 'd', 'e'] }).success).toBe(false);
    expect(isAllowedMenuPath(['View', '--headed'])).toBe(false);
    expect(isAllowedMenuPath(['View', 'Say "hi"'])).toBe(false);
    expect(isAllowedMenuPath(['View', 'a\u0007b'])).toBe(false);
    expect(StepSchema.safeParse({ op: 'choose_menu', app: 'Terminal', menu: CLEAN_UP }).success).toBe(false);
  });

  it('is an external effect, so it asks at every level and never runs unattended', () => {
    expect(effectOfOp('choose_menu', 'Finder')).toBe('external_effect');
    expect(effectsOf(menuAutomation())).toContain('external_effect');
  });

  it('names the exact path in its approval question', () => {
    expect(describeStep({ op: 'choose_menu', app: 'Finder', menu: CLEAN_UP })).toBe(
      'Choose View → Clean Up By → Name in "Finder"?',
    );
  });
});

describe('compileMenuAutomation', () => {
  it('brings the app forward, then chooses the path, and marks the routine as made by hand', () => {
    const automation = menuAutomation();
    expect(AutomationSchema.parse(automation)).toEqual(automation);
    expect(automation.steps).toEqual([
      { op: 'focus_app', app: 'Finder' },
      { op: 'choose_menu', app: 'Finder', menu: CLEAN_UP },
    ]);
    expect(automation.routineId).toBe('manual:menu-test');
  });

  it('refuses an input field the page should not send, and a shell as the app', () => {
    expect(MenuAutomationInputSchema.safeParse({ name: 'x', app: 'Finder', menu: CLEAN_UP, steps: [] }).success).toBe(false);
    expect(MenuAutomationInputSchema.safeParse({ name: 'x', app: 'bash', menu: CLEAN_UP }).success).toBe(false);
  });
});

describe('running a menu step', () => {
  it('passes when the adapter confirms the menu was chosen', async () => {
    const chooseMenu = vi.fn(async () => true);
    const result = await runAutomation(
      menuAutomation(),
      { mode: 'supervised', policy: POLICY, approve: async () => true },
      executor(chooseMenu),
    );
    expect(result.status).toBe('completed');
    expect(chooseMenu).toHaveBeenCalledWith('Finder', CLEAN_UP);
    expect(result.steps.at(-1)?.outcome).toBe('passed');
  });

  it('asks before the menu is chosen, and chooses nothing when the person says no', async () => {
    const chooseMenu = vi.fn(async () => true);
    const approve = vi.fn(async () => false);
    const result = await runAutomation(menuAutomation(), { mode: 'supervised', policy: POLICY, approve }, executor(chooseMenu));
    expect(approve).toHaveBeenCalled();
    expect(chooseMenu).not.toHaveBeenCalled();
    expect(result.status).not.toBe('completed');
  });

  it('is blocked before anyone is asked when the system cannot choose menus', async () => {
    const approve = vi.fn(async () => true);
    const result = await runAutomation(menuAutomation(), { mode: 'supervised', policy: POLICY, approve }, executor());
    expect(result.status).toBe('blocked');
    expect(result.steps.at(-1)?.reason).toMatch(/agent-desktop/);
  });

  it('is blocked, not failed, when the adapter refuses because nothing was chosen', async () => {
    const chooseMenu = vi.fn(async () => {
      throw new StepRefusedError('A menu item was not found.');
    });
    const result = await runAutomation(
      menuAutomation(),
      { mode: 'supervised', policy: POLICY, approve: async () => true },
      executor(chooseMenu),
    );
    expect(result.status).toBe('blocked');
    expect(result.steps.at(-1)?.failureReason).toBe('A menu item was not found.');
  });

  it('fails when a click could not be confirmed', async () => {
    const result = await runAutomation(
      menuAutomation(),
      { mode: 'supervised', policy: POLICY, approve: async () => true },
      executor(async () => false),
    );
    expect(result.status).toBe('failed');
    expect(result.steps.at(-1)?.outcome).toBe('failed');
  });
});

describe('TwinAgent.createMenuAutomation', () => {
  it('stores a draft at level 2 with its effects, and refuses an invalid input', () => {
    const agent = temps.track(new TwinAgent({ dataDir: temps.folder('twin-menu-'), dataKey: randomBytes(32), now: () => 1_800_000_000_000 }));
    const view = agent.createMenuAutomation({ name: 'Arrange the Desktop', app: 'Finder', menu: CLEAN_UP });
    expect(view.state.level).toBe(2);
    expect(view.state.effects).toContain('external_effect');
    expect(agent.automations().map(item => item.automation.id)).toContain(view.automation.id);
    expect(() => agent.createMenuAutomation({ name: 'x', app: 'Finder', menu: ['View'] })).toThrow(/not valid/);
  });

  it('keeps the name the person typed out of the plain-text export', () => {
    const agent = temps.track(new TwinAgent({ dataDir: temps.folder('twin-menu-'), dataKey: randomBytes(32), now: () => 1_800_000_000_000 }));
    agent.createMenuAutomation({ name: 'Payroll cleanup', app: 'Finder', menu: ['View', 'Clean Up'] });
    expect(JSON.stringify(agent.exportAll())).not.toContain('Payroll cleanup');
  });
});
