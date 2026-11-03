import { spawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { StepRefusedError, isAllowedMenuPath, parseKeyChord, type Executor } from '@companyos/twin-core';
import {
  clickWithAgentDesktop,
  fillWithAgentDesktop,
  pasteWithAgentDesktop,
  pressKeyWithAgentDesktop,
  readTextWithAgentDesktop,
  setFieldWithAgentDesktop,
} from './desktop-actions';

/**
 * The optional "hands" executor. An external agent-desktop program takes over the key-press step, and it counts an app's
 * windows before a focus by name. The focus itself is the built-in adapter's. The program is not bundled. Its path is a
 * setting that defaults to empty, and an empty path keeps the built-in adapters, so nothing in this file runs unless a
 * person sets the path.
 *
 * The program is the agent-desktop CLI (vercel-labs/agent-desktop). It is called with a fixed argument array and never
 * through a shell. A call names either the app or one of its windows:
 *   <program> list-windows --app <name>          lists the app's windows as a JSON envelope, read only to count them
 *   <program> focus-window --app <name>          brings the app's window to the front and confirms focus
 *   <program> press <chord> --headed --app <name>  brings the app's window forward, then sends the chord
 *   <program> focus-window --window-id <id>      the same, for one window from list-windows
 *   <program> press <chord> --headed --window-id <id>  the same, for one window from list-windows
 * A window ID is used when it is given, and the app name is then only for logs. Without one, the program is first asked
 * how many windows the app has. A focus by name is refused as ambiguous when the app has more than one window, because
 * the app could come forward with a window the person did not mean. The focus itself is then the built-in adapter's, so
 * the program does not move the pointer for it. A press by name is refused the same way, since its first step is a focus.
 * A zero count, or a list-windows call that fails, lets the focus call run and report its own error. The listing is never
 * kept. This module never picks a window for the caller. The CLI's exit status 1 is shared by every structured error, so
 * AMBIGUOUS_TARGET is read from the JSON envelope the program prints on stdout, by a match that keeps only its position
 * and never the output. The error code of a failed focus or press is read the same way, and only that code is kept. A press
 * is always preceded by a focus-window call with the same target. Exit status 0 is success.
 * Any other status, a signal, a timeout or too much output is a failure.
 */

/** How long one call may run before the program is stopped. */
export const AGENT_DESKTOP_TIMEOUT_MS = 10_000;
/** The most output, across stdout and stderr, that one call may produce. Output is counted and discarded, never kept. */
const MAX_OUTPUT_BYTES = 16 * 1024;
/** The most output a find or list-windows call made by a desktop step may produce. A busy web page has a large tree. */
export const FIND_OUTPUT_BYTES = 4 * 1024 * 1024;
/** How long output is still read after the program exits. A child that inherited the pipes can hold them open. */
const EXIT_DRAIN_MS = 500;
const MAX_PATH_LENGTH = 512;
/** An application name: a letter or digit first, then letters, digits, spaces and . _ ( ) -. No quotes, slashes, flags or control characters. */
const APP_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,99}$/u;
/** Key chord text. The exact form is then checked by parseKeyChord, the same rule the step schema uses. */
const CHORD_TEXT = /^[a-z0-9+]{1,40}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
/** A window ID from list-windows, such as "w-1.0-org-a11y-atspi-accessible-2". No leading dash, so it cannot read as a flag. */
const WINDOW_ID = /^(?!-)[A-Za-z0-9._:-]{1,120}$/;
/** The error code the CLI prints in its JSON envelope when a target matches more than one window. */
const AMBIGUOUS_CODE = Buffer.from('"AMBIGUOUS_TARGET"');
/** A CLI error code: a letter, then upper-case letters, digits and underscores. Anything else is not recorded. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,39}$/;

export type HandsStep = 'focus_app' | 'press_shortcut' | 'choose_menu' | 'click' | 'paste_text' | 'press_key' | 'fill_field' | 'set_field' | 'check_text';
export type HandsFailure =
  | 'blocked'
  | 'invalid_input'
  | 'exit'
  | 'ambiguous'
  | 'signal'
  | 'timeout'
  | 'output_limit'
  | 'spawn_error'
  | 'not_found'
  | 'submenu'
  | 'unverified';
export type HandsResult = { ok: true } | { ok: false; failure: HandsFailure; reason: string };

/**
 * What is kept about one call that started the program: the step, how it ended, how long it took, and the CLI's error
 * code when it printed one. The application name, the chord and the error message are never kept, since the message can
 * name an app or a window.
 */
export interface HandsRecord {
  step: HandsStep;
  exit: number | HandsFailure;
  durationMs: number;
  code?: string;
  /** The agent id of the run's cursor, so lines from runs that overlap can be told apart. Never a name or a label. */
  agent?: string;
}

