import { describe, expect, it } from 'vitest';
import type { DecisionAnswer, DecisionModel, DecisionRequest, DecisionResult } from '../src/decision';
import { PICK_MAX_OPTIONS, candidatesOf, pickTarget, type PickCandidate } from '../src/picker';

const candidates: PickCandidate[] = [
  { ref: '@s1:e1', role: 'treeitem', name: 'Applications', region: 'sidebar "Favourites"', actions: ['Click'] },
  { ref: '@s1:e2', role: 'button', name: 'Delete', actions: ['Click'] },
  { ref: '@s1:e3', role: 'textfield', name: 'Search', actions: ['SetValue'] },
];

const abstained: DecisionResult = { status: 'abstained', reason: 'no_model' };

function choice(choiceId: string, probabilities: Record<string, number>, confidence: number): DecisionResult {
  return { status: 'answered', answer: { kind: 'choice', choice: choiceId, probabilities, confidence } };
}

function rating(probability: number): DecisionResult {
  return { status: 'answered', answer: { kind: 'noul', probability, confidence: Math.max(probability, 1 - probability) } };
}

/** A model that gives fixed answers, and records every request it was sent. */
function fakeModel(choiceAnswer: DecisionResult, ratingAnswer: DecisionResult = abstained) {
  const calls: DecisionRequest[] = [];
  const model: DecisionModel & { calls: DecisionRequest[] } = {
    id: 'fake',
    calls,
    async decide(request) {
      calls.push(request);
      return request.question.kind === 'choice' ? choiceAnswer : ratingAnswer;
    },
  };
  return model;
}

const picksApplications = { c0: 0.95, c1: 0.02, c2: 0.01, none: 0.02 };

describe('pickTarget', () => {
  it('acts on a confident choice without rating its risk', async () => {
    const model = fakeModel(choice('c0', picksApplications, 0.95));
    const outcome = await pickTarget('open the Applications folder', candidates, model);
    expect(outcome).toMatchObject({ decision: 'act', reason: 'act', ref: '@s1:e1', confidence: 0.95, truncated: false });
    expect(model.calls.map(call => call.question.kind)).toEqual(['choice']);
  });

  it('acts on a choice between the two bars when the step is not hard to undo', async () => {
    const model = fakeModel(choice('c0', { c0: 0.8, c1: 0.1, c2: 0.05, none: 0.05 }, 0.8), rating(0.1));
    const outcome = await pickTarget('open the Applications folder', candidates, model);
    expect(outcome).toMatchObject({ decision: 'act', ref: '@s1:e1', confidence: 0.8 });
    expect(model.calls.map(call => call.question.kind)).toEqual(['choice', 'noul']);
  });

  it('stops on a choice between the two bars when the step is hard to undo, and names it', async () => {
    const model = fakeModel(choice('c1', { c0: 0.05, c1: 0.8, c2: 0.1, none: 0.05 }, 0.8), rating(0.9));
    const outcome = await pickTarget('remove the old files', candidates, model);
    expect(outcome).toMatchObject({ decision: 'stop', reason: 'needs_confirmation', ref: '@s1:e2', confidence: 0.8 });
  });

  it('counts a rating that does not come back as hard to undo', async () => {
    const model = fakeModel(choice('c0', { c0: 0.8, c1: 0.1, c2: 0.05, none: 0.05 }, 0.8), abstained);
    const outcome = await pickTarget('open the Applications folder', candidates, model);
    expect(outcome).toMatchObject({ decision: 'stop', reason: 'needs_confirmation', ref: '@s1:e1' });
  });

  it('stops below the ordinary bar without rating, and names the candidate', async () => {
    const model = fakeModel(choice('c0', { c0: 0.6, c1: 0.2, c2: 0.1, none: 0.1 }, 0.6));
    const outcome = await pickTarget('open the Applications folder', candidates, model);
    expect(outcome).toMatchObject({ decision: 'stop', reason: 'needs_confirmation', ref: '@s1:e1' });
    expect(model.calls.map(call => call.question.kind)).toEqual(['choice']);
  });

  it('stops below the floor, and does not name a candidate to act on', async () => {
    const model = fakeModel(choice('c0', { c0: 0.4, c1: 0.3, c2: 0.2, none: 0.1 }, 0.4));
    const outcome = await pickTarget('open the Applications folder', candidates, model);
    expect(outcome).toMatchObject({ decision: 'stop', reason: 'low_confidence', ref: '@s1:e1', confidence: 0.4 });
  });

  it('stops when the model chooses none', async () => {
    const model = fakeModel(choice('none', { c0: 0.1, c1: 0.1, c2: 0.1, none: 0.7 }, 0.7));
    const outcome = await pickTarget('book a flight', candidates, model);
    expect(outcome).toMatchObject({ decision: 'stop', reason: 'chose_none' });
    expect(outcome.ref).toBeUndefined();
  });

  it('stops when the model names an option that is not on the screen', async () => {
    const model = fakeModel(choice('c9', { c9: 0.99 }, 0.99));
    expect(await pickTarget('open the Applications folder', candidates, model)).toMatchObject({ reason: 'unknown_option' });
  });

  it('stops when the model abstains, and does not act', async () => {
    const outcome = await pickTarget('open the Applications folder', candidates, fakeModel(abstained));
    expect(outcome).toMatchObject({ decision: 'stop', reason: 'model_abstained' });
    expect(outcome.ref).toBeUndefined();
  });

  it('stops when the model answers with the wrong kind of answer', async () => {
    const wrongKind: DecisionAnswer = { kind: 'score', score: 1, probabilities: { '0': 1 }, confidence: 1 };
    const outcome = await pickTarget('open the Applications folder', candidates, fakeModel({ status: 'answered', answer: wrongKind }));
    expect(outcome).toMatchObject({ decision: 'stop', reason: 'not_answered' });
  });

  it('asks nothing when the screen has no actionable element', async () => {
    const model = fakeModel(abstained);
    const outcome = await pickTarget('open the Applications folder', [], model);
    expect(outcome).toMatchObject({ decision: 'stop', reason: 'no_candidates' });
    expect(model.calls).toHaveLength(0);
  });

  it('names the runner-up by its ref', async () => {
    const model = fakeModel(choice('c0', { c0: 0.9, c1: 0.03, c2: 0.06, none: 0.01 }, 0.9));
    const outcome = await pickTarget('open the Applications folder', candidates, model);
    expect(outcome.runnerUp).toEqual({ ref: '@s1:e3', probability: 0.06 });
  });

  it('sends the model option ids and descriptions, never the refs', async () => {
    const model = fakeModel(choice('c0', picksApplications, 0.95));
    await pickTarget('open the Applications folder', candidates, model);
    const question = model.calls[0].question;
    expect(question.kind).toBe('choice');
    if (question.kind !== 'choice') return;
    expect(question.options.map(option => option.id)).toEqual(['c0', 'c1', 'c2', 'none']);
    expect(question.options[0].description).toBe('treeitem "Applications" in sidebar "Favourites"');
    expect(JSON.stringify(model.calls[0])).not.toContain('@s1');
  });

  it('cuts a long screen to the option limit and says so', async () => {
    const many: PickCandidate[] = Array.from({ length: PICK_MAX_OPTIONS + 5 }, (_, i) => ({
      ref: `@s1:e${i}`,
      role: 'button',
      name: `Item ${i}`,
      actions: ['Click'],
    }));
    const model = fakeModel(choice('c0', { c0: 0.95 }, 0.95));
    const outcome = await pickTarget('open item 0', many.slice(0, PICK_MAX_OPTIONS), model, true);
    expect(outcome.truncated).toBe(true);
    const question = model.calls[0].question;
    expect(question.kind === 'choice' && question.options).toHaveLength(PICK_MAX_OPTIONS + 1);
  });
});

