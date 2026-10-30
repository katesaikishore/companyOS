import { hkdfSync } from 'node:crypto';
import { isExcludedApp } from './classify';
import { AutomationSchema, compileRoutine, effectsOf, type Automation } from './automation';
import { buildCloudTrace, nameRoutine, type LedgerEntry, type MessagesClient, type NameSuggestion } from './cloud';
import { DEFAULT_MINING, mineRoutines, type Routine } from './mine';
import { Pseudonymizer, normalizeSignal } from './redact';
import { promotionCheck, promote as promoteState, recordRun, setLevel as applyLevel, initialState, type AutonomyConfig, type AutonomyState, type RunRecord } from './autonomy';
import { runAutomation, type Executor, type RunMode, type RunRequest, type RunResult } from './runner';
import { segment, type Segment } from './segment';
import { EncryptedStore } from './store';
import {
  DEFAULT_CONFIG,
  TwinConfigSchema,
  type AutonomyLevel,
  type TwinConfig,
  type TwinEvent,
  type WindowClass,
} from './types';

const DAY_MS = 86_400_000;
const ANALYSIS_DAYS = 30;
const RETENTION_DAYS = 90;

export interface AgentOptions {
  dataDir: string;
  /** 32-byte data key. The desktop app obtains it from the OS keychain. Losing it loses the twin. */
  dataKey: Buffer;
  now?: () => number;
  /** Optional. Only used when cloud escalation is switched on. */
  claude?: MessagesClient;
}

export interface AutomationView {
  automation: Automation;
  state: AutonomyState;
  promotion: ReturnType<typeof promotionCheck>;
}

export interface Suggestion {
  routine: Routine;
  preview: Automation;
}

/**
 * The twin's facade. Everything the desktop app does goes through here, so the privacy rules,
 * the policy and the autonomy gates cannot be skipped by a caller.
 */
export class TwinAgent {
  private readonly store: EncryptedStore;
  private readonly pseudonyms: Pseudonymizer;
  private readonly now: () => number;
  private readonly claude: MessagesClient | undefined;
  private config: TwinConfig;
  /** One run per automation at a time. Overlapping runs would overwrite each other's state. */
  private readonly running = new Set<string>();

  constructor(options: AgentOptions) {
    this.store = new EncryptedStore(options.dataDir, options.dataKey);
    const pseudonymKey = hkdfSync('sha256', options.dataKey, Buffer.alloc(0), 'companyos-twin/pseudonyms', 32);
    this.pseudonyms = new Pseudonymizer(Buffer.from(pseudonymKey));
    this.now = options.now ?? (() => Date.now());
    this.claude = options.claude;
    const saved = this.store.readAll<unknown>('settings').at(-1);
    this.config = saved ? TwinConfigSchema.parse(saved) : { ...DEFAULT_CONFIG };
  }

  get configuration(): TwinConfig {
    return { ...this.config, excludedApps: [...this.config.excludedApps] };
  }

  updateConfig(patch: Partial<TwinConfig>): TwinConfig {
    const next = TwinConfigSchema.parse({ ...this.config, ...patch });
    const excludedChanged = JSON.stringify(next.excludedApps) !== JSON.stringify(this.config.excludedApps);
    this.config = next;
    this.store.replaceAll('settings', [next]);
    if (excludedChanged) this.purgeExcluded();
    return this.configuration;
  }

  /** An app added to the exclusion list is forgotten, not just ignored from now on. */
  private purgeExcluded(): void {
    const all = this.store.readAll<TwinEvent>('events');
    const kept = all.filter(event => !event.app || !isExcludedApp(event.app, this.config.excludedApps));
    if (kept.length !== all.length) this.store.replaceAll('events', kept);
  }

  /** Feeds one raw capture signal. Returns false when redaction dropped it. */
  ingest(signal: unknown): boolean {
    const event = normalizeSignal(signal, {
      excludedApps: this.config.excludedApps,
      watchBrowsers: this.config.watchBrowsers,
    });
    if (!event) return false;
    this.store.append('events', event);
    return true;
  }

  analyze(): { segments: Segment[]; routines: Routine[] } {
    const segments = segment(this.recentEvents(ANALYSIS_DAYS), this.config.idleGapMs);
    return { segments, routines: mineRoutines(segments, DEFAULT_MINING) };
  }