export interface HandsOptions {
  /** The program's path, as set in Settings. */
  binary: string;
  /**
   * Called once for each focus-window or press call that ends, and once for a step refused for several windows. The
   * list-windows check that comes before a focus by name is not recorded.
   */
  record?: (entry: HandsRecord) => void;
  /** Overrides the call timeout. Tests use it; the app does not. */
  timeoutMs?: number;
  /** The automation's own named cursor. With a session, its menu clicks are drawn and attributed under this cursor. */
  cursor?: HandsCursor;
  /** The shared multi-agent session. Without it, or when it cannot start, menu clicks run with no session and no cursor. */
  session?: AgentDesktopSession;
  /** The system clipboard, for pasting text and for checks that read it. The app passes Electron's; tests pass a fake. */
  clipboard?: { readText(): string | Promise<string>; writeText(text: string): void | Promise<void> };
}

/** One automation's cursor in the shared session: its agent id, the name drawn beside it, and its colour. */
export interface HandsCursor {
  agentId: string;
  label: string;
  /** A hex colour for the cursor's body and ripple, so overlapping runs can be told apart on screen. */
  colour: string;
}

const MESSAGES = {
  missing: 'No agent-desktop program is set. Set its path in Settings to use it for focus and key steps.',
  invalidPath: 'The agent-desktop path is not valid.',
  relative: 'The agent-desktop path must be an absolute path to the program.',
  notFile: 'No program file exists at the agent-desktop path.',
  app: 'The application name is not one the agent-desktop program accepts.',
  window: 'The window ID is not one the agent-desktop program accepts.',
  ambiguous: 'More than one window of this app is open. Choose a window, then try again.',
  chord: 'The key chord is not one the agent-desktop program accepts.',
  timeout: 'The agent-desktop program did not finish in time.',
  output: 'The agent-desktop program wrote too much output.',
  signal: 'The agent-desktop program was stopped before it finished.',
  spawn: 'The agent-desktop program could not be started.',
  menu: 'The menu path is not one the agent-desktop program accepts.',
  menuItem: 'A menu item was not found. The app needs an open window, and each label must match its menu, letter for letter.',
  submenu: 'Menu paths with a submenu are not supported yet: opening a submenu needs the mouse, which companyOS does not move. Nothing was chosen.',
  noMenu: 'The menu did not open, so nothing was chosen.',
  unverified: 'A menu click could not be confirmed, so the run stopped there.',
} as const;

/** Why the program path cannot be used, or undefined when it can. Blank means off. The disk is checked on every call. */
export function agentDesktopProblem(path: string): string | undefined {
  const value = path.trim();
  if (value === '') return MESSAGES.missing;
  if (value.length > MAX_PATH_LENGTH || CONTROL_CHARACTERS.test(value)) return MESSAGES.invalidPath;
  if (!isAbsolute(value)) return MESSAGES.relative;
  try {
    return statSync(value).isFile() ? undefined : MESSAGES.notFile;
  } catch {
    return MESSAGES.notFile;
  }
}

/** True for an application name the program may be given. It is checked before it reaches the argument list. */
export function isAllowedAppName(app: string): boolean {
  return APP_NAME.test(app) && app === app.trim();
}

/** True for a window ID in the form list-windows prints. Checked before it reaches the argument list. */
export function isAllowedWindowId(windowId: string): boolean {
  return WINDOW_ID.test(windowId);
}

/** The failure table for a streamed match: for each length, the longest proper prefix that is also a suffix of it. */
function failureTable(pattern: Buffer): number[] {
  const table = [0];
  let k = 0;
  for (let i = 1; i < pattern.length; i++) {
    while (k > 0 && pattern[i] !== pattern[k]) k = table[k - 1];
    if (pattern[i] === pattern[k]) k++;
    table[i] = k;
  }
  return table;
}
const AMBIGUOUS_FAILURE = failureTable(AMBIGUOUS_CODE);

/** True for a key chord in the canonical form the step schema accepts, such as "cmd+shift+k". */
export function isAllowedChord(chord: string): boolean {
  return CHORD_TEXT.test(chord) && parseKeyChord(chord) === chord;
}

/** Why the target cannot be used, or undefined when it can. The app name is checked even with a window ID: it is for logs. */
function targetProblem(app: string, windowId: string | undefined): string | undefined {
  if (!isAllowedAppName(app)) return MESSAGES.app;
  if (windowId !== undefined && !isAllowedWindowId(windowId)) return MESSAGES.window;
  return undefined;
}

/** The arguments that name the target: the window when one is given, otherwise the app. Call only after targetProblem. */
function targetArgs(app: string, windowId: string | undefined): string[] {
  return windowId === undefined ? ['--app', app] : ['--window-id', windowId];
}

