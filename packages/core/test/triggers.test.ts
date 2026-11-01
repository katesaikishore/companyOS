import { mkdtempSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRIGGER_RULES, TriggerGate, TwinAgent, openingApps, type Automation, type Executor } from '../src';
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

describe('TriggerGate declines', () => {
  it('keeps a decline across a restart, until its cooldown ends', () => {
    const before = new TriggerGate(() => at(0, 9));
    before.recordDecline('a');
    // A new gate after a restart, loaded with the declines the first one kept.
    let time = at(0, 10);
    const restarted = new TriggerGate(() => time, before.declineRecords());
    expect(restarted.eligible('a')).toBe(false);
    expect(restarted.eligible('b')).toBe(true);
    time = at(0, 9) + TRIGGER_RULES.declineCooldownMs;
    expect(restarted.eligible('a')).toBe(true);
  });

  it('doubles the wait with each decline in a row, and caps it at seven days', () => {
    let time = at(0, 9);
    const gate = new TriggerGate(() => time);
    const waitsInHours = [4, 8, 16, 32, 64, 128, 168, 168];
    for (const hours of waitsInHours) {
      gate.recordDecline('a');
      time += hours * HOUR - 60_000;
      expect(gate.eligible('a')).toBe(false);
      time += 60_000;
      expect(gate.eligible('a')).toBe(true);
    }
  });

  it('starts the count again after a reset', () => {
    let time = at(0, 9);
    const gate = new TriggerGate(() => time);
    gate.recordDecline('a');
    gate.recordDecline('a');
    expect(gate.resetDeclines('a')).toBe(true);
    expect(gate.resetDeclines('a')).toBe(false);
    gate.recordDecline('a');
    time += TRIGGER_RULES.declineCooldownMs;
    expect(gate.eligible('a')).toBe(true);
  });
});

describe('TwinAgent declines', () => {
  /** An agent on a clock the test moves. Ten working days are ingested, as the trigger tests above have them. */
  function withClock() {
    const dir = mkdtempSync(join(tmpdir(), 'twin-declines-'));
    const key = randomBytes(32);
    const clock = { now: at(10, 9) };
    const agent = new TwinAgent({ dataDir: dir, dataKey: key, now: () => clock.now });
    agent.updateConfig({ watchBrowsers: true });
    for (const signal of workdays(10)) agent.ingest(signal);
    return { agent, clock, dir, key };
  }
  type Context = ReturnType<typeof withClock>;

  /** Closes the agent and opens the same store again, as a restart does. The clock carries on. */
  function restart(context: Context): Context {
    context.agent.close();
    const agent = new TwinAgent({ dataDir: context.dir, dataKey: context.key, now: () => context.clock.now });
    return { ...context, agent };
  }

  /** Accepts the four-step routine and raises it to level 3, so the twin may offer it. */
  function acceptFourStep(agent: TwinAgent): string {
    const routine = agent.suggestions().find(suggestion => suggestion.routine.steps.length === 4)!.routine.id;
    const id = agent.acceptRoutine(routine).automation.id;
    agent.setLevel(id, 3);
    return id;
  }

  function focusingExecutor(): Executor {
    let front: string | undefined;
    return {
      focusApp: async app => {
        front = app;
        return true;
      },
      frontmostApp: async () => front,
    };
  }

  it('keeps a decline across a restart, and the wait runs from the decline', () => {
    let context = withClock();
    const id = acceptFourStep(context.agent);
    context.agent.recordDecline(id);
    context.clock.now += HOUR;
    context = restart(context);
    expect(context.agent.triggerCandidates('Microsoft Excel')).toEqual([]);
    context.clock.now += 4 * HOUR;
    expect(context.agent.triggerCandidates('Microsoft Excel')).toHaveLength(1);
    context.agent.close();
  });

  it('waits eight hours after a second decline in a row, even across a restart', () => {
    let context = withClock();
    const id = acceptFourStep(context.agent);
    context.agent.recordDecline(id);
    context.clock.now += 4 * HOUR;
    context = restart(context);
    context.agent.recordDecline(id);
    context.clock.now += 7 * HOUR;
    expect(context.agent.triggerCandidates('Microsoft Excel')).toEqual([]);
    context.clock.now += HOUR + 1;
    expect(context.agent.triggerCandidates('Microsoft Excel')).toHaveLength(1);
    context.agent.close();
  });

  it('counts a dismissal as a decline, so the next one waits eight hours', () => {
    const context = withClock();
    const id = acceptFourStep(context.agent);
    context.agent.dismissRoutine(context.agent.automations()[0].automation.routineId);
    context.agent.recordDecline(id);
    context.clock.now += 4 * HOUR + 1;
    expect(context.agent.triggerCandidates('Microsoft Excel')).toEqual([]);
    context.clock.now += 4 * HOUR;
    expect(context.agent.triggerCandidates('Microsoft Excel')).toHaveLength(1);
    context.agent.close();
  });

  it('starts the count again after a completed run', async () => {
    const context = withClock();
    const id = acceptFourStep(context.agent);
    context.agent.recordDecline(id);
    context.agent.recordDecline(id);
    const result = await context.agent.run(id, { mode: 'supervised', approve: async () => true }, focusingExecutor());
    expect(result.status).toBe('completed');
    context.agent.recordDecline(id);
    context.clock.now += 4 * HOUR + 1;
    expect(context.agent.triggerCandidates('Microsoft Excel')).toHaveLength(1);
    context.agent.close();
  });

  it('starts the count again when the routine is accepted', () => {
    const context = withClock();
    const routine = context.agent.suggestions().find(suggestion => suggestion.routine.steps.length === 4)!.routine.id;
    context.agent.dismissRoutine(routine);
    // A dismissed routine can still be accepted through the twin, and the accept starts its count again.
    const id = context.agent.acceptRoutine(routine).automation.id;
    context.agent.setLevel(id, 3);
    context.agent.recordDecline(id);
    context.clock.now += 4 * HOUR + 1;
    expect(context.agent.triggerCandidates('Microsoft Excel')).toHaveLength(1);
    context.agent.close();
  });
});
