import {
  RETENTION_DAYS,
  TRIGGER_RULES,
  TwinAgent,
  classifyApp,
  deriveMediaKey,
  isBrowserApp,
  isExcludedApp,
  mergeConfigPatch,
  screenDecision,
  KindLabelJob,
  describeWhen,
  effectOfOp,
  effectsOf,
  modelWorkAllowed,
  planSetup,
  resolveStep,
  type AudioRead,
  type Automation,
  type AutomationView,
  type AutonomyLevel,
  type CaptureChannelState,
  type CaptureHitView,
  type CapturePermission,
  type CaptureSearchRequest,
  type Decision,
  type DraftStep,
  type Executor,
  type HardwareProfile,
  type KeystrokeState,
  type LocalApiState,
  type NetworkEntry,
  type PipeGate,
  type Pipe,
  type PipeOutputSummaryView,
  type RunResult,
  type ScreenRead,
  type SetupPlan,
  type Step,
  type SuggestionView,
  type TwinConfig,
  type TwinStatus,
  type PendingRunView,
  type RoutineNamingJob,
  type WindowClass,
  normalizeAppName,
} from '@companyos/twin-core';
import { SPEAKER_MIN_SAMPLES, SPEAKER_MODEL_ID, WHISPER_MODEL_ID } from '@companyos/twin-core';
import { app, desktopCapturer, systemPreferences } from 'electron';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLOUD_TOKEN_FOLDER } from './connectors-cloud/seal';
import { BROWSER_APP_NAMES, startBrowserBridge, type BrowserBridge, type BrowserVisit } from './browser-bridge';
import { CaptureService } from './capture';
import { createKeyboardSource } from './keyboard';
import { KeystrokeService } from './keystroke-service';
import { AudioCaptureService, WhisperTranscriber, microphoneGranted, type SpeakerIdentifier } from './audio-capture';
import { SpeakerEmbedder } from './speaker-embedder';
import { destroyStoredSecrets, loadOrCreateApiToken, loadOrCreateDataKey, rotateApiToken as replaceApiToken } from './keys';
import { LOCAL_API_HOST, LOCAL_API_PORT, createLocalApi, withheldFromLocalApi, type LocalApi } from './local-api';
import { MediaStore } from './media-store';
import { readAccessibleText } from './accessibility';
import { electronFrameSource, forkOcrWorker, ScreenCaptureService, type Frame, type ScreenContext } from './screen-capture';
import { secureInputState } from './secure-input';
import { detectHardware } from './hardware';
import { LayaBundleManager, type LayaTestOptions } from './laya';
import { LayaDecisionModel } from './decision-laya';
import { ModelManager, createRoutineNamer } from './models';
import { browserCapturePaths, installNativeHost, isBrowserCaptureSupported, removeNativeHost } from './native-host-install';
import { AgentDesktopSession, cursorFor, handsExecutor } from './agent-desktop';
import { choosePlatform, executorFor, type Platform } from './platform';
import { PipeScheduler, removeLegacyPipeFiles } from './pipes';
import { LocalConnectorService } from './connectors-scheduler';
import type { LocalConnectorKind } from './connectors-validate';

export interface RuntimeOptions {
  userData: string;
  /** Asks a person to approve one step. The main process shows a native dialog. */
  approve: (automation: Automation, step: Step, decision: Decision) => Promise<boolean>;
  /** Seconds since the last keyboard or mouse input. */
  idleSeconds: () => number;
  /** True when the device runs on battery. Model work waits for AC power or idleness (plan §5.5). */
  onBattery: () => boolean;
  /** The screen's lock state from the operating system, or undefined when it cannot say. Asked only while the state is unknown. */
  screenLocked?: () => boolean | undefined;
  /** Called when model downloads change, so open pages refresh. */
  onChange: () => void;
  /** Called when a routine is offered. The main process shows the tray and a notification. */
  onOffer: (offer: PendingRunView) => void;
  /** Called after a level 4 run so the owner can see that it ran or stopped. */
  onUnattendedRun?: (result: RunResult) => void;
  /** Called when a pipe with the notify action finds new matches. The text holds a count and app names, never item text. */
  onPipeNotice?: (text: string) => void;
  /** The native messaging host script shipped with the app. Browser capture cannot start without it. */
  browserHostScript?: string;
  fetchImpl?: typeof fetch;
  /** Test-only. Points the decision-model download at a local server. The main process never sets it in a packaged build. */
  laya?: LayaTestOptions;
}

const NO_CONTROL: Executor = {
  focusApp: async () => {
    throw new Error('App control is not available on this system yet.');
  },
  frontmostApp: async () => undefined,
};

const DAY_MS = 86_400_000;
/** How often the kind labeller looks for routines to label. A look reads the routines, so it is not more often. */
const KIND_PASS_MS = 60_000;
/** How long the Laya model stays loaded after labelling, before it is freed. */
const LAYA_IDLE_RELEASE_MS = 5 * 60_000;
/** When to try again to free the model while a pass still runs. */
const KIND_RELEASE_RETRY_MS = 30_000;
/** After a pass that labelled nothing, how long to wait before the next look. Each look reads the whole history. */
const KIND_QUIET_MS = 10 * 60_000;
/** How often the capture channels get their current state, so a lock, pause or idle change is seen within this time. */
const CAPTURE_SYNC_MS = 5_000;
/** The image folder's cap. Once it is over, the oldest images go first. Their text stays. */
const MEDIA_CAP_BYTES = 2 * 1024 ** 3;
const MEDIA_CAP_BATCH = 200;
/** The least time between sweeps that run because a frame was kept. A busy screen keeps a frame every few seconds. */
const SWEEP_MIN_INTERVAL_MS = 60_000;
/** Reading the image folder means looking at every file, so its size is refreshed at most this often while frames are kept. */
const MEDIA_SIZE_REFRESH_MS = 60_000;
/** A frame larger than this is not sent to the page. Frames are about 120 KB, so this only stops a runaway file. */
const MAX_FRAME_BYTES = 512 * 1024;

/**
 * Connects the twin engine to the operating system and to the model installer. It is the only thing the IPC
 * layer talks to, so the page never receives a key, a raw event, or a path it did not ask for.
 */
