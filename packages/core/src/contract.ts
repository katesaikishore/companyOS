import type { KindLabel } from './labels';
import type { AutomationView } from './agent';
import type { MenuAutomationInput, PlaybookInput } from './automation';
import type { PlanFallbackReason } from './llm/planner';
import type { GateRequirement } from './autonomy';
import type { EffectClass, TwinConfig, AutonomyLevel, CaptureKind, WindowClass } from './types';
import type { DownloadState, HardwareProfile, InstalledModel, LayaBundleView, NetworkEntry, SetupPlan } from './models/types';
import type { RunResult } from './runner';
import type { TaskDecision } from './tasks';
import type { ProposedTask } from './operator/understand';
import type { DayRecap } from './recap';

/**
 * The contract between the desktop main process and its pages (the app and the tray).
 * It is type-only and lives here, so the pages and the main process cannot drift apart.
 */

/** Focus switches per app over the last seven days. Names stay on this device. */
export interface AppUsageView {
  app: string;
  windowClass: string;
  /** Focus switches for this app over the last seven days. */
  events: number;
  /**
   * Strength of the strongest recurring routine pattern involving this app. This is based on
   * observed repetition and distinct days in the 30-day analysis window, not a prediction of
   * error-free automation or a measured run-success rate.
   */
  learningScore: number;
  patternCount: number;
  patternSupport: number;
  patternDays: number;
}

/** One step of the workflow the twin would draft from a routine. */
export interface DraftStep {
  /** 'act' moves focus to an app; 'check' confirms the expected app is in front. */
  kind: 'act' | 'check';
  app: string;
  /** How many other apps were seen in this position. More than zero means the app is a parameter. */
  alternatives: number;
  effect: EffectClass;
}

export interface SuggestionView {
  routineId: string;
  name: string;
  support: number;
  days: number;
  score: number;
  /** Estimate of the time this routine takes by hand, per week. Not measured from the person. */
  minutesPerWeek: number;
  /** When the latest occurrence of this routine began, in ms. */
  lastSeenAt: number;
  /** When the routine usually happens, in plain words, from the start of each occurrence in local time. See describeWhen. */
  when: string;
  /** The kind of work the routine is, and whether a decision model or the rules gave it. Display only. See labels.ts. */
  kind: { label: KindLabel; source: 'model' | 'rule' };
  drafted: DraftStep[];
  effects: EffectClass[];
  parameters: Array<{ name: string; options: string[] }>;
}

export interface StatsView {
  /** Routines detected or accepted. */
  routinesLearned: number;
  /** Suggestions not yet accepted, plus automations still at draft. */
  waiting: number;
  /** Level 4 automations currently enabled for unattended execution. */
  unattendedReady: number;
  /** Estimated minutes per week across automations at level 3 or above. */
  minutesBackPerWeek: number;
  /** Days since the first recorded event. */
  observedDays: number;
}

/** An offer to run a routine, waiting for the person's answer. */
export interface PendingRunView {
  id: string;
  automationId: string;
  automationName: string;
  /** The app that came into focus and opened the routine. */
  app: string;
  createdAt: number;
  expiresAt: number;
}

/** How one app's switches fall across the three groups. The badge on each row reads this. */
export type AppReadinessStatus = 'automatable' | 'partly' | 'approval' | 'not_yet';

/** A routine an app appears in. Its sequence is app names, so it stays on this device. */
export interface AppReadinessRoutineView {
  routineId: string;
  /** The routine's steps as app names, in order. Apps seen at one position are joined with " or ". */
  sequence: string;
  /** Distinct days the routine was seen on in the analysis window. */
  days: number;
  /** This app's switches inside the routine over the last seven days. */
  switches: number;
  /** Automatable when every step is local and reversible. Approval when a step is not. */
  kind: 'automatable' | 'approval';
  /** Suggested, accepted as an automation, or dismissed by the person. A near copy of a dismissed routine is dismissed too. */
  status: 'suggested' | 'accepted' | 'dismissed';
  automationId?: string;
  automationName?: string;
  level?: AutonomyLevel;
}

/** The promotion gate of the automation an app's routine became. Every value is the gate's own, not an estimate. */
export interface AppReadinessGate {
  automationId: string;
  automationName: string;
  level: AutonomyLevel;
  requirements: GateRequirement[];
}

