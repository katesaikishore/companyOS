import spawn from 'cross-spawn';
import {
  UNKNOWN_HANDOFF_SUMMARY,
  type AgentDelegationResult,
  type Automation,
  type HandoffView,
} from '@companyos/twin-core';

export const MAX_TASK_BRIEF = 500;
const MAX_OUTPUT_BYTES = 1_000_000;
const CLI_TIMEOUT_MS = 31 * 60_000;
/** How long output is still read after the CLI exits. A child that inherited the pipe can hold it open, so the read is capped. */
const EXIT_DRAIN_MS = 1_500;
/** The end of stderr that is kept. Only its first non-blank line is used, in the error for a non-zero exit. */
const MAX_STDERR_CHARS = 4_096;
const MAX_EXIT_LINE = 200;
const MAX_COMMAND_LENGTH = 512;
const MAX_TARGET_LENGTH = 120;
/** A lead bot or room: a letter or digit first, then letters, digits, spaces and _ . @ -. */
const TARGET_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_.@ -]*$/u;
const COMMAND_PROBLEM = 'Set a valid OpenMausBot CLI executable in Settings.';
const TARGET_PROBLEM = 'Set an existing OpenMausBot lead bot or room in Settings.';
const UNREADABLE_RESULT = 'OpenMausBot returned an unreadable result. A job may already exist in its workspace. Check it before sending again.';
const WAIT_TIMED_OUT = 'The wait timed out; the job may still be running in OpenMausBot.';
const MAX_SUMMARY = 8_000;
const MAX_TASK_TREE = 24_000;
/** Limits on the job tree kept from the CLI. The tree is stored and shown as text, so these bound both. */
const MAX_TREE_NODES = 100;
const MAX_TREE_LEVELS = 5;
const MAX_TREE_CHILDREN = 30;
const MAX_TREE_TEXT = 300;
const OMITTED_TREE = '[additional task details omitted]';
const TREE_TEXT_FIELDS = ['id', 'title', 'name', 'task', 'state', 'status', 'agent', 'assignee', 'parentId'];
const TREE_CHILD_FIELDS = ['dependsOn', 'children', 'subtasks', 'tasks'];
const VALID_STATES = new Set<AgentDelegationResult['state']>([
  'completed',
  'idle',
  'needs-input',
  'failed',
  'stalled',
  'timed-out',
  'cancelled',
]);

export interface OpenMausBotTaskOptions {
  command: string;
  target: string;
  automation: Automation;
  taskBrief: string;
}

/** How the CLI process ended: its exit code, or the signal that stopped it, and the end of its stderr. */
export interface CliExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

/**
 * The CLI ran, or may have run, and the call ended without a reply: its output was too large or unreadable, it exited
 * with no valid state, or the local wait ran out. The job may already exist in OpenMausBot, so the handoff is recorded
 * as unknown, not failed.
 */
class NoReplyError extends Error {}

/** The problem with an OpenMausBot CLI executable, or undefined when it can be used. Settings and handoffs share this rule. */
export function openMausBotCommandProblem(command: string): string | undefined {
  const value = command.trim();
  return value.length > 0 && value.length <= MAX_COMMAND_LENGTH ? undefined : COMMAND_PROBLEM;
}

/**
 * The problem with a lead bot or room name, or undefined when it can be used. A handoff always needs one. Settings
 * may leave it blank, which turns delegation off.
 */
export function openMausBotTargetProblem(target: string): string | undefined {
  const value = target.trim();
  return value.length > 0 && value.length <= MAX_TARGET_LENGTH && TARGET_PATTERN.test(value) ? undefined : TARGET_PROBLEM;
}

/**
 * Checks the OpenMausBot fields of a settings save with the rules a handoff applies, so a value saved here works when
 * a handoff is sent. A blank lead bot or room is allowed, because it turns delegation off.
 */
export function checkOpenMausBotSettings(patch: unknown): void {
  if (!patch || typeof patch !== 'object') return;
  const { openMausBotCommand, openMausBotTarget } = patch as Record<string, unknown>;
  if (typeof openMausBotCommand === 'string') {
    const problem = openMausBotCommandProblem(openMausBotCommand);
    if (problem) throw new Error(problem);
  }
  if (typeof openMausBotTarget === 'string' && openMausBotTarget.trim() !== '') {
    const problem = openMausBotTargetProblem(openMausBotTarget);
    if (problem) throw new Error(problem);
  }
}

