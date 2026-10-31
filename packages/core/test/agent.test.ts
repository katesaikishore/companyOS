import { mkdtempSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONFIG,
  EncryptedStore,
  RETENTION_DAYS,
  TwinAgent,
  mineRoutines,
  normalizeSignal,
  segment,
  type Executor,
  type HandoffView,
  type Routine,
  type TwinConfig,
  type TwinEvent,
} from '../src';
import { SECRET_QUERY, at, workdays } from './fixtures';

const DAY = 86_400_000;

function openAgent(dir: string, key: Buffer, now: number, claude?: MessagesClient): TwinAgent {
  return new TwinAgent({ dataDir: dir, dataKey: key, now: () => now, ...(claude ? { claude } : {}) });
}

function seeded(days = 10): { agent: TwinAgent; dir: string; key: Buffer; now: number } {
  const dir = mkdtempSync(join(tmpdir(), 'twin-agent-'));
  const key = randomBytes(32);
  const now = at(days, 0);
  const agent = openAgent(dir, key, now);
  agent.updateConfig({ watchBrowsers: true });
  for (const signal of workdays(days)) agent.ingest(signal);
  return { agent, dir, key, now };
}

function focusingExecutor(): Executor & { focusApp: ReturnType<typeof vi.fn> } {
  let current: string | undefined;
  const focusApp = vi.fn(async (app: string) => {
    current = app;
    return true;
  });
  return { focusApp, frontmostApp: async () => current };
}

describe('privacy at ingest', () => {
  it('never stores excluded apps, secure input, URL queries or secrets', () => {
    const { agent } = seeded(10);
    const stored = JSON.stringify(agent.exportAll());
    expect(stored).not.toContain(SECRET_QUERY);
    expect(stored).not.toContain('token=');
    const events = (agent.exportAll() as { events: TwinEvent[] }).events;
    expect(events.some(event => event.app === '1password')).toBe(false);
    expect(events.find(event => event.urlTemplate)?.urlTemplate).toBe('docs.example.com/doc');
  });

  it('rejects a capture adapter that sends a window title', () => {
    const { agent } = seeded(1);
    expect(() => agent.ingest({ kind: 'focus', ts: at(0, 12), app: 'Slack', title: 'Salary review' })).toThrow();
  });
});

describe('routine to automation', () => {
  it('detects, accepts, and keeps the routine as a level 2 draft', () => {
    const { agent } = seeded(10);
    const suggestion = agent.suggestions().find(s => s.routine.steps.length === 4);
    expect(suggestion).toBeDefined();
    const view = agent.acceptRoutine(suggestion!.routine.id);
    expect(view.state.level).toBe(2);
    expect(agent.suggestions().some(s => s.routine.id === suggestion!.routine.id)).toBe(false);
  });

  it('draft runs are dry runs and never touch the executor', async () => {
    const { agent } = seeded(10);
    const view = agent.acceptRoutine(agent.suggestions()[0].routine.id);
    const executor = focusingExecutor();
    const result = await agent.run(view.automation.id, { mode: 'dry_run' }, executor);
    expect(result.status).toBe('dry_run');
    expect(executor.focusApp).not.toHaveBeenCalled();
    await expect(agent.run(view.automation.id, { mode: 'supervised' }, executor)).rejects.toThrow(/level 3/);
  });

  it('supervised run at level 3 asks before each external step and records the run', async () => {
    const { agent } = seeded(10);
    const id = agent.acceptRoutine(agent.suggestions().find(s => s.routine.steps.length === 4)!.routine.id).automation.id;
    agent.setLevel(id, 3);
    const approve = vi.fn(async () => true);
    const result = await agent.run(id, { mode: 'supervised', approve }, focusingExecutor());
    expect(result.status).toBe('completed');
    expect(approve).toHaveBeenCalledTimes(2);
    expect(agent.automations()[0].state.runs).toHaveLength(1);
  });

  it('a reverted run drops the automation back to level 3', async () => {
    const { agent } = seeded(10);
    const id = agent.acceptRoutine(agent.suggestions()[0].routine.id).automation.id;
    agent.setLevel(id, 3);
    await agent.run(id, { mode: 'supervised', approve: async () => true }, focusingExecutor());
    expect(agent.revertLastRun(id).state.runs.at(-1)?.reverted).toBe(true);
    expect(agent.automations()[0].state.level).toBe(3);
  });

  it('is not eligible for unattended runs with too little history', () => {
    const { agent } = seeded(10);
    const view = agent.acceptRoutine(agent.suggestions()[0].routine.id);
    expect(view.promotion.eligible).toBe(false);
    expect(view.promotion.reasons.join(' ')).toMatch(/supervised runs/);
  });
});

