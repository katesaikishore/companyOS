import {
  FrameDeduper,
  TwinAgent,
  audioDecision,
  dayKeyOf,
  deriveMediaKey,
  describeWhen,
  fingerprintBitmap,
  newId,
  normaliseOcr,
  screenDecision,
  type Automation,
  type AudioState,
  type Executor,
  type ScreenState,
  type TwinEvent,
  type WindowClass,
} from '@companyos/twin-core';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaStore } from '../../apps/desktop/src/main/media-store';
import { ModelManager } from '../../apps/desktop/src/main/models';
import { CANARIES, type Surface } from './canaries';
import { ConsoleCapture, diskSurfaces, errorText, listFiles, recordingFetch, refuseOutbound } from './surfaces';

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
 * capture adapter would send: the secure flag set and the value withheld, or the value attached by mistake. A secure
 * or excluded event still carries the page URL it came from, so each dropped row plants a canary the scanner can find.
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
  { label: 'IsPassword field with the value withheld', outcome: 'dropped', signal: ts => ({ kind: 'focus', ts, app: 'Microsoft Edge', secureInput: true, url: `https://login.example.com/signin?t=${CANARIES.secureFieldUrl}` }) },
  { label: 'private window with a URL', outcome: 'dropped', signal: ts => ({ kind: 'focus', ts, app: 'Google Chrome', isPrivateWindow: true, url: `https://docs.example.com/doc/x?token=${CANARIES.privateWindowUrl}` }) },
  { label: 'URL query and fragment in a browser', outcome: 'stored', signal: ts => ({ kind: 'focus', ts, app: 'Google Chrome', url: CHROME_URL }) },
  { label: 'URL userinfo in a browser', outcome: 'stored', signal: ts => ({ kind: 'focus', ts, app: 'Google Chrome', url: `https://${CANARIES.urlUserinfo}@docs.example.com/wiki/page` }) },
  { label: 'URL with an identifier as first path segment', outcome: 'stored', signal: ts => ({ kind: 'focus', ts, app: 'Google Chrome', url: `https://docs.example.com/${CANARIES.urlPathSegment}/edit` }) },
  { label: 'URL on a chat app', outcome: 'stored', signal: ts => ({ kind: 'focus', ts, app: 'Slack', url: `https://chat.example.com/room?t=${CANARIES.urlQuery}` }) },
  { label: 'file URL in a browser', outcome: 'stored', signal: ts => ({ kind: 'focus', ts, app: 'Google Chrome', url: `file:///Users/someone/${CANARIES.urlQuery}.txt` }) },
  { label: 'overlong URL', outcome: 'rejected', signal: ts => ({ kind: 'focus', ts, app: 'Google Chrome', url: `https://docs.example.com/${'a'.repeat(2100)}?t=${CANARIES.overlongUrl}` }) },
  { label: 'excluded password manager', outcome: 'dropped', signal: ts => ({ kind: 'focus', ts, app: '1Password 8', url: `https://vault.example.com/item?t=${CANARIES.excludedAppUrl}` }) },
  { label: 'percent-encoded URL query in a browser', outcome: 'stored', signal: ts => ({ kind: 'focus', ts, app: 'Google Chrome', url: `https://docs.example.com/doc/5f0e7c21/view?t=${encodeURIComponent(CANARIES.encodedForms)}` }) },
];

/** Size of the stand-in frames. fingerprintBitmap samples frames down to 64 by 36, so no resizing is needed. */
const FRAME_WIDTH = 64;
const FRAME_HEIGHT = 36;

/** A stand-in screen frame: the app in front, the window class and the policy inputs that differ from a clear screen. */
export interface PlantedFrame {
  label: string;
  outcome: Outcome;
  app: string;
  windowClass: WindowClass;
  state: Partial<Pick<ScreenState, 'locked' | 'paused' | 'idle' | 'appExcluded' | 'secureInput' | 'permissionGranted'>>;
  /** The text the stand-in OCR returns for the frame. */
  text: string;
}

/**
 * Screen frames planted through the steps the screen service takes: the policy, the dedupe, the cleaned text, a sealed
 * image and the agent's ingest. The grab and the OCR are stand-ins that return the planted text. The Electron modules are
 * not imported, so the suite runs without Electron. The frame in the first row is the only one that may be kept, so its
 * canary is the only screen canary the store may hold. Every dropped row carries a canary of its own.
 */
