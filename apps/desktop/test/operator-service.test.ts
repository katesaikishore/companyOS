import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Observation, type OperatorHands, type OperatorModel } from '@companyos/twin-core';
import { OperatorService, describeAction, type OperatorModelChoice } from '../src/main/operator-service';

const slack: Observation = { app: 'Slack', controls: [{ ref: '@s:e1', role: 'button', name: 'Send now' }] };
const textEdit: Observation = { app: 'TextEdit', controls: [{ ref: '@t:e1', role: 'button', name: 'New Document' }] };

function setup(options: { model?: OperatorModelChoice; replies?: unknown[]; observation?: Observation; path?: string; key?: boolean; brokenHands?: boolean; slowModel?: Promise<void>; modelError?: string } = {}) {
  const prompts: string[] = [];
  const acted: string[] = [];
  let i = 0;
  const model: OperatorModel = {
    async complete(request) {
      prompts.push(request.prompt);
      if (options.modelError) throw new Error(options.modelError);
      return options.replies?.[i++] ?? { action: 'done', reason: 'Finished.' };
    },
  };
  const hands: OperatorHands = {
    async observe() {
      return options.observation ?? textEdit;
    },
    async act(action) {
      acted.push(action.type);
      return { delivery: 'delivered' };
    },
  };
  let changes = 0;
  const shares: boolean[] = [];
  const service = new OperatorService({
    config: () => ({ excludedApps: DEFAULT_CONFIG.excludedApps, agentDesktopPath: options.path ?? '/opt/homebrew/bin/agent-desktop', operatorModel: options.model ?? 'local' }),
    hands: () => {
      if (options.brokenHands) throw new Error('The agent-desktop program path must be absolute.');
      return hands;
    },
    model: async (choice, modelOptions) => {
      shares.push(modelOptions.sharesScreenText);
      if (options.slowModel) await options.slowModel;
      return choice === 'chutes' && options.key === false ? undefined : model;
    },
    ownApps: ['companyOS Twin', 'companyOS', 'Electron'],
    memory: () => ['TextEdit, today: Tue client presentation, final draft due'],
    hasChutesKey: () => options.key !== false,
    onChange: () => {
      changes += 1;
    },
  });
  return { service, prompts, acted, shares, changes: () => changes };
}

/** Waits until the service's view matches, checking on each turn of the event loop. */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise(resolve => setTimeout(resolve, 5));
  if (!check()) throw new Error('timed out');
}