describe('persistence and retention', () => {
  it('reopens with the same automations and settings', () => {
    const { dir, key, now, agent } = seeded(10);
    agent.acceptRoutine(agent.suggestions()[0].routine.id);
    agent.updateConfig({ idleGapMs: 30 * 60_000 });
    const reopened = openAgent(dir, key, now);
    expect(reopened.automations()).toHaveLength(1);
    expect(reopened.configuration.idleGapMs).toBe(30 * 60_000);
  });

  it('prunes events past 90 days', () => {
    const { dir, key, agent } = seeded(10);
    const later = openAgent(dir, key, at(10, 0) + 100 * DAY);
    expect(later.prune()).toBeGreaterThan(0);
    expect((later.exportAll() as { events: unknown[] }).events).toHaveLength(0);
    expect(agent).toBeDefined();
  });

  it('prunes at the RETENTION_DAYS window the Overview reports', () => {
    const { dir, key } = seeded(10);
    // The window ends exactly at the start of the newest day, so every older day is dropped and that day is kept.
    const later = openAgent(dir, key, at(9, 0) + RETENTION_DAYS * DAY);
    later.prune();
    const kept = (later.exportAll() as { events: TwinEvent[] }).events;
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every(event => event.ts >= at(9, 0))).toBe(true);
  });

  it('prunes handoffs past the same window by send time, and a read still returns at most 100', () => {
    const dir = mkdtempSync(join(tmpdir(), 'twin-handoff-prune-'));
    const key = randomBytes(32);
    const sentAt = at(0, 9);
    const agent = openAgent(dir, key, sentAt);
    const handoffSentAt = (id: string, time: number): HandoffView => ({
      id,
      automationId: 'auto_0123456789ab',
      routineName: 'Invoice follow-up',
      target: 'Lead Bot',
      brief: 'Summarise the follow-ups',
      apps: ['Slack'],
      sentAt: time,
      state: 'completed',
      summary: 'Done.',
      localFailure: false,
    });
    for (let index = 0; index < 3; index++) agent.recordHandoff(handoffSentAt(`old-${index}`, sentAt - (RETENTION_DAYS + 10) * DAY + index));
    for (let index = 0; index < 101; index++) agent.recordHandoff(handoffSentAt(`new-${index}`, sentAt - DAY + index));
    agent.close();

    const later = openAgent(dir, key, sentAt + 5 * DAY);
    expect(later.prune()).toBe(3);
    const read = later.handoffs();
    expect(read).toHaveLength(100);
    expect(read.every(item => item.id.startsWith('new-'))).toBe(true);
    expect((later.exportAll() as { handoffs: HandoffView[] }).handoffs).toHaveLength(101);
    later.close();
  });
});

