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
  planRuns,
  chooseChatModel,
  routineApps,
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
  type StepApproval,
  type DraftStep,
  type Executor,
  type HardwareProfile,
  type KeystrokeState,
  type LocalModelClient,
  type PlanCandidate,
  type PlanRunView,
  type SwarmRunView,
  type LiveRunView,
  stepSummary,
  type PlanView,
  type RunPlan,
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
  type Identity,
} from '@companyos/twin-core';
import { SPEAKER_MIN_SAMPLES, SPEAKER_MODEL_ID, WHISPER_MODEL_ID } from '@companyos/twin-core';
import { discoverFromScreen, proposeTasks, recapBlocks, writeRecap, type DayRecap, type ProposedTask, type ScreenDiscovery } from '@companyos/twin-core';
import { answerFromItems, closestItems, discordLine, selfCheck, type DiscordStatusView, type MemoryAnswer, type MemoryItem } from '@companyos/twin-core';
import { DiscordReader } from './discord-reader';
import { FileSearchIndex, parseQuery, type FileHitView, type FileSearchView } from '@companyos/twin-core';
import { accountIdentity, indexFiles, QueryVectors, type FileIndexProgress } from './file-index';
import { readSurface } from './app-surface';
import { createOllamaChat, createOllamaEmbedder, createOllamaVision, visionModelReady } from './vision-ollama';
import type { OperatorModel, OperatorTaskRequest } from '@companyos/twin-core';
import { OperatorService, type OperatorModelChoice } from './operator-service';
import { agentDesktopHands } from './operator-hands';
import { createChutesChat, validChutesKey } from './remote-model';
import { app, clipboard, desktopCapturer, nativeImage, shell, systemPreferences } from 'electron';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLOUD_TOKEN_FOLDER, createCloudTokenStore } from './connectors-cloud/seal';
import { BROWSER_APP_NAMES, startBrowserBridge, type BrowserBridge, type BrowserVisit } from './browser-bridge';
import { CaptureService } from './capture';
import { createKeyboardSource } from './keyboard';
import { KeystrokeService } from './keystroke-service';
import { AudioCaptureService, WhisperTranscriber, microphoneGranted, type SpeakerIdentifier } from './audio-capture';
import { SpeakerEmbedder } from './speaker-embedder';
import {
  clearChutesKey as removeChutesKey,
  destroyStoredSecrets,
  hasChutesKey,
  loadChutesKey,
  loadOrCreateApiToken,
  loadOrCreateDataKey,
  rotateApiToken as replaceApiToken,
  saveChutesKey,
} from './keys';
import { spawnNativeOcr } from './native-ocr';
import { LOCAL_API_HOST, LOCAL_API_PORT, createLocalApi, withheldFromLocalApi, type LocalApi } from './local-api';
import { MediaStore } from './media-store';
import { readAccessibleText } from './accessibility';
import { electronFrameSource, ScreenCaptureService, type Frame, type ScreenContext } from './screen-capture';
import { secureInputState } from './secure-input';
import { detectHardware } from './hardware';
import { LayaBundleManager, type LayaTestOptions } from './laya';
import { LayaDecisionModel } from './decision-laya';
import { ModelManager, SharedModelClients, createRoutineNamer } from './models';
import { InputLock } from './input-lock';
import { browserCapturePaths, installNativeHost, isBrowserCaptureSupported, removeNativeHost } from './native-host-install';
import { AgentDesktopSession, CURSOR_COLOURS, cursorFor, cursorLabel, handsExecutor, type HandsCursor } from './agent-desktop';
import { gatherDuplicates } from './file-actions';
import { choosePlatform, executorFor, type Platform } from './platform';
import { PipeScheduler, removeLegacyPipeFiles } from './pipes';
import { LocalConnectorService } from './connectors-scheduler';
import { CloudConnectorService } from './connectors-cloud-service';
import { clientIdsFor } from './connectors-cloud/client-ids';
import { CLOUD_PROVIDER_IDS, type CloudProviderId } from './connectors-cloud/providers';
import type { LocalConnectorKind } from './connectors-validate';

interface RuntimeOptions {
  userData: string;
  /** Asks a person to approve one step. The main process shows a native dialog. */
  approve: (automation: Automation, step: Step, decision: Decision) => Promise<StepApproval>;
  /**
   * Asks the person once whether to start a plan's runs, naming each automation. The main process shows a native dialog.
   * Saying yes starts the runs; each one still asks before any step that acts on an app.
   */
  confirmPlan: (names: string[]) => Promise<boolean>;
  /**
   * Asks the person once whether to start a swarm, naming each automation: run them allowing all their steps, run them and
   * ask for each run, or not now. The main process shows a native dialog.
   */
  confirmSwarm?: (names: string[]) => Promise<'all' | 'each' | false>;
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
/** How long a finished run stays in the live view. */
const LIVE_KEEP_MS = 2 * 60_000;
/** The most automations one swarm starts together. Each draws its own cursor, and they share the input step by step. */
const SWARM_MAX = 9;
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
/** Why an on-demand job search stopped before the model ran. */
type FindJobsRefusal = 'no_surface' | 'not_in_front' | 'not_allowed' | 'model_offline' | 'model_missing' | 'no_frame';

/** The longest an on-demand screen grab may take before it counts as no frame. */
const FIND_JOBS_GRAB_MS = 10_000;
/** How far back the screen text that tasks are proposed from goes. */
const UNDERSTAND_WINDOW_MS = 24 * 3_600_000;
/** Discord messages are stored under their own app name, apart from whole-screen reads of the Discord window. */
const DISCORD_MESSAGES_APP = 'Discord messages';
/** The conversation at the start of a stored Discord line: "@Kala · Kala (2026-11-02 18:23): ...". */
const DISCORD_CONVERSATION = /^(.*) · [^·]+? \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\): /;
const DISCORD_CHECK_MIN_MESSAGES = 20;
const DISCORD_CHECK_NEW_MESSAGES = 30;
const DISCORD_CHECK_EVERY_MS = 3_600_000;
const DISCORD_CHECK_QUESTIONS = 8;
const FILE_INDEX_FIRST_MS = 60_000;
const FILE_INDEX_EVERY_MS = 6 * 3_600_000;
const FILE_RESULTS = 12;
/** The longest a search waits for its query embedding before ranking without meaning. */
const QUERY_EMBED_TIMEOUT_MS = 400;
/** Files that would run when opened: apps, scripts, installers and shortcuts. */
const RUNNABLE = /\.(app|command|sh|bash|zsh|tool|terminal|workflow|scpt|applescript|pkg|mpkg|dmg|jar|py|rb|pl|js|exe|bat|cmd|ps1|webloc|inetloc|url|fileloc)$/i;
const PREVIEW_CACHE = 300;