export const PLANTED_FRAMES: readonly PlantedFrame[] = [
  { label: 'screen text in an allowed app', outcome: 'stored', app: 'Microsoft Excel', windowClass: 'spreadsheet', state: {}, text: `Invoice total ${CANARIES.screenOcr}` },
  { label: 'screen text from an excluded app', outcome: 'dropped', app: '1Password 8', windowClass: 'other', state: { appExcluded: true }, text: `Vault ${CANARIES.screenOcrExcluded}` },
  { label: 'screen text with a password field focused', outcome: 'dropped', app: 'Microsoft Word', windowClass: 'document', state: { secureInput: true }, text: `Password ${CANARIES.screenOcrSecure}` },
  { label: 'screen text when secure input cannot be checked', outcome: 'dropped', app: 'Microsoft Word', windowClass: 'document', state: { secureInput: 'unknown' }, text: `Unchecked ${CANARIES.screenOcrUnknown}` },
  { label: 'screen text while the screen is locked', outcome: 'dropped', app: 'Slack', windowClass: 'chat', state: { locked: true }, text: `Locked ${CANARIES.screenOcrLocked}` },
  { label: 'screen text in a browser window', outcome: 'dropped', app: 'Google Chrome', windowClass: 'browser', state: {}, text: `Browser ${CANARIES.screenOcrBrowser}` },
];

/** A stand-in microphone segment, with the policy inputs that differ from a clear microphone. */
export interface PlantedSegment {
  label: string;
  outcome: Outcome;
  state: Partial<Pick<AudioState, 'locked' | 'paused' | 'idle' | 'permissionGranted'>>;
  /** The transcript the stand-in speech model returns for the segment. */
  text: string;
}

export const PLANTED_SEGMENTS: readonly PlantedSegment[] = [
  { label: 'microphone text while paused', outcome: 'dropped', state: { paused: true }, text: `Meeting notes ${CANARIES.audioTranscript}` },
];

function frameState(planted: PlantedFrame): ScreenState {
  return {
    enabled: true,
    locked: false,
    paused: false,
    idle: false,
    appExcluded: false,
    windowClass: planted.windowClass,
    secureInput: false,
    permissionGranted: true,
    ...planted.state,
  };
}

/** A stand-in for the JPEG the Electron encoder makes: the JPEG header, then fixed bytes that hold no planted text. */
function standInJpeg(mediaId: string): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    createHash('sha256').update(mediaId).digest(),
    Buffer.alloc(2048, 0x42),
  ]);
}

/** The steps the screen service takes for one frame, with the stand-ins. Returns what became of it. */
async function plantFrame(
  agent: TwinAgent,
  media: MediaStore,
  deduper: FrameDeduper,
  planted: PlantedFrame,
  index: number,
  ts: number,
  thrown: unknown[],
): Promise<Outcome> {
  if (!screenDecision(frameState(planted)).capture) return 'dropped';
  // Each frame is a flat colour with its own level, so two planted frames never look alike to the dedupe.
  const bgra = Buffer.alloc(FRAME_WIDTH * FRAME_HEIGHT * 4, 40 + index * 20);
  if (!deduper.shouldKeep(fingerprintBitmap(bgra, FRAME_WIDTH, FRAME_HEIGHT))) return 'dropped';
  const text = normaliseOcr(planted.text);
  if (text === '') return 'dropped';
  const mediaId = newId();
  try {
    await media.write(mediaId, standInJpeg(mediaId));
    const stored = agent.ingestScreen({ ts, app: planted.app, windowClass: planted.windowClass, text, mediaId });
    // An image whose text was not stored is removed, as the service does.
    if (!stored) await media.remove([mediaId]);
    return stored ? 'stored' : 'dropped';
  } catch (error) {
    thrown.push(error);
    await media.remove([mediaId]).catch(() => undefined);
    return 'rejected';
  }
}

/** The steps the audio service takes for one segment, with the stand-in transcript. */
function plantSegment(agent: TwinAgent, planted: PlantedSegment, ts: number, thrown: unknown[]): Outcome {
  const state: AudioState = { enabled: true, locked: false, paused: false, idle: false, permissionGranted: true, ...planted.state };
  if (!audioDecision(state).capture) return 'dropped';
  try {
    return agent.ingestAudio({ ts, durationMs: 30_000, text: planted.text }) ? 'stored' : 'dropped';
  } catch (error) {
    thrown.push(error);
    return 'rejected';
  }
}

