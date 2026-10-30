import type { AutomationView } from './agent';
import type { EffectClass, TwinConfig, AutonomyLevel } from './types';
import type { DownloadState, HardwareProfile, InstalledModel, NetworkEntry, SetupPlan } from './models/types';
import type { RunResult } from './runner';

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

/** Sanitized result from an explicitly approved OpenMausBot handoff. */
export interface AgentDelegationResult {
  state: 'completed' | 'idle' | 'needs-input' | 'failed' | 'stalled' | 'timed-out' | 'cancelled';
  summary: string;
  threadId?: string;
  /** The harness job tree only; transcripts and screenshots are never passed to the renderer. */
  taskTree?: string;
}

export interface TwinStatus {
  capture: { state: 'capturing' | 'paused' | 'idle' | 'locked' | 'unsupported'; detail: string };
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
  stats: StatsView;
  downloads: DownloadState[];
  /** Offers waiting for an answer. Expired offers are removed. */
  pendingRuns: PendingRunView[];
}

/** Everything a page may ask of the main process. Each call is validated there. */
export interface TwinBridge {
  status(): Promise<TwinStatus>;
  hardware(): Promise<HardwareProfile>;
  setupPlan(): Promise<SetupPlan>;
  installModel(modelId: string): Promise<void>;
  cancelDownload(modelId: string): Promise<void>;
  removeModel(modelId: string): Promise<void>;
  completeSetup(): Promise<void>;

  setPaused(paused: boolean): Promise<void>;
  updateConfig(patch: Partial<TwinConfig>): Promise<TwinConfig>;
  stopAllAutomations(): Promise<void>;

  acceptRoutine(routineId: string, name?: string): Promise<AutomationView>;
  dismissRoutine(routineId: string): Promise<void>;
  setLevel(automationId: string, level: AutonomyLevel): Promise<AutomationView>;
  promote(automationId: string): Promise<AutomationView>;
  dryRun(automationId: string): Promise<RunResult>;
  supervisedRun(automationId: string): Promise<RunResult>;
  revertLast(automationId: string): Promise<AutomationView>;
  /** Answers an offer. `run: true` starts a supervised run, where each external step still asks. */
  answerPendingRun(id: string, run: boolean): Promise<void>;
  /** Starts a multi-agent job for an accepted routine after a native data-sharing confirmation. */
  delegateRoutine(automationId: string, taskBrief: string): Promise<AgentDelegationResult>;

  exportData(): Promise<string>;
  deleteAll(): Promise<void>;

  /** Shows the main window, optionally on a route such as '#/ledger'. Used by the tray. */
  openMainWindow(route?: string): Promise<void>;
  /** Calls back when the main process asks this page to change route. Returns an unsubscribe function. */
  onNavigate(listener: (route: string) => void): () => void;
}

export type { InstalledModel, DownloadState, HardwareProfile, SetupPlan, NetworkEntry };
