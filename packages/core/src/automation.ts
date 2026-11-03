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
 * One label in a menu path, as the app shows it, such as "View", "Clean Up By" or "Save As…". A letter or digit first, then
 * letters, digits, spaces and a few marks. No quotes, control characters or leading dash, so it cannot read as a flag.
 */
export const MENU_LABEL = /^[\p{L}\p{N}][\p{L}\p{N} .,…&()’'+:/-]{0,79}$/u;
const MenuLabel = z.string().min(1).max(80).regex(MENU_LABEL, 'Use the menu label as the app shows it.');
/** A menu path: the menu bar item first, then each submenu, then the item to choose. */
export const MENU_PATH_MIN = 2;
export const MENU_PATH_MAX = 4;

/** True for a menu path the twin may choose: two to four labels, each one allowed. */
export function isAllowedMenuPath(menu: readonly string[]): boolean {
  return menu.length >= MENU_PATH_MIN && menu.length <= MENU_PATH_MAX && menu.every(label => MENU_LABEL.test(label));
}

/**
 * A name or window title a desktop step matches, as the app shows it: a letter, digit or mark first, then printable text.
 * No control characters, and no leading dash, so it cannot read as a flag.
 */
export const UI_LABEL = /^[^\u0000-\u001f\u007f-][^\u0000-\u001f\u007f]{0,119}$/u;
const UiLabel = z.string().min(1).max(120).regex(UI_LABEL, 'Use the name as the app shows it.');

/** The accessibility roles a desktop step can aim at. Anything else is refused, so a step names what it touches. */
export const UI_ROLES = [
  'group',
  'button',
  'menuitem',
  'textfield',
  'statictext',
  'radiobutton',
  'checkbox',
  'cell',
  'link',
  'image',
  'combobox',
] as const;

/**
 * One element in a window: its role, and its name exactly or by the start of it. `last` picks the last match instead of
 * the first, and `inDialog` keeps only elements inside an open dialog, so a dialog's OK never resolves to a button behind it.
 */
export const LocatorSchema = z
  .object({
    role: z.enum(UI_ROLES),
    name: UiLabel.optional(),
    namePrefix: UiLabel.optional(),
    last: z.boolean().optional(),
    inDialog: z.boolean().optional(),
  })
  .strict()
  .refine(locator => (locator.name === undefined) !== (locator.namePrefix === undefined), 'Give a name or a name prefix.');
export type Locator = z.infer<typeof LocatorSchema>;

/** Text a step enters: printable characters, tabs and line breaks only, so it cannot carry other control keys. */
export const ENTERED_TEXT = /^[^\u0000-\u0008\u000b-\u001f\u007f]*$/u;
export const ENTERED_TEXT_MAX = 4000;
const EnteredText = z.string().min(1).max(ENTERED_TEXT_MAX).regex(ENTERED_TEXT, 'Use printable text, tabs and line breaks.');

/** A key a step presses, alone or with modifiers, such as "return", "escape" or "cmd+shift+n". */
const KeyName = z
  .string()
  .min(1)
  .max(40)
  .refine(value => parseKeyName(value) === value, 'Use one key, with or without modifiers, such as return or cmd+v.');

/** What a check reads: the clipboard, or every piece of text shown in the window. */
const CheckSource = z.enum(['clipboard', 'window']);

/**
 * The steps an automation may contain. Focus and check are the original vocabulary. Open URL, open file and press
 * shortcut each name what they act on, are classified in classify.ts, and have a postcondition the runner checks.
 * The desktop steps act in one window of an app, chosen by its title, through the agent-desktop program: click an
 * element, paste text, press a key, fill a field (checked before it is submitted), set a field by typing, and check
 * that text is shown. Every step is strict, so a stored step with an unknown field fails to load instead of being guessed at.
 */
export const StepSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('focus_app'), app: z.string().min(1).max(200) }).strict(),
  z.object({ op: z.literal('check_focus'), app: z.string().min(1).max(200) }).strict(),
  z.object({ op: z.literal('open_url'), app: AppRef, url: UrlRef }).strict(),
  z.object({ op: z.literal('open_file'), app: TargetAppRef, path: FilePath }).strict(),
  z.object({ op: z.literal('press_shortcut'), app: TargetAppRef, shortcut: KeyChord }).strict(),
  z.object({ op: z.literal('choose_menu'), app: TargetAppRef, menu: z.array(MenuLabel).min(MENU_PATH_MIN).max(MENU_PATH_MAX) }).strict(),
  z
    .object({
      op: z.literal('click'),
      app: TargetAppRef,
      window: UiLabel.optional(),
      target: LocatorSchema,
      button: z.enum(['left', 'right']).optional(),
    })
    .strict(),
  z.object({ op: z.literal('paste_text'), app: TargetAppRef, window: UiLabel.optional(), text: EnteredText }).strict(),
  z.object({ op: z.literal('press_key'), app: TargetAppRef, window: UiLabel.optional(), key: KeyName }).strict(),
  z
    .object({
      op: z.literal('fill_field'),
      app: TargetAppRef,
      window: UiLabel.optional(),
      target: LocatorSchema,
      text: EnteredText.max(400),
      submit: z.boolean(),
    })
    .strict(),
  z
    .object({ op: z.literal('set_field'), app: TargetAppRef, window: UiLabel.optional(), target: LocatorSchema, text: EnteredText.max(400) })
    .strict(),
  z
    .object({
      op: z.literal('check_text'),
      app: TargetAppRef,
      window: UiLabel.optional(),
      source: CheckSource,
      expect: z.array(z.string().min(1).max(400).regex(ENTERED_TEXT)).min(1).max(40),
    })
    .strict(),
]);