/**
 * Focuses an application, or one of its windows when windowId is given, through the program. Nothing starts unless the
 * path is usable and the name, and the window ID when there is one, are allowed. A focus by name is refused when the app
 * has more than one window.
 */
export async function focusWithAgentDesktop(options: HandsOptions, app: string, windowId?: string): Promise<HandsResult> {
  const problem = agentDesktopProblem(options.binary);
  if (problem) return refused('blocked', problem);
  const invalid = targetProblem(app, windowId);
  if (invalid) return refused('invalid_input', invalid);
  const several = await refuseSeveralWindows(options, 'focus_app', app, windowId);
  if (several) return several;
  return runProgram(options, 'focus_app', ['focus-window', ...targetArgs(app, windowId)]);
}

/**
 * Presses a key chord in an application, or one of its windows when windowId is given, through the program. Nothing
 * starts unless every input is allowed. A press by name is refused when the app has more than one window.
 */
export async function pressWithAgentDesktop(
  options: HandsOptions,
  app: string,
  shortcut: string,
  windowId?: string,
): Promise<HandsResult> {
  const problem = agentDesktopProblem(options.binary);
  if (problem) return refused('blocked', problem);
  const invalid = targetProblem(app, windowId);
  if (invalid) return refused('invalid_input', invalid);
  if (!isAllowedChord(shortcut)) return refused('invalid_input', MESSAGES.chord);
  // A press by name starts with a focus by name, so it gets the same several-windows check before anything starts.
  const several = await refuseSeveralWindows(options, 'press_shortcut', app, windowId);
  if (several) return several;
  const aim = targetArgs(app, windowId);
  // A headless press sends the keys to the app's process, and a window that is not the key window ignores them. On macOS
  // the CLI still reports success in that case, so the press is headed: it brings the window forward and delivers the
  // keys to it, at the cost of focus and cursor side effects. The focus before it keeps the refusal and failure point.
  const focused = await runProgram(options, 'press_shortcut', ['focus-window', ...aim]);
  if (!focused.ok) return focused;
  return runProgram(options, 'press_shortcut', ['press', shortcut, '--headed', ...aim]);
}

/** A qualified ref as find prints it, such as "@s1bn72231t061l:e1". No leading dash, so it cannot read as a flag. */
export const REF = /^@[A-Za-z0-9]{1,64}:e\d{1,6}$/;
/** A session id as session start prints it. */
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
/** An agent id the program accepts: 1 to 64 letters, digits, "-" or "_". */
export const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The longest cursor label. The program also cuts the label to a few words. */
const CURSOR_LABEL_MAX = 60;
/** How long the menu may take to close after the last click. */
const MENU_CLOSE_MS = 2_000;
/** The longest menu path the program can choose for now: a menu bar item and one item in its menu. */
export const SUPPORTED_MENU_DEPTH = 2;

/** Cursor colours, far enough apart to tell runs apart at a glance. A design choice. */
export const CURSOR_COLOURS = ['#E5484D', '#30A46C', '#0090FF', '#F76B15', '#8E4EC6', '#12A594'] as const;

/** One colour for an agent id, the same on every run: a 32-bit FNV-1a hash of the id picks it. */
function cursorColour(agentId: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < agentId.length; index++) {
    hash ^= agentId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return CURSOR_COLOURS[hash % CURSOR_COLOURS.length];
}

/**
 * The named cursor for one automation. The agent id comes from the automation's id, so it stays the same across runs and a
 * reused id reuses its cursor and its colour. The label is the automation's name, with control characters made spaces.
 */
export function cursorFor(automationId: string, name: string): HandsCursor {
  const agentId = automationId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64) || 'automation';
  // A leading dash is dropped, so the label can never read as a flag after --label.
  const label = name
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^-+\s*/, '')
    .slice(0, CURSOR_LABEL_MAX);
  return { agentId, label: label || 'companyOS', colour: cursorColour(agentId) };
}

/**
 * The one multi-agent session the app's menu clicks share. It starts on first need with the cursor overlay on and tracing
 * off, so the program keeps no trace of what it read. Each automation's cursor is styled once with its label. A session
 * that cannot start is tried again on the next need, and the clicks run with no session meanwhile.
 */
export class AgentDesktopSession {
  private started: Promise<string | undefined> | undefined;
  /** The program path the current session was started with. A session belongs to that program only. */
  private startedWith: string | undefined;
  /** The current session's id once it has started, so a report about an older session cannot drop this one. */
  private current: string | undefined;
  /** Agent id and label pairs already drawn, so a renamed automation gets its new label. */
  private readonly styled = new Set<string>();
  /** Counts dropped sessions, so a style call that finishes after a drop cannot mark the new session as styled. */
  private generation = 0;

