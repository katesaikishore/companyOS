import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Automation, HandoffView } from '@companyos/twin-core';
import {
  buildOpenMausBotPrompt,
  checkOpenMausBotSettings,
  observedAppSequence,
  openMausBotCommandProblem,
  openMausBotTargetProblem,
  parseResult,
  runOpenMausBotTask,
  sanitizeJobTree,
  sendHandoff,
} from '../src/main/openmausbot';

/**
 * A stand-in for the OpenMausBot CLI. It writes its argument list to the file named by FAKE_OMB_ARGV, then prints what
 * the test chose: FAKE_OMB_JSON, a block over 1 MB when FAKE_OMB_MODE is "large", or nothing when it is "hang".
 */
const FAKE_CLI = [
  `#!${process.execPath}`,
  "const { writeFileSync } = require('node:fs');",
  'writeFileSync(process.env.FAKE_OMB_ARGV, JSON.stringify(process.argv.slice(2)));',
  "const mode = process.env.FAKE_OMB_MODE || 'json';",
  "if (mode === 'large') process.stdout.write('x'.repeat(1200000));",
  "else if (mode === 'hang') setInterval(() => {}, 1000);",
  "else process.stdout.write(process.env.FAKE_OMB_JSON || '{\"state\":\"completed\",\"reply\":\"done\"}');",
  '',
].join('\n');

const FAKE_ENV_KEYS = ['FAKE_OMB_ARGV', 'FAKE_OMB_MODE', 'FAKE_OMB_JSON'];

let folder: string;
let cli: string;
let argvCount = 0;

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'omb-cli-'));
  cli = join(folder, 'openmausbot-fake');
  writeFileSync(cli, FAKE_CLI);
  chmodSync(cli, 0o755);
});

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

afterEach(() => {
  for (const key of FAKE_ENV_KEYS) delete process.env[key];
  vi.useRealTimers();
});

/** Points the fake CLI at a fresh argument file and sets what it prints. Returns the argument file's path. */
function useFake(options: { json?: string; mode?: 'large' | 'hang' } = {}): string {
  argvCount++;
  const argvFile = join(folder, `argv-${argvCount}.json`);
  process.env.FAKE_OMB_ARGV = argvFile;
  if (options.json !== undefined) process.env.FAKE_OMB_JSON = options.json;
  if (options.mode !== undefined) process.env.FAKE_OMB_MODE = options.mode;
  return argvFile;
}

/** An automation with every kind of step, so the tests can show which of them reach the prompt. */
const automation: Automation = {
  id: 'auto_0123456789ab',
  name: 'Invoice follow-up',
  version: 1,
  routineId: '0123456789ab',
  params: [{ name: 'p2', options: ['Slack', 'Microsoft Outlook'], default: 'Slack' }],
  steps: [
    { op: 'focus_app', app: 'Microsoft Excel' },
    { op: 'check_focus', app: 'Microsoft Excel' },
    { op: 'open_url', app: 'Google Chrome', url: 'https://docs.example.com/invoices/canary-path' },
    { op: 'open_file', app: 'Microsoft Excel', path: '/Users/kate/Private/salary-canary.xlsx' },
    { op: 'press_shortcut', app: 'Microsoft Excel', shortcut: 'cmd+shift+k' },
    { op: 'focus_app', app: 'Microsoft Excel' },
    { op: 'focus_app', app: '$p2' },
  ],
  estimate: { minutesPerWeek: 42, occurrencesPerWeek: 3 },
};

/** Counts the task objects in a sanitised tree, not the arrays or text around them. */
function countObjects(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + countObjects(item), 0);
  return 1 + Object.values(value).reduce<number>((sum, item) => sum + countObjects(item), 0);
}

/** How many task objects deep the first chain of children goes. */
function chainDepth(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
  const children = (value as { children?: unknown }).children;
  if (!Array.isArray(children)) return 1;
  return 1 + Math.max(0, ...children.map(chainDepth));
}