/** The most steps one automation may hold. A desktop playbook strings many small steps together. */
export const STEPS_MAX = 120;

export const AutomationSchema = z
  .object({
    id: z.string().min(1).max(80),
    name: z.string().min(1).max(NAME_MAX),
    /** Version 1 automations hold focus and check steps only. Later steps are added without changing that shape. */
    version: z.number().int().positive(),
    routineId: z.string().min(1),
    params: z.array(ParamSchema).max(6),
    steps: z.array(StepSchema).min(1).max(STEPS_MAX),
    /** Estimated time the routine takes by hand. Shown as "time back"; never measured from the person. */
    estimate: z.object({ minutesPerWeek: z.number().nonnegative(), occurrencesPerWeek: z.number().nonnegative() }).strict().optional(),
  })
  .strict();

/**
 * What a person gives to make a menu automation by hand: its name, the app, and the menu path to choose. The app is a plain
 * name, never a parameter, a shell or a script runner. The schema is strict, so a field the page should not send is refused.
 */
export const MenuAutomationInputSchema = z
  .object({
    name: z.string().trim().min(1).max(NAME_MAX),
    app: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine(value => PLAIN_APP_NAME.test(value) && !isShellApp(value), 'Choose an application, not a shell or script runner.'),
    menu: z.array(z.string().trim().pipe(MenuLabel)).min(MENU_PATH_MIN).max(MENU_PATH_MAX),
  })
  .strict();
export type MenuAutomationInput = z.infer<typeof MenuAutomationInputSchema>;

/**
 * A hand-made automation that chooses one menu path: it brings the app forward, then chooses the path. Its routine id says
 * it was made by hand, so no learned routine is ever matched to it.
 */
export function compileMenuAutomation(input: MenuAutomationInput, id: string): Automation {
  return AutomationSchema.parse({
    id,
    name: fitName(input.name),
    version: 2,
    routineId: `manual:${id}`,
    params: [],
    steps: [
      { op: 'focus_app', app: input.app },
      { op: 'choose_menu', app: input.app, menu: input.menu },
    ],
  });
}

/**
 * A playbook: a hand-written automation of desktop steps, such as one exported by a benchmark. It names its steps
 * exactly, with no parameters, and every step passes the step schema. It starts as a draft, like a menu automation.
 */
export const PlaybookInputSchema = z
  .object({
    name: z.string().trim().min(1).max(NAME_MAX),
    steps: z.array(StepSchema).min(1).max(STEPS_MAX),
  })
  .strict()
  .refine(input => input.steps.every(step => !PARAM_REF.test(step.app)), 'A playbook names each app; it takes no parameters.');
export type PlaybookInput = z.infer<typeof PlaybookInputSchema>;

/** A playbook as an automation. Its routine id says it was made by hand, so no learned routine is ever matched to it. */
export function compilePlaybook(input: PlaybookInput, id: string): Automation {
  return AutomationSchema.parse({
    id,
    name: fitName(input.name),
    version: 3,
    routineId: `manual:${id}`,
    params: [],
    steps: input.steps,
  });
}

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
 * The canonical form of a key a desktop step presses, with or without modifiers, such as "return" or "cmd+v", or
 * undefined. The keys are the same fixed list a chord uses.
 */
export function parseKeyName(value: string): string | undefined {
  return CHORD_KEY.test(value) ? value : parseKeyChord(value);
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
    case 'choose_menu':
      if (!isAllowedMenuPath(step.menu)) throw new Error('That menu path is not allowed.');
      return { op: 'choose_menu', app: targetAppName(app), menu: [...step.menu] };
    case 'press_key':
      if (parseKeyName(step.key) !== step.key) throw new Error('That key is not allowed.');
      return { ...step, app: targetAppName(app) };
    case 'click':
    case 'paste_text':
    case 'fill_field':
    case 'set_field':
    case 'check_text':
      // Desktop steps take no parameters. The schema checked their text, names and keys when the automation loaded.
      return { ...step, app: targetAppName(app) };
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
    case 'choose_menu':
      return `Choose ${step.menu.join(' → ')} in "${step.app}"?`;
    case 'click':
      return `${step.button === 'right' ? 'Right-click' : 'Click'} ${describeTarget(step.target)} in ${describeWindow(step)}?`;
    case 'paste_text':
      return `Paste ${describeText(step.text)} into ${describeWindow(step)}?`;
    case 'press_key':
      return `Press ${step.key} in ${describeWindow(step)}?`;
    case 'fill_field':
      return `Enter ${describeText(step.text)} in ${describeTarget(step.target)}${step.submit ? ' and press Return' : ''} in ${describeWindow(step)}?`;
    case 'set_field':
      return `Type ${describeText(step.text)} into ${describeTarget(step.target)} in ${describeWindow(step)}?`;
    case 'check_text':
      return `Check that ${step.source === 'clipboard' ? 'the clipboard' : describeWindow(step)} shows ${step.expect.length === 1 ? describeText(step.expect[0]) : `${step.expect.length} expected values`}?`;
  }
}

function describeWindow(step: { app: string; window?: string }): string {
  return step.window ? `the "${step.window}" window of "${step.app}"` : `"${step.app}"`;
}

function describeTarget(target: Locator): string {
  return `the ${target.role} "${target.name ?? `${target.namePrefix}…`}"`;
}

/** Text as an approval shows it: in full when short, otherwise its start and its length. */
function describeText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= 80 ? `"${flat}"` : `"${flat.slice(0, 77)}…" (${text.length} characters)`;
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
