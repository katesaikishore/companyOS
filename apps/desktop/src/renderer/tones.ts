/** A section colour from tokens.css. The class tone-<name> sets --tone, --tone-hi, --tone-soft and --tone-ink. */
export type Tone = 'blue' | 'green' | 'orange' | 'purple' | 'cyan' | 'steel';

/** An app's brand colour from tokens.css, as the design draws app marks. The class app-<name> sets --app. */
export type AppColour = 'excel' | 'word' | 'outlook' | 'powerpoint' | 'teams' | 'onenote' | 'code' | 'slack' | 'figma' | 'other';

/** Known apps take the colour people know them by. The first whole word found in the name wins. */
const APP_COLOURS: ReadonlyArray<[word: RegExp, colour: AppColour]> = [
  [/\b(excel|calc|sheets|numbers)\b/, 'excel'],
  [/\b(word|writer|docs|pages)\b/, 'word'],
  [/\b(outlook|mail)\b/, 'outlook'],
  [/\b(powerpoint|impress|keynote|slides)\b/, 'powerpoint'],
  [/\bteams\b/, 'teams'],
  [/\bonenote\b/, 'onenote'],
  [/\bcode\b/, 'code'],
  [/\bslack\b/, 'slack'],
  [/\bfigma\b/, 'figma'],
];

/** Any other app is the design's neutral grey. */
export function appColour(app: string): AppColour {
  const name = app.trim().toLowerCase();
  return APP_COLOURS.find(([word]) => word.test(name))?.[1] ?? 'other';
}
