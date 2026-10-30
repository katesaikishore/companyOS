import type { EffectClass, StepOp, WindowClass } from './types';

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
 * Shells, script hosts and interpreters by name, including the Windows tools that run a script, a library or an
 * installer. Terminal apps are matched by their window class, which covers the rest.
 */
const SHELL_APPS = [
  'bash',
  'bun',
  'cmd',
  'command prompt',
  'cscript',
  'csh',
  'dash',
  'deno',
  'fish',
  'ksh',
  'mshta',
  'msiexec',
  'node',
  'osascript',
  'perl',
  'php',
  'powershell',
  'pwsh',
  'py',
  'pythonw',
  'regsvr32',
  'ruby',
  'rundll32',
  'sh',
  'tcsh',
  'windows powershell',
  'wscript',
  'wsl',
  'zsh',
];

/** Windows drops a trailing dot or space from a name, so "wscript.exe." runs as "wscript.exe". */
const TRAILING_DOTS_AND_SPACES = /[\s.]+$/;

/**
 * True for a shell, a script interpreter or host, or a terminal app. A file handed to one of them, or keys sent to one,
 * can run commands, so none of them may be the target of an open or a key press. The name is cut the way Windows cuts
 * it before the list is checked, so every spelling of a shell is refused.
 */
export function isShellApp(name: string): boolean {
  const windowsName = name.replace(TRAILING_DOTS_AND_SPACES, '');
  // A second cut catches a space left in front of the extension, as in "wscript .exe.".
  const normalized = normalizeAppName(windowsName).replace(TRAILING_DOTS_AND_SPACES, '');
  return classifyApp(windowsName) === 'terminal' || SHELL_APPS.includes(normalized) || /^python[\d.]*$/.test(normalized);
}

/**
 * Effect of a step, from its operation and the application it touches. Steps whose outcome the twin cannot see
 * into are external, so they need a person.
 */
export function effectOfOp(op: StepOp, app: string): EffectClass {
  // Checking focus changes nothing.
  if (op === 'check_focus') return 'read_only';
  // A link or a file can trigger an action in the app, and a shortcut does whatever the app binds it to. None of it is visible.
  if (op === 'open_url' || op === 'open_file' || op === 'press_shortcut') return 'external_effect';
  // Messages are composed and sent by the person in these apps, and the twin cannot see what is sent.
  const windowClass = classifyApp(app);
  return windowClass === 'mail' || windowClass === 'chat' ? 'external_effect' : 'read_only';
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
