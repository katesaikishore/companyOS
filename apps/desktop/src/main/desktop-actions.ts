import { StepRefusedError, UI_LABEL, parseKeyName, type Locator } from '@companyos/twin-core';
import {
  AGENT_ID,
  FIND_OUTPUT_BYTES,
  REF,
  agentDesktopProblem,
  isAllowedAppName,
  isAllowedWindowId,
  parseEnvelope,
  recordStep,
  refused,
  runCall,
  sessionEnded,
  type HandsOptions,
  type HandsResult,
  type HandsStep,
} from './agent-desktop';

/**
 * The desktop steps: click an element, paste text, press a key, fill a field, type into a field, and read text, each in
 * one window of an app, through the agent-desktop program. Every call is made with a fixed argument array and no shell,
 * through runCall. The window is chosen from list-windows by the start of its title, or is the app's only visible window;
 * several candidates are refused, so a step never acts in a window the person did not name. An element is found by its
 * role and its exact name or the start of it. Clicks on elements that report bounds are real clicks at their centre,
 * after the window is brought forward, since web pages ignore many accessibility presses.
 *
 * In the shared multi-agent session each call carries the automation's agent id, so its cursor is drawn and attributed.
 * The program's output is read for refs, bounds, values and text only, and is not kept past the call. Text read for a check
 * is returned to the runner, which compares it and drops it.
 */

const MESSAGES = {
  app: 'The application name is not one the agent-desktop program accepts.',
  windowName: 'The window title is not one the agent-desktop program accepts.',
  noWindow: 'No open window of this app matches the step. Open it, then try again.',
  severalWindows: 'More than one window of this app is open. Name the window in the step, then try again.',
  notFound: 'The element was not found in the window, so nothing was done.',
  key: 'The key is not one the agent-desktop program accepts.',
  clipboard: 'The clipboard is not available to the desktop steps.',
  fieldMismatch: 'The field did not show the entered text, so it was not submitted.',
  notFocused: 'No field took the text, so nothing was submitted.',
  typedText: 'Typed text cannot start with a dash, since the program would read it as an option.',
} as const;

/** A window big enough to be a document window, not a menu bar strip or a dock tile that list-windows also reports. */
const MIN_WINDOW_HEIGHT = 100;
/** How long a pasted text may take to reach the app before the person's clipboard is put back. */
const PASTE_SETTLE_MS = 600;

interface Match {
  ref?: string;
  name?: string;
  value?: string;
  states: string[];
  path: string[];
  bounds?: { x: number; y: number; width: number; height: number };
}

interface Context {
  scope: string[];
  actor: string[];
}

/** The session and agent id arguments for this automation's calls, or none when no session runs. */
async function contextFor(options: HandsOptions): Promise<Context> {
  const cursor = options.cursor && AGENT_ID.test(options.cursor.agentId) ? options.cursor : undefined;
  const sessionId = cursor ? await options.session?.id() : undefined;
  if (sessionId === undefined || !cursor) return { scope: [], actor: [] };
  await options.session?.style(sessionId, cursor);
  return { scope: ['--session', sessionId], actor: ['--agent-id', cursor.agentId] };
}

/** One call made in the session. A call that says the session ended drops it, so the next step starts a new one. */
async function call(options: HandsOptions, context: Context, args: readonly string[], maxBytes?: number) {
  const result = await runCall(options, [...args, ...context.scope, ...context.actor], true, maxBytes);
  if (context.scope.length > 0 && sessionEnded(result.output)) options.session?.forget(context.scope[1]);
  return result;
}

/** Why the inputs cannot be used, or undefined when they can. */
function inputProblem(options: HandsOptions, app: string, window: string | undefined): HandsResult | undefined {
  const problem = agentDesktopProblem(options.binary);
  if (problem) return refused('blocked', problem);
  if (!isAllowedAppName(app)) return refused('invalid_input', MESSAGES.app);
  if (window !== undefined && !UI_LABEL.test(window)) return refused('invalid_input', MESSAGES.windowName);
  return undefined;
}

