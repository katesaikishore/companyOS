import { z } from 'zod';
import { riskOf } from '../apps/capabilities';
import { isExcludedApp, isShellApp, normalizeAppName } from '../classify';

/**
 * The actions the task operator may take in a desktop app, and the rule for each one. The model proposes one action at a
 * time; this module checks it against what is on the screen, and decides whether it runs, waits for the person, or is
 * refused. The model's own words never lower that decision.
 *
 * The rule is an allowlist, because no word list can name every way to send or delete. The operator acts on its own only
 * in a short list of local apps. In every other app each step waits for the person. Inside the allowed apps, a step that may
 * send, share, spend, sign in or lose work still waits.
 */

/** One addressable control from an accessibility snapshot. Refs are valid only for the snapshot they came from. */
export interface Control {
  ref: string;
  role: string;
  /** The name as the app gives it, with line breaks and control characters removed. */
  name: string;
  /** The accessibility description, when there is one. Icon buttons often carry their meaning only here. */
  description?: string;
  /** True for a field that hides what is typed, such as a password field. */
  secure?: boolean;
  /** The current text of a text field, cut short. Left out for other roles and for secure fields. */
  value?: string;
  /** True for a text field whose text has more than one line, such as a document. Text added to it starts a new line. */
  multiline?: boolean;
}

export interface Observation {
  app: string;
  /** The title of the window that was read, such as the open folder or document. It is screen text, like a control name. */
  window?: string;
  controls: Control[];
  /** A short fact about the app's state, such as having no window open. */
  note?: string;
}

export type OperatorAction =
  | { type: 'click'; ref: string; reason: string }
  | { type: 'type'; ref: string; text: string; reason: string }
  | { type: 'press'; keys: string; reason: string }
  | { type: 'scroll'; ref: string; direction: 'up' | 'down'; reason: string }
  | { type: 'launch'; app: string; reason: string }
  | { type: 'focus_app'; app: string; reason: string }
  | { type: 'done'; summary: string }
  | { type: 'fail'; reason: string };

export const ACTION_NAMES = ['click', 'type', 'press', 'scroll', 'launch', 'focus_app', 'done', 'fail'] as const;

/** The JSON shape the model fills. It is flat, so a grammar or a tool schema can hold it. */
export const ACTION_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...ACTION_NAMES] },
    ref: { type: 'string' },
    name: { type: 'string' },
    text: { type: 'string' },
    keys: { type: 'string' },
    app: { type: 'string' },
    direction: { type: 'string', enum: ['up', 'down'] },
    reason: { type: 'string' },
  },
  // ref, name and text are always present, empty when unused, so a small model cannot leave the target or the text out.
  required: ['action', 'ref', 'name', 'text', 'reason'],
} as const;

/** The apps the operator may act in without asking each step: local editors where a step cannot send anything. */
export const DEFAULT_AUTONOMOUS_APPS: readonly string[] = ['textedit', 'notes', 'stickies'];

const APP_NAME = /^[\p{L}\p{N}][\p{L}\p{N} .\-()]{0,79}$/u;
/** A bundle ID such as com.apple.Terminal. It would never match the app-name lists, so it is not accepted. */
const BUNDLE_ID = /^[a-z0-9-]+(?:\.[a-z0-9-]+){2,}$/i;
const KEYS = /^[a-z0-9]+(?:\+[a-z0-9]+){0,3}$/;
const MAX_TEXT = 2000;

/**
 * A target field that is too long to name anything is treated as left empty. Small models fill every field, for example
 * the whole document as the name of a done reply, and that must not turn a good answer into an invalid one.
 */
const target = (max: number) =>
  z
    .string()
    .optional()
    .transform(value => (value !== undefined && value.length <= max ? value : undefined));

const Reply = z.object({
  action: z.enum(ACTION_NAMES),
  ref: target(80),
  name: target(120),
  text: z.string().max(MAX_TEXT).optional(),
  keys: target(40),
  app: target(80),
  direction: z.enum(['up', 'down']).optional(),
  reason: z.string().trim().min(1).max(300),
});