export class TwinRuntime {
  private readonly agent: TwinAgent;
  private readonly capture: CaptureService;
  /** Typed text, off until the person turns it on. See keystroke-service.ts. */
  private readonly keystrokes: KeystrokeService;
  private readonly platform: Platform | undefined;
  private readonly models: ModelManager;
  /** The optional decision-model bundle. Nothing in the app asks it for a decision. */
  private readonly laya: LayaBundleManager;
  /** Listens for visits from the browser extension. Exists only while browser capture is on. */
  private browserBridge: BrowserBridge | undefined;
  private browserChanges: Promise<void> = Promise.resolve();
  /** Why browser capture could not start while its setting is on. Shown on the capture card until it works or is switched off. */
  private browserProblem: string | undefined;
  private readonly namer: RoutineNamingJob;
  private readonly decisionModel: LayaDecisionModel;
  private readonly kindLabels: KindLabelJob;
  private kindLabelTimer: ReturnType<typeof setInterval> | undefined;
  private kindReleaseTimer: ReturnType<typeof setTimeout> | undefined;
  private kindQuietUntil = 0;
  private hardwareProfile: Promise<HardwareProfile> | undefined;
  /** Offers waiting for an answer. At most one at a time. */
  private pending: PendingRunView[] = [];
  /** Runs in progress. No offers are made while one runs, so the run's own app switches cannot trigger one. */
  private activeRuns = 0;
  /** The one agent-desktop session the menu clicks share, so each automation keeps its own named cursor across runs. */
  private readonly handsSession = new AgentDesktopSession(() => ({ binary: this.agent.configuration.agentDesktopPath.trim() }));
  /** Screen and microphone capture. Each starts only while its setting is on. */
  private readonly screen: ScreenCaptureService;
  private readonly audio: AudioCaptureService;
  private readonly systemAudio: AudioCaptureService;
  /** The speaker model's process. Started by the first segment when speaker identification is on, and stopped when idle. */
  private readonly speakerEmbedder: SpeakerEmbedder;
  /** The speech model state the microphone was last decided on. Undefined until the first decision. */
  private speechWasInstalled: boolean | undefined;
  /** The daily sweep of expired text and images. Cleared on stop, so a stopped app does not keep a timer. */
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private lastSweepAt = 0;
  private readonly media: MediaStore;
  private readonly grabber = electronFrameSource();
  private captureTimer: ReturnType<typeof setInterval> | undefined;
  /** The app in front, from the last check. Undefined when it could not be named. */
  private frontApp: string | undefined;
  /** How many screen and microphone items are stored. Kept here, so a status read does not decrypt every row. */
  private counts = { screen: 0, audio: 0, keystroke: 0 };
  private mediaBytes = 0;
  private mediaSizedAt = 0;
  /** Image ids whose file could not be removed. The agent has already forgotten them, so every sweep tries them again. */
  private readonly unremovedImages = new Set<string>();
  private apiState: LocalApiState = 'off';
  private localApi: LocalApi | undefined;
  private apiToken: string | undefined;
  /** API and token changes run one at a time, as browser capture changes do. */
  private apiChanges: Promise<void> = Promise.resolve();
  /** Runs the saved pipes on their schedules. It starts and stops with the runtime. Its last-run times stay in memory. */
  private readonly pipeScheduler: PipeScheduler;
  /** Reads the local sources (folder, Git, calendar, mail) every six hours, and on request. See connectors-scheduler.ts. */
  private readonly connectors: LocalConnectorService;

  private constructor(
    private readonly options: RuntimeOptions,
    platform: Platform | undefined,
    detail: string,
    dataKey: Buffer,
  ) {
    this.platform = platform;
    this.media = new MediaStore(join(options.userData, 'media'), deriveMediaKey(dataKey));
    this.agent = new TwinAgent({
      dataDir: join(options.userData, 'twin'),
      dataKey,
      // Expired and excluded images are deleted through removeImages. The delete is not awaited. An image that cannot be
      // removed is kept in unremovedImages, and the next sweep tries it again.
      deleteMedia: mediaIds => void this.removeImages(mediaIds),
    });
    this.keystrokes = new KeystrokeService({
      source: createKeyboardSource(process.platform),
      frontApp: () => this.platform?.frontmost().catch(() => undefined) ?? Promise.resolve(undefined),
      secureInput: () => secureInputState(),
      state: app => this.keystrokeState(app),
      ingest: piece => this.keepKeystrokes(piece),
    });
    this.capture = new CaptureService(
      {
        agent: this.agent,
        platform,
        idleSeconds: options.idleSeconds,
        bridgeRunning: () => this.browserBridge !== undefined,
        onFocus: app => this.observeFocus(app),
        onFrontApp: app => this.keystrokes.noteFront(app),
      },
      detail,
    );
    this.screen = new ScreenCaptureService({
      source: { grab: () => this.grabFrame() },
      ocr: forkOcrWorker(join(__dirname, 'ocr-worker.js')),
      media: { write: (mediaId, jpeg) => this.writeFrame(mediaId, jpeg), remove: mediaIds => this.media.remove(mediaIds) },
      sink: { ingestScreen: read => this.keepScreenRead(read) },
      now: () => Date.now(),
      secureInput: () => this.checkSecureInput(),
      accessibility: () => readAccessibleText(),
      frontApp: async () => {
        const app = await this.platform?.frontmost().catch(() => undefined);
        return app ? normalizeAppName(app) : null;
      },
    });
    // One speech process serves both sources, so the model is in memory once.
    const transcriber = new WhisperTranscriber({
      workerPath: join(__dirname, 'transcribe-worker.js'),
      modelsDir: join(options.userData, 'models'),
    });
    // Voices are compared in a process of their own, and only while the person has turned speaker identification on.
    this.speakerEmbedder = new SpeakerEmbedder({
      workerPath: join(__dirname, 'speaker-worker.js'),
      modelsDir: join(options.userData, 'models'),
    });
    const speakers: SpeakerIdentifier = { identify: samples => this.identifySpeaker(samples) };
    // Speaker identification runs only while its setting is on, so the raw voice never reaches the model otherwise.
    const speakersEnabled = (): boolean => this.agent.configuration.speakerIdentificationEnabled;
    this.audio = new AudioCaptureService({
      transcriber,
      sink: { ingestAudio: segment => this.keepAudioSegment(segment) },
      speakers,
      speakersEnabled,
    });
    // System audio is loopback sound, which needs screen recording on macOS, not the microphone permission.
    this.systemAudio = new AudioCaptureService({
      transcriber,
      sink: { ingestAudio: segment => this.keepAudioSegment(segment) },
      source: 'system',
      speakers,
      speakersEnabled,
      permissionGranted: screenPermissionGranted,
    });
    this.models = new ModelManager({
      modelsDir: join(options.userData, 'models'),
      agent: this.agent,
      onChange: () => {
        // A speech model that is installed or removed changes whether the microphone may run.
        this.noteSpeechModel();
        options.onChange();
      },
      fetchImpl: options.fetchImpl,
    });
    // Inside the models folder, so wiping that folder removes the bundle with it.
    this.laya = new LayaBundleManager({
      rootDir: join(options.userData, 'models', 'laya'),
      record: entry => this.agent.recordNetworkCall(entry),
      onChange: options.onChange,
      fetchImpl: options.fetchImpl,
      ...options.laya,
    });
    this.namer = createRoutineNamer({
      agent: this.agent,
      models: this.models,
      workerPath: join(__dirname, 'llm-worker.js'),
      idleSeconds: options.idleSeconds,
      onBattery: options.onBattery,
      preferredModelId: async () => (await this.setupPlan()).chat?.spec.id,
    });
    // The Laya bundle labels routines the catalogue does not know. It is advice shown beside a suggestion. See labels.ts.
    this.decisionModel = new LayaDecisionModel({ runtime: () => this.laya.readyRuntime() });
    this.kindLabels = new KindLabelJob({
      routines: () => this.agent.routinesToLabelKind(),
      setKind: (routineId, labeling) => this.agent.setRoutineKind(routineId, labeling),
      model: this.decisionModel,
      available: () => this.laya.view().status === 'installed',
      allowed: () => modelWorkAllowed({ onBattery: options.onBattery(), idleSeconds: options.idleSeconds() }),
    });
    // A pipe reads only the stored text, through the engine's search, which leaves out excluded apps. The gates are read per run.
    // A write pipe's matches are kept encrypted in the store, through the agent, and never written to a file.
    this.pipeScheduler = new PipeScheduler({
      now: () => Date.now(),
      pipes: () => this.agent.configuration.pipes,
      gate: () => this.pipeGate(),
      search: request => this.agent.searchCapture(request),
      notify: text => options.onPipeNotice?.(text),
      storeOutput: (pipeId, output) => {
        this.agent.storePipeOutput(pipeId, output);
      },
    });
    // A scheduled import waits for the same gates as the pipes: paused, locked, or away. A person's own import does not.
    this.connectors = new LocalConnectorService({
      agent: this.agent,
      now: () => Date.now(),
      gate: () => this.capture.holds(),
      report: message => console.error(message),
    });
  }

