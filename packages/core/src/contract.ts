import type { KindLabel } from './labels';
import type { AutomationView } from './agent';
import type { GateRequirement } from './autonomy';
import type { EffectClass, TwinConfig, AutonomyLevel, WindowClass } from './types';
import type { DownloadState, HardwareProfile, InstalledModel, LayaBundleView, NetworkEntry, SetupPlan } from './models/types';
import type { RunResult } from './runner';
import type { TaskDecision } from './tasks';

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

export interface TwinStatus {
  capture: { state: 'capturing' | 'paused' | 'idle' | 'locked' | 'unsupported'; detail: string };
  /** Whether browser capture can run on this system. The browser bridge is available on macOS and Linux only. */
  browserCaptureSupported: boolean;
  config: TwinConfig;
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
  /** How much of each app's repeated work could run on its own, over the last seven days. */
  readiness: AppReadinessView;
  /** How the person usually works, over the last four weeks. Rebuilt from the stored events on each read. */
  habits: HabitsView;
  /** Today's tasks, grouped from the day's app switches with the person's decisions applied. */
  tasks: DayTasksView;
  /** What the twin knows about the person's routines. Rebuilt from the stored events on each read. */
  knownRoutines: KnownRoutinesView;
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

  acceptRoutine(routineId: string, name?: string): Promise<AutomationView>;
  dismissRoutine(routineId: string): Promise<void>;
  /** Clears the decline and the wait of a routine, and lifts a dismissal, so the twin may suggest it again. */
  resetDecline(routineId: string): Promise<void>;
  /** Changes the name of an automation. Nothing else about it changes. */
  renameAutomation(automationId: string, name: string): Promise<AutomationView>;
  setLevel(automationId: string, level: AutonomyLevel): Promise<AutomationView>;
  promote(automationId: string): Promise<AutomationView>;
  dryRun(automationId: string): Promise<RunResult>;
  supervisedRun(automationId: string): Promise<RunResult>;
  revertLast(automationId: string): Promise<AutomationView>;
  /** Answers an offer. `run: true` starts a supervised run, where each external step still asks. */
  answerPendingRun(id: string, run: boolean): Promise<void>;

  /** Confirms, renames, merges or splits one of a day's tasks. The engine checks it before it is stored. */
  decideTask(decision: TaskDecision): Promise<void>;

  exportData(): Promise<string>;
  deleteAll(): Promise<void>;

  /** Shows the main window, optionally on a route such as '#/ledger'. Used by the tray. */
  openMainWindow(route?: string): Promise<void>;
  /** Calls back when the main process asks this page to change route. Returns an unsubscribe function. */
  onNavigate(listener: (route: string) => void): () => void;
}

export type { InstalledModel, DownloadState, HardwareProfile, SetupPlan, NetworkEntry, LayaBundleView };