describe('review fixes', () => {
  function plain(): { agent: TwinAgent; dir: string; key: Buffer; now: number } {
    const dir = mkdtempSync(join(tmpdir(), 'twin-review-'));
    const key = randomBytes(32);
    const now = at(10, 0);
    return { agent: openAgent(dir, key, now), dir, key, now };
  }

  function routineId(agent: TwinAgent): string {
    return agent.suggestions().find(s => s.routine.steps.length === 4)!.routine.id;
  }

  it('does not record browser activity with the default settings', () => {
    const { agent } = plain();
    expect(agent.ingest({ kind: 'focus', ts: at(0, 10), app: 'Google Chrome' })).toBe(false);
    expect((agent.exportAll() as { events: unknown[] }).events).toHaveLength(0);
  });

  it('forgets stored events of an app once it is excluded', () => {
    const { agent } = seeded(3);
    agent.updateConfig({ excludedApps: [...agent.configuration.excludedApps, 'slack'] });
    const events = (agent.exportAll() as { events: TwinEvent[] }).events;
    expect(events.some(event => event.app === 'slack')).toBe(false);
    expect(events.some(event => event.app === 'microsoft outlook')).toBe(true);
  });

  it('refuses a second run of the same automation while one is in flight', async () => {
    const { agent } = seeded(10);
    const id = agent.acceptRoutine(routineId(agent)).automation.id;
    agent.setLevel(id, 3);
    let release!: (ok: boolean) => void;
    const pending = new Promise<boolean>(resolve => {
      release = resolve;
    });
    const first = agent.run(id, { mode: 'supervised', approve: () => pending }, focusingExecutor());
    await expect(agent.run(id, { mode: 'dry_run' }, focusingExecutor())).rejects.toThrow(/already running/);
    release(true);
    await first;
  });

  it('a kill switch pressed during a run stops the steps that have not started', async () => {
    const { agent } = seeded(10);
    const id = agent.acceptRoutine(routineId(agent)).automation.id;
    agent.setLevel(id, 3);
    let release!: (ok: boolean) => void;
    const pending = new Promise<boolean>(resolve => {
      release = resolve;
    });
    const run = agent.run(id, { mode: 'supervised', approve: () => pending }, focusingExecutor());
    agent.setLevel(id, 2);
    release(true);
    const result = await run;
    expect(result.status).toBe('blocked');
    expect(agent.automations()[0].state.level).toBe(2);
  });
});

describe('dismissals, the automations switch, the ledger and the overview', () => {
  function seededAgent(days = 10) {
    const dir = mkdtempSync(join(tmpdir(), 'twin-overview-'));
    const key = randomBytes(32);
    const now = at(days, 0);
    const agent = openAgent(dir, key, now);
    agent.updateConfig({ watchBrowsers: true });
    for (const signal of workdays(days)) agent.ingest(signal);
    return { agent, dir, key, now };
  }

  it('a dismissed routine is not suggested again, and survives a restart', () => {
    const { agent, dir, key, now } = seededAgent(10);
    const id = agent.suggestions().find(suggestion => suggestion.routine.steps.length === 4)!.routine.id;
    agent.dismissRoutine(id);
    expect(agent.suggestions().some(suggestion => suggestion.routine.id === id)).toBe(false);
    expect(openAgent(dir, key, now).suggestions().some(suggestion => suggestion.routine.id === id)).toBe(false);
  });

  it('stopping automations blocks every run, but a dry run still previews', async () => {
    const { agent } = seededAgent(10);
    const id = agent.acceptRoutine(agent.suggestions()[0].routine.id).automation.id;
    agent.setLevel(id, 3);
    agent.updateConfig({ automationsEnabled: false });
    const executor = { focusApp: vi.fn(async () => true), frontmostApp: async () => undefined };
    await expect(agent.run(id, { mode: 'supervised', approve: async () => true }, executor)).rejects.toThrow(/stopped/);
    expect(executor.focusApp).not.toHaveBeenCalled();
    await expect(agent.run(id, { mode: 'dry_run' }, executor)).resolves.toMatchObject({ status: 'dry_run' });
  });

  it('records network calls, shows them newest last, and keeps them through export', () => {
    const { agent } = seededAgent(3);
    agent.recordNetworkCall({ ts: 1, purpose: 'model_download', modelId: 'a', host: 'huggingface.co', path: '/x', bytes: 10, sha256Verified: true, outcome: 'ok' });
    agent.recordNetworkCall({ ts: 2, purpose: 'model_download', modelId: 'b', host: 'huggingface.co', path: '/y', bytes: 0, sha256Verified: false, outcome: 'failed' });
    expect(agent.networkLedger().map(entry => entry.modelId)).toEqual(['a', 'b']);
    expect((agent.exportAll() as { network: unknown[] }).network).toHaveLength(2);
  });

  it('records installed models once per id, and removes them', () => {
    const { agent } = seededAgent(3);
    agent.markModelInstalled({ id: 'qwen3-4b', sha256: 'a'.repeat(64), bytes: 1, installedAt: 1 });
    agent.markModelInstalled({ id: 'qwen3-4b', sha256: 'b'.repeat(64), bytes: 2, installedAt: 2 });
    expect(agent.configuration.installedModels).toEqual([{ id: 'qwen3-4b', sha256: 'b'.repeat(64), bytes: 2, installedAt: 2 }]);
    agent.removeModelRecord('qwen3-4b');
    expect(agent.configuration.installedModels).toEqual([]);
  });

  it('marks setup complete and keeps the theme', () => {
    const { agent, dir, key, now } = seededAgent(3);
    agent.updateConfig({ theme: 'dark' });
    agent.completeSetup();
    const reopened = openAgent(dir, key, now);
    expect(reopened.configuration.setupCompleted).toBe(true);
    expect(reopened.configuration.theme).toBe('dark');
  });

  it('counts focus switches by weekday and hour over four weeks', () => {
    const { agent } = seededAgent(10);
    const grid = agent.activityGrid(28);
    expect(grid).toHaveLength(7);
    expect(grid.every(row => row.length === 24)).toBe(true);
    const total = grid.flat().reduce((sum, value) => sum + value, 0);
    expect(total).toBe(agent.observed().recordedFocusEvents);
    expect(grid[new Date(at(9, 9)).getDay() === 0 ? 6 : new Date(at(9, 9)).getDay() - 1][9]).toBeGreaterThan(0);
  });

  it('reports observed days and the store size without reading content', () => {
    const { agent } = seededAgent(10);
    expect(agent.observed().observedDays).toBeGreaterThanOrEqual(9);
    expect(agent.storageBytes()).toBeGreaterThan(0);
  });

  it('gives an accepted automation a time estimate from the routine', () => {
    const { agent } = seededAgent(10);
    const view = agent.acceptRoutine(agent.suggestions()[0].routine.id);
    expect(view.automation.estimate?.occurrencesPerWeek).toBeGreaterThan(0);
    expect(view.automation.estimate?.minutesPerWeek).toBeGreaterThan(0);
  });
});