const KEY_ALIASES: Record<string, string> = {
  command: 'cmd',
  meta: 'cmd',
  super: 'cmd',
  win: 'cmd',
  windows: 'cmd',
  option: 'alt',
  opt: 'alt',
  control: 'ctrl',
  enter: 'return',
  kpenter: 'return',
  keypadenter: 'return',
  numpadenter: 'return',
  esc: 'escape',
  del: 'delete',
  forwarddelete: 'delete',
  bksp: 'backspace',
};
const MODIFIERS = ['cmd', 'ctrl', 'alt', 'shift'];

/** A key combo in one spelling: aliases folded, modifiers in a fixed order, so "Command+Enter" and "cmd+return" are the same. */
export function normalizeKeys(raw: string): string | undefined {
  const parts = raw.trim().toLowerCase().replace(/\s+/g, '').split('+').filter(Boolean).map(part => KEY_ALIASES[part] ?? part);
  if (parts.length === 0 || parts.length > 4) return undefined;
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);
  if (MODIFIERS.includes(key) || !modifiers.every(modifier => MODIFIERS.includes(modifier))) return undefined;
  const ordered = [...new Set(modifiers)].sort((a, b) => MODIFIERS.indexOf(a) - MODIFIERS.indexOf(b));
  const combo = [...ordered, key].join('+');
  return KEYS.test(combo) ? combo : undefined;
}

/**
 * The model's reply as an action, or a reason it cannot be one. A ref must be in this turn's observation, so the model
 * cannot act on a control it did not see.
 */
export function parseAction(reply: unknown, observation: Observation): { action: OperatorAction } | { invalid: string } {
  const parsed = Reply.safeParse(reply);
  if (!parsed.success) return { invalid: 'The reply does not match the action shape.' };
  const { action, ref, name, text, keys, app, direction, reason } = parsed.data;
  const refs = new Set(observation.controls.map(control => control.ref));
  // A ref from this turn wins. Otherwise a control name counts only when exactly one control on the screen has that name.
  const needsRef = (): string | undefined => {
    if (ref && refs.has(ref)) return ref;
    const wanted = name?.trim().toLowerCase();
    if (!wanted) return undefined;
    const matches = observation.controls.filter(control => control.name.trim().toLowerCase() === wanted);
    return matches.length === 1 ? matches[0].ref : undefined;
  };
  switch (action) {
    case 'click': {
      const target = needsRef();
      return target ? { action: { type: 'click', ref: target, reason } } : { invalid: 'The ref is not on the screen.' };
    }
    case 'type': {
      const target = needsRef();
      if (!target) return { invalid: 'The ref is not on the screen.' };
      if (!text) return { invalid: 'There is no text to type.' };
      return { action: { type: 'type', ref: target, text, reason } };
    }
    case 'scroll': {
      const target = needsRef();
      return target ? { action: { type: 'scroll', ref: target, direction: direction ?? 'down', reason } } : { invalid: 'The ref is not on the screen.' };
    }
    case 'press': {
      // Models often put the combo in "name", the one target field every reply fills. It counts only when it is a combo, so a
      // button called "Delete" never becomes the Delete key.
      const raw = keys || (name?.includes('+') ? name : undefined);
      const combo = raw ? normalizeKeys(raw) : undefined;
      return combo ? { action: { type: 'press', keys: combo, reason } } : { invalid: 'The key combo is not allowed.' };
    }
    case 'launch':
    case 'focus_app': {
      const appName = (app || name)?.trim();
      if (!appName || !APP_NAME.test(appName) || BUNDLE_ID.test(appName)) return { invalid: 'The application name is not allowed.' };
      return { action: { type: action, app: appName, reason } };
    }
    case 'done':
      return { action: { type: 'done', summary: reason } };
    case 'fail':
      return { action: { type: 'fail', reason } };
  }
}

export type Verdict = { verdict: 'allow' } | { verdict: 'ask'; why: string } | { verdict: 'deny'; why: string };

export interface JudgeOptions {
  excludedApps: readonly string[];
  /** Apps where steps run without asking. Defaults to DEFAULT_AUTONOMOUS_APPS. */
  autonomousApps?: readonly string[];
}

/** Script tools and terminals that isShellApp does not name. Any of them can run a shell command. */
const SCRIPT_HOSTS = new Set(['script editor', 'automator', 'shortcuts', 'terminal', 'iterm', 'iterm2', 'warp', 'rio', 'wave', 'termius', 'kitty', 'alacritty', 'ghostty', 'wezterm', 'hyper']);
const OUTBOUND_WORDS =
  /\b(send|post|publish|reply|submit|share|forward|invite|e-?mail|message|upload|attach|approve|accept|decline|allow|connect|subscribe|follow|like|comment|rsvp|push|pay|payment|purchase|buy|order|checkout|check out|transfer|donate|sign in|sign up|log in|login|register|continue with)\b/i;