  constructor(private readonly options: () => HandsOptions) {}

  /** The session id, or undefined when the session cannot start. A changed program path starts a new session. */
  id(): Promise<string | undefined> {
    const binary = this.options().binary;
    if (this.started && this.startedWith !== binary) this.forget();
    if (!this.started) {
      const attempt = this.start();
      this.started = attempt;
      this.startedWith = binary;
      // Forgotten on failure, so the next menu step tries again. Only this attempt is forgotten, never a newer one.
      void attempt.then(id => {
        if (this.started !== attempt) return;
        if (id === undefined) this.forget();
        else this.current = id;
      });
    }
    return this.started;
  }

  /**
   * Drops the session, so the next menu step starts a new one, and ends the dropped one so its cursors leave the screen.
   * Called when a call made in the session reports that the session has ended, or when the program path changes. With an
   * id, only that session is dropped: a late report from a session already replaced leaves the newer one running.
   */
  forget(ended?: string): void {
    if (ended !== undefined && ended !== this.current) return;
    void this.drop();
  }

  /**
   * Forgets the session at once, then ends it with the program that started it. Ending is best effort: a session that has
   * already ended refuses quietly.
   */
  private async drop(): Promise<void> {
    const previous = this.started;
    const binary = this.startedWith;
    this.started = undefined;
    this.startedWith = undefined;
    this.current = undefined;
    this.styled.clear();
    this.generation++;
    const id = await previous;
    if (id !== undefined && binary !== undefined) await runCall({ ...this.options(), binary }, ['session', 'end', id], false);
  }

  private async start(): Promise<string | undefined> {
    const call = await runCall(
      this.options(),
      ['session', 'start', '--name', 'companyOS', '--cursor', '--multi-agent', '--no-trace'],
      true,
    );
    return call.result.ok ? sessionIdOf(call.output) : undefined;
  }

  /**
   * Draws the automation's cursor with its name and colour, once per agent id and name. Best effort: a failure keeps the
   * default cursor.
   */
  async style(sessionId: string, cursor: HandsCursor): Promise<void> {
    const key = `${cursor.agentId}\u0000${cursor.label}`;
    if (this.styled.has(key) || !AGENT_ID.test(cursor.agentId) || !CURSOR_COLOUR.test(cursor.colour)) return;
    const generation = this.generation;
    const call = await runCall(
      this.options(),
      [
        'cursor-overlay',
        'enable',
        '--label',
        cursor.label,
        '--fill',
        cursor.colour,
        '--accent',
        cursor.colour,
        '--session',
        sessionId,
        '--agent-id',
        cursor.agentId,
      ],
      false,
    );
    if (call.result.ok && generation === this.generation) this.styled.add(key);
  }

  /** Ends the session, which stops every cursor in it. Called when the app stops. */
  async end(): Promise<void> {
    await this.drop();
  }
}

/** A cursor colour the program accepts: # and six hex digits. */
const CURSOR_COLOUR = /^#[0-9A-Fa-f]{6}$/;

/**
 * True when a call's envelope says the session it named has ended, so the session should be started again. The program
 * reports this as INVALID_ARGS with details.kind "session_ended" (seen on agent-desktop 1.0.2). An unknown session id is
 * not reported as a session error.
 */
export function sessionEnded(output: Buffer | undefined): boolean {
  const envelope = parseEnvelope(output) as { ok?: unknown; error?: { details?: { kind?: unknown } } };
  return envelope?.ok === false && envelope.error?.details?.kind === 'session_ended';
}

/**
 * Chooses one menu path in an application through the program: the menu bar item, then each submenu, then the item. Each
 * label is found on its surface with an exact name, and only a menu item that matches is clicked.
 *
 * A reported success does not prove an effect, so each click is judged by what it opened. The menu bar click must come
 * back verified and must open a menu. The last click runs the item, and the menu closes as it does, so it cannot be verified
 * from the menu. It must be delivered, and the menu must then close.
 *
 * Only a menu bar item and one item in its menu can be chosen for now. On macOS a press on a submenu item reports success
 * and opens nothing, and the program cannot tell a submenu item from an ordinary one before it is clicked, so a longer
 * path would click an item in the middle and run it. Such a path is refused before anything starts.
 *
 * Escape closes a menu only when a click confirmed the menu opened, and is never sent once the last click has started,
 * since the item may have opened a dialog. The program's output is read for the ref, the delivery, the surface count and
 * the wait result only, and is never kept.
 */
