import { mkdtempSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TwinAgent } from '../src';
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
});