const DESTRUCTIVE_WORDS = /\b(close|delete|remove|erase|trash|bin|discard|don't save|do not save|revert|replace|overwrite|clear|reset|wipe|log out|sign out|quit|shut down|restart|uninstall|archive)\b/i;
const PASSWORD_WORDS = /\b(password|passwort|passphrase|passcode|kennwort|contraseña|senha|mot de passe|pin)\b/i;
/** Keys that only edit or move inside a local editor. Anything else waits for the person, even in an allowed app. */
const SAFE_KEYS = new Set(['return', 'tab', 'space', 'up', 'down', 'left', 'right', 'backspace', 'delete', 'escape', 'home', 'end', 'pageup', 'pagedown', 'cmd+n', 'cmd+a', 'cmd+c', 'cmd+v', 'cmd+z', 'cmd+shift+z', 'cmd+b', 'cmd+i', 'cmd+u']);
/** Control characters that can submit a field or move focus when typed. A new line is allowed in an allowed editor only. */
const RISKY_TEXT = /[\u0000-\u0009\u000b-\u001f\u007f]/;

/** A control's name and description, in one spelling: curly apostrophes and no-break spaces folded. */
function labelOf(control: Control | undefined): string {
  if (!control) return '';
  return `${control.name} ${control.description ?? ''}`.replace(/[\u2018\u2019]/g, "'").replace(/\u00a0/g, ' ');
}

/**
 * Whether an action runs, waits for the person, or is refused. Password managers, excluded apps, shells and script tools are
 * refused, and passwords are never typed. Outside the allowed apps every step waits for the person.
 */
export function judge(action: OperatorAction, observation: Observation, options: JudgeOptions): Verdict {
  const autonomous = new Set((options.autonomousApps ?? DEFAULT_AUTONOMOUS_APPS).map(normalizeAppName));
  const app = action.type === 'launch' || action.type === 'focus_app' ? action.app : observation.app;
  const normalized = normalizeAppName(app);
  if (isExcludedApp(app, options.excludedApps)) return { verdict: 'deny', why: `${app} is on the excluded list.` };
  if (isShellApp(app) || SCRIPT_HOSTS.has(normalized)) return { verdict: 'deny', why: 'Shells, terminals and script tools are not operated.' };

  const target = 'ref' in action ? observation.controls.find(control => control.ref === action.ref) : undefined;
  if (action.type === 'type' && (target?.secure || /secure/i.test(target?.role ?? '') || PASSWORD_WORDS.test(labelOf(target)))) {
    return { verdict: 'deny', why: 'Passwords are never typed.' };
  }
  if (action.type === 'launch' || action.type === 'focus_app') {
    return autonomous.has(normalized) ? { verdict: 'allow' } : { verdict: 'ask', why: `${app} is not on the list of apps the operator may use on its own.` };
  }
  if (action.type === 'done' || action.type === 'fail') return { verdict: 'allow' };
  if (!autonomous.has(normalized)) return { verdict: 'ask', why: `Every step in ${app} needs your approval.` };

  switch (action.type) {
    case 'scroll':
      return { verdict: 'allow' };
    case 'click': {
      const label = labelOf(target);
      if (!target) return { verdict: 'ask', why: 'The control could not be checked.' };
      if (DESTRUCTIVE_WORDS.test(label) || riskOf(label, 'read_only') === 'destructive') return { verdict: 'ask', why: `"${target.name || target.description}" may delete or lose work.` };
      if (OUTBOUND_WORDS.test(label) || riskOf(label, 'read_only') === 'outbound') return { verdict: 'ask', why: `"${target.name || target.description}" may send or share something.` };
      return { verdict: 'allow' };
    }
    case 'type':
      return RISKY_TEXT.test(action.text) ? { verdict: 'ask', why: 'The text has characters that may submit or move focus.' } : { verdict: 'allow' };
    case 'press':
      return SAFE_KEYS.has(action.keys) ? { verdict: 'allow' } : { verdict: 'ask', why: `${action.keys} may quit, close, delete or send.` };
  }
}
