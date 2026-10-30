import type { WindowClass } from './types';

/** Normalised application names mapped to a coarse window class. Anything unknown is 'other'. */
const CATALOG: Readonly<Record<string, WindowClass>> = {
  chrome: 'browser',
  'google chrome': 'browser',
  'google-chrome': 'browser',
  chromium: 'browser',
  msedge: 'browser',
  'microsoft edge': 'browser',
  firefox: 'browser',
  'mozilla firefox': 'browser',
  safari: 'browser',
  brave: 'browser',
  'brave browser': 'browser',

  excel: 'spreadsheet',
  'microsoft excel': 'spreadsheet',
  calc: 'spreadsheet',
  'libreoffice calc': 'spreadsheet',
  'libreoffice-calc': 'spreadsheet',
  numbers: 'spreadsheet',

  word: 'document',
  'microsoft word': 'document',
  writer: 'document',
  'libreoffice writer': 'document',
  'libreoffice-writer': 'document',
  pages: 'document',
  notion: 'document',
  obsidian: 'document',

  outlook: 'mail',
  'microsoft outlook': 'mail',
  thunderbird: 'mail',
  mail: 'mail',

  slack: 'chat',
  teams: 'chat',
  'microsoft teams': 'chat',
  discord: 'chat',
  zoom: 'chat',
  telegram: 'chat',
  whatsapp: 'chat',
  messages: 'chat',

  code: 'editor',
  'visual studio code': 'editor',
  xcode: 'editor',
  pycharm: 'editor',
  cursor: 'editor',
  'sublime text': 'editor',
  devenv: 'editor',

  terminal: 'terminal',
  iterm2: 'terminal',
  powershell: 'terminal',
  windowsterminal: 'terminal',
  'windows terminal': 'terminal',
  konsole: 'terminal',
  'gnome-terminal': 'terminal',
  alacritty: 'terminal',
  kitty: 'terminal',

  figma: 'design',
  photoshop: 'design',
  illustrator: 'design',
  sketch: 'design',
};

export function normalizeAppName(name: string): string {
  return name.trim().toLowerCase().replace(/\.(app|exe)$/, '').replace(/\s+/g, ' ');
}

export function classifyApp(name: string): WindowClass {
  return CATALOG[normalizeAppName(name)] ?? 'other';
}

/**
 * Names that refer to the same application on different systems. A person types the display name
 * ("Microsoft Edge"); the OS reports the process name ("msedge"). Exclusion matches every alias.
 */
const ALIAS_GROUPS: readonly (readonly string[])[] = [
  ['chrome', 'google chrome', 'google-chrome'],
  ['msedge', 'microsoft edge', 'edge'],
  ['firefox', 'mozilla firefox'],
  ['brave', 'brave browser'],
  ['excel', 'microsoft excel'],
  ['word', 'microsoft word'],
  ['outlook', 'microsoft outlook'],
  ['teams', 'microsoft teams'],
  ['calc', 'libreoffice calc', 'libreoffice-calc'],
  ['writer', 'libreoffice writer', 'libreoffice-writer'],
  ['iterm', 'iterm2'],
  ['windowsterminal', 'windows terminal'],
  ['gnome-terminal', 'gnome-terminal-server'],
  ['keepass', 'keepassxc'],
];

function aliasesOf(name: string): string[] {
  const normalized = normalizeAppName(name);
  const group = ALIAS_GROUPS.find(candidates => candidates.includes(normalized));
  return group ? [...group] : [normalized];
}

/**
 * True when the observed name is one of the excluded apps. Short names must match exactly, so that
 * "edge" does not swallow unrelated names. Longer names may also match inside a longer name.
 */
export function isExcludedApp(name: string, excluded: readonly string[]): boolean {
  const observed = normalizeAppName(name);
  return excluded.some(pattern =>
    aliasesOf(pattern).some(alias => alias.length > 0 && (observed === alias || (alias.length >= 6 && observed.includes(alias)))),
  );
}
