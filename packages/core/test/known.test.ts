import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TwinAgent, describeWhen, routineIdOf, signatureOf, type Routine } from '../src';
import { at, workdays } from './fixtures';
import { tempFolders } from './temp-folders';

const temps = tempFolders();

const DAY = 86_400_000;

function openAgent(dir: string, key: Buffer, now: number): TwinAgent {
  return temps.track(new TwinAgent({ dataDir: dir, dataKey: key, now: () => now }));
}

/** Ten working days seen through the browser, so the four-step routine is detected with its site. */
function seeded(days = 10) {
  const dir = temps.folder('twin-known-');
  const key = randomBytes(32);
  const now = at(days, 0);
  const agent = openAgent(dir, key, now);
  agent.updateConfig({ watchBrowsers: true });
  for (const signal of workdays(days)) agent.ingest(signal);
  return { agent, dir, key, now };
}

/** The detected routine with four steps, the one the fixture plants. */
function fourStep(agent: TwinAgent): Routine {
  const suggestion = agent.suggestions().find(candidate => candidate.routine.steps.length === 4);
  if (!suggestion) throw new Error('The fixture should detect a four-step routine.');
  return suggestion.routine;
}

describe('knownRoutines', () => {
  it('names a detected routine by its steps, its site and its usual time, as suggested', () => {
    const { agent } = seeded();
    const routine = fourStep(agent);
    const suggestion = agent.suggestions().find(candidate => candidate.routine.id === routine.id)!;
    const view = agent.knownRoutines().routines.find(item => item.routineId === routine.id)!;

    expect(view).toMatchObject({ name: suggestion.preview.name, status: 'suggested', when: describeWhen(routine.when) });
    expect(view.steps.map(step => step.app)).toEqual(routine.steps.map(step => step.app));
    expect(view.steps[0].alternatives).toBe(routine.steps[0].options.length - 1);
    expect(view.steps.find(step => step.site !== undefined)?.site).toBe('docs.example.com/doc');
    expect(view.automationId).toBeUndefined();
  });

  it('shows the name the local model gave a routine', () => {
    const { agent } = seeded();
    const routine = fourStep(agent);
    agent.setRoutineName(routine.id, 'Month-end close');
    expect(agent.knownRoutines().routines.find(item => item.routineId === routine.id)?.name).toBe('Month-end close');
  });

  it('leaves a dismissed routine out of the list, and shows it with what the person said no to, with its count', () => {
    const { agent, now } = seeded();
    const id = fourStep(agent).id;
    agent.dismissRoutine(id);
    const view = agent.knownRoutines();

    expect(view.routines.some(item => item.routineId === id)).toBe(false);
    expect(view.declined).toEqual([{ routineId: id, name: expect.any(String), dismissed: true, declines: 1, at: now }]);
  });

  it('keeps an accepted routine listed as its automation, under the name it was given', () => {
    const { agent } = seeded();
    const id = fourStep(agent).id;
    const automation = agent.acceptRoutine(id, 'Invoice follow-up').automation;
    const view = agent.knownRoutines().routines.find(item => item.routineId === id);

    expect(view).toMatchObject({ status: 'accepted', name: 'Invoice follow-up', automationId: automation.id, level: 2 });
  });

  it('lists a declined offer with its count in a row, and drops it once the decline is reset', () => {
    const { agent } = seeded();
    const id = fourStep(agent).id;
    const automationId = agent.acceptRoutine(id).automation.id;
    agent.recordDecline(automationId);
    agent.recordDecline(automationId);

    expect(agent.knownRoutines().declined).toEqual([expect.objectContaining({ routineId: id, dismissed: false, declines: 2 })]);
    agent.resetDecline(id);
    expect(agent.knownRoutines().declined).toEqual([]);
    expect(agent.configuration.declinedRoutines).toEqual([]);
  });

  it('shows an accepted routine that is no longer detected from its automation, with no time and no site', () => {
    const { agent, dir, key } = seeded();
    const id = fourStep(agent).id;
    const automation = agent.acceptRoutine(id, 'Invoice follow-up').automation;
    agent.close();

    // Two months on, the events are outside the analysis window, so the routine is no longer detected.
    const later = openAgent(dir, key, at(10, 0) + 60 * DAY);
    const view = later.knownRoutines().routines.find(item => item.routineId === id);

    expect(view).toMatchObject({ status: 'accepted', name: 'Invoice follow-up', automationId: automation.id, level: 2 });
    expect(view?.when).toBeUndefined();
    expect(view?.steps.every(step => step.site === undefined)).toBe(true);
    expect(view?.steps).toHaveLength(automation.steps.filter(step => step.op === 'focus_app').length);
    later.close();
  });
});

describe('resetDecline', () => {
  it('lifts a dismissal, so the routine is suggested again, and that holds after a restart', () => {
    const { agent, dir, key, now } = seeded();
    const id = fourStep(agent).id;
    agent.dismissRoutine(id);
    expect(agent.suggestions().some(suggestion => suggestion.routine.id === id)).toBe(false);

    agent.resetDecline(id);
    expect(agent.suggestions().some(suggestion => suggestion.routine.id === id)).toBe(true);
    expect(agent.knownRoutines().declined).toEqual([]);
    agent.close();

    const reopened = openAgent(dir, key, now);
    expect(reopened.suggestions().some(suggestion => suggestion.routine.id === id)).toBe(true);
    reopened.close();
  });

  it('finds the signature of a dismissed routine by its id, so a reset works once the routine is no longer detected', () => {
    const { agent, dir, key, now } = seeded();
    const routine = fourStep(agent);
    agent.dismissRoutine(routine.id);
    expect(agent.configuration.dismissedRoutineSignatures).toEqual([signatureOf(routine)]);
    agent.close();

    const later = openAgent(dir, key, at(10, 0) + 60 * DAY);
    expect(later.knownRoutines().declined).toEqual([
      expect.objectContaining({ routineId: routine.id, dismissed: true, name: undefined, declines: 1 }),
    ]);
    later.resetDecline(routine.id);
    expect(later.configuration.dismissedRoutineIds).toEqual([]);
    expect(later.configuration.dismissedRoutineSignatures).toEqual([]);
    later.close();

    const back = openAgent(dir, key, now);
    expect(back.suggestions().some(suggestion => suggestion.routine.id === routine.id)).toBe(true);
    back.close();
  });

  it('lets an offer come back once the decline is reset', () => {
    const { agent } = seeded();
    const id = fourStep(agent).id;
    const view = agent.acceptRoutine(id);
    agent.setLevel(view.automation.id, 3);
    agent.recordDecline(view.automation.id);
    expect(agent.triggerCandidates('Microsoft Excel')).toEqual([]);

    agent.resetDecline(id);
    expect(agent.triggerCandidates('Microsoft Excel').map(candidate => candidate.automation.id)).toEqual([view.automation.id]);
  });

  it('changes nothing for an id with nothing to reset', () => {
    const { agent } = seeded();
    const before = agent.configuration;
    agent.resetDecline(routineIdOf('nothing was declined'));
    expect(agent.configuration).toEqual(before);
  });
});

describe('routine ids', () => {
  it('gives each detected routine the id of its signature, so a stored signature names its routine', () => {
    const { agent } = seeded();
    const routines = agent.analyze().routines;
    expect(routines.length).toBeGreaterThan(0);
    for (const routine of routines) expect(routineIdOf(signatureOf(routine))).toBe(routine.id);
  });
});