  static async create(options: RuntimeOptions): Promise<TwinRuntime> {
    const dataKey = await loadOrCreateDataKey(options.userData);
    const { platform, detail } = await choosePlatform(app.isPackaged);
    return new TwinRuntime(options, platform, detail, dataKey);
  }

  async start(): Promise<void> {
    // The saved pause and the lock state are read before the first await, so no capture check runs before them.
    this.capture.setPaused(this.agent.configuration.capturePaused);
    this.learnLockState();
    await this.housekeeping();
    await this.models.reconcile();
    await this.laya.reconcile();
    this.capture.start();
    this.startCapture();
    void this.setLocalApi(this.agent.configuration.localApiEnabled);
    // A bridge that cannot start leaves the setting on with no browser URLs. The app still starts, and the capture card says why.
    if (this.agent.configuration.watchBrowsers) {
      await this.setBrowserCapture(true).catch(error => {
        this.browserProblem = error instanceof Error ? error.message : 'Watch browsers could not start.';
      });
    }
    this.namer.start();
    this.pipeScheduler.start();
    // Plain-text pipe files from an earlier version are removed once, here, and again whenever captured text is deleted.
    removeLegacyPipeFiles(this.options.userData).catch(() => {
      console.error('The pipe files from an earlier version could not be removed. Their text is not logged.');
    });
    this.connectors.start();
    this.startKindLabels();
    this.sweepTimer = setInterval(() => void this.sweepMedia(), DAY_MS);
    this.sweepTimer.unref();
  }

  stop(): void {
    clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    this.capture.stop();
    this.keystrokes.stop();
    void this.stopCapture();
    void this.setLocalApi(false);
    this.browserBridge?.stop();
    this.browserBridge = undefined;
    this.namer.stop();
    this.pipeScheduler.stop();
    this.connectors.stop();
    this.stopKindLabels();
    void this.handsSession.end();
  }

  setLocked(locked: boolean): void {
    this.capture.setLocked(locked);
    this.refreshCapture();
  }

  /** The person's pause. It is saved in the encrypted settings, so a relaunch keeps it. */
  setPaused(paused: boolean): void {
    this.agent.updateConfig({ capturePaused: paused });
    this.capture.setPaused(paused);
    this.refreshCapture();
  }

  /** Whether the person has paused capture. The tray label reads it. */
  capturePaused(): boolean {
    return this.agent.configuration.capturePaused;
  }

  hardware(): Promise<HardwareProfile> {
    this.hardwareProfile ??= detectHardware(this.options.userData);
    return this.hardwareProfile;
  }

  async setupPlan(): Promise<SetupPlan> {
    return planSetup(await this.hardware());
  }

  installModel(modelId: string): void {
    this.models.install(modelId);
  }

  cancelDownload(modelId: string): void {
    this.models.cancel(modelId);
  }

  removeModel(modelId: string): Promise<void> {
    return this.models.remove(modelId);
  }

  installLaya(): void {
    this.laya.install();
  }

  cancelLaya(): void {
    this.laya.cancel();
  }

  removeLaya(): Promise<void> {
    return this.laya.remove();
  }

  completeSetup(): void {
    this.agent.completeSetup();
  }

  /** Update checks are written to the same network ledger as model downloads. */
  recordNetworkCall(entry: NetworkEntry): void {
    this.agent.recordNetworkCall(entry);
  }

  status(): TwinStatus {
    const suggestions = this.suggestionViews();
    const automations = this.agent.automations();
    const config = this.agent.configuration;
    const drafts = automations.filter(view => view.state.level === 2).length;
    const minutesBack = automations
      .filter(view => view.state.level >= 3)
      .reduce((sum, view) => sum + (view.automation.estimate?.minutesPerWeek ?? 0), 0);
    const observed = this.agent.observed();
    return {
      capture: {
        ...(this.browserProblem ? { ...this.capture.status, detail: this.browserProblem } : this.capture.status),
        ...this.captureChannels(),
      },
      browserCaptureSupported: isBrowserCaptureSupported(),
      config,
      speakerProfiles: this.agent.speakerProfileCount(),
      usage: this.agent.appUsage(7),
      suggestions,
      automations,
      network: this.agent.networkLedger(),
      activity: this.agent.activityGrid(28),
      recordedFocusEvents: observed.recordedFocusEvents,
      storageBytes: this.agent.storageBytes(),
      retentionDays: RETENTION_DAYS,
      readiness: this.agent.readiness(),
      habits: this.agent.habits(),
      tasks: this.agent.dayTasks(),
      knownRoutines: this.agent.knownRoutines(),
      connectorItems: this.agent.connectorCount(),
      connectorCounts: this.connectors.lastCounts(),
      pipeOutputs: this.pipeOutputSummaries(config.pipes),
      assignedTasks: this.agent.assignedTasks(),
      taskRuns: this.agent.taskRuns(),
      stats: {
        routinesLearned: suggestions.length + automations.length,
        waiting: suggestions.length + drafts,
        unattendedReady: automations.filter(
          view =>
            config.automationsEnabled &&
            config.allowUnattended &&
            config.maxAutonomyLevel >= 4 &&
            view.state.level === 4,
        ).length,
        minutesBackPerWeek: Math.round(minutesBack * 10) / 10,
        observedDays: observed.observedDays,
      },
      downloads: this.models.states(),
      laya: this.laya.view(),
      pendingRuns: this.livePending(),
    };
  }