/**
 * Hands a user-approved routine brief to OpenMausBot's existing agent harness. The CLI owns agent discovery, nested
 * delegation, job waiting and result reporting. With --on-input exit it exits when it reaches an approval request, so
 * companyOS never answers one. Every bad input is a rejected promise, and the CLI does not start for it.
 */
export async function runOpenMausBotTask(options: OpenMausBotTaskOptions): Promise<AgentDelegationResult> {
  const command = options.command.trim();
  const target = options.target.trim();
  const taskBrief = options.taskBrief.trim();
  const problem = openMausBotCommandProblem(command) ?? openMausBotTargetProblem(target);
  if (problem) throw new Error(problem);
  if (!taskBrief || taskBrief.length > MAX_TASK_BRIEF) {
    throw new Error(`Describe the task in 1–${MAX_TASK_BRIEF} characters.`);
  }

  const prompt = buildOpenMausBotPrompt(options.automation, taskBrief);
  const args = [
    'run',
    target,
    prompt,
    '--json',
    '--quiet',
    '--strict',
    '--wait',
    'job',
    '--on-input',
    'exit',
    '--on-timeout',
    'leave',
    '--timeout',
    '30m',
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let drain: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      // The local wait ran out with no reply. The job may still be running, so the handoff is recorded as unknown.
      settle(() => reject(new NoReplyError(WAIT_TIMED_OUT)), true);
      child.kill();
    }, CLI_TIMEOUT_MS);
    timeout.unref();
    /**
     * The first of the timer, the error, the close, or the exit once its drain ends settles the call, and nothing after
     * that changes the result. A command that fails to start also closes, and that must not be read as empty output.
     * When the pipes may still be open they are destroyed, so a child holding them cannot hold the call.
     */
    const settle = (finish: () => void, releasePipes: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(drain);
      if (releasePipes) {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      finish();
    };
    const report = (exit: CliExit): void => {
      try {
        resolve(parseResult(stdout, exit));
      } catch (error) {
        reject(error);
      }
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(chunk, 'utf8') > MAX_OUTPUT_BYTES) {
        child.kill();
        settle(() => reject(new NoReplyError('OpenMausBot returned more than 1 MB. The task may still be running in its workspace.')), true);
        return;
      }
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_CHARS);
    });

    child.once('error', error => {
      settle(() => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          reject(new Error(`Could not find “${command}”. Install OpenMausBot's CLI or set its executable path in Settings.`));
          return;
        }
        reject(new Error(`Could not start OpenMausBot: ${error.message}`));
      }, true);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      // The CLI has exited. Output still in the pipe is read for a short drain, then the call settles either way.
      drain = setTimeout(() => settle(() => report({ code, signal, stderr }), true), EXIT_DRAIN_MS);
    });
    child.once('close', (code, signal) => {
      settle(() => report({ code, signal, stderr }), false);
    });
  });
}

/** The part of the twin a send writes its handoff records to. */
export interface HandoffRecorder {
  recordHandoff(view: HandoffView): void;
}

/**
 * Sends one approved handoff and keeps its record. The record is written as "sending" before the CLI runs, so a send
 * is never unrecorded. It is then updated with the reply, or with companyOS's message when the CLI could not be run or
 * gave no reply. A send that closed without a reply is recorded as unknown. The error is rethrown for the page. The
 * caller has already asked the person, so a cancelled confirmation never reaches this function.
 */