describe('near copies of a dismissed routine', () => {
  const SHEET = ['Microsoft Excel', 'Microsoft Word', 'Slack', 'Figma'];
  const NEAR = ['Microsoft Excel', 'Microsoft Word', 'Microsoft Outlook', 'Figma'];
  const OTHER = ['Figma', 'Slack', 'Microsoft Excel', 'Microsoft Outlook'];
  const SHEET_FLOW = 'microsoft excel > microsoft word > slack > figma';
  const NEAR_FLOW = 'microsoft excel > microsoft word > microsoft outlook > figma';
  const OTHER_FLOW = 'figma > slack > microsoft excel > microsoft outlook';

  /** One stretch of work at a regular pace, then an idle break that ends it. */
  function sitting(day: number, hour: number, apps: string[]): Array<Record<string, unknown>> {
    const focus = apps.map((app, index) => ({ kind: 'focus', ts: at(day, hour, index * 10), app }));
    return [...focus, { kind: 'idle_start', ts: at(day, hour, 40) }];
  }

  /** Six days of one routine, four days of its near copy (one app changed), and an unrelated routine on every day. */
  function nearCopies() {
    const dir = mkdtempSync(join(tmpdir(), 'twin-near-'));
    const key = randomBytes(32);
    const now = at(10, 0);
    const agent = openAgent(dir, key, now);
    for (let day = 0; day < 10; day++) {
      for (const signal of sitting(day, 9, day < 6 ? SHEET : NEAR)) agent.ingest(signal);
      for (const signal of sitting(day, 14, OTHER)) agent.ingest(signal);
    }
    return { agent, dir, key, now };
  }

  /** The apps of a routine in order, so a test can name the routine it means. */
  function flowOf(routine: Routine): string {
    return routine.steps.map(step => step.app).join(' > ');
  }

  it('hides a near copy of a dismissed routine, and keeps an unrelated routine', () => {
    const { agent, dir, key, now } = nearCopies();
    const flows = () => agent.suggestions().map(suggestion => flowOf(suggestion.routine));
    expect(flows()).toEqual(expect.arrayContaining([SHEET_FLOW, NEAR_FLOW, OTHER_FLOW]));

    const sheet = agent.suggestions().find(suggestion => flowOf(suggestion.routine) === SHEET_FLOW)!.routine.id;
    agent.dismissRoutine(sheet);
    expect(flows()).toEqual([OTHER_FLOW]);
    expect(agent.routinesToName().map(routine => flowOf(routine))).toEqual([OTHER_FLOW]);
    agent.close();

    const reopened = openAgent(dir, key, now);
    expect(reopened.suggestions().map(suggestion => flowOf(suggestion.routine))).toEqual([OTHER_FLOW]);
    reopened.close();
  });

  it('exports the dismissal and its decline, and a wipe removes both', () => {
    const { agent, dir, key, now } = nearCopies();
    const sheet = agent.suggestions().find(suggestion => flowOf(suggestion.routine) === SHEET_FLOW)!.routine.id;
    agent.dismissRoutine(sheet);
    const config = (agent.exportAll() as { config: TwinConfig }).config;
    // Names only as the twin already keeps them: window classes here, and the same keys the routine is mined under.
    expect(config.dismissedRoutineSignatures).toEqual(['spreadsheet>document>chat>design']);
    expect(config.declinedRoutines).toEqual([{ routineId: sheet, at: now, count: 1 }]);
    agent.wipe();

    const after = openAgent(dir, key, now);
    expect(after.configuration.dismissedRoutineSignatures).toEqual([]);
    expect(after.configuration.declinedRoutines).toEqual([]);
    after.close();
  });

  it('still counts a near copy in readiness, where it is shown as dismissed', () => {
    const { agent } = nearCopies();
    const near = agent.suggestions().find(suggestion => flowOf(suggestion.routine) === NEAR_FLOW)!.routine.id;
    const sheet = agent.suggestions().find(suggestion => flowOf(suggestion.routine) === SHEET_FLOW)!.routine.id;
    agent.dismissRoutine(sheet);
    const learned = agent.readiness().rows.flatMap(row => row.learned);
    expect(learned.find(item => item.routineId === near)?.status).toBe('dismissed');
    agent.close();
  });
});