  /**
   * Turning browser capture on starts the local bridge and installs the native host first. If that fails, the
   * setting stays off and the error reaches the page.
   */
  async updateConfig(patch: unknown): Promise<TwinConfig> {
    // The local sources change only through their own actions, which check the kind and the path the person picked.
    if (typeof patch === 'object' && patch !== null && (patch as Record<string, unknown>).connectors !== undefined) {
      throw new Error('Sources change only through their own actions.');
    }
    // Checked as the saved config with the patch applied. Parsing the patch alone would reset every setting it leaves out.
    const next = mergeConfigPatch(this.agent.configuration, patch);
    const changed = patch as Partial<TwinConfig>;
    if (changed.watchBrowsers !== undefined) {
      await this.setBrowserCapture(next.watchBrowsers);
      this.browserProblem = undefined;
    }
    const saved = this.agent.updateConfig(next);
    // The pause is kept in the settings, so the capture check is given the saved value whichever path changed it.
    this.capture.setPaused(saved.capturePaused);
    // Removing an app from the captured text happens when the exclusion list changes, so the counts are read again.
    if (changed.excludedApps !== undefined) this.refreshCaptureCounts();
    // A shorter image period takes effect now, not at the next sweep.
    if (changed.frameRetentionDays !== undefined) void this.sweepMedia();
    this.refreshCapture();
    if (changed.localApiEnabled !== undefined) await this.setLocalApi(saved.localApiEnabled);
    return saved;
  }

  /** Adds a local source the person picked in the system dialog, and imports it once. Resolves to the items stored. */
  addConnector(kind: LocalConnectorKind, path: string): Promise<number> {
    return this.connectors.addSource(kind, path);
  }

  /** Removes a source and its items. The files it read are not changed. */
  removeConnector(id: string): Promise<void> {
    return this.connectors.removeSource(id);
  }

  /** Reads a source again now. The capture gates do not apply, because the person asked for this read. */
  importConnector(id: string): Promise<number> {
    return this.connectors.importNow(id);
  }

  stopAllAutomations(): void {
    this.agent.updateConfig({ automationsEnabled: false });
  }

  acceptRoutine(routineId: string, name?: string): AutomationView {
    return this.agent.acceptRoutine(routineId, name);
  }

  dismissRoutine(routineId: string): void {
    this.agent.dismissRoutine(routineId);
  }

  /** Clears the decline and wait of a routine, and lifts a dismissal, so the twin may suggest it again. */
  resetDecline(routineId: string): void {
    this.agent.resetDecline(routineId);
  }

  renameAutomation(automationId: string, name: string): AutomationView {
    return this.agent.renameAutomation(automationId, name);
  }

  createMenuAutomation(input: unknown): AutomationView {
    return this.agent.createMenuAutomation(input);
  }

  /** Confirms, renames, merges or splits one of a day's tasks. The engine checks the decision before it is stored. */
  decideTask(input: unknown): void {
    this.agent.decideTask(input);
  }

  setLevel(automationId: string, level: AutonomyLevel): AutomationView {
    return this.agent.setLevel(automationId, level);
  }

  promote(automationId: string): AutomationView {
    return this.agent.promote(automationId);
  }

  revertLast(automationId: string): AutomationView {
    return this.agent.revertLastRun(automationId);
  }

  /** Dry runs never touch the operating system, so they work on every platform. */
  dryRun(automationId: string): Promise<RunResult> {
    return this.agent.run(automationId, { mode: 'dry_run' }, NO_CONTROL);
  }

  async supervisedRun(automationId: string): Promise<RunResult> {
    return this.withRun(async () => {
      const platform = this.platform;
      if (!platform) throw new Error('App control is not available on this system yet.');
      const automation = this.agent.automations().find(view => view.automation.id === automationId)?.automation;
      if (!automation) throw new Error('Unknown automation.');
      return this.agent.run(
        automationId,
        {
          mode: 'supervised',
          approve: (step, decision) => this.options.approve(automation, step, decision),
        },
        this.runExecutor(platform, automation),
      );
    });
  }

  /**
   * The executor for one run. An empty agent-desktop path keeps the built-in adapters, so focus and key steps work as
   * before. A path sends those two steps through the program, and an unusable path blocks them with the reason. The
   * program's exit status, the CLI's error code when it gave one, and the duration are logged. Nothing it was given, and
   * no error message, is.
   */
  private runExecutor(platform: Platform, automation?: { id: string; name: string }): Executor {
    const native = executorFor(platform);
    const binary = this.agent.configuration.agentDesktopPath.trim();
    if (binary === '') return native;
    return handsExecutor(native, {
      binary,
      // The automation's own cursor, named after it, so several runs can be told apart on screen.
      ...(automation ? { cursor: cursorFor(automation.id, automation.name) } : {}),
      session: this.handsSession,
      record: entry => {
        const code = entry.code === undefined ? '' : ` code=${entry.code}`;
        console.info(`[agent-desktop] ${entry.step} exit=${entry.exit}${code} duration=${entry.durationMs}ms`);
      },
    });
  }

  /**
   * Called for every focus change the twin recorded. Offers at most one routine at a time, and only a routine
   * the person set to level 3 or above, and only when the gate allows it. An offer never starts a run.
   */
  observeFocus(app: string): void {
    // A focus change is a good moment for a screen frame. The frame still passes every check, so an excluded app is not read.
    if (this.agent.configuration.screenCaptureEnabled) void this.screen.requestFrame('focus');
    if (this.activeRuns > 0) return;
    this.expireOffers();
    if (this.pending.length > 0) return;
    const config = this.agent.configuration;
    // The agent keeps the offer gate, so the candidates it returns have already passed the cooldowns.
    const pick = this.agent.triggerCandidates(app).find(view => view.state.level <= config.maxAutonomyLevel);
    if (!pick) return;

    // Level 4 only runs without a prompt after the owner enabled it. The core re-checks the live policy
    // before every step. Counting it in the same cooldown prevents repeats from the run's own app switches.
    const unattendedSafe = effectsOf(pick.automation).every(effect => effect === 'read_only' || effect === 'local_reversible');
    if (pick.state.level === 4 && config.allowUnattended && unattendedSafe) {
      this.agent.recordOffer(pick.automation.id);
      void this.runUnattended(pick.automation.id);
      return;
    }

    const createdAt = Date.now();
    const offer: PendingRunView = {
      id: randomUUID(),
      automationId: pick.automation.id,
      automationName: pick.automation.name,
      app: normalizeAppName(app),
      createdAt,
      expiresAt: createdAt + TRIGGER_RULES.offerTtlMs,
    };
    this.pending = [...this.pending, offer];
    this.agent.recordOffer(pick.automation.id);
    this.options.onOffer(offer);
  }

