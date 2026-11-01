import { z } from 'zod';
import { effectOfOp, isShellApp } from './classify';
import type { Routine } from './mine';
import type { EffectClass } from './types';

const PARAM_REF = /^\$(p\d+)$/;
/** The longest automation name the schema accepts. Routine names are built from window classes, so they can exceed it. */
const NAME_MAX = 80;

export const ParamSchema = z
  .object({
    name: z.string().regex(/^p\d+$/),
    options: z.array(z.string().min(1).max(200)).min(2).max(5),
    default: z.string().min(1).max(200),
  })
  .strict();

/** Application names for the steps that open things: letters, digits, spaces and a few marks. Never a path or a flag. */
const PLAIN_APP_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._+()'-]*$/u;

/** An application named by a step, or a `$pN` parameter whose approved option names one. */
const AppRef = z
  .string()
  .min(1)
  .max(200)
  .refine(value => PARAM_REF.test(value) || PLAIN_APP_NAME.test(value), 'Use a plain application name.');

/** The application that receives a file or a key press. A shell or interpreter can run what it is given, so it is refused. */
const TargetAppRef = AppRef.refine(
  value => PARAM_REF.test(value) || !isShellApp(value),
  'Choose an application, not a shell or script runner.',
);

/** An http or https address, or a `$pN` parameter whose approved option is one. */
const UrlRef = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    value => PARAM_REF.test(value) || parseWebAddress(value) !== undefined,
    'Use an http or https address with no login, query or fragment.',
  );

/** One exact file path, stored literally. Parameters are not allowed here: the path is approved for each run. */
const FilePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(isSafeFilePath, 'Use one exact absolute file path, not a folder, a program or a wildcard.');

/** A key chord in canonical form, such as "cmd+shift+k". */
const KeyChord = z
  .string()
  .min(1)
  .max(40)
  .refine(value => parseKeyChord(value) === value, 'Use one or more modifiers and one key, such as cmd+shift+k.');

/**
 * The steps an automation may contain. Focus and check are the original vocabulary. Open URL, open file and press
 * shortcut each name what they act on, are classified in classify.ts, and have a postcondition the runner checks.
 * Every step is strict, so a stored step with an unknown field fails to load instead of being guessed at.
 */
export const StepSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('focus_app'), app: z.string().min(1).max(200) }).strict(),
  z.object({ op: z.literal('check_focus'), app: z.string().min(1).max(200) }).strict(),
  z.object({ op: z.literal('open_url'), app: AppRef, url: UrlRef }).strict(),
  z.object({ op: z.literal('open_file'), app: TargetAppRef, path: FilePath }).strict(),
  z.object({ op: z.literal('press_shortcut'), app: TargetAppRef, shortcut: KeyChord }).strict(),
]);

export const AutomationSchema = z
  .object({
    id: z.string().min(1).max(80),
    name: z.string().min(1).max(NAME_MAX),
    /** Version 1 automations hold focus and check steps only. Later steps are added without changing that shape. */
    version: z.number().int().positive(),
    routineId: z.string().min(1),
    params: z.array(ParamSchema).max(6),
    steps: z.array(StepSchema).min(1).max(12),
    /** Estimated time the routine takes by hand. Shown as "time back"; never measured from the person. */
    estimate: z.object({ minutesPerWeek: z.number().nonnegative(), occurrencesPerWeek: z.number().nonnegative() }).strict().optional(),
  })
  .strict();

export type Param = z.infer<typeof ParamSchema>;
export type Step = z.infer<typeof StepSchema>;
export type Automation = z.infer<typeof AutomationSchema>;

const WEB_SCHEMES = ['http:', 'https:'];
/** A dotted DNS-style host name. Keeps out bare words such as "localhost" and most odd forms. */
const HOST_NAME = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/**
 * Parses an http or https address the twin may open, and returns it in canonical form, or undefined. Logins, explicit
 * ports, queries and fragments are refused. Queries and fragments are where tokens and personal data tend to sit, and
 * the twin never stores them.
 */
