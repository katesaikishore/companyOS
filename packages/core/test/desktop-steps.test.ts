import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PlaybookInputSchema,
  StepRefusedError,
  StepSchema,
  TwinAgent,
  compilePlaybook,
  describeStep,
  effectOfOp,
  evaluateStep,
  missingText,
  runAutomation,
  type Approval,
  type Executor,
  type Step,
} from '../src';
import { tempFolders } from './temp-folders';

const temps = tempFolders();

const SHEETS = { app: 'Google Chrome', window: 'companyOS Enterprise Benchmark' };
const NAME_BOX = { role: 'group' as const, namePrefix: 'Name box' };

const FILL: Step = { op: 'fill_field', ...SHEETS, target: NAME_BOX, text: 'Finance!A1:D4', submit: true };
const COPY: Step = { op: 'press_key', ...SHEETS, key: 'cmd+c' };
const CHECK: Step = { op: 'check_text', ...SHEETS, source: 'clipboard', expect: ['cod\t171\t312468', 'prepaid\t24'] };

const POLICY = { level: 3 as const, maxLevel: 4 as const, unattended: false, excludedApps: [] };

/** An executor whose desktop steps all succeed, and whose clipboard holds the given text. */
function desktop(clipboard = '', overrides: Partial<Executor> = {}): Executor & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    focusApp: async () => true,
    frontmostApp: async () => 'Google Chrome',
    click: async (_app, _window, target, button) => (calls.push(`click ${button} ${target.name ?? target.namePrefix}`), true),
    pasteText: async (_app, _window, text) => (calls.push(`paste ${text}`), true),
    pressKey: async (_app, _window, key) => (calls.push(`key ${key}`), true),
    fillField: async (_app, _window, _target, text, submit) => (calls.push(`fill ${text} ${submit}`), true),
    setField: async (_app, _window, _target, text) => (calls.push(`set ${text}`), true),
    readText: async () => clipboard,
    ...overrides,
  };
}

function playbook(steps: Step[]) {
  return compilePlaybook({ name: 'Finance check', steps }, 'playbook-test');
}