  private async runUnattended(automationId: string): Promise<void> {
    const platform = this.platform;
    if (!platform) return;
    const automation = this.agent.automations().find(view => view.automation.id === automationId)?.automation;
    try {
      const result = await this.withRun(() =>
        this.agent.run(
          automationId,
          { mode: 'unattended' },
          this.runExecutor(platform, automation),
        ),
      );
      this.options.onUnattendedRun?.(result);
    } catch {
      // A concurrent settings change can invalidate the run before its first step. Keep capture alive and fail closed.
    }
  }

  hasPendingOffers(): boolean {
    return this.livePending().length > 0;
  }

  /** `run: true` starts a supervised run, where each external step still asks. `false` leaves the routine alone for a while. */
  async answerPendingRun(id: string, run: boolean): Promise<void> {
    const offer = this.livePending().find(candidate => candidate.id === id);
    if (!offer) throw new Error('That request has expired.');
    this.pending = this.pending.filter(candidate => candidate !== offer);
    if (!run) {
      this.agent.recordDecline(offer.automationId);
      return;
    }
    await this.supervisedRun(offer.automationId);
  }

  private async withRun<T>(task: () => Promise<T>): Promise<T> {
    this.activeRuns++;
    try {
      return await task();
    } finally {
      this.activeRuns--;
      this.agent.quietAfterRun();
    }
  }

  private livePending(): PendingRunView[] {
    this.expireOffers();
    return [...this.pending];
  }

  private expireOffers(): void {
    const now = Date.now();
    this.pending = this.pending.filter(offer => offer.expiresAt > now);
  }

