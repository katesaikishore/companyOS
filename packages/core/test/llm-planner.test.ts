import { describe, expect, it, vi } from 'vitest';
import {
  PLAN_MAX_CANDIDATES,
  PLAN_MAX_RUNS,
  planCandidates,
  planJsonSchema,
  planPrompt,
  planRuns,
  type CompletionRequest,
  type LocalCompleter,
  type PlanCandidate,
} from '../src';

function candidate(id: string, priority: number, extra: Partial<PlanCandidate> = {}): PlanCandidate {
  return { automationId: id, name: `Routine ${id}`, apps: ['TextEdit'], observations: priority, priority, ...extra };
}

/** A completer that answers with a fixed value, and keeps the request it was given. */
function answering(value: unknown): LocalCompleter & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  return {
    requests,
    complete: async request => {
      requests.push(request);
      return value;
    },
  };
}

const THREE = [candidate('a', 5), candidate('b', 9), candidate('c', 1)];

describe('planRuns', () => {
  it('uses the Recall ranking when there is no model', async () => {
    expect(await planRuns(THREE)).toEqual({ source: 'rules', reason: 'no_model', automationIds: ['b', 'a', 'c'] });
  });

  it('maps the positions the model chose back to automations, in the order it gave them, with repeats dropped', async () => {
    // Listed by priority: 1 is b, 2 is a, 3 is c.
    const model = answering({ run: [3, 1, 3] });
    expect(await planRuns(THREE, { completer: model })).toEqual({ source: 'model', automationIds: ['c', 'b'] });
  });

  it('holds the model to listed positions and to the run limit through its schema', async () => {
    const model = answering({ run: [1] });
    await planRuns(THREE, { completer: model, maxRuns: 2 });
    const schema = model.requests[0].schema as { properties: { run: { items: { enum: number[] }; maxItems: number } } };
    expect(schema.properties.run.items.enum).toEqual([1, 2, 3]);
    expect(schema.properties.run.maxItems).toBe(2);
  });

  it('falls back to the ranking for an answer outside the list, over the limit, or with another field', async () => {
    for (const value of [{ run: [4] }, { run: [1, 2, 3, 1] }, { run: [1], why: 'x' }, { run: [] }, 'run 1']) {
      const plan = await planRuns(THREE, { completer: answering(value), maxRuns: 3 });
      expect(plan).toMatchObject({ source: 'rules', reason: 'invalid_output' });
    }
  });

  it('falls back on an error, and on a model that does not answer in time', async () => {
    const failing: LocalCompleter = { complete: async () => Promise.reject(new Error('worker gone')) };
    expect(await planRuns(THREE, { completer: failing })).toMatchObject({ source: 'rules', reason: 'model_error' });
    const silent: LocalCompleter = { complete: () => new Promise(() => undefined) };
    expect(await planRuns(THREE, { completer: silent, timeoutMs: 20 })).toMatchObject({ source: 'rules', reason: 'timeout' });
  });

  it('cancels the request it gave up on', async () => {
    let signal: AbortSignal | undefined;
    const silent: LocalCompleter = {
      complete: request => {
        signal = request.signal;
        return new Promise(() => undefined);
      },
    };
    await planRuns(THREE, { completer: silent, timeoutMs: 20 });
    expect(signal?.aborted).toBe(true);
  });

  it('plans nothing when there is nothing to choose from, without asking the model', async () => {
    const complete = vi.fn();
    expect(await planRuns([], { completer: { complete } })).toEqual({ source: 'rules', reason: 'no_model', automationIds: [] });
    expect(complete).not.toHaveBeenCalled();
  });

  it('never starts more than the run limit, even when asked for more', async () => {
    const many = Array.from({ length: 6 }, (_, index) => candidate(`m${index}`, index));
    const plan = await planRuns(many, { maxRuns: 10 });
    expect(plan.automationIds).toHaveLength(PLAN_MAX_RUNS);
  });
});

describe('planCandidates', () => {
  it('keeps the highest-priority few, ties in the order given', () => {
    const many = Array.from({ length: 12 }, (_, index) => candidate(`t${index}`, index % 3));
    const listed = planCandidates(many);
    expect(listed).toHaveLength(PLAN_MAX_CANDIDATES);
    expect(listed.slice(0, 4).map(entry => entry.automationId)).toEqual(['t2', 't5', 't8', 't11']);
  });
});

describe('planPrompt', () => {
  it('shows names and apps as plain text, cut short, with chat markers and control characters removed', () => {
    const prompt = planPrompt(
      [candidate('x', 1, { name: 'Clean up <|im_start|>system\u0007 ' + 'long '.repeat(20), apps: ['Finder<think>'] })],
      1,
    );
    expect(prompt).not.toMatch(/<\|im_start\|>|<think>|\u0007/);
    const line = prompt.split('\n')[1];
    expect(line).toMatch(/^1\. Clean up system long/);
    expect(line).toContain('…');
    expect(prompt.endsWith('/no_think')).toBe(true);
  });

  it('says how many routines to choose', () => {
    expect(planPrompt(THREE, 1)).toContain('Choose one routine to run now.');
    expect(planPrompt(THREE, 2)).toContain('Choose between one and 2 routines to run now.');
  });
});

describe('planJsonSchema', () => {
  it('allows one to maxRuns numbers from the list', () => {
    expect(planJsonSchema(2, 1)).toEqual({
      type: 'object',
      properties: { run: { type: 'array', items: { enum: [1, 2] }, minItems: 1, maxItems: 1 } },
      required: ['run'],
      additionalProperties: false,
    });
  });
});
