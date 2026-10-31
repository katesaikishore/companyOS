import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONFIG,
  NAMING_SYSTEM_PROMPT,
  ROUTINE_NAME_JSON_SCHEMA,
  RoutineNameOutputSchema,
  mineRoutines,
  namingPrompt,
  nameRoutine,
  normalizeSignal,
  segment,
  type CompletionRequest,
  type LocalCompleter,
  type Routine,
  type TwinEvent,
} from '../src';
import { SECRET_QUERY, siteWorkdays, workdays } from './fixtures';

/** Routines mined from the seeded working days, the same data the engine uses in the app. */
function minedRoutines(days = 10): Routine[] {
  const events = workdays(days)
    .map(signal => normalizeSignal(signal, { excludedApps: DEFAULT_CONFIG.excludedApps, watchBrowsers: true }))
    .filter((event): event is TwinEvent => event !== null);
  return mineRoutines(segment(events, DEFAULT_CONFIG.idleGapMs));
}

function routine(): Routine {
  const found = minedRoutines().find(candidate => candidate.steps.length === 4);
  if (!found) throw new Error('The fixtures should mine a four-step routine.');
  return found;
}

/** A fake model. It records each request, and answers with whatever the test gives it. */
function fakeModel(answer: () => unknown): LocalCompleter & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  return {
    requests,
    complete: async request => {
      requests.push(request);
      return answer();
    },
  };
}