  /** Detected routines that have not been accepted yet, each with the automation it would become. */
  suggestions(): Suggestion[] {
    const accepted = new Set(this.readAutomations().map(automation => automation.routineId));
    return this.analyze()
      .routines.filter(routine => !accepted.has(routine.id))
      .map(routine => ({ routine, preview: compileRoutine(routine) }));
  }

  /** Accepting a routine creates a draft automation at level 2. Nothing runs yet. */
  acceptRoutine(routineId: string, name?: string): AutomationView {
    const existing = this.readAutomations().find(automation => automation.routineId === routineId);
    if (existing) return this.view(existing);

    const routine = this.analyze().routines.find(candidate => candidate.id === routineId);
    if (!routine) throw new Error('That routine is no longer detected.');

    const automation = compileRoutine(routine, name);
    this.writeAutomation(automation);
    this.writeState(initialState(automation.id, effectsOf(automation)));
    return this.view(automation);
  }

  automations(): AutomationView[] {
    return this.readAutomations().map(automation => this.view(automation));
  }

  setLevel(automationId: string, level: AutonomyLevel): AutomationView {
    this.writeState(applyLevel(this.requireState(automationId), level, this.autonomyConfig()));
    return this.view(this.requireAutomation(automationId));
  }

  promote(automationId: string): AutomationView {
    this.writeState(promoteState(this.requireState(automationId), this.now(), this.autonomyConfig()));
    return this.view(this.requireAutomation(automationId));
  }

  /** The person undid the effects of the latest run. The automation drops to level 3. */
  revertLastRun(automationId: string): AutomationView {
    const state = this.requireState(automationId);
    const last = state.runs.at(-1);
    if (!last) throw new Error('There is no run to revert.');
    const runs: RunRecord[] = [...state.runs.slice(0, -1), { ...last, reverted: true }];
    this.writeState({ ...state, runs, level: Math.min(state.level, 3) as AutonomyLevel });
    return this.view(this.requireAutomation(automationId));
  }

  /**
   * Runs an automation. Dry runs never touch the executor. Supervised runs need level 3 and a
   * person to approve anything the policy asks about. Unattended runs need level 4 and the setting on.
   */
  async run(
    automationId: string,
    request: { mode: RunMode; values?: Record<string, string>; approve?: RunRequest['approve'] },
    executor: Executor,
  ): Promise<RunResult> {
    if (this.running.has(automationId)) throw new Error('This automation is already running.');
    const automation = this.requireAutomation(automationId);
    const state = this.requireState(automationId);
    if (request.mode === 'supervised' && state.level < 3) {
      throw new Error('Raise this automation to level 3 before a supervised run.');
    }
    if (request.mode === 'unattended' && (state.level < 4 || !this.config.allowUnattended)) {
      throw new Error('Unattended runs need level 4 and the setting switched on.');
    }

    this.running.add(automationId);
    try {
      const result = await runAutomation(
        automation,
        {
          mode: request.mode,
          values: request.values,
          approve: request.approve,
          policy: {
            level: state.level,
            maxLevel: this.config.maxAutonomyLevel,
            unattended: request.mode === 'unattended',
            excludedApps: this.config.excludedApps,
          },
          // A kill switch pressed during the run applies to the steps that have not started yet.
          currentLevel: () => this.requireState(automationId).level,
        },
        executor,
      );

      // Only completed and failed runs count as evidence. A blocked run says nothing about the automation.
      if (result.status === 'completed' || result.status === 'failed') {
        const record: RunRecord = {
          ts: this.now(),
          mode: request.mode === 'unattended' ? 'unattended' : 'supervised',
          level: state.level,
          status: result.status,
          postconditionsPassed: result.postconditionsPassed,
          postconditionsFailed: result.postconditionsFailed,
          reverted: false,
        };
        // Written from the latest state, not the snapshot taken before the run, so no change made meanwhile is lost.
        this.writeState(recordRun(this.requireState(automationId), record));
      }
      return result;
    } finally {
      this.running.delete(automationId);
    }
  }

