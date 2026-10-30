import { mkdtempSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRIGGER_RULES, TriggerGate, TwinAgent, openingApps, type Automation } from '../src';
import { at, workdays } from './fixtures';

const HOUR = 60 * 60_000;

function automation(steps: Automation['steps'], params: Automation['params'] = []): Automation {
  return { id: 'auto_test', name: 'Test', version: 1, routineId: 'test', params, steps };
}

describe('openingApps', () => {
  it('uses the first focus step app', () => {
    expect(openingApps(automation([{ op: 'focus_app', app: 'microsoft excel' }, { op: 'check_focus', app: 'microsoft excel' }]))).toEqual(['microsoft excel']);
  });

  it('uses every observed option when the first app is a parameter', () => {
    const params = [{ name: 'p0', options: ['microsoft excel', 'libreoffice calc'], default: 'microsoft excel' }];
    expect(openingApps(automation([{ op: 'focus_app', app: '$p0' }], params))).toEqual(['microsoft excel', 'libreoffice calc']);
  });

  it('offers nothing when the routine does not begin by focusing an app', () => {
    expect(openingApps(automation([{ op: 'check_focus', app: 'slack' }, { op: 'focus_app', app: 'slack' }]))).toEqual([]);
  });
});

describe('TriggerGate', () => {
  it('offers a routine, then leaves it alone for an hour', () => {
    let time = at(0, 9);
    const gate = new TriggerGate(() => time);
    expect(gate.eligible('a')).toBe(true);
    gate.recordOffer('a');
    time += 30 * 60_000;
    expect(gate.eligible('a')).toBe(false);
    time += 31 * 60_000;
    expect(gate.eligible('a')).toBe(true);
  });

  it('keeps a declined routine quiet for four hours, and does not affect other routines', () => {
    let time = at(0, 9);
    const gate = new TriggerGate(() => time);
    gate.recordDecline('a');
    time += 2 * HOUR;
    expect(gate.eligible('a')).toBe(false);
    expect(gate.eligible('b')).toBe(true);
    time += 2 * HOUR + 60_000;
    expect(gate.eligible('a')).toBe(true);
  });

  it('caps offers per routine per day', () => {
    let time = at(0, 6);
    const gate = new TriggerGate(() => time);
    for (let offer = 0; offer < TRIGGER_RULES.maxOffersPerDay; offer++) {
      expect(gate.eligible('a')).toBe(true);
      gate.recordOffer('a');
      time += TRIGGER_RULES.offerCooldownMs + 60_000;
    }
    expect(gate.eligible('a')).toBe(false);
    time += 24 * HOUR;
    expect(gate.eligible('a')).toBe(true);
  });

  it('stays quiet after a run, so the run cannot trigger itself', () => {
    let time = at(0, 9);
    const gate = new TriggerGate(() => time);
    gate.quietAfterRun();
    expect(gate.eligible('a')).toBe(false);
    time += TRIGGER_RULES.quietAfterRunMs + 1;
    expect(gate.eligible('a')).toBe(true);
  });
});

describe('TwinAgent.triggerCandidates', () => {
  function seeded() {
    const dir = mkdtempSync(join(tmpdir(), 'twin-trigger-'));
    const key = randomBytes(32);
    const now = at(10, 0);
    const agent = new TwinAgent({ dataDir: dir, dataKey: key, now: () => now });
    agent.updateConfig({ watchBrowsers: true });
    for (const signal of workdays(10)) agent.ingest(signal);
    return agent;
  }

  it('offers only routines at level 3 or above, for the app that opens them', () => {
    const agent = seeded();
    const id = agent.acceptRoutine(agent.suggestions().find(suggestion => suggestion.routine.steps.length === 4)!.routine.id).automation.id;
    expect(agent.triggerCandidates('Microsoft Excel')).toEqual([]);
    agent.setLevel(id, 3);
    expect(agent.triggerCandidates('Microsoft Excel').map(view => view.automation.id)).toEqual([id]);
    expect(agent.triggerCandidates('LibreOffice Calc')).toHaveLength(1);
  });

  it('does not offer for an app that appears later in the routine', () => {
    const agent = seeded();
    const id = agent.acceptRoutine(agent.suggestions().find(suggestion => suggestion.routine.steps.length === 4)!.routine.id).automation.id;
    agent.setLevel(id, 3);
    expect(agent.triggerCandidates('Slack')).toEqual([]);
    expect(agent.triggerCandidates('Google Chrome')).toEqual([]);
  });

  it('offers nothing while automations are stopped', () => {
    const agent = seeded();
    const id = agent.acceptRoutine(agent.suggestions().find(suggestion => suggestion.routine.steps.length === 4)!.routine.id).automation.id;
    agent.setLevel(id, 3);
    agent.updateConfig({ automationsEnabled: false });
    expect(agent.triggerCandidates('Microsoft Excel')).toEqual([]);
  });
});
