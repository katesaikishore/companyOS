import spawn from 'cross-spawn';
import type { AgentDelegationResult, Automation } from '@companyos/twin-core';

const MAX_TASK_BRIEF = 500;
const MAX_OUTPUT_BYTES = 1_000_000;
const CLI_TIMEOUT_MS = 31 * 60_000;
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

/**
 * Hands a user-approved routine brief to OpenMausBot's existing agent harness. The CLI owns
 * agent discovery, nested delegation, approvals, job waiting, and result reporting.
 */
export function runOpenMausBotTask(options: OpenMausBotTaskOptions): Promise<AgentDelegationResult> {
  const command = options.command.trim();
  const target = options.target.trim();
  const taskBrief = options.taskBrief.trim();
  if (!command || command.length > 512) throw new Error('Set a valid OpenMausBot CLI executable in Settings.');
  if (!target || target.length > 120 || !/^[\p{L}\p{N}][\p{L}\p{N}_.@ -]*$/u.test(target)) {
    throw new Error('Set an existing OpenMausBot lead bot or room in Settings.');
  }
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
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, CLI_TIMEOUT_MS);
    timeout.unref();

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
      clearTimeout(timeout);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        reject(new Error(`Could not find “${command}”. Install OpenMausBot's CLI or set its executable path in Settings.`));
        return;
      }
      reject(new Error(`Could not start OpenMausBot: ${error.message}`));
    });

    child.once('close', () => {
      clearTimeout(timeout);
      if (outputTooLarge) {
        reject(new Error('OpenMausBot returned more than 1 MB. The task may still be running in its workspace.'));
        return;
      }
      if (timedOut) {
        resolve({ state: 'timed-out', summary: 'The wait timed out; the job may still be running in OpenMausBot.' });
        return;
      }
      resolve(parseResult(stdout));
    });
  });
}

export function buildOpenMausBotPrompt(automation: Automation, taskBrief: string): string {
  const apps: string[] = [];
  for (const step of automation.steps) {
    if (step.op !== 'focus_app' || apps[apps.length - 1] === step.app) continue;
    apps.push(step.app);
  }
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

function parseResult(stdout: string): AgentDelegationResult {
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error('OpenMausBot returned an unreadable result. Check its workspace and try again.');
  }

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
    ? reply.slice(0, 8_000)
    : error?.slice(0, 8_000) ?? stateSummary(state);
  const jobTree = result.job === undefined ? undefined : JSON.stringify(sanitizeJobTree(result.job), null, 2).slice(0, 24_000);
  const threadId = typeof result.threadId === 'string' ? result.threadId.slice(0, 100) : undefined;

  return {
    state,
    summary,
    ...(threadId ? { threadId } : {}),
    ...(jobTree ? { taskTree: jobTree } : {}),
  };
}

/** Keep only hierarchy and task metadata; agent replies, logs, files, and transcripts stay in OpenMausBot. */
function sanitizeJobTree(value: unknown): unknown {
  let nodes = 0;
  const visit = (item: unknown, depth: number): unknown => {
    nodes++;
    if (nodes > 100 || depth > 5) return '[additional task details omitted]';
    if (typeof item === 'string') return item.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300);
    if (item === null || typeof item === 'number' || typeof item === 'boolean') return item;
    if (Array.isArray(item)) return item.slice(0, 30).map(child => visit(child, depth + 1));
    if (!item || typeof item !== 'object') return undefined;

    const source = item as Record<string, unknown>;
    const safe: Record<string, unknown> = {};
    const textFields = ['id', 'title', 'name', 'task', 'state', 'status', 'agent', 'assignee', 'parentId'];
    for (const key of textFields) {
      const field = source[key];
      if (typeof field === 'string' || typeof field === 'number' || typeof field === 'boolean') safe[key] = visit(field, depth + 1);
    }
    for (const key of ['dependsOn', 'children', 'subtasks', 'tasks']) {
      if (Array.isArray(source[key])) safe[key] = visit(source[key], depth + 1);
    }
    return safe;
  };
  return visit(value, 0);
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
