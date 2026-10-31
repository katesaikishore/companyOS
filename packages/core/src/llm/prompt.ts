import type { Routine } from '../mine';

/**
 * The instructions for naming a routine. The model is told what it can see, which is app names, step order and
 * counts, so it does not invent detail it was never given.
 */
export const NAMING_SYSTEM_PROMPT = [
  'You name a routine that a person repeats on their own computer.',
  'You see only the app names in order, and how often the routine happens.',
  'Reply with JSON of the form {"name": "..."}.',
  'The name is three to six plain words in sentence case.',
  'Use only apps that appear in the steps. Do not use quotation marks.',
].join(' ');

/**
 * Longest app name shown to the model, in characters. A capture adapter may report a name of up to 200 characters, and
 * a routine shows up to five apps for each of six steps. Cut at 40, the longest prompt is about 1,500 characters. Uncut,
 * it could pass the 4,000 the worker accepts (MAX_WORKER_TEXT_CHARS). The worker then refuses it, the refusal looks like
 * a model error, and the naming job retries the same routine every minute and never reaches the ones behind it.
 */
export const MAX_APP_NAME_CHARS = 40;

function shown(app: string): string {
  return app.length <= MAX_APP_NAME_CHARS ? app : `${app.slice(0, MAX_APP_NAME_CHARS - 1)}…`;
}

/**
 * Builds the user message for one routine from abstract data only: app names, step positions and counts. Window
 * titles, field values and URLs never reach the model, so they cannot leak into a name.
 */
export function namingPrompt(routine: Routine): string {
  const steps = routine.steps.map((step, index) => {
    const others = step.options.filter(app => app !== step.app);
    const alternatives = others.length > 0 ? ` (sometimes ${others.map(shown).join(', ')})` : '';
    return `${index + 1}. ${shown(step.app)}${alternatives}`;
  });
  return [
    `Steps in order (${routine.steps.length} steps):`,
    ...steps,
    `Seen in ${routine.support} work sessions on ${routine.days} days, about ${routine.occurrencesPerWeek} times a week.`,
    'Name this routine. /no_think',
  ].join('\n');
}
