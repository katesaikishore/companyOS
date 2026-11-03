import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { ActResult, Observation, OperatorAction, OperatorHands } from '@companyos/twin-core';
import { APP_NAME } from './app-surface';

/**
 * The operator's hands: the agent-desktop program, called with a fixed argument list and no shell. It reads an app's
 * accessibility tree and carries out one action at a time. It never uses physical input (no --headed) and never forces a
 * shortcut agent-desktop calls dangerous (no --force). Positional text goes after "--", so typed text that starts with a
 * hyphen is never read as a flag.
 */

/** Runs the program and gives back what it printed, also when it exits with an error, because errors come as JSON too. */
export type Exec = (binary: string, args: readonly string[], signal?: AbortSignal) => Promise<string>;

const CALL_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_CONTROLS = 200;
/** Names and descriptions are kept long enough for the safety check to see every word. The prompt shows less. */
const MAX_LABEL = 300;
/** A field's text as the model sees it: its start and its end, so a line typed at the end can be seen to have landed. */
const MAX_VALUE = 200;
const VALUE_HEAD = 60;
const MAX_TITLE = 120;
const TEXT_ROLES = new Set(['textfield', 'textarea', 'searchfield', 'combobox']);
const WINDOW_ID = /^w-\d+$/;

// Stop ends a call that is still running: the stop signal kills the program.
const defaultExec: Exec = (binary, args, signal) =>
  new Promise(resolve => {
    execFile(binary, [...args], { timeout: CALL_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, signal }, (_error, stdout) => resolve(stdout ?? ''));
  });

interface Envelope {
  ok?: boolean;
  data?: unknown;
  error?: { code?: string; disposition?: { delivery?: string } };
}

function envelope(stdout: string): Envelope | undefined {
  try {
    return JSON.parse(stdout) as Envelope;
  } catch {
    return undefined;
  }
}

/** Screen text with line breaks and control characters turned into spaces, so it stays one line. */
function clean(text: unknown, max: number): string {
  return typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim().slice(0, max) : '';
}

/** Long text cut to its start and its end, with an ellipsis between, so the newest lines at the end stay in view. */
function headAndTail(text: string): string {
  if (text.length <= MAX_VALUE) return text;
  return `${text.slice(0, VALUE_HEAD)} … ${text.slice(text.length - (MAX_VALUE - VALUE_HEAD - 3))}`;
}

/** The addressable controls in a snapshot. A secure field is marked, and its value is never kept. */
export function controlsOf(snapshot: Envelope | undefined): Observation['controls'] {
  const controls: Observation['controls'] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object' || controls.length >= MAX_CONTROLS) return;
    const element = node as { ref_id?: unknown; role?: unknown; name?: unknown; description?: unknown; value?: unknown; states?: unknown; children?: unknown };
    // A disabled or hidden control cannot take an action, so it is left out: a small model would keep pressing it.
    const states = Array.isArray(element.states) ? element.states : [];
    const inert = states.includes('disabled') || states.includes('hidden');
    if (typeof element.ref_id === 'string' && typeof element.role === 'string' && !inert) {
      const name = clean(element.name, MAX_LABEL);
      const description = clean(element.description, MAX_LABEL);
      const secure = /secure/i.test(element.role) || states.includes('secure');
      const control: Observation['controls'][number] = { ref: element.ref_id, role: element.role, name: name || description };
      if (description && description !== control.name) control.description = description;
      if (secure) control.secure = true;
      else if (TEXT_ROLES.has(element.role) && typeof element.value === 'string') {
        control.value = headAndTail(clean(element.value, Number.MAX_SAFE_INTEGER));
        if (/[\r\n]/.test(element.value)) control.multiline = true;
      }
      controls.push(control);
    }
    if (Array.isArray(element.children)) for (const child of element.children) walk(child);
  };
  walk((snapshot?.data as { tree?: unknown } | undefined)?.tree);
  return controls;
}

/** agent-desktop's delivery word, folded into four. Only not_delivered is safe to try again. */
export function deliveryOf(result: Envelope | undefined): ActResult {
  if (!result) return { delivery: 'unknown', code: 'unreadable_output' };
  const data = result.data as { disposition?: { delivery?: string } } | undefined;
  const word = result.ok ? data?.disposition?.delivery : result.error?.disposition?.delivery;
  const code = result.ok ? undefined : result.error?.code;
  if (word === 'not_delivered') return { delivery: 'not_delivered', code };
  if (result.ok && word === 'delivered_unverified') return { delivery: 'unverified' };
  if (result.ok && (word === undefined || word.startsWith('delivered'))) return { delivery: 'delivered' };
  return { delivery: 'unknown', code };
}