export interface ScenarioRun {
  /** Every output the suite inspects, taken after the whole scenario ran. */
  surfaces: Surface[];
  /** What the pipeline did with each planted input, keyed by its label. */
  outcomes: Record<string, Outcome>;
  events: TwinEvent[];
  facts: {
    ledgerEntries: number;
    unexpectedOutboundCalls: number;
    chromeTemplate?: string;
    downloadStatus: string[];
    captures: {
      /** Stored screen items and microphone items after the run. */
      screenCount: number;
      audioCount: number;
      /** Sealed image files left in the media folder. */
      mediaFiles: number;
      /** Stored screen items that the search for a word in the stored frame returned. */
      screenHits: number;
      /** Items that the search for the query canary returned. It must be zero. */
      queryHits: number;
    };
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
 * network and every process call are refused and recorded, and the console is captured in memory.
 */
export async function runPlantedScenario(): Promise<ScenarioRun> {
  const root = mkdtempSync(join(tmpdir(), 'twin-privacy-'));
  const storeDir = join(root, 'twin');
  const mediaDir = join(root, 'media');
  const key = randomBytes(32);
  const outbound: string[] = [];
  const thrown: unknown[] = [];
  const outcomes: Record<string, Outcome> = {};
  const restoreOutbound = refuseOutbound(outbound);
  const capture = new ConsoleCapture();

  const agent = new TwinAgent({ dataDir: storeDir, dataKey: key, now: () => at(10, 0) });
  try {
    // Screen and microphone text are off by default. This run turns both on, so the planted text can reach the store
    // where the policy allows it. The default-off check is a separate test.
    agent.updateConfig({ watchBrowsers: true, screenCaptureEnabled: true, audioCaptureEnabled: true });
    for (let day = 0; day < 10; day++) for (const signal of workday(day)) agent.ingest(signal);
    PLANTED.forEach((planted, index) => {
      outcomes[planted.label] = ingestOutcome(agent, planted.signal(at(0, 11, index)), thrown);
    });

    const media = new MediaStore(mediaDir, deriveMediaKey(key));
    const deduper = new FrameDeduper();
    for (const [index, planted] of PLANTED_FRAMES.entries()) {
      outcomes[planted.label] = await plantFrame(agent, media, deduper, planted, index, at(0, 12, index), thrown);
    }
    for (const [index, planted] of PLANTED_SEGMENTS.entries()) {
      outcomes[planted.label] = plantSegment(agent, planted, at(0, 13, index), thrown);
    }
    // A search for words the store holds finds the stored frame. A search for the query canary finds nothing, and the
    // query itself is not kept, which the store check below reads. A malformed search is refused with a fixed sentence.
    const screenHits = agent.searchCapture({ text: 'Invoice', from: at(-1, 0), to: at(1, 0) }).length;
    const queryHits = agent.searchCapture({ text: CANARIES.searchQuery, from: at(-1, 0), to: at(1, 0) }).length;
    try {
      agent.searchCapture({ text: CANARIES.searchQuery, from: 'soon' as unknown as number, to: at(1, 0) });
    } catch (error) {
      thrown.push(error);
    }

    const detected = agent.suggestions();
    const suggestion = detected.find(candidate => candidate.routine.steps.length === 4);
    if (!suggestion) throw new Error('The scenario should detect a four-step routine.');
    const view = agent.acceptRoutine(suggestion.routine.id, 'Invoice follow-up');
    agent.setLevel(view.automation.id, 3);
    await agent.run(view.automation.id, { mode: 'dry_run' }, focusingExecutor());
    await agent.run(view.automation.id, { mode: 'supervised', approve: async () => true }, focusingExecutor());
    // A decline is kept in the encrypted config, so the store and the export carry it. The canary checks read it there.
    agent.recordDecline(view.automation.id);

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

    // Tasks for a working day, with the first one confirmed, so the task view and the decision store hold real data.
    const taskDay = dayKeyOf(at(9, 12));
    agent.decideTask({ day: taskDay, kind: 'confirm', taskId: agent.dayTasks(taskDay).tasks[0].id });

    const exported = agent.exportAll() as { events: TwinEvent[]; automations: Automation[]; config: unknown };
    const surfaces: Surface[] = [
      ...diskSurfaces(root, storeDir, key, mediaDir),
      { name: 'console', text: capture.text() },
      { name: 'ledger', text: JSON.stringify({ network: agent.networkLedger(), downloads: models.states() }, null, 2) },
      { name: 'export', text: JSON.stringify(exported, null, 2) },
      { name: 'export:automations', text: JSON.stringify(exported.automations, null, 2) },
      { name: 'export:config', text: JSON.stringify(exported.config, null, 2) },
      { name: 'habits', text: JSON.stringify(agent.habits(), null, 2) },
      // The What the twin knows page: its routines, sites, timing and declines. It is built from the same planted run.
      { name: 'knows', text: JSON.stringify(agent.knownRoutines(), null, 2) },
      {
        name: 'suggestions',
        text: JSON.stringify(
          detected.map(item => ({ when: describeWhen(item.routine.when) })),
          null,
          2,
        ),
      },
      { name: 'tasks', text: JSON.stringify(agent.dayTasks(taskDay), null, 2) },
      { name: 'errors', text: thrown.map(errorText).join('\n') },
      { name: 'outbound:fetch', text: outbound.join('\n') },
    ];

    return {
      surfaces,
      outcomes,
      events: exported.events,
      facts: {
        ledgerEntries: agent.networkLedger().length,
        unexpectedOutboundCalls: outbound.filter(line => line.startsWith('UNEXPECTED')).length,
        chromeTemplate: exported.events.find(event => event.urlTemplate)?.urlTemplate,
        downloadStatus: models.states().map(state => state.status),
        captures: {
          screenCount: agent.captureSummary().screenCount,
          audioCount: agent.captureSummary().audioCount,
          mediaFiles: existsSync(mediaDir) ? listFiles(mediaDir).filter(path => path.endsWith('.bin')).length : 0,
          screenHits,
          queryHits,
        },
      },
    };
  } finally {
    capture.restore();
    restoreOutbound();
    // Windows will not delete the store's files while the agent holds them open.
    agent.close();
    rmSync(root, { recursive: true, force: true });
  }
}