/** One app's repeated work over the last seven days, split by what could run on its own. Percentages are whole numbers. */
export interface AppReadinessRow {
  app: string;
  windowClass: string;
  switches: number;
  automatablePct: number;
  approvalPct: number;
  notYetPct: number;
  status: AppReadinessStatus;
  /** A plain reason for the split. It never shows a model's confidence. */
  reason: string;
  /** Routines that use this app. */
  routines: number;
  /** Those routines, most switches first. */
  learned: AppReadinessRoutineView[];
  /** The gate of this app's accepted automation, when one exists. */
  gate?: AppReadinessGate;
}

export interface AppReadinessView {
  switches: number;
  apps: number;
  automatablePct: number;
  approvalPct: number;
  notYetPct: number;
  rows: AppReadinessRow[];
}

/** The usual hours of one weekday. Weekdays run Monday first, as in the activity grid. */
export interface UsualHoursView {
  /** 0 is Monday. */
  weekday: number;
  /**
   * Whole local days in the window with an app switch on this weekday. A day the window cuts, or today before it
   * ends, is left out.
   */
  days: number;
  /** False when too few days were seen to name an hour. The hours are then null, so the twin does not guess. */
  enoughData: boolean;
  /** Median hour of the first app switch of each observed day, to two decimals. 9.5 is 09:30. */
  startHour: number | null;
  /** Median hour of the last app switch of each observed day. */
  endHour: number | null;
}

/** How long a work segment usually lasts. A segment runs from its first app switch to its last. */
export interface SessionMinutesView {
  /** Work segments in the window. */
  segments: number;
  /** Null below the minimum number of segments. */
  medianMinutes: number | null;
}

/** The app a window class uses most in the window. Only classes with enough switches appear. */
export interface UsualAppView {
  windowClass: WindowClass;
  /** App switches into this class in the window. */
  switches: number;
  /** The normalised app name. */
  app: string;
  /** Whole percentage of the class's switches that went to this app. */
  sharePct: number;
}

/** How long the person stayed in one app of a window class before switching to another. */
export interface StretchMinutesView {
  windowClass: WindowClass;
  /** Stretches in this class that ended with a switch to another app. */
  stretches: number;
  /** Null below the minimum number of stretches. */
  medianMinutes: number | null;
}

/**
 * How the person usually works, over the last four weeks. It describes what was recorded and never judges it. Until
 * enough days are observed, it says so and gives no habit.
 */
export type HabitsView =
  | { state: 'not_enough_data'; windowDays: number; observedDays: number; requiredDays: number }
  | {
      state: 'ready';
      windowDays: number;
      observedDays: number;
      usualHours: UsualHoursView[];
      sessionMinutes: SessionMinutesView;
      usualAppPerKind: UsualAppView[];
      stretchMinutes: StretchMinutesView[];
    };

/** A stretch of work inside a task, from its first focus event to its last. A split refers to one by its id. */
export interface TaskSegmentView {
  id: string;
  startTs: number;
}

/**
 * One task of a day: consecutive stretches of work grouped from app names and timing, named from the two most used apps
 * unless the person named it. Nothing in it is window text or page content.
 */
export interface TaskView {
  /** The id of the task's first stretch. Decisions refer to a task by it. */
  id: string;
  /** The name the person gave, or the two most used apps, such as "Microsoft Excel and Slack". */
  name: string;
  /** True when the person named the task. */
  renamed: boolean;
  /** The app names in the task, most used first. Stored names are lower case. */
  apps: string[];
  startTs: number;
  endTs: number;
  /** The task's stretches in time order. A split can happen at any of them but the first. */
  segments: TaskSegmentView[];
  /** True once the person has confirmed the task, or has merged, split or renamed it. */
  confirmed: boolean;
}

/** The tasks of one local day, in time order. */
export interface DayTasksView {
  /** The local calendar day, as YYYY-MM-DD. */
  day: string;
  tasks: TaskView[];
}

/** One step of a routine the twin knows. A browser step names its site, as the routine does, and nothing more. */
export interface RoutineStepView {
  /** The app the step focuses, as the twin stores it. */
  app: string;
  /** The site a browser step visited: its host and first path segment. Absent for any other step. */
  site?: string;
  /** Other apps seen at this step. More than zero means the app varies between runs. */
  alternatives: number;
}