type HandAction = Exclude<OperatorAction, { type: 'done' } | { type: 'fail' }>;

function isTextControl(ref: string, observation: Observation): boolean {
  const target = observation.controls.find(control => control.ref === ref);
  return target !== undefined && TEXT_ROLES.has(target.role);
}

/** The fixed argument list for one action. */
export function argsFor(action: HandAction, observation: Observation): string[] {
  switch (action.type) {
    case 'click':
      // A text field takes no press action, so a click on one is delivered as what it means: put the cursor there.
      return isTextControl(action.ref, observation) ? ['focus', '--', action.ref] : ['click', '--', action.ref];
    case 'type':
      return ['type', '--', action.ref, action.text];
    case 'scroll':
      return ['scroll', '--direction', action.direction, '--', action.ref];
    case 'press':
      return ['press', '--app', observation.app, '--', action.keys];
    case 'launch':
      return ['launch', '--activate', '--', action.app];
    case 'focus_app':
      return ['focus-window', '--app', action.app];
  }
}

/** The window to read when an app has several: the focused one, or else the first one listed. */
function windowToRead(list: Envelope | undefined): string | undefined {
  const windows = Array.isArray(list?.data) ? (list.data as { id?: unknown; is_focused?: unknown }[]) : [];
  const chosen = windows.find(window => window.is_focused === true) ?? windows[0];
  return typeof chosen?.id === 'string' && WINDOW_ID.test(chosen.id) ? chosen.id : undefined;
}

export function agentDesktopHands(binary: string, exec: Exec = defaultExec): OperatorHands {
  if (!isAbsolute(binary)) throw new Error('The agent-desktop program path must be absolute.');
  return {
    async observe(app, signal) {
      if (!APP_NAME.test(app)) throw new Error('That application name is not allowed.');
      let result = envelope(await exec(binary, ['snapshot', '--app', app, '-i', '--compact'], signal));
      // Several windows make the app ambiguous. Read the focused window instead.
      if (result?.error?.code === 'AMBIGUOUS_TARGET') {
        const id = windowToRead(envelope(await exec(binary, ['list-windows', '--app', app], signal)));
        if (id) result = envelope(await exec(binary, ['snapshot', '--window-id', id, '-i', '--compact'], signal));
      }
      // A running app with no window is a state the model can act on, for example with cmd+n. agent-desktop sees only the
      // windows on the screen in use, so a window on another desktop counts as none.
      if (result?.error?.code === 'WINDOW_NOT_FOUND') {
        return { app, controls: [], note: 'No window of the app is on the screen. It may have none open, or it may be on another desktop.' };
      }
      if (!result?.ok) throw new Error('agent-desktop could not read that application.');
      // The window title tells the model where the app is, so it can see that a step such as opening a folder worked.
      const title = clean((result.data as { window?: { title?: unknown } } | undefined)?.window?.title, MAX_TITLE);
      return { app, ...(title ? { window: title } : {}), controls: controlsOf(result) };
    },
    async act(action, observation, signal) {
      if ((action.type === 'launch' || action.type === 'focus_app') && !APP_NAME.test(action.app)) {
        return { delivery: 'not_delivered', code: 'app_name_refused' };
      }
      // Text typed into a field that already holds text goes after it. The model cannot place the cursor, and agent-desktop
      // types where the cursor is, which is often the start, so the hands move to the end first.
      const target = action.type === 'type' ? observation.controls.find(control => control.ref === action.ref) : undefined;
      if (action.type === 'type' && target?.value && TEXT_ROLES.has(target.role)) {
        const focused = deliveryOf(envelope(await exec(binary, ['focus', '--', action.ref], signal)));
        if (focused.delivery !== 'delivered') return focused;
        const moved = deliveryOf(envelope(await exec(binary, ['press', '--app', observation.app, '--', 'cmd+down'], signal)));
        if (moved.delivery === 'not_delivered') return moved;
        // Added to a document, the text starts its own line, so it never runs onto the end of the last one.
        if (target.multiline && !/^[\r\n]/.test(action.text)) {
          return deliveryOf(envelope(await exec(binary, argsFor({ ...action, text: `\n${action.text}` }, observation), signal)));
        }
      }
      return deliveryOf(envelope(await exec(binary, argsFor(action, observation), signal)));
    },
  };
}
