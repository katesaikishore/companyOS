/** The most characters an automation name keeps. It is the limit a routine's name gets when the routine is accepted. */
export const AUTOMATION_NAME_LIMIT = 80;

/**
 * The name the main process takes for a rename: the text, trimmed and cut to the limit an accepted routine's name gets.
 * Anything that is not text, or is blank once trimmed, gives undefined, so the call is refused.
 */
export function renamedAutomationName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.slice(0, AUTOMATION_NAME_LIMIT).trim();
  return name.length > 0 ? name : undefined;
}