/**
 * A routine the twin knows and the person has not dismissed: suggested and waiting for an answer, or accepted as an
 * automation. Names, apps, sites and timing only.
 */
export interface RoutineView {
  routineId: string;
  name: string;
  status: 'suggested' | 'accepted';
  steps: RoutineStepView[];
  /** When the routine usually happens, in plain words. Absent when the routine is no longer detected. */
  when?: string;
  /** The automation an accepted routine became, and the level it is at. */
  automationId?: string;
  level?: AutonomyLevel;
}

/** A routine the person said no to: "Not now" on an offer, or "Not a routine". Reset clears it. */
export interface DeclinedRoutineView {
  routineId: string;
  /** The name, while the routine is still detected or accepted. */
  name?: string;
  /** True when the person said it is not a routine. False for "Not now" on an offer. */
  dismissed: boolean;
  /** Declines in a row, with no accept or completed run in between. Zero for a dismissal kept by an earlier version. */
  declines: number;
  /** When the latest decline or dismissal happened, in ms. Absent for a dismissal kept by an earlier version. */
  at?: number;
}

/** What the twin knows about the person's routines, for the What the twin knows page. */
export interface KnownRoutinesView {
  routines: RoutineView[];
  declined: DeclinedRoutineView[];
}

/** Where the screen or microphone channel stands. 'needs_permission' means the operating system has not granted access yet. */
export type CaptureChannelState = 'off' | 'on' | 'paused' | 'needs_permission' | 'unsupported';

/** Where the local API stands. 'failed' means it is switched on but could not bind to its port. */
export type LocalApiState = 'off' | 'listening' | 'failed';

/** The two permissions capture can ask the operating system for. */
export type CapturePermission = 'screen' | 'microphone';

/** A search from the Recall page. Words are split and matched by the engine. A kind, app or range left out is not filtered. */
export interface CaptureSearchRequest {
  text: string;
  kind?: CaptureKind;
  app?: string;
  /** Only audio items with this speaker name or session label. Left out, every speaker is searched. */
  speaker?: string;
  /** Inclusive bounds, in ms. */
  from: number;
  to: number;
}

/**
 * One captured item that matched. For a screen item, `id` names its image, which frameImage reads. The snippet is a short piece of the stored text.
 * `speaker` is set on an audio item that was labelled, with a name or a session label such as 'Speaker 2'. It is never a voice.
 */
export interface CaptureHitView {
  kind: CaptureKind;
  id: string;
  ts: number;
  app: string | null;
  snippet: string;
  speaker?: string;
}

/** One step of a task, as the Tasks page shows it. */
export interface OperatorStepView {
  n: number;
  /** The step in plain words, such as: Click "New Document". */
  text: string;
  outcome: 'landed' | 'unverified' | 'not_landed' | 'may_have_landed' | 'held' | 'refused' | 'finished' | 'invalid' | 'no_answer';
  why?: string;
}

/** The task operator: the task running now, the step waiting for the person, and how the last task ended. */
export interface OperatorTaskView {
  state: 'idle' | 'running' | 'waiting';
  goal?: string;
  app?: string;
  model: 'local' | 'chutes';
  steps: OperatorStepView[];
  /** The step that waits for the person. Answer it with answerTaskStep. */
  pending?: { id: string; text: string; why: string; detail?: string };
  result?: { status: 'done' | 'failed' | 'refused' | 'declined' | 'stopped' | 'step_limit'; summary?: string };
  /** Whether a task can start: the agent-desktop path is set, and a Chutes key is saved when Chutes is chosen. */
  ready: { agentDesktop: boolean; chutesKey: boolean };
}

/** A task the person types: what to do, and the app to start in. */
export interface OperatorTaskRequest {
  goal: string;
  app: string;
  /** Lets memory notes from captured text go to Chutes with the task. Notes always go to a model on this Mac. */
  shareMemory?: boolean;
}