export async function chooseMenuWithAgentDesktop(options: HandsOptions, app: string, menu: readonly string[]): Promise<HandsResult> {
  const problem = agentDesktopProblem(options.binary);
  if (problem) return refused('blocked', problem);
  if (!isAllowedAppName(app)) return refused('invalid_input', MESSAGES.app);
  if (!isAllowedMenuPath(menu)) return refused('invalid_input', MESSAGES.menu);
  if (menu.length > SUPPORTED_MENU_DEPTH) return refused('submenu', MESSAGES.submenu);

  // In a multi-agent session every desktop action needs an agent id, so the session is used only with a cursor.
  const cursor = options.cursor && AGENT_ID.test(options.cursor.agentId) ? options.cursor : undefined;
  const sessionId = cursor ? await options.session?.id() : undefined;
  const first = await choosePath(options, app, menu, cursor, sessionId);
  if (first !== SESSION_ENDED) return first;
  // The session ended before anything was clicked, and was forgotten, so the path can start again: once in a new session,
  // and if that one has ended too, with no session, as when one cannot start.
  const fresh = await options.session?.id();
  const second = fresh === undefined ? SESSION_ENDED : await choosePath(options, app, menu, cursor, fresh);
  if (second !== SESSION_ENDED) return second;
  const plain = await choosePath(options, app, menu, cursor, undefined);
  // Without a session no call can report one ended, so this is only for the type.
  return plain === SESSION_ENDED ? refused('not_found', MESSAGES.menuItem) : plain;
}

/** What choosePath returns when the session ended before the first click, so nothing was done and the path can be tried again. */
const SESSION_ENDED = Symbol('session ended');

/** One try at a menu path, in the given session or in none. */
async function choosePath(
  options: HandsOptions,
  app: string,
  menu: readonly string[],
  cursor: HandsCursor | undefined,
  sessionId: string | undefined,
): Promise<HandsResult | typeof SESSION_ENDED> {
  const scope = sessionId === undefined ? [] : ['--session', sessionId];
  const actor = sessionId !== undefined && cursor ? ['--agent-id', cursor.agentId] : [];
  if (sessionId !== undefined && cursor) await options.session?.style(sessionId, cursor);

  const started = Date.now();
  let openMenus = 0;
  for (const [index, label] of menu.entries()) {
    const last = index === menu.length - 1;
    const surface = index === 0 ? 'menubar' : 'menu';
    const found = await runCall(options, ['find', '--app', app, '--surface', surface, '--name', label, '--exact', '--first', ...scope], true);
    const ref = found.result.ok ? menuItemRef(found.output, label) : undefined;
    if (ref === undefined) {
      const code = errorCodeOf(found.output);
      if (sessionId !== undefined && sessionEnded(found.output)) {
        options.session?.forget(sessionId);
        if (index === 0) {
          recordStep(options, 'choose_menu', found.exit, started, code);
          return SESSION_ENDED;
        }
      }
      if (openMenus > 0) await closeMenu(options, app, scope, actor);
      recordStep(options, 'choose_menu', 'not_found', started, code);
      return refused('not_found', MESSAGES.menuItem);
    }
    const clicked = await runCall(options, ['click', ref, ...scope, ...actor], true);
    const delivery = deliveryOf(clicked.output);
    if (!clicked.result.ok) {
      const code = errorCodeOf(clicked.output);
      if (sessionId !== undefined && sessionEnded(clicked.output)) options.session?.forget(sessionId);
      // After the last click the item may have run, and before it Escape is sent only to a menu known to be open.
      if (!last && openMenus > 0) await closeMenu(options, app, scope, actor);
      recordStep(options, 'choose_menu', clicked.exit, started, code);
      return clicked.result;
    }
    if (last) {
      // The item ran, or may have: no Escape from here on, whatever the wait shows.
      if (delivery === 'delivered_verified' || delivery === 'delivered_unverified') break;
      recordStep(options, 'choose_menu', 'unverified', started);
      return refused('unverified', MESSAGES.unverified);
    }
    const menus = surfaceCount(clicked.output);
    if (delivery !== 'delivered_verified' || menus <= openMenus) {
      if (Math.max(openMenus, menus) > 0) await closeMenu(options, app, scope, actor);
      const failure = delivery === 'delivered_verified' ? 'submenu' : 'unverified';
      recordStep(options, 'choose_menu', failure, started);
      return refused(failure, failure === 'submenu' ? MESSAGES.noMenu : MESSAGES.unverified);
    }
    openMenus = menus;
  }
  const closed = await runCall(
    options,
    ['wait', '--menu-closed', '--app', app, '--timeout', String(MENU_CLOSE_MS), ...scope],
    true,
  );
  let done = closed.result.ok && waitFound(closed.output);
  // Finder's menu surfaces cannot be read once no menu is open (agent-desktop 2.5), so the wait fails there every time.
  // Its menu bar item still says whether its menu is open: selected while it is, not once it closes.
  if (!done && surfaceReadFailed(closed.output)) done = await menuBarItemClosed(options, app, menu[0], scope);
  recordStep(options, 'choose_menu', done ? 0 : 'unverified', started, errorCodeOf(closed.output));
  return done ? { ok: true } : refused('unverified', MESSAGES.unverified);
}