describe('renaming an automation', () => {
  it('changes only the name, and keeps the name across a restart', async () => {
    const { agent, dir, key, now } = seeded(10);
    const id = agent.acceptRoutine(agent.suggestions()[0].routine.id).automation.id;
    agent.setLevel(id, 3);
    await agent.run(id, { mode: 'supervised', approve: async () => true }, focusingExecutor());
    const before = agent.automations()[0];
    const renamed = agent.renameAutomation(id, 'Month-end sheet');
    expect(renamed.automation).toEqual({ ...before.automation, name: 'Month-end sheet' });
    expect(renamed.state).toEqual(before.state);
    agent.close();
    expect(openAgent(dir, key, now).automations()[0].automation.name).toBe('Month-end sheet');
  });

  it('refuses a blank name and an unknown automation, and cuts a long name to fit as an accepted routine is', () => {
    const { agent } = seeded(10);
    const id = agent.acceptRoutine(agent.suggestions()[0].routine.id).automation.id;
    expect(() => agent.renameAutomation(id, '   ')).toThrow('Give the automation a name.');
    expect(() => agent.renameAutomation('auto_000000000000', 'Name')).toThrow('Unknown automation.');
    const cut = agent.renameAutomation(id, 'x'.repeat(120)).automation.name;
    expect(cut).toHaveLength(80);
    expect(cut.endsWith('…')).toBe(true);
    agent.close();
  });
});

describe('settings saved by an earlier version', () => {
  it('opens with no declines and no dismissed signatures', () => {
    const dir = mkdtempSync(join(tmpdir(), 'twin-old-settings-'));
    const key = randomBytes(32);
    const earlier: Record<string, unknown> = { ...DEFAULT_CONFIG };
    delete earlier.dismissedRoutineSignatures;
    delete earlier.declinedRoutines;
    const store = new EncryptedStore(dir, key);
    store.replaceAll('settings', [earlier]);
    store.close();
    const agent = openAgent(dir, key, at(0, 9));
    expect(agent.configuration.dismissedRoutineSignatures).toEqual([]);
    expect(agent.configuration.declinedRoutines).toEqual([]);
    agent.close();
  });
});
