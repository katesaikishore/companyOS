import spawn from 'cross-spawn';
import type { AgentDelegationResult, Automation, HandoffView } from '@companyos/twin-core';

export const MAX_TASK_BRIEF = 500;
const MAX_OUTPUT_BYTES = 1_000_000;
const CLI_TIMEOUT_MS = 31 * 60_000;
const MAX_COMMAND_LENGTH = 512;
const MAX_TARGET_LENGTH = 120;
/** A lead bot or room: a letter or digit first, then letters, digits, spaces and _ . @ -. */
const TARGET_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_.@ -]*$/u;
const COMMAND_PROBLEM = 'Set a valid OpenMausBot CLI executable in Settings.';
const TARGET_PROBLEM = 'Set an existing OpenMausBot lead bot or room in Settings.';
const UNREADABLE_RESULT = 'OpenMausBot returned an unreadable result. Check its workspace and try again.';
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
 * Hands a user-approved routine brief to OpenMausBot's existing agent harness. The CLI owns
 * agent discovery, nested delegation, approvals, job waiting, and result reporting.
 */
export function runOpenMausBotTask(options: OpenMausBotTaskOptions): Promise<AgentDelegationResult> {
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
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    let outputTooLarge = false;
    let timedOut = false;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, CLI_TIMEOUT_MS);
    timeout.unref();
    /** The first of 'error' and 'close' settles the call. A command that fails to start also closes, and that must not be read as empty output. */
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      finish();
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(chunk, 'utf8') > MAX_OUTPUT_BYTES) {
        outputTooLarge = true;
        child.kill();
        return;
      }
      stdout += chunk;
    });

    child.once('error', error => {
      settle(() => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          reject(new Error(`Could not find “${command}”. Install OpenMausBot's CLI or set its executable path in Settings.`));
          return;
        }
        reject(new Error(`Could not start OpenMausBot: ${error.message}`));
      });
    });

    child.once('close', () => {
      settle(() => {
        if (outputTooLarge) {
          reject(new Error('OpenMausBot returned more than 1 MB. The task may still be running in its workspace.'));
          return;
        }
        if (timedOut) {
          resolve({ state: 'timed-out', summary: 'The wait timed out; the job may still be running in OpenMausBot.' });
          return;
        }
        try {
          resolve(parseResult(stdout));
        } catch (error) {
          reject(error);
        }
      });
    });
  });
}

/** The part of the twin a send writes its handoff records to. */
export interface HandoffRecorder {
  recordHandoff(view: HandoffView): void;
}

/**
 * Sends one approved handoff and keeps its record. The record is written as "sending" before the CLI runs, so a send
 * is never unrecorded. It is then updated with the reply, or with companyOS's message when the CLI could not be run,
 * and that error is rethrown for the page. The caller has already asked the person, so a cancelled confirmation never
 * reaches this function.
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
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'OpenMausBot could not be reached.';
    recorder.recordHandoff({ ...handoff, state: 'failed', summary: message, localFailure: true });
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

/** Reads the CLI's JSON result. An unknown or missing state becomes failed. Throws when the output is not a JSON object. */
export function parseResult(stdout: string): AgentDelegationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(UNREADABLE_RESULT);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(UNREADABLE_RESULT);
  const result = parsed as Record<string, unknown>;

  const rawState = typeof result.state === 'string' ? result.state : 'failed';
  const state: AgentDelegationResult['state'] = VALID_STATES.has(rawState as AgentDelegationResult['state'])
    ? rawState as AgentDelegationResult['state']
    : 'failed';
  const reply = typeof result.reply === 'string'
    ? result.reply
    : result.reply && typeof result.reply === 'object'
      ? (result.reply as Record<string, unknown>).text
      : undefined;
  const error = typeof result.error === 'string' ? result.error : undefined;
  const summary = typeof reply === 'string'
    ? reply.slice(0, MAX_SUMMARY)
    : error?.slice(0, MAX_SUMMARY) ?? stateSummary(state);
  const jobTree = result.job === undefined ? undefined : JSON.stringify(sanitizeJobTree(result.job), null, 2).slice(0, MAX_TASK_TREE);
  const threadId = typeof result.threadId === 'string' ? result.threadId.slice(0, 100) : undefined;

  return {
    state,
    summary,
    ...(threadId ? { threadId } : {}),
    ...(jobTree ? { taskTree: jobTree } : {}),
  };
}

/**
 * Keeps only hierarchy and task metadata; agent replies, logs, files, and transcripts stay in OpenMausBot. At most 100
 * values are kept, task objects nest at most five levels deep, and text is capped at 300 characters with control
 * characters turned into spaces. A value past a bound is replaced by a marker.
 */
export function sanitizeJobTree(value: unknown): unknown {
  let nodes = 0;
  const visit = (item: unknown, level: number): unknown => {
    nodes++;
    if (nodes > MAX_TREE_NODES) return OMITTED_TREE;
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

function stateSummary(state: AgentDelegationResult['state']): string {
  switch (state) {
    case 'completed': return 'The OpenMausBot job completed.';
    case 'idle': return 'No agent took up the task. Check the selected bot or room.';
    case 'needs-input': return 'The agent team needs your input. Continue in OpenMausBot.';
    case 'failed': return 'The OpenMausBot job failed. Review its workspace for details.';
    case 'stalled': return 'The OpenMausBot job stalled. Review its workspace for details.';
    case 'timed-out': return 'The wait timed out; the job may still be running in OpenMausBot.';
    case 'cancelled': return 'The handoff was cancelled.';
  }
}
