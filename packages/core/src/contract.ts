import type { AutomationView } from './agent';
import type { LedgerEntry, NameSuggestion } from './cloud';
import type { RunResult } from './runner';
import type { AutonomyLevel, TwinConfig } from './types';

/**
 * The contract between the desktop app's main process and its page. It lives here, type-only,
 * so the page and the main process cannot drift apart.
 */
export interface AppUsageView {
  app: string;
  windowClass: string;
  events: number;
}

export interface SuggestionView {
  routineId: string;
  support: number;
  days: number;
  score: number;
  steps: Array<{ windowClass: string; app: string; alternatives: number }>;
  previewName: string;
}

export interface TwinStatus {
  capture: { state: 'capturing' | 'paused' | 'idle' | 'locked' | 'unsupported'; detail: string };
  config: TwinConfig;
  apiKeyConfigured: boolean;
  usage: AppUsageView[];
  suggestions: SuggestionView[];
  automations: AutomationView[];
  ledger: LedgerEntry[];
  recordedFocusEvents: number;
}

/** Everything the page may ask for. Each call is a thin, validated request to the main process. */
export interface TwinBridge {
  status(): Promise<TwinStatus>;
  setPaused(paused: boolean): Promise<void>;
  updateConfig(patch: Partial<TwinConfig>): Promise<TwinConfig>;
  acceptRoutine(routineId: string, name?: string): Promise<AutomationView>;
  setLevel(automationId: string, level: AutonomyLevel): Promise<AutomationView>;
  promote(automationId: string): Promise<AutomationView>;
  dryRun(automationId: string): Promise<RunResult>;
  supervisedRun(automationId: string): Promise<RunResult>;
  revertLast(automationId: string): Promise<AutomationView>;
  requestName(routineId: string): Promise<NameSuggestion | undefined>;
  setApiKey(key: string): Promise<boolean>;
  exportData(): Promise<string>;
  deleteAll(): Promise<void>;
}
