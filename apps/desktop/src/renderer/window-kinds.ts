/**
 * The kinds of window the settings can exclude. The renderer cannot import the twin engine's values, so this list is a
 * copy of WINDOW_CLASSES in packages/core/src/types.ts, and test/window-kinds.test.ts fails if the two ever differ.
 */
export const WINDOW_KIND_IDS = [
  'browser',
  'editor',
  'spreadsheet',
  'document',
  'mail',
  'chat',
  'terminal',
  'design',
  'other',
] as const;

export type WindowKindId = (typeof WINDOW_KIND_IDS)[number];

export const WINDOW_KIND_LABELS: Record<WindowKindId, string> = {
  browser: 'Browsers',
  editor: 'Code and text editors',
  spreadsheet: 'Spreadsheets',
  document: 'Documents',
  mail: 'Mail',
  chat: 'Chat and messaging',
  terminal: 'Terminals',
  design: 'Design tools',
  other: 'Other windows',
};
