import { mkdtempSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EncryptedStore, TwinAgent, legacyRoutineIdOf, signatureOf, type Routine } from '../src';
import { at, workdays } from './fixtures';

/**
 * Ten working days seen through the browser. The fixture plants a four-step routine with a browser site, so its id
 * changed when the site became part of the key. The routine's id from before that is its legacy id.
 */
function seeded() {
  const dir = mkdtempSync(join(tmpdir(), 'twin-relink-'));
  const key = randomBytes(32);
  const now = at(10, 0);
  const agent = new TwinAgent({ dataDir: dir, dataKey: key, now: () => now });
  agent.updateConfig({ watchBrowsers: true });
  for (const signal of workdays(10)) agent.ingest(signal);
  const routine = agent.suggestions().find(candidate => candidate.routine.steps.length === 4)!.routine;
  const legacy = legacyRoutineIdOf(routine)!;
  return { agent, dir, key, now, routine, legacy };
}

describe('legacy routine ids', () => {
  it('moves an accepted automation to the routine\'s new id, so the routine stays accepted after a restart', () => {
    const { agent, dir, key, now, routine, legacy } = seeded();
    agent.acceptRoutine(routine.id);

    // Rewrite the stored automation as it was before the site was kept.
    const store = new EncryptedStore(dir, key);
    const [automation] = store.readAll<Record<string, unknown>>('automations');
    store.replaceAll('automations', [{ ...automation, routineId: legacy }]);

    const reopened = new TwinAgent({ dataDir: dir, dataKey: key, now: () => now });
    expect(reopened.suggestions().some(candidate => candidate.routine.id === routine.id)).toBe(false);
    expect(reopened.automations()[0].automation.routineId).toBe(routine.id);
    expect(new EncryptedStore(dir, key).readAll<{ routineId: string }>('automations')[0].routineId).toBe(routine.id);
  });

  it('moves a dismissal to the new id, so the routine stays hidden, and keeps its signature', () => {
    const { agent, legacy, routine } = seeded();
    agent.updateConfig({ dismissedRoutineIds: [legacy] });

    expect(agent.suggestions().some(candidate => candidate.routine.id === routine.id)).toBe(false);
    expect(agent.configuration.dismissedRoutineIds).toEqual([routine.id]);
    expect(agent.configuration.dismissedRoutineSignatures).toContain(signatureOf(routine));
  });

  it('leaves a legacy dismissal alone when no detected routine has its id', () => {
    const { agent } = seeded();
    const unrelated = 'ffffffffffff';
    agent.updateConfig({ dismissedRoutineIds: [unrelated] });
    agent.suggestions();
    expect(agent.configuration.dismissedRoutineIds).toEqual([unrelated]);
  });
});
