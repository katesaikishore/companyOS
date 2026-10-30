import { mkdtempSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RoutineNamingJob, TwinAgent, type InstalledModel, type NamingModel } from '../src';
import { at, workdays } from './fixtures';

function seeded(days = 10): { agent: TwinAgent; dir: string; key: Buffer; now: number } {
  const dir = mkdtempSync(join(tmpdir(), 'twin-names-'));
  const key = randomBytes(32);
  const now = at(days, 0);
  const agent = new TwinAgent({ dataDir: dir, dataKey: key, now: () => now });
  agent.updateConfig({ watchBrowsers: true });
  for (const signal of workdays(days)) agent.ingest(signal);
  return { agent, dir, key, now };
}

function fourStepRoutineId(agent: TwinAgent): string {
  const found = agent.suggestions().find(suggestion => suggestion.routine.steps.length === 4);
  if (!found) throw new Error('The fixtures should suggest a four-step routine.');
  return found.routine.id;
}

describe('routine names from the local model', () => {
  it('shows a name set for a suggestion instead of the rule-based one', () => {
    const { agent } = seeded();
    const id = fourStepRoutineId(agent);
    expect(agent.suggestions().find(suggestion => suggestion.routine.id === id)?.preview.name).toMatch(/^Routine: /);

    agent.setRoutineName(id, 'Morning spreadsheet triage');
    expect(agent.suggestions().find(suggestion => suggestion.routine.id === id)?.preview.name).toBe(
      'Morning spreadsheet triage',
    );
  });

  it('gives an accepted automation the name it had when it was accepted', () => {
    const { agent } = seeded();
    const id = fourStepRoutineId(agent);
    agent.setRoutineName(id, 'Morning spreadsheet triage');
    expect(agent.acceptRoutine(id).automation.name).toBe('Morning spreadsheet triage');
  });

  it('lets an explicit name from the person win over the model name', () => {
    const { agent } = seeded();
    const id = fourStepRoutineId(agent);
    agent.setRoutineName(id, 'Model name');
    expect(agent.acceptRoutine(id, 'My own name').automation.name).toBe('My own name');
  });

  it('keeps the rule-based name for a routine with no model name', () => {
    const { agent } = seeded();
    const id = fourStepRoutineId(agent);
    expect(agent.acceptRoutine(id).automation.name).toMatch(/^Routine: /);
  });

  it('keeps names in memory only, so a restart names routines again', () => {
    const { agent, dir, key, now } = seeded();
    const id = fourStepRoutineId(agent);
    agent.setRoutineName(id, 'Morning spreadsheet triage');

    const reopened = new TwinAgent({ dataDir: dir, dataKey: key, now: () => now });
    expect(reopened.suggestions().find(suggestion => suggestion.routine.id === id)?.preview.name).toMatch(/^Routine: /);
    expect(JSON.stringify(agent.exportAll())).not.toContain('Morning spreadsheet triage');
  });

  it('forgets the oldest name once more than 200 are held', () => {
    const { agent } = seeded();
    const id = fourStepRoutineId(agent);
    agent.setRoutineName(id, 'Oldest name');
    for (let index = 0; index < 200; index++) agent.setRoutineName(`filler-${index}`, `Filler ${index}`);

    expect(agent.suggestions().find(suggestion => suggestion.routine.id === id)?.preview.name).toMatch(/^Routine: /);
  });

  it('keeps the newer names when the cap is reached', () => {
    const { agent } = seeded();
    const id = fourStepRoutineId(agent);
    for (let index = 0; index < 199; index++) agent.setRoutineName(`filler-${index}`, `Filler ${index}`);
    agent.setRoutineName(id, 'Kept name');
    agent.setRoutineName('filler-extra', 'Extra');

    expect(agent.suggestions().find(suggestion => suggestion.routine.id === id)?.preview.name).toBe('Kept name');
  });
});

/**
 * Five working days with two routines. One six-step routine alternates two long window classes, so its rule-based
 * name ("Routine: spreadsheet → terminal → ...") is 81 characters, over the 80-character limit of an automation.
 * The other is a normal three-step routine.
 */
function longAndNormal(): TwinAgent {
  const dir = mkdtempSync(join(tmpdir(), 'twin-long-names-'));
  const now = at(5, 0);
  const agent = new TwinAgent({ dataDir: dir, dataKey: randomBytes(32), now: () => now });
  for (let day = 0; day < 5; day++) {
    const long = ['Microsoft Excel', 'Terminal', 'Microsoft Excel', 'Terminal', 'Microsoft Excel', 'Terminal'];
    long.forEach((app, index) => agent.ingest({ kind: 'focus', ts: at(day, 9, index * 5), app }));
    agent.ingest({ kind: 'idle_start', ts: at(day, 9, 40) });
    const normal = ['Microsoft Excel', 'Microsoft Outlook', 'Slack'];
    normal.forEach((app, index) => agent.ingest({ kind: 'focus', ts: at(day, 11, index * 10), app }));
    agent.ingest({ kind: 'idle_start', ts: at(day, 11, 40) });
  }
  return agent;
}

const installed: InstalledModel = { id: 'qwen3-4b', sha256: 'a'.repeat(64), bytes: 1, installedAt: 1 };
const fakeModel: NamingModel = {
  complete: async () => ({ name: 'Monthly invoice check' }),
  warm: async () => undefined,
  stop: () => undefined,
};

describe('naming a routine whose rule-based name is too long', () => {
  it('lists only the routines that can compile, and names the normal one without throwing', async () => {
    const agent = longAndNormal();
    const routines = agent.analyze().routines;
    const normal = routines.find(routine => routine.steps.length === 3);
    if (!normal) throw new Error('The fixtures should mine a three-step routine.');
    expect(routines.some(routine => routine.steps.length === 6)).toBe(true);

    expect(() => agent.routinesToName()).not.toThrow();
    expect(agent.routinesToName().map(routine => routine.id)).toEqual([normal.id]);

    const job = new RoutineNamingJob({
      routines: () => agent.routinesToName(),
      rename: (routineId, name) => agent.setRoutineName(routineId, name),
      installed: () => [installed],
      preferredModelId: async () => 'qwen3-4b',
      modelPath: spec => `/models/${spec.file}`,
      verify: async () => true,
      openModel: () => fakeModel,
      allowed: () => true,
    });
    await expect(job.pass()).resolves.toBeUndefined();

    expect(agent.acceptRoutine(normal.id).automation.name).toBe('Monthly invoice check');
  });
});