describe('the desktop steps', () => {
  it('accepts a named window, a role with an exact name or a prefix, text with tabs and line breaks, and keys', () => {
    for (const step of [FILL, COPY, CHECK]) expect(StepSchema.safeParse(step).success).toBe(true);
    expect(StepSchema.safeParse({ op: 'paste_text', app: 'Google Chrome', text: 'Method\tOrders\n=COUNTIF(A:A,"cod")' }).success).toBe(true);
    expect(StepSchema.safeParse({ op: 'press_key', app: 'Finder', key: 'return' }).success).toBe(true);
    expect(StepSchema.safeParse({ op: 'click', app: 'Google Chrome', target: { role: 'menuitem', name: 'Rename' }, button: 'right' }).success).toBe(true);
  });

  it('refuses a shell, an unknown role, a name and a prefix together, control characters, a dash-led name and a free-form key', () => {
    expect(StepSchema.safeParse({ op: 'paste_text', app: 'Terminal', text: 'ls' }).success).toBe(false);
    expect(StepSchema.safeParse({ op: 'click', app: 'Finder', target: { role: 'window', name: 'x' } }).success).toBe(false);
    expect(StepSchema.safeParse({ op: 'click', app: 'Finder', target: { role: 'button', name: 'OK', namePrefix: 'O' } }).success).toBe(false);
    expect(StepSchema.safeParse({ op: 'click', app: 'Finder', target: { role: 'button' } }).success).toBe(false);
    expect(StepSchema.safeParse({ op: 'paste_text', app: 'TextEdit', text: 'a\u001bb' }).success).toBe(false);
    expect(StepSchema.safeParse({ op: 'click', app: 'Finder', target: { role: 'button', name: '--help' } }).success).toBe(false);
    expect(StepSchema.safeParse({ op: 'press_key', app: 'Finder', key: 'cmd+q+x' }).success).toBe(false);
    expect(StepSchema.safeParse({ op: 'press_key', app: 'Finder', key: 'hyper' }).success).toBe(false);
  });

  it('treats every action as an external effect and a check as read only', () => {
    for (const op of ['click', 'paste_text', 'press_key', 'fill_field', 'set_field'] as const) {
      expect(effectOfOp(op, 'Google Chrome')).toBe('external_effect');
    }
    expect(effectOfOp('check_text', 'Google Chrome')).toBe('read_only');
  });

  it('asks before an action with a person present, never runs one unattended, and lets a check run at level 3', () => {
    expect(evaluateStep(FILL, POLICY).decision).toBe('ask');
    expect(evaluateStep(FILL, { ...POLICY, level: 4, unattended: true }).decision).toBe('deny');
    expect(evaluateStep(CHECK, POLICY).decision).toBe('allow');
    expect(evaluateStep(CHECK, { ...POLICY, unattended: true }).decision).toBe('deny');
    expect(evaluateStep(CHECK, { ...POLICY, level: 4, unattended: true }).decision).toBe('allow');
  });

  it('names what each step does in its approval question, with long text cut and its length given', () => {
    expect(describeStep(FILL)).toBe(
      'Enter "Finance!A1:D4" in the group "Name box…" and press Return in the "companyOS Enterprise Benchmark" window of "Google Chrome"?',
    );
    expect(describeStep({ op: 'paste_text', app: 'TextEdit', text: 'x'.repeat(120) })).toMatch(/…" \(120 characters\) into "TextEdit"\?$/);
    expect(describeStep({ op: 'click', app: 'Finder', target: { role: 'button', name: 'OK' }, button: 'right' })).toBe(
      'Right-click the button "OK" in "Finder"?',
    );
  });

  it('matches expected text across runs of spaces and line breaks, and names what is missing', () => {
    expect(missingText('Total\n195  351044', ['195 351044'])).toEqual([]);
    expect(missingText('Total 195', ['195', '351044'])).toEqual(['351044']);
  });
});

describe('a playbook run', () => {
  it('asks once for each action, and passes a check that finds every value', async () => {
    const asked: string[] = [];
    const exec = desktop('Method\tOrders\ncod\t171\t312468\nprepaid\t24\t38576');
    const result = await runAutomation(
      playbook([FILL, COPY, CHECK]),
      { mode: 'supervised', policy: POLICY, approve: async step => (asked.push(step.op), true) },
      exec,
    );
    expect(result.status).toBe('completed');
    expect(asked).toEqual(['fill_field', 'press_key']);
    expect(exec.calls).toEqual(['fill Finance!A1:D4 true', 'key cmd+c']);
    expect(result.postconditionsPassed).toBe(3);
  });

  it('asks only once when the person allows the whole run, and still stops at a denied step', async () => {
    let asked = 0;
    const approve = async (): Promise<Approval> => (asked++, 'run');
    const steps: Step[] = [FILL, COPY, { op: 'paste_text', ...SHEETS, text: 'x' }, CHECK];
    const result = await runAutomation(playbook(steps), { mode: 'supervised', policy: POLICY, approve }, desktop('cod\t171\t312468 prepaid\t24'));
    expect(result.status).toBe('completed');
    expect(asked).toBe(1);

    // An app on the exclusion list is denied even after the run was allowed.
    const denied = await runAutomation(
      playbook([FILL, { ...COPY, app: 'Slack' }]),
      { mode: 'supervised', policy: { ...POLICY, excludedApps: ['Slack'] }, approve },
      desktop(),
    );
    expect(denied.status).toBe('blocked');
    expect(denied.steps.at(-1)?.reason).toMatch(/exclusion list/);
  });

  it('fails the run when a check does not find every value, without keeping the text it read', async () => {
    const result = await runAutomation(playbook([CHECK]), { mode: 'supervised', policy: POLICY }, desktop('cod\t170'));
    expect(result.status).toBe('failed');
    expect(result.steps[0]).toMatchObject({ outcome: 'check_failed', reason: '2 of 2 expected values were not shown.' });
    expect(JSON.stringify(result)).not.toContain('cod\t170');
  });

  it('blocks before asking when the system cannot do a step, and blocks with the reason when the adapter refuses', async () => {
    let asked = 0;
    const approve = async () => (asked++, true);
    const missing = await runAutomation(playbook([FILL]), { mode: 'supervised', policy: POLICY, approve }, desktop('', { fillField: undefined }));
    expect(missing.status).toBe('blocked');
    expect(missing.steps[0].reason).toMatch(/cannot fill fields/);
    expect(asked).toBe(0);

    const refusing = desktop('', {
      fillField: async () => {
        throw new StepRefusedError('The field did not show the entered text, so it was not submitted.');
      },
    });
    const refused = await runAutomation(playbook([FILL]), { mode: 'supervised', policy: POLICY, approve }, refusing);
    expect(refused.status).toBe('blocked');
    expect(refused.steps[0].failureReason).toMatch(/not submitted/);
  });

  it('never acts unattended, even at level 4', async () => {
    const exec = desktop();
    const result = await runAutomation(playbook([FILL]), { mode: 'unattended', policy: { ...POLICY, level: 4, unattended: true } }, exec);
    expect(result.status).toBe('blocked');
    expect(exec.calls).toEqual([]);
  });
});

describe('TwinAgent.createPlaybook', () => {
  it('stores a draft at level 2 with its effects, refuses an invalid playbook, and keeps its name out of the export', () => {
    const agent = temps.track(new TwinAgent({ dataDir: temps.folder('twin-playbook-'), dataKey: randomBytes(32), now: () => 1_800_000_000_000 }));
    const view = agent.createPlaybook({ name: 'Quarter close check', steps: [FILL, COPY, CHECK] });
    expect(view.state.level).toBe(2);
    expect(view.state.effects).toEqual(expect.arrayContaining(['external_effect', 'read_only']));
    expect(view.automation.steps).toHaveLength(3);
    expect(() => agent.createPlaybook({ name: 'x', steps: [{ op: 'paste_text', app: 'Terminal', text: 'ls' }] })).toThrow(/not valid/);
    expect(() => agent.createPlaybook({ name: 'x', steps: [] })).toThrow(/not valid/);
    expect(JSON.stringify(agent.exportAll())).not.toContain('Quarter close check');
  });

  it('refuses a parameter in place of an app', () => {
    expect(PlaybookInputSchema.safeParse({ name: 'x', steps: [{ ...COPY, app: '$p0' }] }).success).toBe(false);
  });
});
