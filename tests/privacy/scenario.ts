import { TwinAgent, type Automation, type Executor, type TwinEvent } from '@companyos/twin-core';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelManager } from '../../apps/desktop/src/main/models';
import { buildOpenMausBotPrompt, runOpenMausBotTask } from '../../apps/desktop/src/main/openmausbot';
import { CANARIES, type Surface } from './canaries';
import { spawnLog } from './fake-spawn';
import { ConsoleCapture, diskSurfaces, errorText, recordingFetch, refuseOutbound } from './surfaces';

export type Outcome = 'stored' | 'dropped' | 'rejected';

/** Local time, so day boundaries match what the person sees. Day 0 is 1 October 2026. */
export function at(dayIndex: number, hour: number, minute = 0): number {
  return new Date(2026, 9, 1 + dayIndex, hour, minute).getTime();
}

const CHROME_URL = `https://docs.example.com/doc/1ab2cd3ef4567890/edit?token=${CANARIES.urlQuery}#${CANARIES.urlFragment}`;

/** One ordinary working day, so that a four-step routine is detected. The browser step carries a URL canary. */
function workday(day: number): Array<Record<string, unknown>> {
  return [
    { kind: 'focus', ts: at(day, 9), app: 'Microsoft Excel' },
    { kind: 'focus', ts: at(day, 9, 20), app: 'Microsoft Outlook' },
    { kind: 'focus', ts: at(day, 9, 30), app: 'Slack' },
    { kind: 'focus', ts: at(day, 10), app: 'Google Chrome', url: CHROME_URL },
    { kind: 'idle_start', ts: at(day, 10, 10) },
    { kind: 'idle_end', ts: at(day, 13) },
  ];
}

export interface Planted {
  /** The ingest surface that carries the canary. */
  label: string;
  /** What the pipeline must do with the input. */
  outcome: Outcome;
  signal: (ts: number) => Record<string, unknown>;
}

/**
 * Every ingest surface the suite plants on. The AXSecureTextField and IsPassword entries stand for what a native
 * capture adapter would send: the secure flag set and the value withheld, or the value attached by mistake.
 */
export const PLANTED: readonly Planted[] = [
  { label: 'window title in a title key', outcome: 'rejected', signal: ts => ({ kind: 'focus', ts, app: 'Slack', title: CANARIES.windowTitle }) },
  { label: 'window title in a windowTitle key', outcome: 'rejected', signal: ts => ({ kind: 'focus', ts, app: 'Microsoft Excel', windowTitle: CANARIES.windowTitle }) },
  { label: 'document title on a browser', outcome: 'rejected', signal: ts => ({ kind: 'focus', ts, app: 'Google Chrome', documentTitle: CANARIES.documentTitle }) },
  { label: 'ordinary field value', outcome: 'rejected', signal: ts => ({ kind: 'focus', ts, app: 'Microsoft Word', fieldValue: CANARIES.fieldValue }) },
  { label: 'ordinary field value under value', outcome: 'rejected', signal: ts => ({ kind: 'focus', ts, app: 'Microsoft Word', value: CANARIES.fieldValue }) },
  { label: 'window title carried as a property name', outcome: 'rejected', signal: ts => ({ kind: 'focus', ts, app: 'Slack', [CANARIES.windowTitle]: true }) },
  { label: 'typed text on a focus event', outcome: 'rejected', signal: ts => ({ kind: 'focus', ts, app: 'Slack', typedText: CANARIES.typedText }) },
  { label: 'keystroke event carrying typed text', outcome: 'rejected', signal: ts => ({ kind: 'keystroke', ts, typed: CANARIES.typedText }) },
  { label: 'clipboard content', outcome: 'rejected', signal: ts => ({ kind: 'focus', ts, app: 'Microsoft Word', clipboard: CANARIES.clipboard }) },
  { label: 'AXSecureTextField with its value attached', outcome: 'rejected', signal: ts => ({ kind: 'focus', ts, app: 'Safari', secureInput: true, value: CANARIES.secureFieldValue }) },
  { label: 'IsPassword field with the value withheld', outcome: 'dropped', signal: ts => ({ kind: 'focus', ts, app: 'Microsoft Edge', secureInput: true }) },
  { label: 'private window with a URL', outcome: 'dropped', signal: ts => ({ kind: 'focus', ts, app: 'Google Chrome', isPrivateWindow: true, url: `https://docs.example.com/doc/x?token=${CANARIES.privateWindowUrl}` }) },
  { label: 'URL query and fragment in a browser', outcome: 'stored', signal: ts => ({ kind: 'focus', ts, app: 'Google Chrome', url: CHROME_URL }) },
  { label: 'URL userinfo in a browser', outcome: 'stored', signal: ts => ({ kind: 'focus', ts, app: 'Google Chrome', url: `https://${CANARIES.urlUserinfo}@docs.example.com/wiki/page` }) },
  { label: 'URL with an identifier as first path segment', outcome: 'stored', signal: ts => ({ kind: 'focus', ts, app: 'Google Chrome', url: `https://docs.example.com/${CANARIES.urlPathSegment}/edit` }) },
  { label: 'URL on a chat app', outcome: 'stored', signal: ts => ({ kind: 'focus', ts, app: 'Slack', url: `https://chat.example.com/room?t=${CANARIES.urlQuery}` }) },
  { label: 'file URL in a browser', outcome: 'stored', signal: ts => ({ kind: 'focus', ts, app: 'Google Chrome', url: `file:///Users/someone/${CANARIES.urlQuery}.txt` }) },
  { label: 'overlong URL', outcome: 'rejected', signal: ts => ({ kind: 'focus', ts, app: 'Google Chrome', url: `https://docs.example.com/${'a'.repeat(2100)}?t=${CANARIES.overlongUrl}` }) },
  { label: 'excluded password manager', outcome: 'dropped', signal: ts => ({ kind: 'focus', ts, app: '1Password 8' }) },
];

