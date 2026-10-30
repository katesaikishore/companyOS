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
 * Builds the user message for one routine from abstract data only: app names, step positions and counts. Window
 * titles, field values and URLs never reach the model, so they cannot leak into a name.
 */
export function namingPrompt(routine: Routine): string {
  const steps = routine.steps.map((step, index) => {
    const others = step.options.filter(app => app !== step.app);
    const alternatives = others.length > 0 ? ` (sometimes ${others.join(', ')})` : '';
    return `${index + 1}. ${step.app}${alternatives}`;
  });
  return [
    `Steps in order (${routine.steps.length} steps):`,
    ...steps,
    `Seen in ${routine.support} work sessions on ${routine.days} days, about ${routine.occurrencesPerWeek} times a week.`,
    'Name this routine. /no_think',
  ].join('\n');
}
