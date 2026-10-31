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

/**
 * Processes of the desktop itself: the shell, the launcher and search, the lock and login screens, the window manager
 * and the authentication prompts. They take focus all the time, so a routine built from them is noise. Matched by
 * normalised name, as the catalogue is. Shells and terminals are not listed here: isShellApp covers them.
 */
const SYSTEM_PROCESSES: ReadonlySet<string> = new Set([
  // macOS
  'finder',
  'dock',
  'loginwindow',
  'securityagent',
  'systemuiserver',
  'spotlight',
  'control center',
  'controlcenter',
  'notification center',
  'notificationcenter',
  'window server',
  'windowserver',
  // Windows
  'explorer',
  'shellexperiencehost',
  'startmenuexperiencehost',
  'searchhost',
  'searchapp',
  'lockapp',
  'textinputhost',
  'credentialuibroker',
  // Linux desktops, and the file managers that play the same part as Finder and Explorer
  'gnome-shell',
  'plasmashell',
  'kwin',
  'kwin_x11',
  'kwin_wayland',
  'mutter',
  'xfwm4',
  'xfce4-panel',
  'gnome-screensaver',
  'xscreensaver',
  'polkit-gnome-authentication-agent-1',
  'polkit-kde-authentication-agent-1',
  'nautilus',
  'dolphin',
  'nemo',
  'thunar',
]);

export function normalizeAppName(name: string): string {
  return name.trim().toLowerCase().replace(/\.(app|exe)$/, '').replace(/\s+/g, ' ');
}

export function classifyApp(name: string): WindowClass {
  return CATALOG[normalizeAppName(name)] ?? 'other';
}

/**
 * Web browsers the catalogue does not list, by normalised name. They keep the class 'other', so they are mined like any
 * unknown app, but browser capture is off by default and must cover them too (see isBrowserApp).
 */
const UNCATALOGUED_BROWSERS: ReadonlySet<string> = new Set([
  'arc',
  'brave-browser',
  'chromium-browser',
  'duckduckgo',
  'epiphany',
  'firefox developer edition',
  'firefox nightly',
  'firefox-esr',
  'gnome-web',
  'google-chrome-stable',
  'librewolf',
  'microsoft-edge',
  'opera',
  'opera gx',
  'opera-stable',
  'orion',
  'tor browser',
  'vivaldi',
  'vivaldi-stable',
  'waterfox',
]);

/** True for a web browser, whether the catalogue lists it or not. Its focus is dropped unless browser capture is on. */
export function isBrowserApp(name: string): boolean {
  return classifyApp(name) === 'browser' || UNCATALOGUED_BROWSERS.has(normalizeAppName(name));
}

/**
 * Shells, script hosts and interpreters by name, including the Windows tools that run a script, a library or an
 * installer. Terminal apps the catalogue lists are matched by their window class. The terminal emulators and remote
 * shells it does not list are named here, so they are never mined either.
 */
const SHELL_APPS = [
  'bash',
  'bun',
  'cmd',
  'cmder',
  'command prompt',
  'conemu',
  'conemu64',
  'conhost',
  'cscript',
  'csh',
  'dash',
  'deno',
  'elvish',
  'fish',
  'foot',
  'ghostty',
  'guake',
  'hyper',
  'ksh',
  'lxterminal',
  'mintty',
  'mobaxterm',
  'mshta',
  'msiexec',
  'node',
  'nu',
  'openconsole',
  'osascript',
  'perl',
  'php',
  'powershell',
  'powershell_ise',
  'pwsh',
  'putty',
  'py',
  'pythonw',
  'qterminal',
  'regsvr32',
  'rxvt',
  'ruby',
  'rundll32',
  'sakura',
  'screen',
  'sh',
  'ssh',
  'tabby',
  'tcsh',
  'telnet',
  'terminator',
  'tilix',
  'tmux',
  'urxvt',
  'warp',
  'wezterm',
  'windows powershell',
  'wscript',
  'wsl',
  'xfce4-terminal',
  'xonsh',
  'xterm',
  'yakuake',
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
 * True for a process of the desktop itself, by name. The name is cut the way Windows cuts it, as isShellApp does, so
 * "explorer.exe." counts as explorer.
 */
export function isSystemProcess(name: string): boolean {
  const windowsName = name.replace(TRAILING_DOTS_AND_SPACES, '');
  return SYSTEM_PROCESSES.has(normalizeAppName(windowsName).replace(TRAILING_DOTS_AND_SPACES, ''));
}

/**
 * True for a name with a dot followed by a letter, which is how a host or a reverse-domain id reads. A Chromium web app's
 * window class carries the site's host, as in "Chrome-web.whatsapp.com__-Default", so such a name can carry a site.
 */
export function isSiteLikeName(name: string): boolean {
  return /\.[a-z]/.test(normalizeAppName(name));
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