describe('naming prompt', () => {
  it('carries app names, step positions and counts', () => {
    const prompt = namingPrompt(routine());
    expect(prompt).toMatch(/Steps in order \(4 steps\):/);
    expect(prompt).toContain('1. microsoft excel');
    expect(prompt).toContain('2. microsoft outlook');
    expect(prompt).toMatch(/Seen in \d+ work sessions on \d+ days, about [\d.]+ times a week\./);
  });

  it('never carries URLs, query strings or secrets', () => {
    // The routine has a browser step with a URL template, so the absence below is a real check.
    expect(routine().steps.some(step => step.urlTemplate === 'docs.example.com/doc')).toBe(true);
    const prompt = namingPrompt(routine());
    expect(prompt).not.toContain('docs.example.com');
    expect(prompt).not.toContain(SECRET_QUERY);
    expect(prompt).not.toContain('token=');
    expect(prompt).not.toMatch(/https?:\/\//);
  });

  it('asks for a JSON name and turns off the reasoning block', () => {
    expect(NAMING_SYSTEM_PROMPT).toContain('{"name": "..."}');
    expect(namingPrompt(routine())).toContain('/no_think');
  });
});

describe('model output', () => {
  it('constrains the model with a schema that allows one name and nothing else', () => {
    expect(ROUTINE_NAME_JSON_SCHEMA).toMatchObject({
      type: 'object',
      required: ['name'],
      additionalProperties: false,
      properties: { name: { type: 'string', minLength: 3, maxLength: 60 } },
    });
  });

  it('accepts a plain name and trims and collapses its spaces', () => {
    expect(RoutineNameOutputSchema.parse({ name: '  Monthly   invoice check ' })).toEqual({ name: 'Monthly invoice check' });
  });

  it.each([
    ['missing', {}],
    ['empty', { name: '' }],
    ['too short', { name: 'ab' }],
    ['too long', { name: 'x'.repeat(61) }],
    ['a newline', { name: 'Line\nbreak' }],
    ['quotation marks', { name: 'Say "hi" now' }],
    ['markup', { name: '<b>Bold</b> name' }],
    ['nine words', { name: 'one two three four five six seven eight nine' }],
    ['an extra field', { name: 'Fine name', extra: 1 }],
    ['a bare string', 'Fine name'],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expect(RoutineNameOutputSchema.safeParse(value).success).toBe(false);
  });
});

describe('nameRoutine', () => {
  it('uses the model name when the output is valid', async () => {
    const model = fakeModel(() => ({ name: 'Monthly invoice check' }));
    const naming = await nameRoutine(routine(), { completer: model });
    expect(naming).toEqual({ source: 'model', name: 'Monthly invoice check' });
  });

  it('sends the system prompt, the schema, a token cap and an abort signal', async () => {
    const model = fakeModel(() => ({ name: 'Monthly invoice check' }));
    await nameRoutine(routine(), { completer: model });
    const [request] = model.requests;
    expect(request.system).toBe(NAMING_SYSTEM_PROMPT);
    expect(request.schema).toBe(ROUTINE_NAME_JSON_SCHEMA);
    expect(request.maxTokens).toBeLessThanOrEqual(64);
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(request.prompt).toBe(namingPrompt(routine()));
  });

  it('keeps the rule-based name when there is no model', async () => {
    expect(await nameRoutine(routine())).toEqual({ source: 'rule', reason: 'no_model' });
  });

  it.each([
    ['an empty object', {}],
    ['a name with quotes', { name: 'Say "hi"' }],
    ['a name with a newline', { name: 'Two\nlines' }],
    ['plain text', 'Monthly invoice check'],
  ])('keeps the rule-based name for output that is %s', async (_label, answer) => {
    const naming = await nameRoutine(routine(), { completer: fakeModel(() => answer) });
    expect(naming).toEqual({ source: 'rule', reason: 'invalid_output' });
  });

  it('keeps the rule-based name when the model throws, and drops the error text', async () => {
    const naming = await nameRoutine(routine(), {
      completer: { complete: async () => Promise.reject(new Error('failed at /Users/someone/Library/models')) },
    });
    expect(naming).toEqual({ source: 'rule', reason: 'model_error' });
    expect(JSON.stringify(naming)).not.toContain('Users');
  });

  it('keeps the rule-based name when the model fails synchronously with a non-error value', async () => {
    const naming = await nameRoutine(routine(), {
      completer: {
        complete: () => {
          throw 'boom';
        },
      },
    });
    expect(naming).toEqual({ source: 'rule', reason: 'model_error' });
  });

  it('gives up after the timeout, cancels the request, and keeps the rule-based name', async () => {
    let signal: AbortSignal | undefined;
    const naming = await nameRoutine(routine(), {
      timeoutMs: 5,
      completer: {
        complete: request => {
          signal = request.signal;
          return new Promise(() => undefined);
        },
      },
    });
    expect(naming).toEqual({ source: 'rule', reason: 'timeout' });
    expect(signal?.aborted).toBe(true);
  });

  it('does not wait for the model after it has answered', async () => {
    vi.useFakeTimers();
    try {
      const naming = await nameRoutine(routine(), { completer: fakeModel(() => ({ name: 'Quick check' })) });
      expect(naming).toEqual({ source: 'model', name: 'Quick check' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Routines mined from the site fixture, whose browser steps each carry the site they visited. */
function siteRoutine(): Routine {
  const events = siteWorkdays(4)
    .map(signal => normalizeSignal(signal, { excludedApps: DEFAULT_CONFIG.excludedApps, watchBrowsers: true }))
    .filter((event): event is TwinEvent => event !== null);
  const found = mineRoutines(segment(events, DEFAULT_CONFIG.idleGapMs)).find(candidate =>
    candidate.steps.some(step => step.site !== undefined),
  );
  if (!found) throw new Error('The site fixtures should mine a routine with a site.');
  return found;
}

describe('naming prompt with sites', () => {
  it('never carries a site or a host, though the routine has them', () => {
    const found = siteRoutine();
    expect(found.steps.some(step => step.site !== undefined)).toBe(true);
    const prompt = namingPrompt(found);
    const siteText = ['mail.google.com', 'jira.example.com', 'docs.google.com', '.com', 'spreadsheets', '/mail', 'https'];
    for (const text of siteText) expect(prompt).not.toContain(text);
    expect(prompt).toContain('google chrome');
  });

  it('builds the same prompt whether or not the steps carry a site', () => {
    const found = siteRoutine();
    const withoutSites = {
      ...found,
      steps: found.steps.map(step => ({ ...step, site: undefined, urlTemplate: undefined })),
    };
    expect(namingPrompt(found)).toBe(namingPrompt(withoutSites));
  });
});
