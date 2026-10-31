/** A section colour from tokens.css. The class tone-<name> sets --tone, --tone-hi, --tone-soft and --tone-ink. */
export type Tone = 'blue' | 'green' | 'orange' | 'purple' | 'cyan' | 'berry' | 'steel';

/** Known apps take the colour people know them by. The first fragment found in the lower-cased name wins. */
const APP_TONES: ReadonlyArray<[fragment: string, tone: Tone]> = [
  ['excel', 'green'],
  ['calc', 'green'],
  ['sheets', 'green'],
  ['numbers', 'green'],
  ['word', 'blue'],
  ['writer', 'blue'],
  ['docs', 'blue'],
  ['pages', 'blue'],
  ['outlook', 'blue'],
  ['mail', 'blue'],
  ['powerpoint', 'orange'],
  ['impress', 'orange'],
  ['keynote', 'orange'],
  ['slides', 'orange'],
  ['firefox', 'orange'],
  ['teams', 'indigo'],
  ['zoom', 'indigo'],
  ['visual studio', 'indigo'],
  ['onenote', 'purple'],
  ['figma', 'purple'],
  ['slack', 'berry'],
  ['edge', 'cyan'],
  ['safari', 'cyan'],
  ['chrome', 'cyan'],
  ['terminal', 'steel'],
  ['notion', 'steel'],
  ['finder', 'steel'],
];

/** Colours for an app no rule names, chosen by the name so the same app always gets the same colour. */
const FALLBACK: readonly Tone[] = ['blue', 'green', 'orange', 'purple', 'indigo', 'cyan', 'berry'];

export function appTone(app: string): Tone {
  const name = app.trim().toLowerCase();
  const known = APP_TONES.find(([fragment]) => name.includes(fragment));
  if (known) return known[1];
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return FALLBACK[hash % FALLBACK.length];
}