describe('candidatesOf', () => {
  const snapshot = {
    command: 'snapshot',
    data: {
      app: 'Finder',
      tree: {
        role: 'window',
        name: 'Finder',
        children: [
          {
            role: 'sidebar',
            name: 'Sidebar',
            children: [{ role: 'treeitem', name: 'Applications', ref_id: '@s1:e1', available_actions: ['Click'] }],
          },
          { role: 'statictext', name: 'label' },
          { role: 'button', name: 'Close', ref_id: '@s1:e2', available_actions: ['Click'] },
          { role: 'button', name: 'Hidden', ref_id: '@s1:e3', available_actions: [] },
        ],
      },
    },
  };

  it('keeps the elements that have a ref and an action, with their named region', () => {
    const { candidates: found, truncated } = candidatesOf(snapshot);
    expect(truncated).toBe(false);
    expect(found).toEqual([
      { ref: '@s1:e1', role: 'treeitem', name: 'Applications', region: 'sidebar "Sidebar"', actions: ['Click'] },
      { ref: '@s1:e2', role: 'button', name: 'Close', region: 'window "Finder"', actions: ['Click'] },
    ]);
  });

  it('returns nothing for a snapshot with no tree', () => {
    expect(candidatesOf({ data: {} }).candidates).toEqual([]);
    expect(candidatesOf(null).candidates).toEqual([]);
  });

  it('marks a screen longer than the limit as truncated', () => {
    const children = Array.from({ length: 5 }, (_, i) => ({ role: 'button', name: `b${i}`, ref_id: `@s1:e${i}`, available_actions: ['Click'] }));
    const { candidates: found, truncated } = candidatesOf({ data: { tree: { children } } }, 3);
    expect(found).toHaveLength(3);
    expect(truncated).toBe(true);
  });
});
