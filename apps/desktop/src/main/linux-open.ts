import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { isShellApp, normalizeAppName } from '@companyos/twin-core';

/**
 * Linux open_url and open_file. The step names an application, and the link or file has to open in that application.
 * There is no Linux equivalent of `open -a`, so the named app is resolved to its desktop entry (the .desktop file the
 * system installs for it), and only that exact file is launched. This module reads and checks entries. It starts
 * nothing. platform.ts launches the entry with `gio launch <entry file> <checked address or file>`.
 *
 * An app that cannot be resolved to exactly one entry that can take the address or the file is refused, and nothing is
 * launched. The step never reaches xdg-open or a default handler, because those would open the target in whatever the
 * system prefers and not in the app the person approved.
 */

/** Entries are small. A larger file is skipped, so a damaged or hostile one cannot cost memory or time. */
const MAX_ENTRY_BYTES = 256 * 1024;
const MAX_ENTRIES = 5000;

export interface DesktopEntry {
  /** The desktop file ID: the file name without .desktop. */
  id: string;
  /** The absolute path the entry was read from. This is the file that is launched. */
  file: string;
  /** The unlocalised Name, if there is one. */
  name?: string;
  /** StartupWMClass: the window class the app's windows have. Capture records the same class on X11. */
  wmClass?: string;
  exec: string;
  mimeTypes: readonly string[];
}

/** What the target needs from the app. A web address needs a handler for its scheme. A file needs a file argument. */
export type OpenNeed = { kind: 'url'; scheme: 'http' | 'https' } | { kind: 'file' };

export type OpenResolution =
  | { ok: true; entry: DesktopEntry }
  | { ok: false; reason: 'not_found' | 'ambiguous' | 'cannot_open' };

/** The text of an Exec value cut into arguments, the way the Desktop Entry spec reads quotes and backslashes in them. */
export function splitExec(exec: string): string[] {
  const args: string[] = [];
  let current = '';
  let started = false;
  let quoted = false;
  for (let i = 0; i < exec.length; i++) {
    const char = exec[i] as string;
    if (char === '\\' && i + 1 < exec.length) {
      current += exec[++i];
      started = true;
    } else if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && /\s/.test(char)) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

/**
 * The programs an Exec line may start: its first argument, and when that is `env`, every later argument that is not an
 * option or an assignment, since `env` starts the first of them and its options can take a value. A name that is not a
 * program, such as the value of `env -u`, does no harm in the list. It is only checked against the shell names.
 */
export function execPrograms(exec: string): string[] {
  const args = splitExec(exec);
  const first = args[0];
  if (first === undefined) return [];
  if (basename(first) !== 'env') return [first];
  return [first, ...args.slice(1).filter(arg => !arg.startsWith('-') && !arg.includes('=') && !arg.startsWith('%'))];
}

/** The `%f`, `%F`, `%u` and `%U` codes in an Exec line. A `%%` is a literal percent sign, not a code. */
function fieldCodes(exec: string): string[] {
  return [...exec.replace(/%%/g, '').matchAll(/%([fFuU])/g)].map(match => match[1] as string);
}

/**
 * True when the Exec line takes the target. A web address needs %u or %U. A file needs one of the four codes. Without a
 * code the launcher starts the app and drops the target, which would report success for a file that was never opened.
 */
export function execTakes(exec: string, need: OpenNeed): boolean {
  const codes = fieldCodes(exec);
  return need.kind === 'url' ? codes.some(code => code === 'u' || code === 'U') : codes.length > 0;
}

function truthy(value: string | undefined): boolean {
  return value === 'true';
}

function list(value: string | undefined): string[] {
  return (value ?? '').split(';').filter(Boolean);
}

/**
 * Reads one desktop entry. Only the [Desktop Entry] group counts, and keys with a locale are ignored. An entry is dropped,
 * not just ranked low, when it could not safely take a target from the twin:
 * - it is not an application, or it is hidden (a hidden entry means the app was removed), or it is not shown in menus;
 * - it runs in a terminal, or its category says it is a terminal emulator;
 * - it has no Exec line, or the Exec line starts a shell or a script interpreter. A wrapper such as `sh -c "app %f"`
 *   hands the path to a shell, and a file name can hold characters a shell reads, such as $ and ;.
 */
export function parseDesktopEntry(id: string, file: string, text: string): DesktopEntry | undefined {
  // No prototype, so a key such as __proto__ or constructor is only a key.
  const values: Record<string, string | undefined> = Object.create(null);
  let inGroup = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      inGroup = line === '[Desktop Entry]';
      continue;
    }
    if (!inGroup) continue;
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    if (key.includes('[')) continue;
    // The first value for a key wins, as the spec reads a file top to bottom within the group.
    if (!(key in values)) values[key] = line.slice(at + 1).trim();
  }
  if (values.Type !== 'Application') return undefined;
  if (truthy(values.Hidden) || truthy(values.NoDisplay) || truthy(values.Terminal)) return undefined;
  if (list(values.Categories).includes('TerminalEmulator')) return undefined;
  const exec = values.Exec;
  if (!exec) return undefined;
  const programs = execPrograms(exec);
  if (programs.length === 0 || programs.some(program => isShellApp(basename(program)))) return undefined;
  return {
    id,
    file,
    exec,
    ...(values.Name ? { name: values.Name } : {}),
    ...(values.StartupWMClass ? { wmClass: values.StartupWMClass } : {}),
    mimeTypes: list(values.MimeType),
  };
}