export interface TwinStatus {
  /**
   * Activity capture (state and detail), then screen text, microphone text and the local API. Counts and sizes cover
   * what is stored. The detail line says, in plain words, why a channel is off, paused or waiting for permission.
   */
  capture: {
    state: 'capturing' | 'paused' | 'idle' | 'locked' | 'unsupported';
    detail: string;
    screenState: CaptureChannelState;
    audioState: CaptureChannelState;
    /** Typed text. 'unsupported' when this system has no keyboard hook, so the setting cannot take effect. */
    keystrokeState: CaptureChannelState;
    apiState: LocalApiState;
    /** Bytes on disk for the sealed screen images. */
    mediaBytes: number;
    screenCount: number;
    audioCount: number;
    keystrokeCount: number;
  };
  /** Whether browser capture can run on this system. The browser bridge is available on macOS and Linux only. */
  browserCaptureSupported: boolean;
  config: TwinConfig;
  /** How many speaker profiles the person has named. The profiles themselves are never sent to a page. */
  speakerProfiles?: number;
  usage: AppUsageView[];
  suggestions: SuggestionView[];
  automations: AutomationView[];
  /** Every network call the twin has made, newest last. */
  network: NetworkEntry[];
  /** Focus switches by weekday (0 = Monday) and hour of day, over the last four weeks. */
  activity: number[][];
  recordedFocusEvents: number;
  /** Bytes on disk for the twin's encrypted store. */
  storageBytes: number;
  /** Days raw events are kept before the engine prunes them. */
  retentionDays: number;
  stats: StatsView;
  downloads: DownloadState[];
  /** The optional decision-model bundle. Nothing in the app uses it yet. */
  laya: LayaBundleView;
  /** Offers waiting for an answer. Expired offers are removed. */
  pendingRuns: PendingRunView[];
  /** Runs happening now, and those that ended in the last two minutes, each with what its cursor is doing. */
  liveRuns?: LiveRunView[];
  /** How much of each app's repeated work could run on its own, over the last seven days. */
  readiness: AppReadinessView;
  /** How the person usually works, over the last four weeks. Rebuilt from the stored events on each read. */
  habits: HabitsView;
  /** Today's tasks, grouped from the day's app switches with the person's decisions applied. */
  tasks: DayTasksView;
  /** What the twin knows about the person's routines. Rebuilt from the stored events on each read. */
  knownRoutines: KnownRoutinesView;
  /** Items stored from connected sources (folder, Git, calendar, mail). Optional, so a status built without it still type-checks. */
  connectorItems?: number;
  /** The items each local source had at its last import this session, by source id. Not saved, so it is empty after a restart. */
  connectorCounts?: Record<string, number>;
  /** The cloud accounts the app can connect, read-only: Google Calendar and GitHub. Optional, so a status built without it still type-checks. */
  cloudAccounts?: CloudAccountView[];
  /** The task operator's current task, if any. */
  operator: OperatorTaskView;
  /** The newest kept run of each write pipe, by pipe id. A pipe with no entry has no kept run. Holds no text. */
  pipeOutputs?: Record<string, PipeOutputSummaryView>;
  /** Automations ranked by the Recall observations of their apps over the last seven days, highest priority first. */
  assignedTasks?: AssignedTaskView[];
  /** Completed and failed runs per local day over the last fourteen days, oldest first and today last. */
  taskRuns?: number[];
  /** The latest plan, made since the app started. Undefined before the first. */
  lastPlan?: PlanView;
  /** How many runs are in progress now, including ones waiting for an approval or for the desktop's input. */
  activeRuns?: number;
}

/** One plan: when it was made, where the choice came from, what it chose, and whether the person said yes. Ids only. */
export interface PlanView {
  at: number;
  source: 'model' | 'rules';
  /** Why the Recall ranking chose instead of the local model. */
  reason?: PlanFallbackReason;
  /** How many automations the plan could choose from. */
  candidates: number;
  automationIds: string[];
  /** How long the choice took, model load included. */
  durationMs: number;
  /** Whether the person said yes to running it. Undefined while they are being asked. */
  confirmed?: boolean;
}

/** A plan and what each run it started did. A run that could not start has an error sentence instead of a result. */
export interface PlanRunView {
  plan: PlanView;
  runs: Array<{ automationId: string; result?: RunResult; error?: string }>;
}

/**
 * A swarm: several automations started together, each under its own cursor. `allowed` says whether the person allowed
 * every step of these runs when they started the swarm, or chose to be asked for each run.
 */
export interface SwarmRunView {
  /** The swarm's name, such as "Finance swarm", or "Swarm 2" when none was given. */
  name: string;
  confirmed: boolean;
  allowed: 'all' | 'each' | 'none';
  runs: Array<{ automationId: string; result?: RunResult; error?: string }>;
}