/**
 * The id of the one window the step acts in: the first visible window whose title starts with `window`, or the app's
 * only visible window when no title is given. Several candidates without a title are refused.
 */
async function windowFor(options: HandsOptions, context: Context, app: string, window: string | undefined): Promise<string | HandsResult> {
  const listed = await call(options, context, ['list-windows', '--app', app], FIND_OUTPUT_BYTES);
  const envelope = parseEnvelope(listed.output) as { data?: unknown } | undefined;
  const windows = Array.isArray(envelope?.data) ? (envelope.data as Array<Record<string, unknown>>) : [];
  const visible = windows.filter(entry => {
    const bounds = entry.bounds as { height?: unknown } | undefined;
    return entry.visible === true && typeof bounds?.height === 'number' && bounds.height >= MIN_WINDOW_HEIGHT;
  });
  const named = window === undefined ? visible : visible.filter(entry => typeof entry.title === 'string' && entry.title.startsWith(window));
  if (named.length === 0) return refused('not_found', MESSAGES.noWindow);
  if (window === undefined && named.length > 1) return refused('ambiguous', MESSAGES.severalWindows);
  const id = named[0].id;
  return typeof id === 'string' && isAllowedWindowId(id) ? id : refused('not_found', MESSAGES.noWindow);
}

/** Every element of a role in the window, as find reports them with no limit. */
async function elements(options: HandsOptions, context: Context, app: string, windowId: string, role: string): Promise<Match[]> {
  const found = await call(
    options,
    context,
    ['find', '--app', app, '--window-id', windowId, '--role', role, '--limit', '0'],
    FIND_OUTPUT_BYTES,
  );
  const envelope = parseEnvelope(found.output) as { ok?: unknown; data?: { matches?: unknown } } | undefined;
  const matches = envelope?.ok === true && Array.isArray(envelope.data?.matches) ? envelope.data.matches : [];
  return (matches as Array<Record<string, unknown>>).map(match => ({
    ref: typeof match.ref_id === 'string' && REF.test(match.ref_id) ? match.ref_id : undefined,
    name: typeof match.name === 'string' ? match.name : undefined,
    value: typeof match.value === 'string' ? match.value : undefined,
    states: Array.isArray(match.states) ? match.states.filter((s): s is string => typeof s === 'string') : [],
    path: Array.isArray(match.path) ? match.path.filter((s): s is string => typeof s === 'string') : [],
    bounds: boundsOf(match.bounds),
  }));
}

function boundsOf(value: unknown): Match['bounds'] {
  const b = value as Record<string, unknown> | undefined;
  if (!b || ![b.x, b.y, b.width, b.height].every(n => typeof n === 'number' && Number.isFinite(n))) return undefined;
  return { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number };
}

/** The element the locator names: exact name or name prefix, inside a dialog when asked, first or last. */
function pick(matches: readonly Match[], target: Locator): Match | undefined {
  const named = matches.filter(match => {
    if (match.name === undefined) return false;
    if (target.name !== undefined && match.name !== target.name) return false;
    if (target.namePrefix !== undefined && !match.name.startsWith(target.namePrefix)) return false;
    if (target.inDialog && !match.path.some(part => /^(alertdialog|dialog|sheet)\b/.test(part))) return false;
    // A tab scrolled out of view reports a width of one point; it cannot be clicked where it is drawn.
    return !match.bounds || match.bounds.width > 2;
  });
  return target.last ? named[named.length - 1] : named[0];
}

async function locate(options: HandsOptions, context: Context, app: string, windowId: string, target: Locator): Promise<Match | HandsResult> {
  const found = pick(await elements(options, context, app, windowId, target.role), target);
  return found ?? refused('not_found', MESSAGES.notFound);
}

function isResult(value: unknown): value is HandsResult {
  return typeof value === 'object' && value !== null && 'ok' in value;
}