/** Closes a menu left open by a path that stopped part way. Best effort: the result is not checked. */
async function closeMenu(options: HandsOptions, app: string, scope: readonly string[], actor: readonly string[]): Promise<void> {
  await runCall(options, ['press', 'escape', '--app', app, ...scope, ...actor], false);
}

/**
 * The ref of the match in a find envelope, when it is a menu item whose name is the label, ignoring case. Anything else,
 * including a ref that is not in the qualified form, is undefined, so nothing but a matching menu item is ever clicked.
 */
function menuItemRef(output: Buffer | undefined, label: string): string | undefined {
  const envelope = parseEnvelope(output) as { ok?: unknown; data?: { match?: { ref_id?: unknown; role?: unknown; name?: unknown } } };
  const match = envelope?.ok === true ? envelope.data?.match : undefined;
  if (!match || match.role !== 'menuitem') return undefined;
  if (typeof match.name !== 'string' || match.name.toLowerCase() !== label.toLowerCase()) return undefined;
  return typeof match.ref_id === 'string' && REF.test(match.ref_id) ? match.ref_id : undefined;
}

/** The delivery a click envelope reports, such as "delivered_verified", or undefined when it reports none. */
function deliveryOf(output: Buffer | undefined): string | undefined {
  const envelope = parseEnvelope(output) as { ok?: unknown; data?: { disposition?: { delivery?: unknown } } };
  const delivery = envelope?.ok === true ? envelope.data?.disposition?.delivery : undefined;
  return typeof delivery === 'string' ? delivery : undefined;
}

/** How many menu surfaces a click envelope says are open after the click. Zero when it lists none. */
function surfaceCount(output: Buffer | undefined): number {
  const envelope = parseEnvelope(output) as { ok?: unknown; data?: { surfaces?: unknown } };
  const surfaces = envelope?.ok === true ? envelope.data?.surfaces : undefined;
  if (!Array.isArray(surfaces)) return 0;
  return surfaces.filter(entry => typeof entry === 'object' && entry !== null && (entry as { type?: unknown }).type === 'menu').length;
}

/** True when an envelope says the app's menu surfaces could not be read, rather than that a menu is still open. */
function surfaceReadFailed(output: Buffer | undefined): boolean {
  const envelope = parseEnvelope(output) as { ok?: unknown; error?: { details?: { kind?: unknown } } };
  return envelope?.ok === false && envelope.error?.details?.kind === 'surface_read';
}

/**
 * True when the menu bar item is found and is not selected, so its menu has closed. Anything else, including a match
 * with no states, is false.
 */
async function menuBarItemClosed(options: HandsOptions, app: string, label: string, scope: readonly string[]): Promise<boolean> {
  const found = await runCall(options, ['find', '--app', app, '--surface', 'menubar', '--name', label, '--exact', '--first', ...scope], true);
  if (menuItemRef(found.output, label) === undefined) return false;
  const envelope = parseEnvelope(found.output) as { data?: { match?: { states?: unknown } } };
  const states = envelope?.data?.match?.states;
  return Array.isArray(states) && !states.includes('selected');
}

/** True when a wait envelope says the condition was met. */
function waitFound(output: Buffer | undefined): boolean {
  const envelope = parseEnvelope(output) as { ok?: unknown; data?: { found?: unknown } };
  return envelope?.ok === true && envelope.data?.found === true;
}

/** The session id from a session start envelope, when it is in the form the program prints. */
function sessionIdOf(output: Buffer | undefined): string | undefined {
  const envelope = parseEnvelope(output) as { ok?: unknown; data?: { session_id?: unknown } };
  const id = envelope?.ok === true ? envelope.data?.session_id : undefined;
  return typeof id === 'string' && SESSION_ID.test(id) ? id : undefined;
}