  /**
   * Test-only, called by the performance harness. Writes a few days of app switches and idle gaps, as the end-to-end
   * tests do, so a measured run has routines to mine. Only app names are written. No titles, URLs or content.
   */
  seedMeasurementActivity(days: number): void {
    const now = new Date();
    const at = (ago: number, hour: number, minute = 0) =>
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - ago, hour, minute).getTime();
    for (let ago = days; ago >= 1; ago--) {
      this.agent.ingest({ kind: 'focus', ts: at(ago, 9), app: 'Microsoft Excel' });
      this.agent.ingest({ kind: 'focus', ts: at(ago, 9, 20), app: 'Microsoft Outlook' });
      this.agent.ingest({ kind: 'focus', ts: at(ago, 9, 30), app: 'Slack' });
      this.agent.ingest({ kind: 'idle_start', ts: at(ago, 10, 10) });
      this.agent.ingest({ kind: 'idle_end', ts: at(ago, 13) });
      this.agent.ingest({ kind: 'focus', ts: at(ago, 13, 5), app: 'Microsoft Excel' });
      this.agent.ingest({ kind: 'focus', ts: at(ago, 13, 25), app: 'Microsoft Word' });
      this.agent.ingest({ kind: 'idle_start', ts: at(ago, 14) });
    }
    this.agent.completeSetup();
  }

  exportData(): string {
    return JSON.stringify(this.agent.exportAll(), null, 2);
  }

  /**
   * Destroys the stored data, the key, the captured screen images and microphone text, the installed models (including the
   * decision-model bundle), and the sealed tokens of connected cloud accounts. Downloads and screen reads are ended before
   * their folders go, so nothing can be written back into them. Nothing can be recovered afterwards.
   */
  async deleteAll(): Promise<void> {
    this.stop();
    await this.stopCapture();
    this.disableBrowserCapture();
    await this.setLocalApi(false);
    // Every step runs even when an earlier one fails, so one failed step cannot leave the key or the store behind.
    // The first failure is raised at the end, so the page still reports it.
    const failures: unknown[] = [];
    const step = async (run: () => unknown): Promise<void> => {
      try {
        await run();
      } catch (error) {
        failures.push(error);
      }
    };
    await step(() => this.laya.wipe());
    await step(() => this.models.wipe());
    await step(() => this.media.wipe());
    await step(() => removeLegacyPipeFiles(this.options.userData));
    await step(() => this.agent.wipe());
    await step(() => rmSync(join(this.options.userData, CLOUD_TOKEN_FOLDER), { recursive: true, force: true }));
    this.apiToken = undefined;
    await step(() => destroyStoredSecrets(this.options.userData));
    if (failures.length > 0) throw failures[0];
  }

  /** The microphone window's page id while that window is open. The permission handler lets only that page use the microphone. */
  captureWebContentsId(): number | undefined {
    return this.audio.captureWebContentsId;
  }

  /** Asks the operating system for screen or microphone access. Capture starts at once if the access is granted. */
  async requestPermission(permission: CapturePermission): Promise<void> {
    if (permission === 'microphone') await this.audio.requestPermission();
    else await requestScreenAccess();
    this.refreshCapture();
  }

  /** Searches the stored screen and microphone text, newest first. Words are matched as phrases. */
  searchCapture(request: CaptureSearchRequest): CaptureHitView[] {
    return this.agent.searchCapture(request);
  }

  /** A stored screen image as a JPEG data URL, or null when it is gone, cannot be read, or is too large to send. */
  async frameImage(id: string): Promise<string | null> {
    const bytes = await this.readFrame(id);
    if (!bytes || bytes.length > MAX_FRAME_BYTES) return null;
    return `data:image/jpeg;base64,${bytes.toString('base64')}`;
  }

  /** Deletes every stored screen image and all captured text, including typed text. Activity history, automations and settings are kept. */
  async deleteCapture(): Promise<void> {
    // A read in progress ends first, so nothing new is stored after the delete. The open piece of typed text is dropped too.
    this.keystrokes.discard();
    await this.stopCapture();
    try {
      await this.media.remove(this.agent.deleteAllCapture());
    } finally {
      this.refreshCaptureCounts();
      await this.refreshMediaBytes();
      this.startCapture();
      // The kept pipe matches went with the text in the store. Any plain-text pipe file left from an earlier version goes too.
      // This runs last, so a failure here cannot stop the capture from starting again, and a failure reaches the page.
      await removeLegacyPipeFiles(this.options.userData);
    }
  }

  /** The newest kept run of each write pipe, by pipe id: its time and match count. Holds no text. */
  private pipeOutputSummaries(pipes: readonly Pipe[]): Record<string, PipeOutputSummaryView> {
    const summaries: Record<string, PipeOutputSummaryView> = {};
    for (const pipe of pipes) {
      const summary = this.agent.pipeOutputSummary(pipe.id);
      if (summary) summaries[pipe.id] = summary;
    }
    return summaries;
  }

  /** Copies the local API token through the given function. The token itself never reaches the page. */
  async copyApiToken(copy: (text: string) => void): Promise<void> {
    copy(await this.queueApi(() => this.apiTokenValue()));
  }

  /** Replaces the local API token. The API reads the token on every request, so the old one stops working at once. */
  rotateApiToken(): Promise<void> {
    return this.queueApi(async () => {
      this.apiToken = await replaceApiToken(this.options.userData);
    });
  }

  /** What activity capture says about the person now. Lock, pause and idle all keep the capture channels quiet. */
  private captureFlags(): { locked: boolean; paused: boolean; idle: boolean } {
    return this.capture.holds();
  }

  /**
   * Asks the operating system for the lock state while it is unknown. Once known, the lock events keep it. Unknown counts as
   * locked for screen and microphone reads, so nothing is read before the state is known.
   */
  private learnLockState(): void {
    if (this.capture.lockKnown) return;
    const locked = this.options.screenLocked?.();
    if (locked !== undefined) this.capture.learnLock(locked);
  }

  private heldBack(): boolean {
    const { locked, paused, idle } = this.captureFlags();
    return locked || paused || idle;
  }

  /** The channels' states and counts, and the local API's state. Holds no text, so the status and the API can return it. */
  private captureChannels(): Omit<TwinStatus['capture'], 'state' | 'detail'> {
    return {
      screenState: this.screenState(),
      audioState: this.audioState(),
      keystrokeState: this.keystrokeChannelState(),
      apiState: this.apiState,
      mediaBytes: this.mediaBytes,
      screenCount: this.counts.screen,
      audioCount: this.counts.audio,
      keystrokeCount: this.counts.keystroke,
    };
  }

  private screenState(): CaptureChannelState {
    if (!this.agent.configuration.screenCaptureEnabled) return 'off';
    // Secure input cannot be read off macOS, so no frame is kept there. The channel says so, rather than looking on.
    if (process.platform !== 'darwin') return 'unsupported';
    if (!screenPermissionGranted()) return 'needs_permission';
    return this.heldBack() ? 'paused' : 'on';
  }

  /**
   * Typed text. 'unsupported' when this system has no keyboard hook, so the setting cannot take effect. The policy also refuses
   * every piece on a system that cannot check secure input, so the channel is shown as on only where both are in place.
   */
  private keystrokeChannelState(): CaptureChannelState {
    if (!this.agent.configuration.keystrokeCaptureEnabled) return 'off';
    if (!this.keystrokes.available) return 'unsupported';
    if (!this.keystrokes.permissionGranted) return 'needs_permission';
    return this.heldBack() ? 'paused' : 'on';
  }

  /**
   * The policy's inputs for typed text, for the app the text would be typed into. An app that cannot be named is treated as
   * excluded, and so is the twin itself. Secure input is added by the keystroke service.
   */
  private keystrokeState(app: string | undefined): Omit<KeystrokeState, 'secureInput'> {
    const config = this.agent.configuration;
    return {
      enabled: config.keystrokeCaptureEnabled,
      ...this.captureFlags(),
      permissionGranted: this.keystrokes.permissionGranted,
      appExcluded: app === undefined || isOwnApp(app) || isExcludedApp(app, config.excludedApps),
      windowClass: windowClassOf(app),
      windowExcluded: config.excludedWindowClasses.includes(windowClassOf(app)),
    };
  }

  /** Stores one finished piece of typed text. The agent checks it again, so this never stores what the policy refused. */
  private keepKeystrokes(piece: { ts: number; app: string; text: string }): boolean {
    const stored = this.agent.ingestKeystrokes({ ...piece, windowClass: windowClassOf(piece.app) });
    if (stored) this.counts.keystroke += 1;
    return stored;
  }

  /** True when the speech model is installed. Its record is kept only after every file has been checked against its pin. */
  private speechInstalled(): boolean {
    return this.agent.configuration.installedModels.some(model => model.id === WHISPER_MODEL_ID);
  }

  /** True when the speaker model is installed. Like the speech model, its record is kept only after every file is checked. */
  private speakerInstalled(): boolean {
    return this.agent.configuration.installedModels.some(model => model.id === SPEAKER_MODEL_ID);
  }

  /**
   * Says who is speaking in one segment, when speaker identification is on and its model is installed. The voice is computed
   * in the speaker process and compared in the engine. Only the name or the session label comes back.
   */
  private async identifySpeaker(samples: Float32Array): Promise<string | undefined> {
    if (!this.agent.configuration.speakerIdentificationEnabled || !this.speakerInstalled()) return undefined;
    // A segment shorter than a second is too short to tell voices apart, so it gets no speaker.
    if (samples.length < SPEAKER_MIN_SAMPLES) return undefined;
    const voice = await this.speakerEmbedder.embed(samples);
    return voice === undefined ? undefined : this.agent.identifySpeaker(voice);
  }

  /** Gives a session speaker a name, from the Recall page. The engine checks the label and the name. */
  nameSpeaker(label: string, name: string): void {
    this.agent.nameSessionSpeaker(label, name);
  }

  /** Deletes every speaker profile and forgets the session speakers. The speaker process is stopped first, so nothing is matched after it. */
  forgetSpeakers(): void {
    this.speakerEmbedder.stop();
    this.agent.forgetSpeakers();
  }

  /** Restarts the microphone decision when the speech model is installed or removed, and does nothing otherwise. */
  private noteSpeechModel(): void {
    const installed = this.speechInstalled();
    if (installed === this.speechWasInstalled) return;
    this.speechWasInstalled = installed;
    if (this.audio && this.screen) this.refreshCapture();
  }

  private audioState(): CaptureChannelState {
    if (!this.agent.configuration.audioCaptureEnabled || !this.speechInstalled()) return 'off';
    if (!microphoneGranted()) return 'needs_permission';
    return this.heldBack() ? 'paused' : 'on';
  }

  /**
   * The screen policy's inputs from the current settings and the app in front. An app that cannot be named is treated as
   * excluded, and so is the twin itself, so nothing it shows is read back.
   */
  private screenContext(): ScreenContext {
    const config = this.agent.configuration;
    const front = this.frontApp;
    return {
      enabled: config.screenCaptureEnabled,
      ...this.captureFlags(),
      app: front === undefined ? null : normalizeAppName(front),
      appExcluded: front === undefined || isOwnApp(front) || isExcludedApp(front, config.excludedApps),
      windowClass: windowClassOf(front),
      windowExcluded: config.excludedWindowClasses.includes(windowClassOf(front)),
      permissionGranted: screenPermissionGranted(),
    };
  }

  /**
   * The gates a pipe run waits for, read from the same holds the capture channels use. Secure input is probed here, once
   * a pipe is due, so the probe is not run on every tick.
   */
  private async pipeGate(): Promise<PipeGate> {
    const holds = this.capture.holds();
    return {
      automationsEnabled: this.agent.configuration.automationsEnabled,
      paused: holds.paused,
      locked: holds.locked,
      idle: holds.idle,
      secureInput: await secureInputState(),
    };
  }

  private async refreshFrontApp(): Promise<void> {
    const app = await this.platform?.frontmost().catch(() => undefined);
    this.frontApp = app || undefined;
  }

  /**
   * The first step of a screen read, run before the policy. It reads the app in front again, so a switch the focus log
   * dropped, such as one to an excluded app, is still seen. The secure input probe runs only when the read is otherwise
   * allowed, since its answer would not change the outcome.
   */
  private async checkSecureInput(): Promise<boolean | 'unknown'> {
    await this.refreshFrontApp();
    const context = this.screenContext();
    this.screen.setContext(context);
    if (!screenDecision({ ...context, secureInput: false }).capture) return 'unknown';
    return secureInputState();
  }

  /**
   * The grab of one frame. The app in front is read again after the grab, and the frame goes on to OCR only when the same
   * app was in front before and after it, and the policy allows that app now. A switch during the grab cannot then file
   * one app's pixels under another, and an excluded app's frame is never read.
   */
  private async grabFrame(): Promise<Frame | null> {
    const before = this.frontApp;
    const frame = await this.grabber.grab();
    if (frame === null) return null;
    await this.refreshFrontApp();
    const context = this.screenContext();
    this.screen.setContext(context);
    if (this.frontApp !== before || !screenDecision({ ...context, secureInput: false }).capture) return null;
    return frame;
  }

  /** Gives both channels the current settings and state, and starts or stops the screen channel to match. */
  private refreshCapture(): void {
    this.learnLockState();
    const config = this.agent.configuration;
    // Typed text starts or stops with its setting, and an open piece is dropped as soon as the policy refuses.
    this.keystrokes.setEnabled(config.keystrokeCaptureEnabled);
    this.keystrokes.refresh();
    // Microphone text needs the speech model. Without it, audio is not kept or transcribed.
    this.audio.setContext({ enabled: config.audioCaptureEnabled && this.speechInstalled(), ...this.captureFlags() });
    this.systemAudio.setContext({ enabled: config.systemAudioCaptureEnabled && this.speechInstalled(), ...this.captureFlags() });
    if (config.screenCaptureEnabled) {
      this.screen.setContext(this.screenContext());
      this.screen.start();
    } else {
      void this.screen.stop();
    }
  }

  /** Starts the microphone and the screen timers. Each channel still does nothing until its own setting is on. */
  private startCapture(): void {
    clearInterval(this.captureTimer);
    this.audio.start();
    this.systemAudio.start();
    this.captureTimer = setInterval(() => this.refreshCapture(), CAPTURE_SYNC_MS);
    this.captureTimer.unref?.();
    this.refreshCapture();
  }

  /** Stops both channels. The promise resolves once any screen read in progress has ended. */
  private stopCapture(): Promise<void> {
    clearInterval(this.captureTimer);
    this.captureTimer = undefined;
    this.audio.stop();
    this.systemAudio.stop();
    this.speakerEmbedder.stop();
    return this.screen.stop();
  }

  private async writeFrame(mediaId: string, jpeg: Buffer): Promise<void> {
    await this.media.write(mediaId, jpeg);
    this.noteFrameKept();
    this.sweepSoon();
  }

  private noteFrameKept(): void {
    const now = Date.now();
    if (now - this.mediaSizedAt < MEDIA_SIZE_REFRESH_MS) return;
    this.mediaSizedAt = now;
    void this.refreshMediaBytes();
  }

  private keepScreenRead(read: ScreenRead): boolean {
    const stored = this.agent.ingestScreen(read);
    if (stored) this.counts.screen += 1;
    return stored;
  }

  private keepAudioSegment(segment: AudioRead): boolean {
    const stored = this.agent.ingestAudio(segment);
    if (stored) this.counts.audio += 1;
    return stored;
  }

  private refreshCaptureCounts(): void {
    const summary = this.agent.captureSummary();
    this.counts = { screen: summary.screenCount, audio: summary.audioCount, keystroke: summary.keystrokeCount };
  }

  private async refreshMediaBytes(): Promise<void> {
    this.mediaBytes = await this.media.sizeBytes().catch(() => this.mediaBytes);
  }

  private readFrame(id: string): Promise<Buffer | null> {
    return this.media.read(id).catch(() => null);
  }

  /**
   * Removes text and images past their retention, and keeps the image folder under its cap. Safe while capture is
   * running: it never deletes an image that a stored item does not yet name. Runs after kept frames, when retention
   * changes, and once a day.
   */
  private async sweepMedia(): Promise<void> {
    try {
      const { mediaIds } = this.agent.pruneWithMedia();
      await this.removeImages([...this.unremovedImages, ...mediaIds]);
      await this.enforceMediaCap();
      this.refreshCaptureCounts();
    } catch {
      // The error is dropped. A path under the media folder or a stored id should not reach a log.
    }
  }

  /**
   * At start, before capture runs: a sweep, then removal of image files that no stored item names. The second step is
   * not safe while capture is running, because an image is written before its text is stored.
   */
  private async housekeeping(): Promise<void> {
    await this.sweepMedia();
    try {
      await this.media.reconcile(new Set(this.agent.liveMediaIds()));
    } catch {
      // The error is dropped, as in the sweep.
    }
  }

  /** Runs a sweep after a kept frame, at most once a minute, so the cap is held while images are being written. */
  private sweepSoon(): void {
    const now = Date.now();
    if (now - this.lastSweepAt < SWEEP_MIN_INTERVAL_MS) return;
    this.lastSweepAt = now;
    void this.sweepMedia();
  }

  /**
   * Deletes images one at a time. A file that cannot be removed, such as one another program holds open, stays in
   * unremovedImages, so the agent forgetting its reference does not leave the file behind. Never throws.
   */
  private async removeImages(mediaIds: string[]): Promise<void> {
    await Promise.all(
      mediaIds.map(async mediaId => {
        try {
          await this.media.remove([mediaId]);
          this.unremovedImages.delete(mediaId);
        } catch {
          this.unremovedImages.add(mediaId);
        }
      }),
    );
  }

  /** Removes the oldest images while the folder is over its cap. Their text stays. */
  private async enforceMediaCap(): Promise<void> {
    let bytes = await this.media.sizeBytes();
    while (bytes > MEDIA_CAP_BYTES) {
      const mediaIds = this.agent.evictScreenMedia(MEDIA_CAP_BATCH);
      if (mediaIds.length === 0) break;
      await this.media.remove(mediaIds);
      bytes = await this.media.sizeBytes();
    }
    this.mediaBytes = bytes;
  }

  /** Starts or stops the local API, after the changes queued before it. */
  private setLocalApi(enabled: boolean): Promise<void> {
    return this.queueApi(() => (enabled ? this.enableLocalApi() : this.disableLocalApi()));
  }

  /** Starts the local API on the loopback address. A failure is shown in the status, and it never throws. */
  private async enableLocalApi(): Promise<void> {
    if (this.localApi) return;
    try {
      const api = createLocalApi({
        host: LOCAL_API_HOST,
        port: LOCAL_API_PORT,
        token: () => this.apiToken ?? '',
        // Stored screen and microphone text and images are served only while screen reading is on, as the docs say. Typed text
        // and imported connector text are kept to the Recall page, so they are never served here.
        search: request => (this.agent.configuration.screenCaptureEnabled ? withheldFromLocalApi(this.agent.searchCapture(request)) : []),
        frameImage: id => (this.agent.configuration.screenCaptureEnabled ? this.readFrame(id) : Promise.resolve(null)),
        status: () => this.captureChannels(),
      });
      await this.apiTokenValue();
      await api.start();
      this.localApi = api;
      this.apiState = 'listening';
    } catch {
      this.apiState = 'failed';
    }
  }

  private async disableLocalApi(): Promise<void> {
    const api = this.localApi;
    this.localApi = undefined;
    this.apiState = 'off';
    await api?.stop();
  }

  /** Runs a change once the ones queued before it have finished. A failed change does not block the next one. */
  private queueApi<T>(task: () => Promise<T>): Promise<T> {
    const run = this.apiChanges.then(task);
    this.apiChanges = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** The bearer token, loaded or created on first use. Call it only through queueApi. */
  private async apiTokenValue(): Promise<string> {
    this.apiToken ??= await loadOrCreateApiToken(this.options.userData);
    return this.apiToken;
  }

  /**
   * A visit from the browser extension. It goes through the engine's normal ingest, so the browser setting and the
   * private-window rule apply. It does not trigger a routine offer, which is for app focus alone. The capture poll is
   * told too, so it leaves that browser's change to the bridge.
   */
  private observeBrowserVisit(visit: BrowserVisit): void {
    this.capture.noteBridgeVisit(visit.browser);
    this.agent.ingest({ kind: 'focus', ts: Date.now(), app: BROWSER_APP_NAMES[visit.browser], url: `https://${visit.template}` });
  }

  /**
   * Browser capture changes run one at a time. Otherwise a quick off after an on could run before the bridge
   * exists, and the bridge would then start while the setting is off.
   */
  private setBrowserCapture(enabled: boolean): Promise<void> {
    const change = this.browserChanges.then(() => (enabled ? this.enableBrowserCapture() : this.disableBrowserCapture()));
    this.browserChanges = change.catch(() => undefined);
    return change;
  }

  /** Starts the bridge, then writes the native host. Unsupported systems keep the setting but start nothing. */
  private async enableBrowserCapture(): Promise<void> {
    if (!isBrowserCaptureSupported() || this.browserBridge) return;
    const hostScript = this.options.browserHostScript;
    if (!hostScript) throw new Error('The browser host is missing from this build.');

    const paths = browserCapturePaths(this.options.userData);
    this.browserBridge = await startBrowserBridge({
      socketPath: paths.socketPath,
      tokenPath: paths.tokenPath,
      onVisit: visit => this.observeBrowserVisit(visit),
    });
    try {
      installNativeHost({ userData: this.options.userData, home: homedir(), runtime: process.execPath, hostScript });
    } catch (error) {
      this.disableBrowserCapture();
      throw error;
    }
  }

  private disableBrowserCapture(): void {
    this.browserBridge?.stop();
    this.browserBridge = undefined;
    if (isBrowserCaptureSupported()) removeNativeHost({ userData: this.options.userData, home: homedir() });
  }

  /** Looks for unlabelled routines once a minute. A look does nothing unless the bundle is installed. */
  private startKindLabels(): void {
    this.kindLabelTimer = setInterval(() => void this.labelKinds(), KIND_PASS_MS);
    this.kindLabelTimer.unref?.();
  }

  private stopKindLabels(): void {
    clearInterval(this.kindLabelTimer);
    clearTimeout(this.kindReleaseTimer);
    this.kindLabelTimer = undefined;
    this.kindReleaseTimer = undefined;
  }

  private async labelKinds(): Promise<void> {
    if (Date.now() < this.kindQuietUntil) return;
    const stored = await this.kindLabels.pass();
    if (stored === 0) {
      this.kindQuietUntil = Date.now() + KIND_QUIET_MS;
      return;
    }
    // The model stays loaded for a few idle minutes after work, then is freed, so an idle app holds no model.
    this.scheduleKindRelease(LAYA_IDLE_RELEASE_MS);
  }

  private scheduleKindRelease(delayMs: number): void {
    clearTimeout(this.kindReleaseTimer);
    this.kindReleaseTimer = setTimeout(() => {
      // A pass still asking the model must finish first, because closing the session under it could crash it.
      if (this.kindLabels.busy) return this.scheduleKindRelease(KIND_RELEASE_RETRY_MS);
      void this.laya.release();
    }, delayMs);
    this.kindReleaseTimer.unref?.();
  }

  private suggestionViews(): SuggestionView[] {
    return this.agent.suggestions().map(({ routine, preview }) => {
      const drafted: DraftStep[] = preview.steps.map(step => {
        const param = preview.params.find(candidate => `$${candidate.name}` === step.app);
        const app = resolveStep(step, preview.params, {}).app;
        return {
          kind: step.op === 'check_focus' ? 'check' : 'act',
          app,
          alternatives: param ? param.options.length - 1 : 0,
          effect: effectOfOp(step.op, app),
        };
      });
      return {
        routineId: routine.id,
        name: preview.name,
        support: routine.support,
        days: routine.days,
        score: routine.score,
        minutesPerWeek: preview.estimate?.minutesPerWeek ?? 0,
        lastSeenAt: routine.lastSeenAt,
        when: describeWhen(routine.when),
        kind: this.agent.kindOfRoutine(routine),
        drafted,
        effects: effectsOf(preview),
        parameters: preview.params.map(param => ({ name: param.name, options: [...param.options] })),
      };
    });
  }
}

/** The same rule capture.ts uses for focus. The twin's own windows are never read back. */
function isOwnApp(app: string): boolean {
  const name = app.toLowerCase();
  return name.includes('companyos') || name === 'electron';
}

/** A browser is never read. Any other app takes its class from the catalogue. An app that cannot be named is 'other'. */
function windowClassOf(app: string | undefined): WindowClass {
  if (app === undefined) return 'other';
  return isBrowserApp(app) ? 'browser' : classifyApp(app);
}

/**
 * Whether macOS lets this app read the screen. Other systems never read it, since secure input cannot be checked there
 * (see secureInputState), so they report granted here and are stopped by the secure input check.
 */
function screenPermissionGranted(): boolean {
  if (process.platform !== 'darwin') return true;
  return systemPreferences.getMediaAccessStatus('screen') === 'granted';
}

/**
 * Asks macOS for screen recording access. Electron has no call for it, so a screen source is requested instead, which
 * makes macOS show its prompt while the access is undecided. The thumbnail is thrown away.
 */
async function requestScreenAccess(): Promise<void> {
  if (process.platform !== 'darwin') return;
  await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => []);
}