/** Brings the window forward, then clicks the element: at its centre when it has bounds, otherwise through its ref. */
async function clickMatch(options: HandsOptions, context: Context, windowId: string, match: Match, button: 'left' | 'right'): Promise<HandsResult> {
  const focused = await call(options, context, ['focus-window', '--window-id', windowId]);
  if (!focused.result.ok) return focused.result;
  if (match.bounds) {
    const x = Math.round(match.bounds.x + match.bounds.width / 2);
    const y = Math.round(match.bounds.y + match.bounds.height / 2);
    return (await call(options, context, ['mouse-click', '--xy', `${x},${y}`, '--button', button, '--headed'])).result;
  }
  if (!match.ref) return refused('not_found', MESSAGES.notFound);
  return (await call(options, context, [button === 'right' ? 'right-click' : 'click', match.ref, '--headed'])).result;
}

async function press(options: HandsOptions, context: Context, windowId: string, key: string): Promise<HandsResult> {
  return (await call(options, context, ['press', key, '--window-id', windowId, '--headed'])).result;
}

/**
 * Puts the text on the clipboard, pastes it with the app's own paste, and puts the person's clipboard back once the app
 * has had time to read it.
 */
async function paste(options: HandsOptions, context: Context, windowId: string, text: string): Promise<HandsResult> {
  const clipboard = options.clipboard;
  if (!clipboard) return refused('blocked', MESSAGES.clipboard);
  const previous = await clipboard.readText();
  await clipboard.writeText(text);
  try {
    return await press(options, context, windowId, 'cmd+v');
  } finally {
    await new Promise(resolve => setTimeout(resolve, PASTE_SETTLE_MS));
    await clipboard.writeText(previous);
  }
}

/** Runs one desktop step, timing and recording it as the other program steps are recorded. */
async function recorded(options: HandsOptions, step: HandsStep, work: () => Promise<HandsResult>): Promise<HandsResult> {
  const started = Date.now();
  const result = await work();
  recordStep(options, step, result.ok ? 0 : result.failure, started);
  return result;
}

/** The runner's view of a result: a refusal (nothing was done) is thrown with its reason, anything else is false. */
function outcome(result: HandsResult): boolean {
  if (result.ok) return true;
  if (result.failure === 'not_found' || result.failure === 'ambiguous' || result.failure === 'invalid_input' || result.failure === 'blocked') {
    throw new StepRefusedError(result.reason);
  }
  return false;
}

export async function clickWithAgentDesktop(options: HandsOptions, app: string, window: string | undefined, target: Locator, button: 'left' | 'right'): Promise<boolean> {
  return outcome(
    await recorded(options, 'click', async () => {
      const problem = inputProblem(options, app, window);
      if (problem) return problem;
      const context = await contextFor(options);
      const windowId = await windowFor(options, context, app, window);
      if (isResult(windowId)) return windowId;
      const match = await locate(options, context, app, windowId, target);
      if (isResult(match)) return match;
      return clickMatch(options, context, windowId, match, button);
    }),
  );
}

export async function pasteWithAgentDesktop(options: HandsOptions, app: string, window: string | undefined, text: string): Promise<boolean> {
  return outcome(
    await recorded(options, 'paste_text', async () => {
      const problem = inputProblem(options, app, window);
      if (problem) return problem;
      const context = await contextFor(options);
      const windowId = await windowFor(options, context, app, window);
      if (isResult(windowId)) return windowId;
      const focused = await call(options, context, ['focus-window', '--window-id', windowId]);
      if (!focused.result.ok) return focused.result;
      return paste(options, context, windowId, text);
    }),
  );
}

export async function pressKeyWithAgentDesktop(options: HandsOptions, app: string, window: string | undefined, key: string): Promise<boolean> {
  return outcome(
    await recorded(options, 'press_key', async () => {
      const problem = inputProblem(options, app, window);
      if (problem) return problem;
      if (parseKeyName(key) !== key) return refused('invalid_input', MESSAGES.key);
      const context = await contextFor(options);
      const windowId = await windowFor(options, context, app, window);
      if (isResult(windowId)) return windowId;
      const focused = await call(options, context, ['focus-window', '--window-id', windowId]);
      if (!focused.result.ok) return focused.result;
      return press(options, context, windowId, key);
    }),
  );
}