/** The program's JSON envelope, or undefined when the output is missing or is not JSON. */
export function parseEnvelope(output: Buffer | undefined): unknown {
  if (output === undefined) return undefined;
  try {
    return JSON.parse(output.toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * The checks a focus by name passes before the built-in adapter focuses the app: the path must be usable, the name must be
 * one the program accepts, and an app with several windows is refused. The program is only asked for the window count, so
 * the focus itself never goes through it. Undefined when the focus may run.
 */
async function checkFocusByName(options: HandsOptions, app: string): Promise<HandsResult | undefined> {
  const problem = agentDesktopProblem(options.binary);
  if (problem) return refused('blocked', problem);
  const invalid = targetProblem(app, undefined);
  if (invalid) return refused('invalid_input', invalid);
  return refuseSeveralWindows(options, 'focus_app', app, undefined);
}

/**
 * The runner's executor when the program path is set. A focus by name is the built-in adapter's, after the program has
 * counted the app's windows. A key press goes through the program on macOS and Windows only. On Linux the program's press
 * crashed a GTK 3 test window in most trials, so the built-in press (xdotool on X11) is used there, and the path does not
 * block it. A menu choice of two labels goes through the program, under the automation's named cursor when a session runs,
 * and a longer one goes to the built-in adapter.
 * Frontmost-app checks, links and files come from the built-in executor unchanged. While the path is unusable, the focus
 * and menu steps are blocked with the reason before anyone is asked, and nothing starts.
 */
export function handsExecutor(base: Executor, options: HandsOptions, platform: NodeJS.Platform = process.platform): Executor {
  const pressThroughProgram = platform !== 'linux';
  return {
    ...base,
    focusApp: async app => {
      const refusal = await checkFocusByName(options, app);
      return refusal ? outcomeOf(refusal) : base.focusApp(app);
    },
    ...(pressThroughProgram
      ? { pressShortcut: async (app: string, shortcut: string) => outcomeOf(await pressWithAgentDesktop(options, app, shortcut)) }
      : {}),
    // The program chooses a menu bar item and one item in its menu, under the automation's cursor. It cannot open a
    // submenu, so a longer path goes to the built-in adapter where it has one (macOS presses it without opening a menu).
    chooseMenu: async (app, menu) =>
      menu.length > SUPPORTED_MENU_DEPTH && base.chooseMenu
        ? base.chooseMenu(app, menu)
        : outcomeOf(await chooseMenuWithAgentDesktop(options, app, menu)),
    // The desktop steps act in one named window through the program, under the automation's cursor.
    click: (app, window, target, button) => clickWithAgentDesktop(options, app, window, target, button),
    pasteText: (app, window, text) => pasteWithAgentDesktop(options, app, window, text),
    pressKey: (app, window, key) => pressKeyWithAgentDesktop(options, app, window, key),
    fillField: (app, window, target, text, submit) => fillWithAgentDesktop(options, app, window, target, text, submit),
    setField: (app, window, target, text) => setFieldWithAgentDesktop(options, app, window, target, text),
    readText: (app, window, source) => readTextWithAgentDesktop(options, app, window, source),
    blockedReason: op => (op === 'press_shortcut' && !pressThroughProgram ? undefined : agentDesktopProblem(options.binary)),
  };
}

/**
 * The runner's view of a result. A refusal for several windows is thrown with its reason, so the runner can show it on
 * the step. Every other failure is a plain false, as before.
 */
function outcomeOf(result: HandsResult): boolean {
  if (result.ok) return true;
  // Nothing was done in these cases: several windows matched, or a menu label was not found or its submenu did not open,
  // so no item was chosen.
  if (result.failure === 'ambiguous' || result.failure === 'not_found' || result.failure === 'submenu') {
    throw new StepRefusedError(result.reason);
  }
  return false;
}

export function refused(failure: HandsFailure, reason: string): HandsResult {
  return { ok: false, failure, reason };
}

/** What one call ended with. The output is set only when the caller asked for it, and it is not kept past the caller. */
export interface CallResult {
  result: HandsResult;
  exit: number | HandsFailure;
  output?: Buffer;
}

/** Writes one call that ended to the log, if there is one. The log is best effort, so a failing log cannot stall a call. */
export function recordStep(options: HandsOptions, step: HandsStep, exit: number | HandsFailure, started: number, code?: string): void {
  try {
    options.record?.({
      step,
      exit,
      durationMs: Date.now() - started,
      ...(code === undefined ? {} : { code }),
      ...(options.cursor ? { agent: options.cursor.agentId } : {}),
    });
  } catch {
    // The log is best effort. A failing log must not leave the call unsettled.
  }
}

/**
 * Refuses a focus by name when the app has more than one window, since focus-window would bring one of them forward. The
 * program is asked for the window list first, and the entries are counted and never kept. A zero count, or a list-windows
 * call that fails, lets the focus call run and report its own error. A window ID names one window, so it is not checked.
 */
async function refuseSeveralWindows(
  options: HandsOptions,
  step: HandsStep,
  app: string,
  windowId: string | undefined,
): Promise<HandsResult | undefined> {
  if (windowId !== undefined) return undefined;
  const started = Date.now();
  const listed = await runCall(options, ['list-windows', '--app', app], true);
  if (!listed.result.ok || windowCount(listed.output) <= 1) return undefined;
  recordStep(options, step, 'ambiguous', started);
  return refused('ambiguous', MESSAGES.ambiguous);
}

/** The number of entries in the data array of a list-windows envelope. Zero when the output cannot be read that way. */
function windowCount(output: Buffer | undefined): number {
  if (output === undefined) return 0;
  try {
    const envelope = JSON.parse(output.toString('utf8')) as { data?: unknown } | null;
    const data = envelope?.data;
    return Array.isArray(data) ? data.length : 0;
  } catch {
    return 0;
  }
}

/**
 * The CLI's error code from its JSON envelope, or undefined when the output has none. The message is read past and never
 * returned, because it can name an app or a window.
 */
export function errorCodeOf(output: Buffer | undefined): string | undefined {
  if (output === undefined) return undefined;
  try {
    const envelope = JSON.parse(output.toString('utf8')) as { ok?: unknown; error?: { code?: unknown } } | null;
    if (envelope?.ok !== false) return undefined;
    const code = envelope.error?.code;
    return typeof code === 'string' && ERROR_CODE.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/** Starts the program with no shell, so the argument array reaches it exactly as built. Undefined when the start throws. */
function start(program: string, args: readonly string[]): ChildProcess | undefined {
  try {
    return spawn(program, [...args], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return undefined;
  }
}

/**
 * Runs one focus-window or press call and records it as one step. Its output is held only until its error code is read,
 * and only that code is recorded.
 */
async function runProgram(options: HandsOptions, step: HandsStep, args: readonly string[]): Promise<HandsResult> {
  const started = Date.now();
  const { result, exit, output } = await runCall(options, args, true);
  recordStep(options, step, exit, started, errorCodeOf(output));
  return result;
}

/**
 * Starts the program and settles on its exit. The timeout, the output cap and a failed start each settle the call once,
 * and stop the program if it is still running. The pipes are destroyed when the call settles, so a child that inherited
 * them cannot hold the call open. The output is returned only when keepOutput is set, and the caller then drops it.
 */
export function runCall(options: HandsOptions, args: readonly string[], keepOutput: boolean, maxBytes = MAX_OUTPUT_BYTES): Promise<CallResult> {
  const program = options.binary.trim();
  return new Promise<CallResult>(resolve => {
    const child = start(program, args);
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let drain: NodeJS.Timeout | undefined;
    const kept: Buffer[] = [];
    const settle = (result: HandsResult, exit: number | HandsFailure): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      const output = keepOutput ? Buffer.concat(kept) : undefined;
      kept.length = 0; // The captured output is handed to the caller once, and not kept here.
      resolve({ result, exit, output });
    };
    const failed = (failure: HandsFailure, reason: string): void => settle({ ok: false, failure, reason }, failure);

    if (!child) {
      failed('spawn_error', MESSAGES.spawn);
      return;
    }
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      failed('timeout', MESSAGES.timeout);
    }, options.timeoutMs ?? AGENT_DESKTOP_TIMEOUT_MS);

    let bytes = 0;
    const count = (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        child.kill('SIGKILL');
        failed('output_limit', MESSAGES.output);
      }
    };
    // The envelope on stdout is matched as it arrives. Only the match position is kept, so the output is still discarded.
    let at = 0;
    let sawAmbiguous = false;
    const look = (chunk: Buffer): void => {
      for (let i = 0; i < chunk.length && !sawAmbiguous; i++) {
        while (at > 0 && chunk[i] !== AMBIGUOUS_CODE[at]) at = AMBIGUOUS_FAILURE[at - 1];
        if (chunk[i] === AMBIGUOUS_CODE[at]) at++;
        if (at === AMBIGUOUS_CODE.length) sawAmbiguous = true;
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      if (keepOutput && !settled) kept.push(chunk);
      count(chunk);
      look(chunk);
    });
    child.stderr?.on('data', count);
    child.once('error', () => failed('spawn_error', MESSAGES.spawn));
    const finish = (code: number | null): void => {
      if (code === 0) settle({ ok: true }, 0);
      else if (code === null) failed('signal', MESSAGES.signal);
      // The CLI exits 1 for every structured error, so the exit status alone cannot tell this one apart.
      else if (sawAmbiguous) settle({ ok: false, failure: 'ambiguous', reason: MESSAGES.ambiguous }, 'ambiguous');
      else settle({ ok: false, failure: 'exit', reason: `The agent-desktop program exited with status ${code}.` }, code);
    };
    // Output can still be in the pipes when the program exits, so the result waits briefly for them to close, and the
    // cap above applies to all of it. A child that inherited the pipes cannot hold the call past that drain.
    child.once('exit', code => {
      if (!settled) drain = setTimeout(() => finish(code), EXIT_DRAIN_MS);
    });
    child.once('close', code => finish(code));
  });
}