export async function sendHandoff(
  recorder: HandoffRecorder,
  handoff: HandoffView,
  send: () => Promise<AgentDelegationResult>,
): Promise<AgentDelegationResult> {
  recorder.recordHandoff(handoff);
  try {
    const result = await send();
    recorder.recordHandoff({
      ...handoff,
      state: result.state,
      summary: result.summary,
      threadId: result.threadId,
      taskTree: result.taskTree,
      localFailure: result.localFailure === true,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'OpenMausBot could not be reached.';
    const noReply = error instanceof NoReplyError;
    recorder.recordHandoff({
      ...handoff,
      state: noReply ? 'unknown' : 'failed',
      summary: noReply ? UNKNOWN_HANDOFF_SUMMARY : message,
      localFailure: true,
    });
    throw error;
  }
}

/**
 * The app names the handoff carries, in order. Consecutive repeats are merged. A step whose app varies between runs
 * names each option it was seen with, not the placeholder.
 */
export function observedAppSequence(automation: Automation): string[] {
  const apps: string[] = [];
  for (const step of automation.steps) {
    if (step.op !== 'focus_app') continue;
    const param = automation.params.find(candidate => `$${candidate.name}` === step.app);
    const label = param ? param.options.join(' or ') : step.app;
    if (apps[apps.length - 1] !== label) apps.push(label);
  }
  return apps;
}

export function buildOpenMausBotPrompt(automation: Automation, taskBrief: string): string {
  const apps = observedAppSequence(automation);
  const cadence = automation.estimate?.occurrencesPerWeek;
  return [
    'A person has approved this handoff from their companyOS routine. Use the existing OpenMausBot team and its agent harness.',
    `Outcome requested by the person: ${taskBrief}`,
    `Routine: ${automation.name}`,
    `Observed app sequence: ${apps.join(' → ') || 'not available'}`,
    cadence === undefined ? undefined : `Approximate routine cadence: ${cadence} times per week.`,
    '',
    'Create one parent task and decompose it into a useful hierarchy with 2–3 levels total. Use OpenMausBot teammate delegation for independent subtasks, record dependencies and acceptance checks, then consolidate the results. If the work is too small to split naturally, ask one teammate to review the approach. Do useful read-only research and prepare reviewable drafts where possible.',
    'The app sequence shows context only; it does not describe the work content. Ask the person for missing intent instead of guessing. Do not request or attempt to access companyOS activity history, screenshots, window contents, or credentials; none are included in this handoff.',
    'Do not send or publish messages, modify external records, delete data, spend money, change permissions, or install software. Stop before any such action and request approval through OpenMausBot.',
    'Return a concise result and preserve the parent/child task tree in the job.',
  ].filter(line => line !== undefined).join('\n');
}

/**
 * Reads the CLI's JSON result and how the process ended. The CLI's reply, or its error, is the summary when it gave one.
 * Otherwise the summary is companyOS's text for the state, and localFailure is set. An unknown or missing state becomes
 * failed. Output that is not a JSON object throws, and so does a non-zero exit with no valid state. A valid state with a
 * non-zero exit is kept, and the exit is noted in the summary.
 */
export function parseResult(stdout: string, exit: CliExit = { code: 0, signal: null, stderr: '' }): AgentDelegationResult {
  const result = parseObject(stdout);
  const rawState = result && typeof result.state === 'string' ? result.state : undefined;
  const reported = rawState !== undefined && VALID_STATES.has(rawState as AgentDelegationResult['state']);
  const exited = exit.code !== 0;
  if (exited && !reported) throw new NoReplyError(exitMessage(exit));
  if (!result) throw new NoReplyError(UNREADABLE_RESULT);

  const state: AgentDelegationResult['state'] = reported ? (rawState as AgentDelegationResult['state']) : 'failed';
  const reply = typeof result.reply === 'string'
    ? result.reply
    : result.reply && typeof result.reply === 'object'
      ? (result.reply as Record<string, unknown>).text
      : undefined;
  const error = typeof result.error === 'string' ? result.error : undefined;
  const fromCli = typeof reply === 'string' || error !== undefined;
  const text = typeof reply === 'string' ? reply : error ?? stateSummary(state);
  const note = exited ? exitNote(exit) : '';
  const summary = `${text.slice(0, MAX_SUMMARY - note.length)}${note}`;
  const threadId = typeof result.threadId === 'string' ? result.threadId.slice(0, 100) : undefined;
  const taskTree = result.job === undefined ? undefined : storedTaskTree(result.job);

  return {
    state,
    summary,
    ...(threadId ? { threadId } : {}),
    ...(taskTree ? { taskTree } : {}),
    ...(fromCli ? {} : { localFailure: true }),
  };
}

/**
 * Keeps only hierarchy and task metadata; agent replies, logs, files, and transcripts stay in OpenMausBot. At most
 * `maxNodes` values are kept, and each value past that bound is replaced by a marker. Task objects nest at most five
 * levels deep, and a deeper one is replaced by a marker. Text is capped at 300 characters, with control characters
 * turned into spaces. An array keeps its first 30 items and drops the rest without a marker.
 */
export function sanitizeJobTree(value: unknown, maxNodes: number = MAX_TREE_NODES): unknown {
  let nodes = 0;
  const visit = (item: unknown, level: number): unknown => {
    nodes++;
    if (nodes > maxNodes) return OMITTED_TREE;
    if (typeof item === 'string') return item.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_TREE_TEXT);
    if (item === null || typeof item === 'number' || typeof item === 'boolean') return item;
    if (level > MAX_TREE_LEVELS) return OMITTED_TREE;
    if (Array.isArray(item)) return item.slice(0, MAX_TREE_CHILDREN).map(child => visit(child, level));
    if (typeof item !== 'object') return undefined;

    const source = item as Record<string, unknown>;
    const safe: Record<string, unknown> = {};
    for (const key of TREE_TEXT_FIELDS) {
      const field = source[key];
      if (typeof field === 'string' || typeof field === 'number' || typeof field === 'boolean') safe[key] = visit(field, level);
    }
    for (const key of TREE_CHILD_FIELDS) {
      if (Array.isArray(source[key])) safe[key] = visit(source[key], level + 1);
    }
    return safe;
  };
  return visit(value, 1);
}

/**
 * The job tree as the text the handoff record keeps: sanitised, then pretty-printed JSON. When that text is longer than
 * the record allows, fewer nodes are kept, so the stored text always parses and is never cut mid-value.
 */
export function storedTaskTree(job: unknown): string {
  let nodes = MAX_TREE_NODES;
  let text = JSON.stringify(sanitizeJobTree(job, nodes), null, 2);
  while (text.length > MAX_TASK_TREE && nodes > 1) {
    nodes = Math.floor(nodes / 2);
    text = JSON.stringify(sanitizeJobTree(job, nodes), null, 2);
  }
  return text.length > MAX_TASK_TREE ? JSON.stringify(OMITTED_TREE) : text;
}

/** The JSON object the CLI printed, or undefined when the output is not one. */
function parseObject(stdout: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
}

/** How the process ended, as a phrase for a message. */
function exitedWith(exit: CliExit): string {
  return exit.code === null ? `exited on ${exit.signal ?? 'a signal'}` : `exited with code ${exit.code}`;
}

/** The message for a CLI that exited with no valid state: how it exited, and the first line of its stderr. */
function exitMessage(exit: CliExit): string {
  const line = firstStderrLine(exit.stderr);
  return `OpenMausBot ${exitedWith(exit)}${line ? `: ${line}` : '.'}`;
}

/** Added to the summary when a valid state came with a non-zero exit. */
function exitNote(exit: CliExit): string {
  return ` OpenMausBot ${exitedWith(exit)} after reporting this state.`;
}

/** The first non-blank line of stderr, with control characters turned into spaces and the length capped. */
function firstStderrLine(stderr: string): string {
  const line = stderr
    .split(/\r?\n/)
    .map(part => part.replace(/[\u0000-\u001f\u007f]/g, ' ').trim())
    .find(part => part.length > 0);
  return (line ?? '').slice(0, MAX_EXIT_LINE);
}

function stateSummary(state: AgentDelegationResult['state']): string {
  switch (state) {
    case 'completed': return 'The OpenMausBot job completed.';
    case 'idle': return 'No agent took up the task. Check the selected bot or room.';
    case 'needs-input': return 'The agent team needs your input. Continue in OpenMausBot.';
    case 'failed': return 'The OpenMausBot job failed. Review its workspace for details.';
    case 'stalled': return 'The OpenMausBot job stalled. Review its workspace for details.';
    case 'timed-out': return WAIT_TIMED_OUT;
    case 'cancelled': return 'The handoff was cancelled.';
  }
}
