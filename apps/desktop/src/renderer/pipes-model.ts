import type { Pipe } from '@companyos/twin-core';

/**
 * The limits and form rules of the Pipes section. The renderer cannot import the engine's values, so the limits are a copy
 * of the constants in packages/core/src/types.ts, and test/pipes-model.test.ts fails if the two ever differ.
 */
export const PIPE_LIMITS = {
  maxPipes: 20,
  nameMax: 60,
  queryMax: 200,
  appMax: 200,
  intervalMinMinutes: 15,
  intervalMaxMinutes: 1440,
} as const;

/** How often a pipe runs. Each choice is inside the limits above. */
export const PIPE_INTERVALS: ReadonlyArray<{ minutes: number; label: string }> = [
  { minutes: 15, label: 'Every 15 minutes' },
  { minutes: 30, label: 'Every 30 minutes' },
  { minutes: 60, label: 'Every hour' },
  { minutes: 120, label: 'Every 2 hours' },
  { minutes: 240, label: 'Every 4 hours' },
  { minutes: 480, label: 'Every 8 hours' },
  { minutes: 1440, label: 'Once a day' },
];

/** Which stored text a pipe searches. An empty value means both. Typed text is not offered, as the engine refuses it. */
export const PIPE_SOURCES: ReadonlyArray<{ value: '' | 'screen' | 'audio'; label: string }> = [
  { value: '', label: 'Screen and microphone text' },
  { value: 'screen', label: 'Screen text' },
  { value: 'audio', label: 'Microphone text' },
];

export const PIPE_ACTION_CHOICES: ReadonlyArray<{ value: 'notify' | 'write'; label: string }> = [
  { value: 'notify', label: 'Notify me of the count' },
  { value: 'write', label: 'Write a Markdown file' },
];

/** The fields of the add form, as the person typed them. */
export interface PipeForm {
  name: string;
  query: string;
  kind: string;
  app: string;
  intervalMinutes: number;
  action: string;
}

const CONTROL_CHARACTER = /\p{Cc}/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * The first problem with the form, in plain words, or undefined when the pipe can be saved. The engine checks the same rules
 * again when the list is saved, so this only gives the person the reason sooner.
 */
export function pipeFormProblem(form: PipeForm, existing: number): string | undefined {
  const name = form.name.trim();
  const query = form.query.trim();
  const app = form.app.trim();
  if (existing >= PIPE_LIMITS.maxPipes) return `You can have up to ${PIPE_LIMITS.maxPipes} pipes. Remove one first.`;
  if (name === '') return 'Give the pipe a name.';
  if (name.length > PIPE_LIMITS.nameMax) return `The name can be at most ${PIPE_LIMITS.nameMax} characters.`;
  if (query.length > PIPE_LIMITS.queryMax) return `The search can be at most ${PIPE_LIMITS.queryMax} characters.`;
  if (query !== '' && !LETTER_OR_DIGIT.test(query)) {
    return 'The search needs a letter or a number. Leave it empty to list everything in the range.';
  }
  if (app.length > PIPE_LIMITS.appMax) return `The app name can be at most ${PIPE_LIMITS.appMax} characters.`;
  if (CONTROL_CHARACTER.test(name) || CONTROL_CHARACTER.test(query) || CONTROL_CHARACTER.test(app)) {
    return 'The name, the search and the app cannot contain control characters.';
  }
  if (!PIPE_INTERVALS.some(choice => choice.minutes === form.intervalMinutes)) return 'Choose how often the pipe runs.';
  if (!PIPE_SOURCES.some(choice => choice.value === form.kind)) return 'Choose which stored text the pipe searches.';
  if (!PIPE_ACTION_CHOICES.some(choice => choice.value === form.action)) return 'Choose what the pipe does with its matches.';
  return undefined;
}

/** The saved pipe for a form that passed pipeFormProblem. The id is a new random id, which is also the file name. */
export function pipeFromForm(form: PipeForm, id: string): Pipe {
  const app = form.app.trim();
  return {
    id,
    name: form.name.trim(),
    query: form.query.trim(),
    ...(form.kind === '' ? {} : { kind: form.kind as 'screen' | 'audio' }),
    ...(app === '' ? {} : { app }),
    intervalMinutes: form.intervalMinutes,
    action: form.action as 'notify' | 'write',
    enabled: true,
  };
}

/** One line for a saved pipe: what it searches, where, how often and what it does. */
export function pipeSummary(pipe: Pipe): string {
  const search = pipe.query === '' ? 'any text' : `"${pipe.query}"`;
  const source = pipe.kind === 'screen' ? 'screen text' : pipe.kind === 'audio' ? 'microphone text' : 'screen and microphone text';
  const interval = PIPE_INTERVALS.find(choice => choice.minutes === pipe.intervalMinutes)?.label ?? `every ${pipe.intervalMinutes} minutes`;
  const app = pipe.app === undefined ? '' : ` · ${pipe.app}`;
  const action = pipe.action === 'write' ? 'writes a file' : 'notifies';
  return `${search} · ${source}${app} · ${interval.toLowerCase()} · ${action}`;
}