/** The directories that hold applications, highest priority first: the user's data dir, then each system data dir. */
export function applicationDirs(env: NodeJS.ProcessEnv): string[] {
  const home = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(homedir(), '.local', 'share');
  const system = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(dir => dir !== '' && isAbsolute(dir));
  return [home, ...system].map(dir => join(dir, 'applications'));
}

/**
 * Every usable desktop entry. A desktop file ID is taken from the first directory that has it, as the spec says, so a
 * user entry replaces a system entry with the same name, and a hidden user entry removes it. Only the top level of each
 * directory is read. An unreadable or oversized file is skipped.
 */
export function loadDesktopEntries(env: NodeJS.ProcessEnv = process.env): DesktopEntry[] {
  const entries: DesktopEntry[] = [];
  const seen = new Set<string>();
  for (const dir of applicationDirs(env)) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.desktop') || name.length === '.desktop'.length) continue;
      const id = name.slice(0, -'.desktop'.length);
      if (seen.has(id)) continue;
      const file = join(dir, name);
      let text: string;
      try {
        if (statSync(file).size > MAX_ENTRY_BYTES) continue;
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      seen.add(id);
      const entry = parseDesktopEntry(id, file, text);
      if (entry) entries.push(entry);
      if (entries.length >= MAX_ENTRIES) return entries;
    }
  }
  return entries;
}

function canTake(entry: DesktopEntry, need: OpenNeed): boolean {
  if (!execTakes(entry.exec, need)) return false;
  return need.kind === 'file' || entry.mimeTypes.includes(`x-scheme-handler/${need.scheme}`);
}

/**
 * The ways a name can match an entry, strongest first. The window class comes first because it is what capture records
 * and what the runner's check compares with. A tier decides only if it matches something. Names are compared after the
 * same normalising the runner uses, so case and spacing do not matter.
 */
const MATCH_TIERS: readonly ((entry: DesktopEntry) => string | undefined)[] = [
  entry => entry.wmClass,
  entry => entry.id,
  entry => entry.name,
];

/**
 * Resolves the named app to one desktop entry that can take the target. Entries that cannot take it (a browser entry
 * that does not handle the scheme, an entry with no file argument) are not candidates. The strongest tier with any
 * candidate must have exactly one, or the name is ambiguous and nothing opens.
 */
export function resolveDesktopEntry(app: string, entries: readonly DesktopEntry[], need: OpenNeed): OpenResolution {
  const wanted = normalizeAppName(app);
  if (wanted === '') return { ok: false, reason: 'not_found' };
  const matches = (tier: (entry: DesktopEntry) => string | undefined, entry: DesktopEntry): boolean => {
    const key = tier(entry);
    return key !== undefined && normalizeAppName(key) === wanted;
  };
  for (const tier of MATCH_TIERS) {
    const found = entries.filter(entry => matches(tier, entry) && canTake(entry, need));
    if (found.length === 1) return { ok: true, entry: found[0] as DesktopEntry };
    if (found.length > 1) return { ok: false, reason: 'ambiguous' };
  }
  const named = entries.some(entry => MATCH_TIERS.some(tier => matches(tier, entry)));
  return { ok: false, reason: named ? 'cannot_open' : 'not_found' };
}