/**
 * One run as it happens, for the live view: whose cursor it is, which swarm it belongs to, the step it is on and what that
 * step does. Finished runs stay for two minutes with their outcome. Holds no entered text and nothing read on screen.
 */
export interface LiveRunView {
  /** One id per run, so the same automation run twice shows twice. */
  runId: string;
  automationId: string;
  name: string;
  /** The cursor's colour, as drawn on screen. */
  colour: string;
  swarm?: string;
  /** The step being run, counted from 1, and how many the run has. */
  step: number;
  steps: number;
  /** What the step does, as drawn beside the cursor, such as "Paste into Swarm Board!C3". */
  doing: string;
  state: 'running' | 'completed' | 'blocked' | 'failed';
  startedAt: number;
  endedAt?: number;
}

/** One automation ranked by what Recall saw of its apps. Holds no text: only counts, a time and the routine's name. */
export interface AssignedTaskView {
  automationId: string;
  name: string;
  /** Stored screen and audio observations of the routine's apps in the window. Audio counts for the app read just before it. */
  observations: number;
  /** The newest of those observations, in ms. */
  latest: number;
  /** Observations weighted by recency, times the estimated minutes a week the routine saves. Higher runs first. */
  priority: number;
  level: AutonomyLevel;
}

/** When a write pipe's newest kept run was read, and how many matches it kept. Holds no text. */
export interface PipeOutputSummaryView {
  count: number;
  ranAt: number;
}

/** A cloud account the app can connect, read-only. The client id is never sent to a page: only whether one is set. */
export interface CloudAccountView {
  provider: 'googleCalendar' | 'github';
  /** Whether this build has a client id for the account. Without one, connecting is refused. */
  configured: boolean;
  /** Whether a source for the account is saved. Its tokens are sealed on this device. */
  connected: boolean;
  /** Epoch milliseconds of the last successful read. */
  lastImportedAt?: number;
  /** Items the last read this session stored. Not saved, so it is empty after a restart. */
  count?: number;
}

/** Everything a page may ask of the main process. Each call is validated there. */
export interface TwinBridge {
  status(): Promise<TwinStatus>;
  hardware(): Promise<HardwareProfile>;
  setupPlan(): Promise<SetupPlan>;
  installModel(modelId: string): Promise<void>;
  cancelDownload(modelId: string): Promise<void>;
  removeModel(modelId: string): Promise<void>;
  /** Starts or resumes the optional decision-model download. Progress arrives through status().laya. */
  installLaya(): Promise<void>;
  /** Stops the download. What was already downloaded stays, so installLaya() continues from there. */
  cancelLaya(): Promise<void>;
  /** Deletes the bundle and any partial download. */
  removeLaya(): Promise<void>;
  completeSetup(): Promise<void>;

  setPaused(paused: boolean): Promise<void>;
  updateConfig(patch: Partial<TwinConfig>): Promise<TwinConfig>;
  stopAllAutomations(): Promise<void>;

  /**
   * Gives a session speaker a name, such as 'Speaker 2' to 'Ada'. The voice is stored as a profile, encrypted on this device,
   * and the audio items with that label are relabelled. Refused while speaker identification is off.
   */
  nameSpeaker(label: string, name: string): Promise<void>;
  /** Deletes every speaker profile and forgets the session speakers. Names already on past audio items stay as they are. */
  forgetSpeakers(): Promise<void>;

  acceptRoutine(routineId: string, name?: string): Promise<AutomationView>;
  dismissRoutine(routineId: string): Promise<void>;
  /** Clears the decline and the wait of a routine, and lifts a dismissal, so the twin may suggest it again. */
  resetDecline(routineId: string): Promise<void>;
  /** Changes the name of an automation. Nothing else about it changes. */
  renameAutomation(automationId: string, name: string): Promise<AutomationView>;
  /** Makes a draft automation by hand that brings an app forward, then chooses one menu path in it. */
  createMenuAutomation(input: MenuAutomationInput): Promise<AutomationView>;
  /** Makes a draft automation from a playbook of desktop steps: clicks, pasted text, keys, fields and checks. */
  createPlaybook(input: PlaybookInput): Promise<AutomationView>;
  /**
   * Plans which automations at level 3 or above to run now, with the local model when it is ready, asks the person once,
   * then starts the chosen runs together. Each run still asks before any step that acts on an app.
   */
  planAndRun(): Promise<PlanRunView>;
  /**
   * Starts two to nine automations at level 3 or above together, as a swarm, each under its own cursor, after asking the
   * person once. They share the desktop's input step by step, so no two actions ever overlap.
   */
  runSwarm(automationIds: string[], name?: string): Promise<SwarmRunView>;
  setLevel(automationId: string, level: AutonomyLevel): Promise<AutomationView>;
  promote(automationId: string): Promise<AutomationView>;
  dryRun(automationId: string): Promise<RunResult>;
  supervisedRun(automationId: string): Promise<RunResult>;
  revertLast(automationId: string): Promise<AutomationView>;
  /** Answers an offer. `run: true` starts a supervised run, where each external step still asks. */
  answerPendingRun(id: string, run: boolean): Promise<void>;

