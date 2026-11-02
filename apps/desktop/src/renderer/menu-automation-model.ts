/** Separators a person may type between menu labels: ">" or "→". A label may hold "/", so "/" is not one. */
const SEPARATOR = /\s*(?:>|→)\s*/;
/** How many labels a path may have: a menu bar item, up to two submenus, then the item. The engine accepts the same. */
export const MENU_LABELS_MIN = 2;
export const MENU_LABELS_MAX = 4;

/**
 * The labels of a typed menu path, such as "View > Clean Up By > Name". Empty labels are dropped, so a trailing separator
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

/** True when every field has something and the path has two to four labels. */
export function draftReady(draft: MenuAutomationDraft): boolean {
  const labels = parseMenuPath(draft.path).length;
  return draft.name.trim() !== '' && draft.app.trim() !== '' && labels >= MENU_LABELS_MIN && labels <= MENU_LABELS_MAX;
}
