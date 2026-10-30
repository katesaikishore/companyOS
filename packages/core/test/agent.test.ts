import { mkdtempSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CloudTraceSchema,
  Pseudonymizer,
  TwinAgent,
  buildCloudTrace,
  mineRoutines,
  normalizeSignal,
  segment,
  type Executor,
  type MessagesClient,
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
    expect(events.find(event => event.urlTemplate)?.urlTemplate).toBe('docs.example.com/doc/:id/edit');
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

describe('cloud naming', () => {
  it('is off by default', async () => {
    const { agent } = seeded(10);
    await expect(agent.requestName(agent.suggestions()[0].routine.id)).rejects.toThrow(/off/);
  });

  it('sends only the strict trace and records it in the ledger', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'twin-cloud-'));
    const key = randomBytes(32);
    const now = at(10, 0);
    const seed = openAgent(dir, key, now);
    for (const signal of workdays(10)) seed.ingest(signal);
    const create = vi.fn(async () => ({
      content: [{ type: 'text', text: JSON.stringify({ name: 'Weekly reconciliation', description: 'Moves numbers from a sheet to mail and chat.' }) }],
      stop_reason: 'end_turn',
    }));
    const agent = openAgent(dir, key, now, { messages: { create } });
    agent.updateConfig({ cloudEnabled: true });

    const routineId = agent.suggestions().find(s => s.routine.steps.length === 4)!.routine.id;
    const name = await agent.requestName(routineId);

    expect(name?.name).toBe('Weekly reconciliation');
    const body = JSON.stringify(create.mock.calls[0][0]);
    for (const raw of ['excel', 'calc', 'outlook', 'slack', 'chrome', 'docs.example.com', SECRET_QUERY]) {
      expect(body.toLowerCase()).not.toContain(raw);
    }
    expect(body).toContain('claude-opus-5-5');
    expect(agent.ledger()).toHaveLength(1);
    expect(agent.ledger()[0]).toMatchObject({ outcome: 'ok', purpose: 'name_automation' });
  });
});

describe('trace schema', () => {
  it('refuses a trace with an extra raw field', () => {
    const events: TwinEvent[] = workdays(10)
      .map((signal, i) => normalizeSignal(signal, { excludedApps: [], newId: () => `e${i}` }))
      .filter((e): e is TwinEvent => e !== null);
    const routine = mineRoutines(segment(events, 3_600_000)).find(r => r.steps.length === 4)!;
    const trace = buildCloudTrace(routine, new Pseudonymizer(Buffer.alloc(32, 9)));
    expect(() => CloudTraceSchema.parse({ ...trace, url: 'https://x.example' })).toThrow();
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
});
