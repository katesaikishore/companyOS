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
  events: number;
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
  /** Automations at level 4, running without a person. */
  runningOwn: number;
  /** Estimated minutes per week across automations at level 3 or above. */
  minutesBackPerWeek: number;
  /** Days since the first recorded event. */
  observedDays: number;
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

  exportData(): Promise<string>;
  deleteAll(): Promise<void>;

  /** Shows the main window, optionally on a route such as '#/ledger'. Used by the tray. */
  openMainWindow(route?: string): Promise<void>;
  /** Calls back when the main process asks this page to change route. Returns an unsubscribe function. */
  onNavigate(listener: (route: string) => void): () => void;
}

export type { InstalledModel, DownloadState, HardwareProfile, SetupPlan, NetworkEntry };