describe('OperatorService', () => {
  it('runs a task to the end and keeps its steps and result for the page', async () => {
    const { service, acted } = setup({ replies: [{ action: 'click', ref: '@t:e1', name: '', reason: 'open' }, { action: 'done', ref: '', name: '', reason: 'Written.' }] });
    await service.start({ goal: 'Write a note', app: 'TextEdit' });
    await until(() => service.view().state === 'idle' && service.view().result !== undefined);
    const view = service.view();
    expect(view.result).toEqual({ status: 'done', summary: 'Written.' });
    expect(view.steps.map(step => [step.text, step.outcome])).toEqual([
      ['Click "New Document"', 'landed'],
      ['Finished: Written.', 'finished'],
    ]);
    expect(acted).toEqual(['click']);
  });

  it('holds a step for the person, and carries out only what they approve', async () => {
    const { service, acted } = setup({ observation: slack, replies: [{ action: 'click', ref: '@s:e1', name: '', reason: 'send' }, { action: 'done', ref: '', name: '', reason: 'Sent.' }] });
    await service.start({ goal: 'Reply to Jordan', app: 'Slack' });
    await until(() => service.view().state === 'waiting');
    const waiting = service.view().pending!;
    expect(waiting.text).toBe('Click "Send now"');
    expect(acted).toHaveLength(0);
    service.answer(waiting.id, true);
    await until(() => service.view().state === 'idle');
    expect(acted).toEqual(['click']);
    expect(service.view().result?.status).toBe('done');
  });

  it('declines the waiting step and ends the task on Stop', async () => {
    const { service, acted } = setup({ observation: slack, replies: [{ action: 'click', ref: '@s:e1', name: '', reason: 'send' }] });
    await service.start({ goal: 'Reply', app: 'Slack' });
    await until(() => service.view().state === 'waiting');
    service.stop();
    await until(() => service.view().state === 'idle');
    expect(acted).toHaveLength(0);
    expect(['stopped', 'declined']).toContain(service.view().result?.status);
  });

  it('refuses an answer for a step that is no longer waiting', async () => {
    const { service } = setup();
    expect(() => service.answer('00000000-0000-0000-0000-000000000000', true)).toThrow('no longer waiting');
  });

  it('starts nothing without the agent-desktop path, a Chutes key when Chutes is chosen, or a valid request', async () => {
    await expect(setup({ path: '' }).service.start({ goal: 'x', app: 'TextEdit' })).rejects.toThrow('agent-desktop');
    await expect(setup({ model: 'chutes', key: false }).service.start({ goal: 'x', app: 'TextEdit' })).rejects.toThrow('Chutes key');
    await expect(setup().service.start({ goal: '', app: 'TextEdit' })).rejects.toThrow('Describe the task');
    await expect(setup().service.start({ goal: 'x', app: '-rf' })).rejects.toThrow('name of the app');
  });

  it('sends memory notes to a local model, and to Chutes only when the person ticks the box', async () => {
    const local = setup();
    await local.service.start({ goal: 'Write the week', app: 'TextEdit' });
    await until(() => local.prompts.length > 0);
    expect(local.prompts[0]).toContain('final draft due');

    const remote = setup({ model: 'chutes' });
    await remote.service.start({ goal: 'Write the week', app: 'TextEdit' });
    await until(() => remote.prompts.length > 0);
    expect(remote.prompts[0]).not.toContain('final draft due');

    const shared = setup({ model: 'chutes' });
    await shared.service.start({ goal: 'Write the week', app: 'TextEdit', shareMemory: true });
    await until(() => shared.prompts.length > 0);
    expect(shared.prompts[0]).toContain('final draft due');
  });

  it('is never left running when the hands cannot be built', async () => {
    const { service } = setup({ brokenHands: true });
    await expect(service.start({ goal: 'x', app: 'TextEdit' })).rejects.toThrow('absolute');
    expect(service.view().state).toBe('idle');
    await expect(service.start({ goal: 'x', app: 'TextEdit' })).rejects.toThrow('absolute');
  });

  it('stops a task while its model is still loading', async () => {
    let release: () => void = () => undefined;
    const { service, acted } = setup({ slowModel: new Promise<void>(resolve => (release = resolve)) });
    const starting = service.start({ goal: 'x', app: 'TextEdit' });
    expect(service.view().state).toBe('running');
    service.stop();
    release();
    await starting;
    expect(service.view()).toMatchObject({ state: 'idle', result: { status: 'stopped' } });
    expect(acted).toHaveLength(0);
  });

  it('refuses to operate its own window', async () => {
    const { service } = setup();
    await service.start({ goal: 'Read the recall page', app: 'companyOS Twin' });
    await until(() => service.view().state === 'idle' && service.view().result !== undefined);
    expect(service.view().result?.status).toBe('refused');
  });

  it('tells the model whether Chutes calls carry screen text', async () => {
    const off = setup({ model: 'chutes' });
    await off.service.start({ goal: 'x', app: 'TextEdit' });
    const on = setup({ model: 'chutes' });
    await on.service.start({ goal: 'x', app: 'TextEdit', shareMemory: true });
    expect([off.shares[0], on.shares[0]]).toEqual([false, true]);
  });

  it('shows typed text in full on the approval', async () => {
    const long = 'Hello Sam,\n' + 'x'.repeat(300);
    const field: Observation = { app: 'Mail', controls: [{ ref: '@m:e1', role: 'textarea', name: 'Message Body' }] };
    const { service } = setup({ observation: field, replies: [{ action: 'type', ref: '@m:e1', name: '', text: long, reason: 'write' }] });
    await service.start({ goal: 'Reply', app: 'Mail' });
    await until(() => service.view().state === 'waiting');
    expect(service.view().pending?.detail).toBe(long);
    service.stop();
  });

  it('shows why the model did not answer on the step and in the result', async () => {
    const why = 'Chutes refused the key (401). Remove the key on the Tasks page and save one that works.';
    const { service } = setup({ model: 'chutes', modelError: why });
    await service.start({ goal: 'Open Downloads', app: 'TextEdit' });
    await until(() => service.view().state === 'idle' && service.view().result !== undefined);
    expect(service.view().steps).toEqual([{ n: 1, text: 'The model did not answer', outcome: 'no_answer', why }]);
    expect(service.view().result).toEqual({ status: 'failed', summary: why });
  });

  it('runs one task at a time', async () => {
    const { service } = setup({ observation: slack, replies: [{ action: 'click', ref: '@s:e1', name: '', reason: 'send' }] });
    await service.start({ goal: 'Reply', app: 'Slack' });
    await expect(service.start({ goal: 'Another', app: 'Slack' })).rejects.toThrow('already running');
    service.stop();
  });
});

describe('describeAction', () => {
  it('says each step in plain words', () => {
    expect(describeAction({ type: 'type', ref: '@x', text: 'Hello', reason: 'x' }, 'Message')).toBe('Type "Hello" into "Message"');
    expect(describeAction({ type: 'press', keys: 'cmd+n', reason: 'x' })).toBe('Press cmd+n');
    expect(describeAction({ type: 'launch', app: 'Notes', reason: 'x' })).toBe('Open Notes');
  });
});
