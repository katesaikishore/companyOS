import {
  MAX_PIPES,
  PIPE_ACTIONS,
  PIPE_KINDS,
  PIPE_INTERVAL_MAX_MINUTES,
  PIPE_INTERVAL_MIN_MINUTES,
  PIPE_NAME_MAX,
  PIPE_QUERY_MAX,
  parsePipes,
} from '@companyos/twin-core';
import { describe, expect, it } from 'vitest';
import {
  PIPE_ACTION_CHOICES,
  PIPE_INTERVALS,
  PIPE_LIMITS,
  PIPE_SOURCES,
  pipeFormProblem,
  pipeFromForm,
  pipeKeptLine,
  pipeSummary,
  type PipeForm,
} from '../src/renderer/pipes-model';

const form: PipeForm = { name: 'Standup', query: 'budget', kind: '', app: '', intervalMinutes: 60, action: 'notify' };
const ID = 'pipe-0001';

/** Whether the engine would save the form as one pipe. */
function engineAccepts(candidate: PipeForm): boolean {
  try {
    parsePipes([pipeFromForm(candidate, ID)]);
    return true;
  } catch {
    return false;
  }
}

describe('the renderer copy of the pipe limits', () => {
  it('matches the engine limits', () => {
    expect(PIPE_LIMITS).toEqual({
      maxPipes: MAX_PIPES,
      nameMax: PIPE_NAME_MAX,
      queryMax: PIPE_QUERY_MAX,
      appMax: 200,
      intervalMinMinutes: PIPE_INTERVAL_MIN_MINUTES,
      intervalMaxMinutes: PIPE_INTERVAL_MAX_MINUTES,
    });
  });

  it('offers only the kinds and actions the engine has', () => {
    expect(PIPE_SOURCES.map(choice => choice.value)).toEqual(['', ...PIPE_KINDS]);
    expect(PIPE_ACTION_CHOICES.map(choice => choice.value)).toEqual([...PIPE_ACTIONS]);
  });

  it('offers only intervals inside the engine range, in increasing order', () => {
    const minutes = PIPE_INTERVALS.map(choice => choice.minutes);
    expect(minutes).toEqual([...minutes].sort((a, b) => a - b));
    for (const value of minutes) {
      expect(value).toBeGreaterThanOrEqual(PIPE_INTERVAL_MIN_MINUTES);
      expect(value).toBeLessThanOrEqual(PIPE_INTERVAL_MAX_MINUTES);
    }
  });
});

describe('pipeFormProblem', () => {
  it('accepts a complete form, and the engine accepts it too', () => {
    expect(pipeFormProblem(form, 0)).toBeUndefined();
    expect(engineAccepts(form)).toBe(true);
  });

  it('agrees with the engine on each rule it checks', () => {
    const cases: PipeForm[] = [
      { ...form, name: '' },
      { ...form, name: '   ' },
      { ...form, name: 'n'.repeat(PIPE_NAME_MAX) },
      { ...form, name: 'n'.repeat(PIPE_NAME_MAX + 1) },
      { ...form, name: 'two\tparts' },
      { ...form, query: '' },
      { ...form, query: 'q'.repeat(PIPE_QUERY_MAX) },
      { ...form, query: 'q'.repeat(PIPE_QUERY_MAX + 1) },
      { ...form, query: '!!!' },
      { ...form, query: '   ' },
      { ...form, app: 'Slack' },
      { ...form, app: 'a'.repeat(201) },
      { ...form, kind: 'screen' },
      { ...form, kind: 'video' },
      { ...form, intervalMinutes: 14 },
      { ...form, intervalMinutes: 1440 },
      { ...form, intervalMinutes: 1441 },
      { ...form, action: 'write' },
      { ...form, action: 'send' },
    ];
    for (const candidate of cases) {
      const problem = pipeFormProblem(candidate, 0);
      expect(problem === undefined, JSON.stringify({ ...candidate, name: '[name]', query: '[query]', app: '[app]' })).toBe(
        engineAccepts(candidate),
      );
    }
  });

  it('refuses a new pipe once the list is full', () => {
    expect(pipeFormProblem(form, MAX_PIPES - 1)).toBeUndefined();
    expect(pipeFormProblem(form, MAX_PIPES)).toMatch(/up to 20 pipes/);
  });

  it('gives plain reasons, and never repeats what was typed', () => {
    const secret = 'TYPEDSECRET'.repeat(7);
    const problem = pipeFormProblem({ ...form, name: secret }, 0);
    expect(problem).toMatch(/at most 60 characters/);
    expect(problem).not.toContain('TYPEDSECRET');
  });
});

describe('pipeFromForm and pipeSummary', () => {
  it('trims the typed text and leaves out the empty optional fields', () => {
    expect(pipeFromForm({ ...form, name: '  Standup  ', query: ' budget ', app: '  ' }, ID)).toEqual({
      id: ID,
      name: 'Standup',
      query: 'budget',
      intervalMinutes: 60,
      action: 'notify',
      enabled: true,
    });
  });

  it('keeps the kind and the app when they are set, and a pipe starts switched on', () => {
    expect(pipeFromForm({ ...form, kind: 'audio', app: ' Slack ', action: 'write' }, ID)).toMatchObject({
      kind: 'audio',
      app: 'Slack',
      action: 'write',
      enabled: true,
    });
  });

  it('describes a pipe in one line', () => {
    expect(pipeSummary(pipeFromForm({ ...form, kind: 'screen', app: 'Slack' }, ID))).toBe(
      '"budget" · screen text · Slack · every hour · notifies',
    );
    expect(pipeSummary(pipeFromForm({ ...form, query: '', action: 'write', intervalMinutes: 1440 }, ID))).toBe(
      'any text · screen and microphone text · once a day · keeps matches',
    );
  });

  it('says what a pipe keeps, with the time and count of its newest run, and never any text', () => {
    const notifyPipe = pipeFromForm({ ...form, action: 'notify' }, ID);
    const writePipe = pipeFromForm({ ...form, action: 'write' }, ID);
    const now = Date.UTC(2026, 10, 2, 12, 0);
    expect(pipeKeptLine(notifyPipe, { count: 3, ranAt: now })).toBe('Shows a notice only. Nothing is kept.');
    expect(pipeKeptLine(writePipe, undefined, now)).toBe('Not run yet. Nothing is kept.');
    const line = pipeKeptLine(writePipe, { count: 1, ranAt: now }, now);
    expect(line).toMatch(/^Last run Today \d{2}:\d{2} · 1 match kept, encrypted\.$/);
    expect(pipeKeptLine(writePipe, { count: 0, ranAt: now }, now)).toMatch(/· 0 matches kept, encrypted\.$/);
    expect(pipeKeptLine(writePipe, { count: 200, ranAt: now }, now)).toMatch(/· 200 matches kept, encrypted\.$/);
  });

  it('offers the write action as keeping the newest matches, encrypted, after notify', () => {
    expect(PIPE_ACTION_CHOICES.map(choice => choice.value)).toEqual(['notify', 'write']);
    expect(PIPE_ACTION_CHOICES.find(choice => choice.value === 'write')?.label).toBe('Keep the newest matches, encrypted');
  });
});