export interface ScenarioRun {
  /** Every output the suite inspects, taken after the whole scenario ran. */
  surfaces: Surface[];
  /** What the pipeline did with each planted input, keyed by its label. */
  outcomes: Record<string, Outcome>;
  events: TwinEvent[];
  facts: {
    ledgerEntries: number;
    spawnCalls: number;
    unexpectedOutboundCalls: number;
    chromeTemplate?: string;
    downloadStatus: string[];
  };
}

function ingestOutcome(agent: TwinAgent, signal: unknown, thrown: unknown[]): Outcome {
  try {
    return agent.ingest(signal) ? 'stored' : 'dropped';
  } catch (error) {
    thrown.push(error);
    return 'rejected';
  }
}

function focusingExecutor(): Executor {
  let front: string | undefined;
  return {
    focusApp: async app => {
      front = app;
      return true;
    },
    frontmostApp: async () => front,
  };
}

async function settle(done: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error('The scenario timed out waiting for a download to finish.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/**
 * Drives the real engine and desktop modules with canaries planted on every ingest surface, then returns every output
 * a person, a log reader or a network observer could see. Nothing here is mocked except the outside world: the
 * network is refused, the CLI is a fake, and the console is captured in memory.
 */
export async function runPlantedScenario(): Promise<ScenarioRun> {
  const root = mkdtempSync(join(tmpdir(), 'twin-privacy-'));
  const storeDir = join(root, 'twin');
  const key = randomBytes(32);
  const outbound: string[] = [];
  const thrown: unknown[] = [];
  const outcomes: Record<string, Outcome> = {};
  spawnLog.length = 0;
  const restoreOutbound = refuseOutbound(outbound);
  const capture = new ConsoleCapture();

  try {
    const agent = new TwinAgent({ dataDir: storeDir, dataKey: key, now: () => at(10, 0) });
    agent.updateConfig({ watchBrowsers: true });
    for (let day = 0; day < 10; day++) for (const signal of workday(day)) agent.ingest(signal);
    PLANTED.forEach((planted, index) => {
      outcomes[planted.label] = ingestOutcome(agent, planted.signal(at(0, 11, index)), thrown);
    });

    const suggestion = agent.suggestions().find(candidate => candidate.routine.steps.length === 4);
    if (!suggestion) throw new Error('The scenario should detect a four-step routine.');
    const view = agent.acceptRoutine(suggestion.routine.id, 'Invoice follow-up');
    agent.setLevel(view.automation.id, 3);
    await agent.run(view.automation.id, { mode: 'dry_run' }, focusingExecutor());
    await agent.run(view.automation.id, { mode: 'supervised', approve: async () => true }, focusingExecutor());

    for (const attempt of [() => agent.setLevel('auto_unknown', 3), () => agent.acceptRoutine('routine_unknown')]) {
      try {
        attempt();
      } catch (error) {
        thrown.push(error);
      }
    }

    // A model download whose server answers with the wrong size: the ledger must record the call, and nothing more.
    const models = new ModelManager({
      modelsDir: join(root, 'models'),
      agent,
      onChange: () => undefined,
      fetchImpl: recordingFetch(outbound, () => new Response('wrong', { status: 200, headers: { 'content-length': '5' } })),
    });
    models.install('qwen3-0.6b');
    await settle(() => models.states().every(state => state.status !== 'running'));

    // The OpenMausBot handoff: the preview the person sees, and the command line that is actually started.
    const brief = 'Summarise the invoice follow-ups from this week';
    const prompt = buildOpenMausBotPrompt(view.automation, brief);
    await runOpenMausBotTask({ command: 'openmausbot', target: 'Lead Bot', automation: view.automation, taskBrief: brief });

    const exported = agent.exportAll() as { events: TwinEvent[]; automations: Automation[] };
    const surfaces: Surface[] = [
      ...diskSurfaces(root, storeDir, key),
      { name: 'console', text: capture.text() },
      { name: 'ledger', text: JSON.stringify({ network: agent.networkLedger(), downloads: models.states() }, null, 2) },
      { name: 'export', text: JSON.stringify(exported, null, 2) },
      { name: 'export:automations', text: JSON.stringify(exported.automations, null, 2) },
      { name: 'prompt:openmausbot', text: prompt },
      { name: 'errors', text: thrown.map(errorText).join('\n') },
      { name: 'outbound:fetch', text: outbound.join('\n') },
      { name: 'outbound:spawn', text: spawnLog.map(call => [call.command, ...call.args].join('\n')).join('\n---\n') },
    ];

    return {
      surfaces,
      outcomes,
      events: exported.events,
      facts: {
        ledgerEntries: agent.networkLedger().length,
        spawnCalls: spawnLog.length,
        unexpectedOutboundCalls: outbound.filter(line => line.startsWith('UNEXPECTED')).length,
        chromeTemplate: exported.events.find(event => event.urlTemplate)?.urlTemplate,
        downloadStatus: models.states().map(state => state.status),
      },
    };
  } finally {
    capture.restore();
    restoreOutbound();
    rmSync(root, { recursive: true, force: true });
  }
}