  /** Confirms, renames, merges or splits one of a day's tasks. The engine checks it before it is stored. */
  decideTask(decision: TaskDecision): Promise<void>;

  /** Searches the stored screen and microphone text. Words are matched as phrases; search syntax is never parsed. */
  searchCapture(request: CaptureSearchRequest): Promise<CaptureHitView[]>;
  /** A stored screen image as a JPEG data URL, or null when it was deleted or cannot be read. */
  frameImage(id: string): Promise<string | null>;
  /** Deletes every stored screen image and all captured text. The main process asks the person first. */
  deleteCapture(): Promise<void>;
  /** Copies the local API token to the clipboard. The token itself never reaches the page. */
  copyApiToken(): Promise<void>;
  /** Replaces the local API token after the person confirms. The old token stops working at once. */
  rotateApiToken(): Promise<void>;
  /** Asks the operating system for screen or microphone access. The result shows in the status. */
  requestPermission(permission: CapturePermission): Promise<void>;
  /** Opens the operating system's privacy settings for screen or microphone access. */
  openPrivacySettings(permission: CapturePermission): Promise<void>;

  /**
   * Asks for a folder (folder and Git repository) or a file (calendar and mail archive) in the system dialog, then reads it
   * once. Resolves to the items stored, or to null when the dialog was cancelled. A source whose first read fails is not kept.
   */
  addConnector(kind: 'folder' | 'git' | 'calendar' | 'mail'): Promise<number | null>;
  /** Removes a local source and its items. The files it read are not changed. */
  removeConnector(id: string): Promise<void>;
  /** Reads a local source again now, and replaces its items. Resolves to the items stored. */
  importConnector(id: string): Promise<number>;
  /**
   * Connects a cloud account, read-only, through the person's own sign-in in the browser. Resolves to the items the first read
   * stored. If that read fails, nothing stays connected.
   */
  connectCloud(provider: CloudAccountView['provider']): Promise<number>;
  /** Disconnects a cloud account: deletes its sealed tokens and its items, and removes it from the list. */
  disconnectCloud(provider: CloudAccountView['provider']): Promise<void>;
  /**
   * Reads the last day's screen text, groups it by meaning with a small embedding model on this Mac, and asks the local
   * model for one next step per piece of work. Proposals only: nothing runs until startTask.
   */
  proposeTasks(): Promise<ProposedTask[]>;
  /** The recap of a day (YYYY-MM-DD, today when absent), written by the local model from that day's tasks, screen text and speech. */
  dayRecap(day?: string): Promise<DayRecap>;
  /** Starts a task. One task runs at a time. Steps that may send, share, delete or sign in wait for answerTaskStep. */
  startTask(request: OperatorTaskRequest): Promise<void>;
  /** Stops the running task. A step that waits for the person is declined. */
  stopTask(): Promise<void>;
  /** Answers the step that waits for the person. */
  answerTaskStep(id: string, approve: boolean): Promise<void>;
  /** Saves the Chutes key in the OS keychain. The key never returns to the page. */
  setChutesKey(key: string): Promise<void>;
  clearChutesKey(): Promise<void>;

  exportData(): Promise<string>;
  deleteAll(): Promise<void>;

  /** Shows the main window, optionally on a route such as '#/ledger'. Used by the tray. */
  openMainWindow(route?: string): Promise<void>;
  /** Calls back when the main process asks this page to change route. Returns an unsubscribe function. */
  onNavigate(listener: (route: string) => void): () => void;
}

export type { InstalledModel, DownloadState, HardwareProfile, SetupPlan, NetworkEntry, LayaBundleView };