/**
 * Clicks the field (or the labelled group around it), selects what it holds, pastes the text, and reads the focused field
 * back. Return is pressed only when that field shows exactly the text; otherwise Escape is pressed and nothing is
 * submitted. This is how a range is entered in a spreadsheet's Name box without a key landing in a cell.
 */
export async function fillWithAgentDesktop(
  options: HandsOptions,
  app: string,
  window: string | undefined,
  target: Locator,
  text: string,
  submit: boolean,
): Promise<boolean> {
  return outcome(
    await recorded(options, 'fill_field', async () => {
      const problem = inputProblem(options, app, window);
      if (problem) return problem;
      const context = await contextFor(options);
      const windowId = await windowFor(options, context, app, window);
      if (isResult(windowId)) return windowId;
      const match = await locate(options, context, app, windowId, target);
      if (isResult(match)) return match;
      const clicked = await clickMatch(options, context, windowId, match, 'left');
      if (!clicked.ok) return clicked;
      const selected = await press(options, context, windowId, 'cmd+a');
      if (!selected.ok) return selected;
      const pasted = await paste(options, context, windowId, text);
      if (!pasted.ok) return pasted;
      const fields = [...(await elements(options, context, app, windowId, 'textfield')), ...(await elements(options, context, app, windowId, 'combobox'))];
      const focused = fields.find(field => field.states.includes('focused'));
      if (!focused) {
        await press(options, context, windowId, 'escape');
        return refused('not_found', MESSAGES.notFocused);
      }
      if ((focused.value ?? '').trim() !== text.trim()) {
        await press(options, context, windowId, 'escape');
        return refused('unverified', MESSAGES.fieldMismatch);
      }
      return submit ? press(options, context, windowId, 'return') : { ok: true };
    }),
  );
}

/**
 * Clears a native field and types the text into it with real key events. Some fields, such as Finder's Name field in Get
 * Info, ignore a pasted string but take typed keys.
 */
export async function setFieldWithAgentDesktop(options: HandsOptions, app: string, window: string | undefined, target: Locator, text: string): Promise<boolean> {
  return outcome(
    await recorded(options, 'set_field', async () => {
      const problem = inputProblem(options, app, window);
      if (problem) return problem;
      const context = await contextFor(options);
      const windowId = await windowFor(options, context, app, window);
      if (isResult(windowId)) return windowId;
      const match = await locate(options, context, app, windowId, target);
      if (isResult(match)) return match;
      if (!match.ref) return refused('not_found', MESSAGES.notFound);
      // The text is an argument here, unlike a paste, so a leading dash would read as a flag.
      if (text.startsWith('-')) return refused('invalid_input', MESSAGES.typedText);
      const cleared = await call(options, context, ['clear', match.ref, '--headed']);
      if (!cleared.result.ok) return cleared.result;
      return (await call(options, context, ['type', match.ref, text, '--headed'])).result;
    }),
  );
}

/**
 * The text a check reads: the clipboard, or every piece of static text in the window, one per line. A table that the
 * window also exposes column by column is read by row only, so each cell is read once.
 */
export async function readTextWithAgentDesktop(options: HandsOptions, app: string, window: string | undefined, source: 'clipboard' | 'window'): Promise<string> {
  if (source === 'clipboard') {
    if (!options.clipboard) throw new StepRefusedError(MESSAGES.clipboard);
    return await options.clipboard.readText();
  }
  let text: string | undefined;
  const result = await recorded(options, 'check_text', async () => {
    const problem = inputProblem(options, app, window);
    if (problem) return problem;
    const context = await contextFor(options);
    const windowId = await windowFor(options, context, app, window);
    if (isResult(windowId)) return windowId;
    const texts = await elements(options, context, app, windowId, 'statictext');
    text = texts
      .filter(match => match.name !== undefined && !match.path.includes('column'))
      .map(match => match.name)
      .join('\n');
    return { ok: true };
  });
  if (!result.ok) {
    outcome(result);
    throw new Error(result.reason);
  }
  return text ?? '';
}