export function parseWebAddress(value: string): URL | undefined {
  if (value.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(value)) return undefined;
  if (value.includes('?') || value.includes('#')) return undefined;
  // Checked on the text. WHATWG parsing drops a default port such as :443, so the parsed URL cannot show it.
  const authority = value.replace(/^[a-z][a-z0-9+.-]*:[/\\]*/i, '').split(/[/\\]/)[0] ?? '';
  if (authority.includes(':')) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!WEB_SCHEMES.includes(url.protocol)) return undefined;
  if (url.username || url.password || url.port) return undefined;
  return HOST_NAME.test(url.hostname) ? url : undefined;
}

/** Files that run as programs, scripts or installers when the system opens them. Opening a file never runs one. */
const PROGRAM_EXTENSION =
  /\.(app|applescript|application|bat|cmd|com|command|cpl|desktop|dll|dmg|exe|hta|jar|js|jse|lnk|mpkg|msc|msi|msix|msp|ocx|pif|pkg|ps1|psm1|reg|scf|scpt|scptd|scr|sh|url|vbe|vbs|webloc|workflow|wsf|wsh)$/i;
/** Control characters, quotes, backticks and wildcards. None of them belongs in one exact path. */
const UNSAFE_PATH_CHARS = /[\u0000-\u001f\u007f"'`*?<>|]/;

/**
 * True for one exact absolute file path: not a folder, not a program, not a wildcard, and no relative or parent
 * segments, no network share and no alternate data stream. The platform adapter checks the file on disk as well,
 * following any link.
 */
export function isSafeFilePath(value: string): boolean {
  if (value.length === 0 || value.length > 1024 || UNSAFE_PATH_CHARS.test(value)) return false;
  if (!/^(\/|[A-Za-z]:[\\/])/.test(value) || /^[\\/]{2}/.test(value) || /[\\/]$/.test(value)) return false;
  // The only colon allowed is the drive letter. Any other colon starts an alternate data stream on Windows.
  if (value.replace(/^[A-Za-z]:/, '').includes(':')) return false;
  const parts = value.split(/[\\/]+/);
  const name = parts[parts.length - 1];
  // Windows drops a trailing dot or space from a name, so "setup.exe." is the program "setup.exe".
  if (!name || /[. ]$/.test(name) || parts.some(part => part === '.' || part === '..')) return false;
  return !PROGRAM_EXTENSION.test(name);
}

/** What the disk says about a path: the real path after following any link, and whether that is a regular file. */
export interface FileStat {
  realPath: string;
  isFile: boolean;
}

/**
 * The real path of one regular file that may be opened, or undefined. The name rules run first. Then the disk decides,
 * through the stat callback, which follows any link: a link to a program is refused like the program, and a folder
 * with no extension is refused too. The caller supplies the callback, so this stays free of file access.
 */
export function openableFilePath(path: string, stat: (path: string) => FileStat | undefined): string | undefined {
  if (!isSafeFilePath(path)) return undefined;
  const found = stat(path);
  return found?.isFile && isSafeFilePath(found.realPath) ? found.realPath : undefined;
}

const CHORD_MODIFIERS = ['cmd', 'ctrl', 'alt', 'shift'] as const;
const CHORD_KEY = /^(?:[a-z0-9]|f(?:[1-9]|1[0-2])|return|tab|escape|space|delete|up|down|left|right|home|end|pageup|pagedown)$/;

/**
 * The canonical form of a key chord, such as "cmd+shift+k", or undefined. A chord has at least one modifier, each
 * modifier at most once, and one key from a fixed list. "cmd" is the primary modifier: Command on macOS, Control elsewhere.
 */
export function parseKeyChord(value: string): string | undefined {
  const parts = value.split('+');
  const key = parts.pop() ?? '';
  if (parts.length === 0 || !CHORD_KEY.test(key)) return undefined;
  const modifiers = CHORD_MODIFIERS.filter(modifier => parts.includes(modifier));
  return modifiers.length === parts.length ? [...modifiers, key].join('+') : undefined;
}

/**
 * Compiles a mined routine into an automation. Each routine position becomes a focus step and a
 * postcondition check. A position where the observed app varies becomes a parameter whose options
 * are the apps actually seen there.
 */
export function compileRoutine(routine: Routine, name: string = defaultName(routine)): Automation {
  const params: Param[] = [];
  const steps: Step[] = [];
  routine.steps.forEach((step, index) => {
    let app = step.app;
    if (step.options.length > 1) {
      const paramName = `p${index}`;
      params.push({ name: paramName, options: step.options, default: step.app });
      app = `$${paramName}`;
    }
    steps.push({ op: 'focus_app', app }, { op: 'check_focus', app });
  });
  return AutomationSchema.parse({
    id: `auto_${routine.id}`,
    name: fitName(name),
    version: 1,
    routineId: routine.id,
    params,
    steps,
    estimate: {
      occurrencesPerWeek: routine.occurrencesPerWeek,
      minutesPerWeek: Number(((routine.durationMs / 60_000) * routine.occurrencesPerWeek).toFixed(1)),
    },
  });
}

/** An unknown app is named by its app, since its window class is only 'other'. */
export function defaultName(routine: Routine): string {
  return `Routine: ${routine.steps.map(step => (step.windowClass === 'other' ? step.app : step.windowClass)).join(' → ')}`;
}

/**
 * A name the schema accepts. A longer one is cut and ends with an ellipsis, so a long routine still compiles. Accepting
 * a routine and renaming an automation both use it, so the two follow the same rule.
 */
export function fitName(name: string): string {
  return name.length <= NAME_MAX ? name : `${name.slice(0, NAME_MAX - 1)}…`;
}

/** Resolves a "$pN" reference against the bound values, which must be observed options. */
export function resolveApp(app: string, params: readonly Param[], values: Readonly<Record<string, string>>): string {
  const match = PARAM_REF.exec(app);
  if (!match) return app;
  const param = params.find(p => p.name === match[1]);
  if (!param) throw new Error(`Unknown parameter ${match[1]}.`);
  const value = values[param.name] ?? param.default;
  if (!param.options.includes(value)) throw new Error(`Value for ${param.name} is not an observed option.`);
  return value;
}

/**
 * Binds a step's parameter references to the values for one run. A bound address must still be an allowed web
 * address, and a bound application name must still be a plain one. An approved option cannot smuggle in something
 * the schema refuses. Any failure throws before the first step, so a bad value runs nothing.
 */
export function resolveStep(step: Step, params: readonly Param[], values: Readonly<Record<string, string>>): Step {
  const app = resolveApp(step.app, params, values);
  switch (step.op) {
    case 'focus_app':
      return { op: 'focus_app', app };
    case 'check_focus':
      return { op: 'check_focus', app };
    case 'open_url': {
      const url = resolveApp(step.url, params, values);
      if (!parseWebAddress(url)) throw new Error('That address is not an allowed http or https address.');
      return { op: 'open_url', app: plainAppName(app), url };
    }
    case 'open_file':
      if (!isSafeFilePath(step.path)) throw new Error('That file path is not allowed.');
      return { op: 'open_file', app: targetAppName(app), path: step.path };
    case 'press_shortcut':
      if (parseKeyChord(step.shortcut) !== step.shortcut) throw new Error('That key chord is not allowed.');
      return { op: 'press_shortcut', app: targetAppName(app), shortcut: step.shortcut };
  }
}

function plainAppName(app: string): string {
  if (!PLAIN_APP_NAME.test(app)) throw new Error('That application name is not allowed.');
  return app;
}

/** The plain name of an application that receives a file or a key press. A shell or interpreter is refused. */
function targetAppName(app: string): string {
  const name = plainAppName(app);
  if (isShellApp(name)) throw new Error('That application cannot be the target of a file or a key press.');
  return name;
}

/**
 * The question an approval asks, in plain words. It names the exact address, file or chord the step uses, so the
 * person approves what will happen rather than a summary of it.
 */
export function describeStep(step: Step): string {
  switch (step.op) {
    case 'focus_app':
      return `Bring "${step.app}" to the front?`;
    case 'check_focus':
      return `Check that "${step.app}" is in front?`;
    case 'open_url':
      return `Open ${step.url} in "${step.app}"?`;
    case 'open_file':
      return `Open ${step.path} in "${step.app}"?`;
    case 'press_shortcut':
      return `Press ${step.shortcut} in "${step.app}"?`;
  }
}

/** Every effect the automation can produce across all parameter options. */
export function effectsOf(automation: Automation): EffectClass[] {
  const effects = new Set<EffectClass>();
  for (const step of automation.steps) {
    const param = automation.params.find(p => `$${p.name}` === step.app);
    const apps = param ? param.options : [step.app];
    for (const app of apps) effects.add(effectOfOp(step.op, app));
  }
  return [...effects];
}
