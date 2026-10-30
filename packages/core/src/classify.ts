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

export function isExcludedApp(name: string, excluded: readonly string[]): boolean {
  const normalized = normalizeAppName(name);
  return excluded.some(pattern => {
    const p = normalizeAppName(pattern);
    return p.length > 0 && normalized.includes(p);
  });
}