describe('the CLI call', () => {
  it('starts the CLI with the target, the prompt and the waiting flags', async () => {
    const argvFile = useFake({ json: '{"state":"completed","reply":"ok"}' });
    const brief = 'Draft the follow-up list';
    const result = await runOpenMausBotTask({ command: cli, target: 'Lead Bot', automation, taskBrief: brief });
    expect(result).toEqual({ state: 'completed', summary: 'ok' });
    expect(JSON.parse(readFileSync(argvFile, 'utf8'))).toEqual([
      'run',
      'Lead Bot',
      buildOpenMausBotPrompt(automation, brief),
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
    ]);
  });

  it('ends a job that runs past the local timer as timed-out, after the CLI own 30 minute wait', async () => {
    useFake({ mode: 'hang' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = runOpenMausBotTask({ command: cli, target: 'Lead Bot', automation, taskBrief: 'Wait for the job' });
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    await expect(pending).resolves.toEqual({
      state: 'timed-out',
      summary: 'The wait timed out; the job may still be running in OpenMausBot.',
    });
  });

  it('names the command when it cannot be found', async () => {
    const missing = join(folder, 'no-such-openmausbot');
    await expect(runOpenMausBotTask({ command: missing, target: 'Lead Bot', automation, taskBrief: 'Anything' })).rejects.toThrow(
      `Could not find “${missing}”`,
    );
  });

  it('rejects output over 1 MB', async () => {
    useFake({ mode: 'large' });
    await expect(runOpenMausBotTask({ command: cli, target: 'Lead Bot', automation, taskBrief: 'Anything' })).rejects.toThrow(
      'OpenMausBot returned more than 1 MB',
    );
  });

  it('rejects output that is not JSON', async () => {
    useFake({ json: 'not json at all' });
    await expect(runOpenMausBotTask({ command: cli, target: 'Lead Bot', automation, taskBrief: 'Anything' })).rejects.toThrow(
      'OpenMausBot returned an unreadable result',
    );
  });

  it('refuses an invalid target or command before the CLI starts', () => {
    const argvFile = useFake();
    expect(() => runOpenMausBotTask({ command: cli, target: 'Lead:Bot', automation, taskBrief: 'Anything' })).toThrow(
      'Set an existing OpenMausBot lead bot or room in Settings.',
    );
    expect(() => runOpenMausBotTask({ command: '   ', target: 'Lead Bot', automation, taskBrief: 'Anything' })).toThrow(
      'Set a valid OpenMausBot CLI executable in Settings.',
    );
    expect(existsSync(argvFile)).toBe(false);
  });
});

describe('the result the CLI prints', () => {
  it('keeps a valid state', () => {
    expect(parseResult('{"state":"needs-input","reply":"Approve the draft?"}')).toEqual({
      state: 'needs-input',
      summary: 'Approve the draft?',
    });
  });

  it('maps an unknown state to failed', () => {
    expect(parseResult('{"state":"exploded","reply":"x"}').state).toBe('failed');
  });

  it('maps a missing state to failed', () => {
    expect(parseResult('{"reply":"x"}').state).toBe('failed');
  });

  it('reads a reply given as an object, and falls back to the error text', () => {
    expect(parseResult('{"state":"completed","reply":{"text":"Done"}}').summary).toBe('Done');
    expect(parseResult('{"state":"failed","error":"Agent crashed"}').summary).toBe('Agent crashed');
  });

  it('keeps the thread id and a sanitised job tree', () => {
    const result = parseResult(
      '{"state":"completed","reply":"ok","threadId":"th_8f2c1","job":{"id":"root","title":"Plan","children":[{"id":"c1","title":"Draft","agent":"GitScout","state":"done"}]}}',
    );
    expect(result.threadId).toBe('th_8f2c1');
    expect(JSON.parse(result.taskTree ?? 'null')).toEqual({
      id: 'root',
      title: 'Plan',
      children: [{ id: 'c1', title: 'Draft', agent: 'GitScout', state: 'done' }],
    });
  });

  it('throws on output that is not a JSON object', () => {
    expect(() => parseResult('[]')).toThrow('unreadable result');
    expect(() => parseResult('null')).toThrow('unreadable result');
    expect(() => parseResult('not json')).toThrow('unreadable result');
  });
});

describe('the job tree bounds', () => {
  it('keeps at most 100 task objects, however wide the tree is', () => {
    const wide = {
      id: 'root',
      children: Array.from({ length: 30 }, (_, a) => ({
        id: `a${a}`,
        children: Array.from({ length: 30 }, (_, b) => ({
          id: `a${a}.${b}`,
          children: Array.from({ length: 30 }, (_, c) => ({ id: `a${a}.${b}.${c}` })),
        })),
      })),
    };
    const kept = countObjects(sanitizeJobTree(wide));
    expect(kept).toBeGreaterThan(1);
    expect(kept).toBeLessThanOrEqual(100);
  });

  it('nests at most five levels of task objects', () => {
    let deep: Record<string, unknown> = { id: 'level-8' };
    for (let level = 7; level >= 1; level--) deep = { id: `level-${level}`, children: [deep] };
    const kept = sanitizeJobTree(deep);
    expect(chainDepth(kept)).toBe(5);
    expect((kept as { children: unknown[] }).children).toHaveLength(1);
  });

  it('caps text at 300 characters and turns control characters into spaces', () => {
    const title = (sanitizeJobTree({ id: 'n1', title: `a\u0007b\nc${'x'.repeat(400)}` }) as { title: string }).title;
    expect(title.startsWith('a b c')).toBe(true);
    expect(title).toHaveLength(300);
    expect(/[\u0000-\u001f\u007f]/.test(title)).toBe(false);
  });

  it('drops every field that is not task metadata', () => {
    expect(
      sanitizeJobTree({ id: 'n1', title: 'Draft', transcript: 'secret text', screenshot: 'data', replies: ['x'] }),
    ).toEqual({ id: 'n1', title: 'Draft' });
  });
});

describe('the prompt carries app names and cadence only', () => {
  it('names the observed apps and the cadence, and none of the URL, file or shortcut in the steps', () => {
    const prompt = buildOpenMausBotPrompt(automation, 'Summarise the follow-ups');
    expect(prompt).toContain('Observed app sequence: Microsoft Excel → Slack or Microsoft Outlook');
    expect(prompt).toContain('Approximate routine cadence: 3 times per week.');
    for (const hidden of ['docs.example.com', 'canary-path', 'salary-canary', '/Users/kate', 'cmd+shift+k', '$p2']) {
      expect(prompt).not.toContain(hidden);
    }
  });

  it('merges repeats and names each option of a varying step', () => {
    expect(observedAppSequence(automation)).toEqual(['Microsoft Excel', 'Slack or Microsoft Outlook']);
  });

  it('leaves out the cadence line when no cadence was estimated', () => {
    const { estimate: _estimate, ...withoutEstimate } = automation;
    expect(buildOpenMausBotPrompt(withoutEstimate, 'Anything')).not.toContain('Approximate routine cadence');
  });
});

describe('the OpenMausBot settings use the handoff rules', () => {
  it('accepts a lead bot or room made of letters, digits and _ . @ - or spaces', () => {
    expect(openMausBotTargetProblem('Lead Bot_2.x@team-1')).toBeUndefined();
  });

  it('refuses other names with the message a handoff gives', () => {
    for (const target of ['', 'Lead:Bot', '-leading', 'x'.repeat(121)]) {
      expect(openMausBotTargetProblem(target)).toBe('Set an existing OpenMausBot lead bot or room in Settings.');
    }
  });

  it('refuses a blank or oversized command with the message a handoff gives', () => {
    expect(openMausBotCommandProblem('openmausbot')).toBeUndefined();
    expect(openMausBotCommandProblem('   ')).toBe('Set a valid OpenMausBot CLI executable in Settings.');
    expect(openMausBotCommandProblem('x'.repeat(513))).toBe('Set a valid OpenMausBot CLI executable in Settings.');
  });

  it('lets Settings leave the lead bot or room blank, and refuses a bad value in a save', () => {
    expect(() => checkOpenMausBotSettings({ openMausBotTarget: '  ' })).not.toThrow();
    expect(() => checkOpenMausBotSettings({ openMausBotTarget: 'Lead:Bot' })).toThrow(
      'Set an existing OpenMausBot lead bot or room in Settings.',
    );
    expect(() => checkOpenMausBotSettings({ openMausBotCommand: '' })).toThrow(
      'Set a valid OpenMausBot CLI executable in Settings.',
    );
    expect(() => checkOpenMausBotSettings({ theme: 'dark' })).not.toThrow();
  });
});

describe('sending a handoff keeps its record', () => {
  const sending: HandoffView = {
    id: 'handoff-send-1',
    automationId: automation.id,
    routineName: automation.name,
    target: 'Lead Bot',
    brief: 'Draft the follow-up list',
    apps: observedAppSequence(automation),
    cadencePerWeek: 3,
    sentAt: 1_000,
    state: 'sending',
    summary: '',
    localFailure: false,
  };

  /** A recorder that keeps a copy of every write, in order. */
  function recorder(): { writes: HandoffView[]; recordHandoff: (view: HandoffView) => void } {
    const writes: HandoffView[] = [];
    return { writes, recordHandoff: view => writes.push({ ...view }) };
  }

  it('writes the handoff as sending before the CLI starts, then with the reply', async () => {
    const { writes, recordHandoff } = recorder();
    let writesBeforeSend = -1;
    const result = await sendHandoff({ recordHandoff }, sending, async () => {
      writesBeforeSend = writes.length;
      return { state: 'completed', summary: 'Ready.', threadId: 'th_8f2c1', taskTree: '{"id":"root"}' };
    });
    expect(writesBeforeSend).toBe(1);
    expect(writes.map(write => write.state)).toEqual(['sending', 'completed']);
    expect(writes[1]).toMatchObject({ id: sending.id, summary: 'Ready.', threadId: 'th_8f2c1', taskTree: '{"id":"root"}', localFailure: false });
    expect(result.state).toBe('completed');
  });

  it('records a companyOS failure and rethrows it when the CLI cannot be found', async () => {
    const { writes, recordHandoff } = recorder();
    const missing = join(folder, 'no-such-openmausbot');
    await expect(
      sendHandoff({ recordHandoff }, sending, () => runOpenMausBotTask({ command: missing, target: 'Lead Bot', automation, taskBrief: 'x' })),
    ).rejects.toThrow('Could not find');
    expect(writes.map(write => write.state)).toEqual(['sending', 'failed']);
    expect(writes[1]).toMatchObject({ state: 'failed', localFailure: true });
    expect(writes[1].threadId).toBeUndefined();
    expect(writes[1].summary).toContain(missing);
  });

  it('records a companyOS failure when the send is refused before the CLI starts', async () => {
    const { writes, recordHandoff } = recorder();
    await expect(
      sendHandoff({ recordHandoff }, sending, () => runOpenMausBotTask({ command: cli, target: 'Lead:Bot', automation, taskBrief: 'x' })),
    ).rejects.toThrow('Set an existing OpenMausBot lead bot or room in Settings.');
    expect(writes.map(write => write.state)).toEqual(['sending', 'failed']);
    expect(writes[1].localFailure).toBe(true);
  });
});
