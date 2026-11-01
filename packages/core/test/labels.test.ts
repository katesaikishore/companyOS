import { describe, expect, it } from 'vitest';
import {
  KIND_LABELS,
  KIND_MIN_CONFIDENCE,
  KindLabelJob,
  hasUnknownStep,
  kindQuestion,
  labelKind,
  ruleKindOfClass,
  ruleKindOfSteps,
  type KindLabeling,
  type KindStep,
} from '../src/labels';
import type { DecisionModel, DecisionRequest, DecisionResult } from '../src/decision';

const known: KindStep[] = [
  { app: 'excel', windowClass: 'spreadsheet' },
  { app: 'outlook', windowClass: 'mail' },
  { app: 'excel', windowClass: 'spreadsheet' },
];
const unknown: KindStep[] = [
  { app: 'arc', windowClass: 'other' },
  { app: 'linear', windowClass: 'other' },
];
const mixed: KindStep[] = [
  { app: 'arc', windowClass: 'other' },
  { app: 'word', windowClass: 'document' },
];

/** A model that answers with the given result, or throws, and records what it was asked. */
function fakeModel(outcome: DecisionResult | 'throw'): DecisionModel & { requests: DecisionRequest[] } {
  const requests: DecisionRequest[] = [];
  return {
    id: 'fake',
    requests,
    async decide(request: DecisionRequest): Promise<DecisionResult> {
      requests.push(request);
      if (outcome === 'throw') throw new Error('the model failed');
      return outcome;
    },
  };
}

const answered = (choice: string, confidence: number): DecisionResult => ({
  status: 'answered',
  answer: { kind: 'choice', choice, probabilities: { [choice]: confidence }, confidence },
});

describe('rule-based kinds', () => {
  it('maps each window class to its kind, and an unknown class to Other', () => {
    expect(ruleKindOfClass('browser')).toBe('Web');
    expect(ruleKindOfClass('editor')).toBe('Code');
    expect(ruleKindOfClass('spreadsheet')).toBe('Spreadsheets');
    expect(ruleKindOfClass('document')).toBe('Documents');
    expect(ruleKindOfClass('mail')).toBe('Email');
    expect(ruleKindOfClass('chat')).toBe('Messages');
    expect(ruleKindOfClass('terminal')).toBe('Terminal');
    expect(ruleKindOfClass('design')).toBe('Design');
    expect(ruleKindOfClass('other')).toBe('Other');
  });

  it('takes the most common kind of a routine, ignoring steps that have none', () => {
    const steps: KindStep[] = [
      { app: 'a', windowClass: 'document' },
      { app: 'b', windowClass: 'spreadsheet' },
      { app: 'c', windowClass: 'document' },
      { app: 'd', windowClass: 'other' },
    ];
    expect(ruleKindOfSteps(steps)).toBe('Documents');
  });

  it('is Mixed when no kind is more than half of the steps, and Other when no step has a kind', () => {
    expect(
      ruleKindOfSteps([
        { app: 'a', windowClass: 'mail' },
        { app: 'b', windowClass: 'chat' },
      ]),
    ).toBe('Mixed');
    expect(
      ruleKindOfSteps([
        { app: 'a', windowClass: 'spreadsheet' },
        { app: 'b', windowClass: 'mail' },
        { app: 'c', windowClass: 'chat' },
        { app: 'd', windowClass: 'browser' },
      ]),
    ).toBe('Mixed');
    expect(
      ruleKindOfSteps([
        { app: 'a', windowClass: 'mail' },
        { app: 'b', windowClass: 'mail' },
        { app: 'c', windowClass: 'chat' },
      ]),
    ).toBe('Email');
    expect(ruleKindOfSteps(unknown)).toBe('Other');
  });

  it('reports a routine with a step the catalogue does not know', () => {
    expect(hasUnknownStep(known)).toBe(false);
    expect(hasUnknownStep(mixed)).toBe(true);
  });
});