export class TwinRuntime {
  private readonly agent: TwinAgent;
  private readonly capture: CaptureService;
  /** Typed text, off until the person turns it on. See keystroke-service.ts. */
  private readonly keystrokes: KeystrokeService;
  private readonly platform: Platform | undefined;
  private readonly models: ModelManager;
  /** The task operator behind the Tasks page. One task runs at a time. */
  private readonly operator: OperatorService;
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
  /** Runs happening now and those that ended lately, by run id, for the live view. */
  private readonly live = new Map<string, LiveRunView>();
  private runCount = 0;
  private swarmCount = 0;
  /**
   * True from the start of a plan until its runs start or it is declined. No offers are made meanwhile, so an offer cannot
   * start a run beside the plan the person is being asked about.
   */
  private planning = false;
  /** The one agent-desktop session the menu clicks share, so each automation keeps its own named cursor across runs. */
  private readonly handsSession = new AgentDesktopSession(() => ({ binary: this.agent.configuration.agentDesktopPath.trim() }));
  /**
   * Sole use of the desktop's input for one step at a time, so runs that overlap take turns for focus changes, key presses
   * and menu clicks. Each turn is logged with the run's cursor id and how long it waited and held the input.
   */
  private readonly inputLock = new InputLock(entry =>
    console.info(`[input] agent=${entry.owner} waited=${entry.waitedMs}ms held=${entry.heldMs}ms`),
  );
  /** The local model's clients, shared by naming and planning, so both use one worker and one copy of the model. */
  private readonly modelClients: SharedModelClients;
  /** Model files the planner has checked against the catalogue's hash, so each one is hashed once. */
  private readonly plannerVerified = new Set<string>();
  /** The latest plan, for the status. Kept in memory only. */
  private lastPlan: PlanView | undefined;
  /** Screen and microphone capture. Each starts only while its setting is on. */
  private readonly screen: ScreenCaptureService;
  /** Reads the Discord app's messages while it is open, when the person has turned that on. */
  private readonly discord: DiscordReader;
  /** Embeddings of stored Discord messages by item id, kept in memory so a question embeds only new ones. */
  private readonly discordVectors = new Map<string, number[]>();
  private discordCheck: DiscordStatusView['check'];
  private discordChecking: Promise<void> | undefined;
  /** Stored Discord messages, counted after each read rather than on every status poll. */
  private discordCounts = { messages: 0, conversations: 0 };
  /** The file search index in memory, with its knowledge graph, rebuilt after each pass. */
  private files: FileSearchIndex | undefined;
  /** Who uses this computer, read from the account once, for questions that say "my". */
  private identity: Identity | undefined;
  /** Query embeddings by their words, so a repeated query does not wait for the model. */
  private readonly queryVectors = new QueryVectors(createOllamaEmbedder({ record: entry => this.agent.recordNetworkCall(entry) }));
  /** Result previews by path, newest last. */
  private readonly previews = new Map<string, string>();
  private fileProgress: FileIndexProgress = { running: false, files: 0, images: 0, documents: 0, done: 0, total: 0 };
  private fileIndexing: Promise<void> | undefined;
  private fileTimer: ReturnType<typeof setTimeout> | undefined;
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
  /** Recaps being written, by day, so a second request for the same day waits for the first. */
  private readonly recapsRunning = new Map<string, Promise<DayRecap>>();
  /** API and token changes run one at a time, as browser capture changes do. */
  private apiChanges: Promise<void> = Promise.resolve();
  /** Runs the saved pipes on their schedules. It starts and stops with the runtime. Its last-run times stay in memory. */
  private readonly pipeScheduler: PipeScheduler;
  /** Reads the local sources (folder, Git, calendar, mail) every six hours, and on request. See connectors-scheduler.ts. */
  private readonly connectors: LocalConnectorService;
  private readonly cloud: CloudConnectorService;

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
    this.discord = new DiscordReader({
      binary: () => this.agent.configuration.agentDesktopPath,
      // Screen text must be on and allowed, and capture must not be paused or locked. Being idle does not stop it: the window
      // shows the same messages whether the person is at the desk or not, and the reader only reads what is shown.
      allowed: () => {
        const config = this.agent.configuration;
        const { locked, paused } = this.captureFlags();
        const screen = this.screenState();
        return config.discordReadingEnabled && (screen === 'on' || screen === 'paused') && !locked && !paused && !isExcludedApp('discord', config.excludedApps);
      },
      store: message => this.agent.ingestScreen({ ts: message.ts, app: DISCORD_MESSAGES_APP, windowClass: 'chat', text: discordLine(message), mediaId: null }),
      seenFile: join(options.userData, 'discord-seen.json'),
      onRead: stored => this.afterDiscordRead(stored),
    });
    this.screen = new ScreenCaptureService({
      source: { grab: () => this.grabFrame() },
      // Apple Vision, through the helper shipped in the app's resources. A development run uses the copy the build made.
      ocr: spawnNativeOcr(app.isPackaged ? join(process.resourcesPath, 'companyos-ocr') : join(app.getAppPath(), 'native-bin', 'companyos-ocr')),
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
    this.operator = new OperatorService({
      config: () => this.agent.configuration,
      // Each task's steps are drawn on screen by its own named cursor, in the session automations and swarms share.
      hands: (binary, goal) => agentDesktopHands(binary, undefined, { session: this.handsSession, cursor: cursorFor('operator-task', cursorLabel('companyOS', goal)) }),
      model: (choice, modelOptions) => this.operatorModel(choice, modelOptions.sharesScreenText),
      memory: goal => this.memoryNotes(goal),
      hasChutesKey: () => hasChutesKey(options.userData),
      // The twin never operates its own window: its pages show captured text and the approvals themselves.
      ownApps: ['companyOS Twin', 'companyOS', 'Electron'],
      onChange: () => options.onChange(),
    });
    // Inside the models folder, so wiping that folder removes the bundle with it.
    this.laya = new LayaBundleManager({
      rootDir: join(options.userData, 'models', 'laya'),
      record: entry => this.agent.recordNetworkCall(entry),
      onChange: options.onChange,
      fetchImpl: options.fetchImpl,
      ...options.laya,
    });
    this.modelClients = new SharedModelClients({ models: this.models, workerPath: join(__dirname, 'llm-worker.js') });
    this.namer = createRoutineNamer({
      agent: this.agent,
      models: this.models,
      clients: this.modelClients,
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
    // Cloud accounts, read-only, on the same schedule and behind the same gates as the local sources. Their tokens are
    // sealed with the OS keychain, which is checked only when a token is saved or read.
    this.cloud = new CloudConnectorService({
      agent: this.agent,
      tokens: createCloudTokenStore(options.userData),
      now: () => Date.now(),
      gate: () => this.capture.holds(),
      clientIds: clientIdsFor({ packaged: app.isPackaged, env: process.env }),
      fetch,
      openExternal: url => shell.openExternal(url),
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
    this.cloud.start();
    this.countDiscord();
    this.discord.start();
    this.loadFileIndex();
    // The first pass waits a minute, so it does not compete with the app starting; then it runs every six hours.
    this.fileTimer = setTimeout(() => this.scheduleFiles(), FILE_INDEX_FIRST_MS);
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
    this.cloud.stop();
    this.discord.stop();
    clearTimeout(this.fileTimer);
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
      cloudAccounts: this.cloud.accounts(),
      files: { enabled: this.agent.configuration.fileSearchEnabled, ...this.fileProgress },
      discord: {
        enabled: this.agent.configuration.discordReadingEnabled,
        messages: this.discordCounts.messages,
        conversations: this.discordCounts.conversations,
        lastReadAt: this.discord.state.lastReadAt,
        problem: this.discord.state.problem,
        checking: this.discordChecking !== undefined,
        check: this.discordCheck,
      },
      pipeOutputs: this.pipeOutputSummaries(config.pipes),
      assignedTasks: this.agent.assignedTasks(),
      taskRuns: this.agent.taskRuns(),
      ...(this.lastPlan ? { lastPlan: this.lastPlan } : {}),
      activeRuns: this.activeRuns,
      liveRuns: this.liveRuns(),
      operator: this.operator.view(),
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
    // Turning file search off deletes the index, its previews and its remembered queries, so nothing of it is kept.
    if (changed.fileSearchEnabled === false) this.clearFileIndex();
    return saved;
  }

  /** Adds a local source the person picked in the system dialog, and imports it once. Resolves to the items stored. */
  addConnector(kind: LocalConnectorKind, path: string): Promise<number> {
    return this.connectors.addSource(kind, path);
  }

  /** Removes a source and its items. The files it read are not changed. */
  /** Connects a cloud account through the person's sign-in in the browser. Resolves to the items the first read stored. */
  connectCloud(provider: unknown): Promise<number> {
    return this.cloud.connect(cloudProvider(provider));
  }

  /** Disconnects a cloud account: its sealed tokens and its items are deleted. */
  disconnectCloud(provider: unknown): Promise<void> {
    return this.cloud.disconnect(cloudProvider(provider));
  }

  removeConnector(id: string): Promise<void> {
    return this.connectors.removeSource(id);
  }

  /** Reads a source again now. The capture gates do not apply, because the person asked for this read. */
  importConnector(id: string): Promise<number> {
    return this.connectors.importNow(id);
  }

  stopAllAutomations(): void {
    // The task stops first, so a failed settings write cannot leave it running.
    this.operator.stop();
    this.agent.updateConfig({ automationsEnabled: false });
  }

  /**
   * Proposes tasks from the last day's screen text, on this Mac: a small embedding model groups the reads by meaning, and
   * the local text model names the work and one next step for each group. Nothing runs here. Excluded apps are left out by the search and again by
   * the proposer.
   */
  async proposeTasks(): Promise<ProposedTask[]> {
    const to = Date.now();
    const hits = this.agent.searchCapture({ text: '', kind: 'screen', from: to - UNDERSTAND_WINDOW_MS, to });
    const record = (entry: NetworkEntry): void => this.agent.recordNetworkCall(entry);
    return proposeTasks(hits, {
      embedder: createOllamaEmbedder({ record }),
      // Screen text is text, and the 4B planner understood it far better than the 2B vision model on the same documents.
      // Using one model for both stages also keeps a single model in memory.
      model: createOllamaChat({ record }),
      excludedApps: this.agent.configuration.excludedApps,
    });
  }

  private loadFileIndex(): void {
    const records = this.agent.fileIndex();
    this.identity ??= accountIdentity();
    this.files = new FileSearchIndex(records, this.identity);
    // The previews of files that changed may be stale, so they are made again.
    this.previews.clear();
    // The embedding model is loaded now, so the first search does not wait for it.
    if (this.agent.configuration.fileSearchEnabled && records.length > 0) void this.queryVectors.get('warm up', 0);
    this.fileProgress = {
      ...this.fileProgress,
      files: records.length,
      images: records.filter(record => record.kind === 'image').length,
      documents: records.filter(record => record.kind === 'document').length,
    };
  }

  private clearFileIndex(): void {
    this.agent.saveFileIndex([]);
    this.files = undefined;
    this.previews.clear();
    this.queryVectors.clear();
    this.fileProgress = { running: false, files: 0, images: 0, documents: 0, done: 0, total: 0 };
    this.options.onChange();
  }

  /** Refuses file search while it is off, so the search bar and its previews show nothing. */
  private requireFileSearch(): FileSearchIndex {
    if (!this.agent.configuration.fileSearchEnabled) throw new Error('File search is off. Turn it on in Connectors.');
    return this.files ?? new FileSearchIndex([]);
  }

  private scheduleFiles(): void {
    void this.indexFilesNow().catch(() => undefined);
    this.fileTimer = setTimeout(() => this.scheduleFiles(), FILE_INDEX_EVERY_MS);
  }

  /** One pass of the file index, when file search is on and capture is not paused. One pass runs at a time. */
  indexFilesNow(): Promise<void> {
    if (this.fileIndexing) return this.fileIndexing;
    if (!this.agent.configuration.fileSearchEnabled || this.agent.configuration.capturePaused) return Promise.resolve();
    const record = (entry: NetworkEntry): void => this.agent.recordNetworkCall(entry);
    const job = indexFiles({
      helper: app.isPackaged ? join(process.resourcesPath, 'companyos-ocr') : join(app.getAppPath(), 'native-bin', 'companyos-ocr'),
      embedder: createOllamaEmbedder({ record }),
      previous: () => [...(this.files?.records ?? this.agent.fileIndex())],
      // A pass that finishes after file search was turned off, or after a pause, keeps nothing.
      save: records => {
        if (this.agent.configuration.fileSearchEnabled && !this.agent.configuration.capturePaused) this.agent.saveFileIndex(records);
      },
      onProgress: progress => {
        this.fileProgress = progress;
        this.options.onChange();
      },
    })
      .then(done => {
        if (!this.agent.configuration.fileSearchEnabled) return;
        this.fileProgress = done;
        this.loadFileIndex();
      })
      .finally(() => {
        this.fileIndexing = undefined;
        this.options.onChange();
      });
    this.fileIndexing = job;
    return job;
  }

  /**
   * Searches the file index with a question in plain words, in milliseconds: the words are read by rules, the query is
   * embedded by the small model (kept loaded, and remembered for repeated queries), and the prebuilt index ranks every file
   * in one pass. Previews are not made here: the search bar asks for them after the results show.
   */
  async searchFiles(query: string): Promise<FileSearchView> {
    const started = performance.now();
    const text = query.trim();
    if (text.length < 2 || text.length > 300) throw new Error('Search with 2 to 300 characters.');
    const index = this.requireFileSearch();
    const plan = parseQuery(text);
    const vector = await this.queryVectors.get(plan.about, QUERY_EMBED_TIMEOUT_MS);
    const hits: FileHitView[] = index.search(plan, vector, FILE_RESULTS).map(hit => ({
      path: hit.record.path,
      name: hit.record.name,
      folder: hit.record.folder,
      kind: hit.record.kind,
      mtime: hit.record.mtime,
      why: hit.why,
    }));
    return {
      plan: { kind: plan.kind, about: plan.about, names: plan.names, shape: plan.shape, ...(plan.mine ? { mine: true, ...(index.me ? { me: index.me } : {}) } : {}) },
      hits,
      indexed: index.records.length,
      ms: Math.round(performance.now() - started),
      meaning: vector !== undefined,
    };
  }

  /** Small previews for search results, from the system's own thumbnailer, made after the results show and remembered. */
  async filePreviews(paths: unknown): Promise<Record<string, string>> {
    if (!Array.isArray(paths)) throw new Error('Invalid previews request.');
    const index = this.requireFileSearch();
    const previews: Record<string, string> = {};
    await Promise.all(
      paths.slice(0, FILE_RESULTS).map(async path => {
        // A file only in iCloud is not previewed: making its thumbnail would download it.
        if (typeof path !== 'string' || !index.has(path) || index.get(path)?.cloudOnly) return;
        const preview = this.previews.get(path) ?? (await this.previewOf(path));
        if (!preview) return;
        this.previews.set(path, preview);
        if (this.previews.size > PREVIEW_CACHE) this.previews.delete(this.previews.keys().next().value as string);
        previews[path] = preview;
      }),
    );
    return previews;
  }

  /** A small preview from the system's own thumbnailer (photos, PDFs and documents), or undefined when it has none. */
  private async previewOf(path: string): Promise<string | undefined> {
    try {
      const image = await nativeImage.createThumbnailFromPath(path, { width: 160, height: 160 });
      return image.isEmpty() ? undefined : image.toDataURL();
    } catch {
      return undefined;
    }
  }

  /** Opens a search result, or shows it in Finder. Only a file that is in the index can be opened. */
  openIndexedFile(path: unknown, reveal: boolean): void {
    const index = this.requireFileSearch();
    if (typeof path !== 'string' || !index.has(path)) throw new Error('That file is not in the search index.');
    // A program or script is shown in Finder, never run: opening it from the search bar would execute it.
    if (reveal || RUNNABLE.test(path)) shell.showItemInFolder(path);
    else void shell.openPath(path);
  }

  /** The stored Discord messages, newest first, as items to search and answer from. */
  private discordItems(): MemoryItem[] {
    return this.agent.captureTexts(DISCORD_MESSAGES_APP);
  }

  private countDiscord(): void {
    const items = this.discordItems();
    const conversations = new Set(items.map(item => DISCORD_CONVERSATION.exec(item.text)?.[1]).filter(Boolean));
    this.discordCounts = { messages: items.length, conversations: conversations.size };
  }

  /**
   * After each read: the counts are refreshed, and the self-check runs on its own once there is enough to check, again when
   * enough new messages have arrived, and at most once an hour, so the model is not kept busy while the person works.
   */
  private afterDiscordRead(stored: number): void {
    if (stored > 0) this.countDiscord();
    const last = this.discordCheck;
    const enough = this.discordCounts.messages >= DISCORD_CHECK_MIN_MESSAGES;
    const due = !last || (this.discordCounts.messages - last.messages >= DISCORD_CHECK_NEW_MESSAGES && Date.now() - last.at >= DISCORD_CHECK_EVERY_MS);
    if (enough && due && !this.discordChecking) void this.checkDiscord().catch(() => undefined);
    if (stored > 0) this.options.onChange();
  }

  /** Answers a question about the person's Discord from the messages read so far, with the local models on this Mac. */
  async askDiscord(question: string): Promise<MemoryAnswer> {
    const text = question.trim();
    if (text.length < 3 || text.length > 500) throw new Error('Ask in 3 to 500 characters.');
    const record = (entry: NetworkEntry): void => this.agent.recordNetworkCall(entry);
    const shown = await closestItems(text, this.discordItems(), createOllamaEmbedder({ record }), this.discordVectors);
    return answerFromItems(text, shown, createOllamaChat({ record }));
  }

  /**
   * The self-check: questions written from real Discord messages, answered by the same path a person's question takes, and
   * graded. The result says how far the answers can be trusted. It is kept in memory only.
   */
  checkDiscord(): Promise<void> {
    if (this.discordChecking) return this.discordChecking;
    const record = (entry: NetworkEntry): void => this.agent.recordNetworkCall(entry);
    const items = this.discordItems();
    const job = selfCheck(items, { model: createOllamaChat({ record }), answer: question => this.askDiscord(question), count: DISCORD_CHECK_QUESTIONS })
      .then(result => {
        this.discordCheck = { ...result, messages: items.length, at: Date.now() };
      })
      .finally(() => {
        this.discordChecking = undefined;
        this.options.onChange();
      });
    this.discordChecking = job;
    this.options.onChange();
    return job;
  }

  /**
   * The recap of one local day, today by default, written by the local model. Recall search returns the newest items
   * first and at most a few hundred, so screen text and speech are read block by block, which spreads the samples over the
   * day instead of its last few minutes. One recap per day is written at a time; asking again while it runs gets the same
   * answer. Typed text and imported connector text are not used.
   */
  dayRecap(day?: string): Promise<DayRecap> {
    if (day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return Promise.reject(new Error('A day is written as YYYY-MM-DD.'));
    const view = this.agent.dayTasks(day);
    const running = this.recapsRunning.get(view.day);
    if (running) return running;
    const hits: CaptureHitView[] = [];
    for (const block of recapBlocks(view)) {
      for (const kind of ['screen', 'audio'] as const) {
        try {
          hits.push(...this.agent.searchCapture({ text: '', kind, from: block.startTs, to: block.endTs }));
        } catch {
          // A channel with nothing stored for the block has nothing to add.
        }
      }
    }
    const record = (entry: NetworkEntry): void => this.agent.recordNetworkCall(entry);
    const job = writeRecap(view, hits, createOllamaChat({ record })).finally(() => this.recapsRunning.delete(view.day));
    this.recapsRunning.set(view.day, job);
    return job;
  }

  /** Starts a task from the Tasks page. The operator checks every step; this only passes the request on. */
  startTask(request: OperatorTaskRequest): Promise<void> {
    return this.operator.start(request);
  }

  stopTask(): void {
    this.operator.stop();
  }

  answerTaskStep(id: string, approve: boolean): void {
    this.operator.answer(id, approve);
  }

  /** Saves the Chutes key in the keychain. It is never sent back to a page. */
  async setChutesKey(key: string): Promise<void> {
    if (!validChutesKey(key)) throw new Error('That is not a Chutes key. A Chutes key starts with cpk_.');
    await saveChutesKey(this.options.userData, key);
    this.options.onChange();
  }

  clearChutesKey(): void {
    removeChutesKey(this.options.userData);
    this.options.onChange();
  }

  /** The model the operator uses. Chutes needs a saved key; without one there is no model, and the task does not start. */
  private async operatorModel(choice: OperatorModelChoice, sharesScreenText: boolean): Promise<OperatorModel | undefined> {
    const record = (entry: NetworkEntry): void => this.agent.recordNetworkCall(entry);
    if (choice === 'local') return createOllamaChat({ record });
    const key = await loadChutesKey(this.options.userData);
    return key && validChutesKey(key) ? createChutesChat({ apiKey: key, sharesScreenText, record }) : undefined;
  }

  /**
   * Short notes from the last week of captured screen text that share a word with the goal. The search already leaves out
   * excluded apps. The notes are information for the model, never instructions.
   */
  private memoryNotes(goal: string): string[] {
    const words = [...new Set(goal.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])].sort((a, b) => b.length - a.length).slice(0, 3);
    const to = Date.now();
    const from = to - 7 * 86_400_000;
    const seen = new Set<string>();
    const notes: string[] = [];
    for (const word of words) {
      let hits: CaptureHitView[] = [];
      try {
        // Screen text only. What the microphone heard is never sent with a task.
        hits = this.agent.searchCapture({ text: word, kind: 'screen', from, to });
      } catch {
        continue;
      }
      for (const hit of hits.slice(0, 4)) {
        if (seen.has(hit.id)) continue;
        seen.add(hit.id);
        notes.push(`${hit.app ?? 'an app'}, ${new Date(hit.ts).toLocaleString()}: ${hit.snippet}`);
        if (notes.length >= 8) return notes;
      }
    }
    return notes;
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

  createPlaybook(input: unknown): AutomationView {
    return this.agent.createPlaybook(input);
  }

  /** Confirms, renames, merges or splits one of a day's tasks. The engine checks the decision before it is stored. */
  /**
   * On demand, for the application in front: reads its controls and the screen, and asks the local vision model what jobs it
   * can do. The result is proposals only. Nothing runs, nothing is saved, and the picture stays on this Mac. It needs the
   * agent-desktop program path in Settings, the application in front, a readable screen, and the Ollama server running.
   * The picture is the whole primary display, as the screen channel captures it, so a window of another app that is visible
   * on that display can be in it. Excluded apps are checked only for the app in front.
   */
  async findJobs(app: string): Promise<ScreenDiscovery | { reason: FindJobsRefusal }> {
    const binary = this.agent.configuration.agentDesktopPath.trim();
    if (binary === '') return { reason: 'no_surface' };
    await this.refreshFrontApp();
    if (this.frontApp !== app) return { reason: 'not_in_front' };
    // The screen rules run before anything is read: the setting, a pause or lock, an excluded app, a browser, and secure input.
    const secureInput = await this.checkSecureInput();
    if (!screenDecision({ ...this.screenContext(), secureInput }).capture) return { reason: 'not_allowed' };
    let surface;
    try {
      surface = await readSurface(binary, app);
    } catch {
      return { reason: 'no_surface' };
    }
    const model = await visionModelReady({ record: entry => this.agent.recordNetworkCall(entry) });
    if (model !== 'ready') return { reason: model === 'server_down' ? 'model_offline' : 'model_missing' };
    // The grab has a time limit, and a failed grab is a missing frame, not an error.
    const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), FIND_JOBS_GRAB_MS));
    const frame = await Promise.race([this.grabFrame().catch((): null => null), timeout]);
    if (!frame) return { reason: 'no_frame' };
    const vision = createOllamaVision({ record: entry => this.agent.recordNetworkCall(entry) });
    return discoverFromScreen(vision, surface, frame.png);
  }

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
    return this.runSupervised(automationId, false);
  }

  /**
   * Starts two to nine automations together as a swarm, each under its own named cursor, after one question naming them
   * all. When the person allows all their steps, each run starts approved for itself; every step still passes the policy,
   * so a denied step stops its run. They take the desktop's input in turns, one step at a time, so actions never overlap.
   */
  async runSwarm(automationIds: string[], name?: string): Promise<SwarmRunView> {
    if (!this.agent.configuration.automationsEnabled) throw new Error('Automations are stopped. Resume them in settings first.');
    if (!this.platform) throw new Error('App control is not available on this system yet.');
    const ids = [...new Set(automationIds)];
    if (ids.length !== automationIds.length) throw new Error('Each automation can be in a swarm once.');
    if (ids.length < 2 || ids.length > SWARM_MAX) throw new Error(`A swarm runs 2 to ${SWARM_MAX} automations.`);
    if (this.planning) throw new Error('A plan is waiting for your answer. Answer it, then start the swarm.');
    const views = ids.map(id => this.agent.automations().find(view => view.automation.id === id));
    if (views.some(view => !view)) throw new Error('Unknown automation.');
    if (views.some(view => view!.state.level < 3)) throw new Error('Raise every automation in the swarm to level 3 first.');
    const label = name?.trim() || `Swarm ${++this.swarmCount}`;
    const answer = this.options.confirmSwarm ? await this.options.confirmSwarm(views.map(view => view!.automation.name)) : false;
    console.info(`[swarm] size=${ids.length} answer=${answer || 'no'}`);
    if (!answer) return { name: label, confirmed: false, allowed: 'none', runs: [] };
    const settled = await Promise.allSettled(
      ids.map((id, index) => this.runSupervised(id, answer === 'all', label, CURSOR_COLOURS[index % CURSOR_COLOURS.length])),
    );
    return {
      name: label,
      confirmed: true,
      allowed: answer,
      runs: settled.map((outcome, index) => ({
        automationId: ids[index],
        ...(outcome.status === 'fulfilled'
          ? { result: outcome.value }
          : { error: outcome.reason instanceof Error ? outcome.reason.message : 'The run could not start.' }),
      })),
    };
  }

  /** One supervised run. `allowed` is set only by a swarm the person allowed in full: the run then asks nothing more. */
  private async runSupervised(automationId: string, allowed: boolean, swarm?: string, colour?: string): Promise<RunResult> {
    return this.withRun(async () => {
      const platform = this.platform;
      if (!platform) throw new Error('App control is not available on this system yet.');
      const automation = this.agent.automations().find(view => view.automation.id === automationId)?.automation;
      if (!automation) throw new Error('Unknown automation.');
      // The run's own cursor. Its label changes at every step to say what the step does, so each cursor on screen, and
      // each row of the live view, says what it is doing.
      const cursor = cursorFor(automation.id, automation.name);
      // In a swarm each member gets its own colour, so no two of its cursors look alike on screen.
      if (colour) cursor.colour = colour;
      const owner = cursor.agentId;
      const base = cursor.label;
      const runId = `run-${++this.runCount}`;
      const entry: LiveRunView = {
        runId,
        automationId,
        name: automation.name,
        colour: cursor.colour,
        ...(swarm ? { swarm } : {}),
        step: 0,
        steps: automation.steps.length,
        doing: 'Starting',
        state: 'running',
        startedAt: Date.now(),
      };
      this.live.set(runId, entry);
      this.options.onChange();
      const finish = (state: LiveRunView['state']): void => {
        entry.state = state;
        entry.endedAt = Date.now();
        entry.doing = state === 'completed' ? 'Done' : state === 'blocked' ? 'Stopped before acting' : 'Stopped: a step failed';
        this.options.onChange();
      };
      try {
        const result = await this.logged(automation, 'supervised', () =>
          this.agent.run(
            automationId,
            {
              mode: 'supervised',
              onStep: (index, total, step) => {
                entry.step = index + 1;
                entry.steps = total;
                entry.doing = stepSummary(step);
                cursor.label = cursorLabel(base, entry.doing);
                this.options.onChange();
              },
            // The dialog takes focus, so it has its own turn of the input: it never opens while another run's step acts,
            // and no step acts while it is open. The runner asks before the step's own turn, so the two never nest.
            approve: allowed
              ? async () => 'run' as const
              : (step, decision) => this.inputLock.run(owner, () => this.options.approve(automation, step, decision)),
          },
          this.runExecutor(platform, automation, cursor),
        ),
      );
        finish(result.status === 'completed' ? 'completed' : result.status === 'blocked' ? 'blocked' : 'failed');
        return result;
      } catch (error) {
        finish('blocked');
        throw error;
      }
    });
  }

  /** The live view: runs now, then runs that ended in the last two minutes, newest first. Older ones are dropped. */
  private liveRuns(): LiveRunView[] {
    const now = Date.now();
    for (const [id, run] of this.live) if (run.endedAt !== undefined && now - run.endedAt > LIVE_KEEP_MS) this.live.delete(id);
    return [...this.live.values()]
      .map(run => ({ ...run }))
      .sort((a, b) => Number(a.state !== 'running') - Number(b.state !== 'running') || b.startedAt - a.startedAt);
  }

  /**
   * The executor for one run. An empty agent-desktop path keeps the built-in adapters, so focus and key steps work as
   * before. A path sends those two steps through the program, and an unusable path blocks them with the reason. The
   * program's exit status, the CLI's error code when it gave one, and the duration are logged. Nothing it was given, and
   * no error message, is.
   */
  private runExecutor(platform: Platform, automation?: { id: string; name: string }, runCursor?: HandsCursor): Executor {
    const cursor = runCursor ?? (automation ? cursorFor(automation.id, automation.name) : undefined);
    // Each step's action and its check take the desktop's input in turn, so overlapping runs cannot move focus under
    // each other. A step's turn starts after its approval, whose dialog had a turn of its own.
    const exclusive = <T>(work: () => Promise<T>): Promise<T> => this.inputLock.run(cursor?.agentId ?? 'run', work);
    // Gathering duplicate files works on the person's folders, not the screen, so it needs no agent-desktop program.
    const native = { ...executorFor(platform), gatherDuplicates: (folders: readonly string[], into: string) => gatherDuplicates(homedir(), folders, into) };
    const binary = this.agent.configuration.agentDesktopPath.trim();
    if (binary === '') return { ...native, exclusive };
    return {
      ...handsExecutor(native, {
        binary,
        // The automation's own cursor, named after it and coloured, so several runs can be told apart on screen.
        ...(cursor ? { cursor } : {}),
        session: this.handsSession,
        // Read through functions, so the clipboard is touched only when a step pastes or reads it.
        clipboard: { readText: () => clipboard.readText(), writeText: text => clipboard.writeText(text) },
        record: entry => {
          const code = entry.code === undefined ? '' : ` code=${entry.code}`;
          console.info(`[agent-desktop] ${entry.step} agent=${entry.agent ?? '-'} exit=${entry.exit}${code} duration=${entry.durationMs}ms`);
        },
      }),
      exclusive,
    };
  }

  /**
   * Runs one automation and writes its start and end to the log, with ids, the mode and the step outcomes only: never a
   * name, a label or an error's text. Several runs can overlap, so each line names its automation and cursor.
   */
  private async logged(automation: Automation, mode: 'supervised' | 'unattended', run: () => Promise<RunResult>): Promise<RunResult> {
    const agentId = cursorFor(automation.id, automation.name).agentId;
    const started = Date.now();
    console.info(`[run] start automation=${automation.id} agent=${agentId} mode=${mode}`);
    try {
      const result = await run();
      const outcomes = result.steps.map(step => step.outcome).join(',') || '-';
      console.info(
        `[run] end automation=${automation.id} status=${result.status} steps=${outcomes} duration=${Date.now() - started}ms`,
      );
      return result;
    } catch (error) {
      console.info(`[run] refused automation=${automation.id} duration=${Date.now() - started}ms`);
      throw error;
    }
  }

  /**
   * Plans which of the person's automations at level 3 or above to run now, asks the person once, then starts the chosen
   * runs together. The local model chooses when the chat model is installed, checks out and loads, and only among those
   * automations; otherwise the Recall ranking chooses. The person asked for the plan, so it is not held back by the
   * battery and idle rule that background model work follows. Each run keeps its own level check, approvals and named
   * cursor, and steps that act on an app take turns for the desktop's input.
   */
  async planAndRun(): Promise<PlanRunView> {
    if (!this.agent.configuration.automationsEnabled) throw new Error('Automations are stopped. Resume them in settings first.');
    if (!this.platform) throw new Error('App control is not available on this system yet.');
    const views = this.agent.automations().filter(view => view.state.level >= 3);
    if (views.length === 0) throw new Error('No automation is at level 3 or above yet. Raise one, then plan again.');
    if (this.planning) throw new Error('A plan is already waiting for your answer.');
    this.planning = true;
    let answered: { plan: PlanView; chosen: AutomationView[] };
    try {
      answered = await this.makePlan(views);
    } finally {
      this.planning = false;
    }
    const { plan, chosen } = answered;
    if (!plan.confirmed) return { plan, runs: [] };

    const settled = await Promise.allSettled(chosen.map(view => this.supervisedRun(view.automation.id)));
    return {
      plan,
      runs: settled.map((outcome, index) => ({
        automationId: chosen[index].automation.id,
        ...(outcome.status === 'fulfilled'
          ? { result: outcome.value }
          : { error: outcome.reason instanceof Error ? outcome.reason.message : 'The run could not start.' }),
      })),
    };
  }

  /** Chooses the runs and asks the person about them. The plan it made is kept as lastPlan, with the answer. */
  private async makePlan(views: AutomationView[]): Promise<{ plan: PlanView; chosen: AutomationView[] }> {
    const ranked = new Map(this.agent.assignedTasks().map(task => [task.automationId, task]));
    const candidates: PlanCandidate[] = views.map(view => {
      const task = ranked.get(view.automation.id);
      return {
        automationId: view.automation.id,
        name: view.automation.name,
        apps: routineApps(view.automation),
        observations: task?.observations ?? 0,
        priority: task?.priority ?? 0,
        ...(view.automation.estimate ? { minutesPerWeek: view.automation.estimate.minutesPerWeek } : {}),
      };
    });

    const started = Date.now();
    const plan = await this.choosePlan(candidates);
    const made: PlanView = {
      at: started,
      source: plan.source,
      ...(plan.source === 'rules' ? { reason: plan.reason } : {}),
      candidates: candidates.length,
      automationIds: plan.automationIds,
      durationMs: Date.now() - started,
    };
    this.lastPlan = made;
    console.info(
      `[plan] source=${made.source}${made.reason ? ` reason=${made.reason}` : ''} candidates=${made.candidates} ` +
        `chosen=${made.automationIds.join(',') || '-'} duration=${made.durationMs}ms`,
    );
    this.options.onChange();

    const chosen = made.automationIds
      .map(id => views.find(view => view.automation.id === id))
      .filter((view): view is AutomationView => view !== undefined);
    const confirmed = chosen.length > 0 && (await this.options.confirmPlan(chosen.map(view => view.automation.name)));
    const answered = { ...made, confirmed };
    this.lastPlan = answered;
    console.info(`[plan] confirmed=${confirmed}`);
    this.options.onChange();
    return { plan: answered, chosen };
  }

  /** The local model's plan when it is ready, otherwise the Recall ranking's. A model that cannot load is a model error. */
  private async choosePlan(candidates: PlanCandidate[]): Promise<RunPlan> {
    const model = await this.planningModel();
    if (!model) return planRuns(candidates);
    try {
      // Loading can take minutes on a slow disk, so it happens before the plan's own time limit starts.
      await model.warm();
    } catch {
      const ranked = await planRuns(candidates);
      return { source: 'rules', reason: 'model_error', automationIds: ranked.automationIds };
    }
    return planRuns(candidates, { completer: model });
  }

  /** The chat model for planning: the same choice and file check as naming, through the shared clients. */
  private async planningModel(): Promise<LocalModelClient | undefined> {
    const spec = chooseChatModel(this.agent.configuration.installedModels, (await this.setupPlan()).chat?.spec.id);
    if (!spec) return undefined;
    const path = this.models.pathFor(spec);
    if (!this.plannerVerified.has(path)) {
      if (!(await this.models.hasVerifiedFile(spec))) return undefined;
      this.plannerVerified.add(path);
    }
    return this.modelClients.open(path, spec.template ?? 'chat');
  }

  /**
   * Called for every focus change the twin recorded. Offers at most one routine at a time, and only a routine
   * the person set to level 3 or above, and only when the gate allows it. An offer never starts a run.
   */
  observeFocus(app: string): void {
    // A focus change is a good moment for a screen frame. The frame still passes every check, so an excluded app is not read.
    if (this.agent.configuration.screenCaptureEnabled) void this.screen.requestFrame('focus');
    if (this.activeRuns > 0 || this.planning) return;
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
      const unattended = () => this.agent.run(automationId, { mode: 'unattended' }, this.runExecutor(platform, automation));
      const result = await this.withRun(() => (automation ? this.logged(automation, 'unattended', unattended) : unattended()));
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
    // An offer made before a plan began stays up, but nothing starts beside the plan the person is being asked about.
    if (run && this.planning) throw new Error('A plan is waiting for your answer. Answer it, then run this.');
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
    this.operator.stop();
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
    // The read Discord messages go with the captured text, so they may be read and stored again.
    this.discord.forget();
    this.discordVectors.clear();
    this.discordCheck = undefined;
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

/** A cloud provider the page may name: one of the built-in ones, never a free string. */
function cloudProvider(value: unknown): CloudProviderId {
  if (typeof value !== 'string' || !(CLOUD_PROVIDER_IDS as readonly string[]).includes(value)) throw new Error('Unknown cloud account.');
  return value as CloudProviderId;
}