  /**
   * Asks the cloud model to name a routine. Off by default. Only the strict, anonymised trace is sent,
   * and every call is written to the ledger the person can read.
   */
  async requestName(routineId: string): Promise<NameSuggestion | undefined> {
    if (!this.config.cloudEnabled) throw new Error('Cloud escalation is off. Turn it on in settings first.');
    if (!this.claude) throw new Error('No Claude API key is configured.');
    const routine = this.analyze().routines.find(candidate => candidate.id === routineId);
    if (!routine) throw new Error('That routine is no longer detected.');

    const trace = buildCloudTrace(routine, this.pseudonyms);
    const result = await nameRoutine(trace, this.claude, this.now());
    this.store.append('ledger', result.entry);
    if (!result.suggestion) throw new Error(result.reason ?? 'No name was returned.');
    return result.suggestion;
  }

  ledger(): LedgerEntry[] {
    return this.store.readAll<LedgerEntry>('ledger');
  }

  /** Drops events older than the retention window. Returns how many were removed. */
  prune(): number {
    const cutoff = this.now() - RETENTION_DAYS * DAY_MS;
    const all = this.store.readAll<TwinEvent>('events');
    const kept = all.filter(event => event.ts >= cutoff);
    if (kept.length !== all.length) this.store.replaceAll('events', kept);
    return all.length - kept.length;
  }

  /** Focus counts per app over the last N days, for the dashboard. Names stay on this device. */
  appUsage(days = 7): Array<{ app: string; windowClass: WindowClass; events: number }> {
    const counts = new Map<string, { windowClass: WindowClass; events: number }>();
    for (const event of this.recentEvents(days)) {
      if (event.kind !== 'focus' || !event.app || !event.windowClass) continue;
      const entry = counts.get(event.app) ?? { windowClass: event.windowClass, events: 0 };
      entry.events++;
      counts.set(event.app, entry);
    }
    return [...counts.entries()]
      .map(([app, entry]) => ({ app, ...entry }))
      .sort((a, b) => b.events - a.events)
      .slice(0, 10);
  }

  /** Everything the twin holds about the person, for the person. */
  exportAll(): object {
    return {
      exportedAt: new Date(this.now()).toISOString(),
      config: this.configuration,
      events: this.store.readAll<TwinEvent>('events'),
      automations: this.readAutomations(),
      autonomy: this.readStates(),
      ledger: this.ledger(),
    };
  }

  /** Removes all stored data. The caller must also destroy the data key to make recovery impossible. */
  wipe(): void {
    this.store.wipe();
  }

  private recentEvents(days: number): TwinEvent[] {
    const since = this.now() - days * DAY_MS;
    return this.store.readAll<TwinEvent>('events').filter(event => event.ts >= since);
  }

  private autonomyConfig(): AutonomyConfig {
    return { maxLevel: this.config.maxAutonomyLevel, allowUnattended: this.config.allowUnattended };
  }

  private view(automation: Automation): AutomationView {
    const state =
      this.readStates().find(candidate => candidate.automationId === automation.id) ??
      initialState(automation.id, effectsOf(automation));
    return { automation, state, promotion: promotionCheck(state, this.now(), this.autonomyConfig()) };
  }

  private readAutomations(): Automation[] {
    return this.store.readAll<unknown>('automations').map(record => AutomationSchema.parse(record));
  }

  private readStates(): AutonomyState[] {
    return this.store.readAll<AutonomyState>('autonomy');
  }

  private requireAutomation(automationId: string): Automation {
    const automation = this.readAutomations().find(candidate => candidate.id === automationId);
    if (!automation) throw new Error('Unknown automation.');
    return automation;
  }

  private requireState(automationId: string): AutonomyState {
    const state = this.readStates().find(candidate => candidate.automationId === automationId);
    if (!state) throw new Error('Unknown automation.');
    return state;
  }

  private writeAutomation(automation: Automation): void {
    const others = this.readAutomations().filter(candidate => candidate.id !== automation.id);
    this.store.replaceAll('automations', [...others, automation]);
  }

  private writeState(state: AutonomyState): void {
    const others = this.readStates().filter(candidate => candidate.automationId !== state.automationId);
    this.store.replaceAll('autonomy', [...others, state]);
  }
}
