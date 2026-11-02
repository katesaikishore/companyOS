/** Separators a person may type between menu labels: ">" or "→". A label may hold "/", so "/" is not one. */
const SEPARATOR = /\s*(?:>|→)\s*/;
/**
 * How many labels the form accepts: a menu bar item and one item in its menu. The program cannot open submenus yet, so a
 * longer path would be refused at every run. The engine itself accepts up to four, for when it can.
 */
export const FORM_MENU_LABELS = 2;

/**
 * The labels of a typed menu path, such as "View > Clean Up". Empty labels are dropped, so a trailing separator
 * does not add one. The engine checks each label against its own rule, so this only splits.
 */
export function parseMenuPath(text: string): string[] {
  return text
    .split(SEPARATOR)
    .map(label => label.trim())
    .filter(label => label.length > 0);
}

/** The form's draft. It lives in memory so a redraw keeps what the person typed. */
export interface MenuAutomationDraft {
  name: string;
  app: string;
  path: string;
}

/** True when every field has something and the path has exactly the labels the form accepts. */
export function draftReady(draft: MenuAutomationDraft): boolean {
  return draft.name.trim() !== '' && draft.app.trim() !== '' && parseMenuPath(draft.path).length === FORM_MENU_LABELS;
}