describe('labelKind', () => {
  it('uses the rules, and does not ask the model, when every step is known', async () => {
    const model = fakeModel(answered('Documents', 0.99));
    const labeling = await labelKind(known, model);
    expect(labeling).toEqual({ kind: 'Spreadsheets', source: 'rule', reason: 'all_known' });
    expect(model.requests).toHaveLength(0);
  });

  it('shows the model label when it is one of the kinds and confident enough', async () => {
    const model = fakeModel(answered('Documents', 0.8));
    const labeling = await labelKind(unknown, model);
    expect(labeling).toEqual({ kind: 'Documents', source: 'model', confidence: 0.8 });
  });

  it('keeps the rule label below the confidence threshold', async () => {
    const model = fakeModel(answered('Documents', KIND_MIN_CONFIDENCE - 0.01));
    expect(await labelKind(mixed, model)).toEqual({ kind: 'Documents', source: 'rule', reason: 'low_confidence' });
  });

  it('accepts a label exactly at the threshold, and rejects a confidence that is not a number', async () => {
    expect((await labelKind(unknown, fakeModel(answered('Email', KIND_MIN_CONFIDENCE))))).toMatchObject({ source: 'model' });
    expect(await labelKind(unknown, fakeModel(answered('Email', Number.NaN)))).toMatchObject({ source: 'rule', reason: 'low_confidence' });
  });

  it('keeps the rule label when the model answers Other', async () => {
    expect(await labelKind(unknown, fakeModel(answered('Other', 0.99)))).toEqual({ kind: 'Other', source: 'rule', reason: 'other' });
  });

  it('keeps the rule label when the answer is not one of the kinds', async () => {
    expect(await labelKind(unknown, fakeModel(answered('Hacking', 0.99)))).toMatchObject({ source: 'rule', reason: 'invalid' });
  });

  it('keeps the rule label on an abstention, and says why', async () => {
    expect(await labelKind(unknown, fakeModel({ status: 'abstained', reason: 'no_model' }))).toMatchObject({ reason: 'no_model' });
    expect(await labelKind(unknown, fakeModel({ status: 'abstained', reason: 'unavailable' }))).toMatchObject({ reason: 'unavailable' });
  });

  it('keeps the rule label when the model throws', async () => {
    expect(await labelKind(unknown, fakeModel('throw'))).toMatchObject({ source: 'rule', reason: 'unavailable' });
  });

  it('sends only the app names, once each, and the fixed kinds with their meanings', async () => {
    const model = fakeModel(answered('Email', 0.9));
    await labelKind([{ app: 'Arc', windowClass: 'other' }, { app: 'arc', windowClass: 'other' }, { app: 'Linear', windowClass: 'other' }], model);
    const [request] = model.requests;
    expect(request.state).toEqual({ apps: ['arc', 'linear'] });
    expect(request.question.kind).toBe('choice');
    expect(kindQuestion().options.map(option => option.id)).toEqual([...KIND_LABELS]);
    expect(request.question).toEqual(kindQuestion());
  });
});

describe('KindLabelJob', () => {
  function job(overrides: Partial<ConstructorParameters<typeof KindLabelJob>[0]> & { model: DecisionModel }) {
    const stored: Array<{ routineId: string; labeling: KindLabeling }> = [];
    const instance = new KindLabelJob({
      routines: () => [
        { routineId: 'r1', steps: unknown },
        { routineId: 'r2', steps: mixed },
      ],
      setKind: (routineId, labeling) => stored.push({ routineId, labeling }),
      available: () => true,
      allowed: () => true,
      ...overrides,
    });
    return { instance, stored };
  }

  it('stores each routine it labels', async () => {
    const { instance, stored } = job({ model: fakeModel(answered('Messages', 0.9)) });
    expect(await instance.pass()).toBe(2);
    expect(stored.map(entry => entry.routineId)).toEqual(['r1', 'r2']);
    expect(stored[0].labeling).toMatchObject({ kind: 'Messages', source: 'model' });
  });

  it('does nothing when the model is not installed, or when work is not allowed', async () => {
    const model = fakeModel(answered('Messages', 0.9));
    expect(await job({ model, available: () => false }).instance.pass()).toBe(0);
    expect(await job({ model, allowed: () => false }).instance.pass()).toBe(0);
    expect(model.requests).toHaveLength(0);
  });

  it('stops at the first unavailable model, and stores nothing for it, so it is tried again later', async () => {
    const model = fakeModel({ status: 'abstained', reason: 'unavailable' });
    const { instance, stored } = job({ model });
    expect(await instance.pass()).toBe(0);
    expect(stored).toHaveLength(0);
    expect(model.requests).toHaveLength(1);
  });

  it('does not store a no-model answer either', async () => {
    const { instance, stored } = job({ model: fakeModel({ status: 'abstained', reason: 'no_model' }) });
    expect(await instance.pass()).toBe(0);
    expect(stored).toHaveLength(0);
  });

  it('labels at most perPass routines in one pass', async () => {
    const model = fakeModel(answered('Email', 0.9));
    const { instance, stored } = job({ model, perPass: 1 });
    expect(await instance.pass()).toBe(1);
    expect(stored).toHaveLength(1);
  });

  it('is busy while a pass runs, and refuses a second pass at the same time', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const slow: DecisionModel = {
      id: 'slow',
      async decide(): Promise<DecisionResult> {
        await gate;
        return answered('Email', 0.9);
      },
    };
    const { instance } = job({ model: slow, perPass: 1 });
    const first = instance.pass();
    expect(instance.busy).toBe(true);
    expect(await instance.pass()).toBe(0);
    release();
    expect(await first).toBe(1);
    expect(instance.busy).toBe(false);
  });
});
