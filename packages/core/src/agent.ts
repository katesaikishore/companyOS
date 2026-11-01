import { AutomationSchema, compileRoutine, effectsOf, fitName, type Automation } from './automation';
import { isExcludedApp, normalizeAppName } from './classify';
import { TriggerGate, openingApps } from './triggers';
import { addSignature, matchesDismissed, signatureOf, signaturesWithNamesIn, withoutExcludedApps, withoutRoutine } from './dismissed';
import { DEFAULT_MINING, legacyRelinks, mineRoutines, type Routine } from './mine';
import { hasUnknownStep, ruleKindOfSteps, type KindLabeling } from './labels';
import { computeReadiness } from './readiness';
import { habits as computeHabits, HABITS_WINDOW_DAYS } from './habits';
import type { AppReadinessView, DayTasksView, HabitsView, KnownRoutinesView } from './contract';
import { knownRoutinesView } from './known';
import { normalizeSignal } from './redact';
import {
  promotionCheck,
  promote as promoteState,
  recordRun,
  setLevel as applyLevel,
  initialState,
  type AutonomyConfig,
  type AutonomyState,
  type RunRecord,
} from './autonomy';
import { runAutomation, type Executor, type RunMode, type RunRequest, type RunResult } from './runner';
import { segment, type Segment } from './segment';
import { EncryptedStore } from './store';
import { dayKeyOf, decisionFits, parseTaskDecision, TaskDecisionSchema, tasksForDay, type TaskDecision } from './tasks';
import type { InstalledModel, NetworkEntry } from './models/types';
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
/** Raw events and handoff records older than this are pruned. The desktop status reports the same figure to the Overview. */
export const RETENTION_DAYS = 90;
/** Names kept in memory for detected routines. The oldest are dropped first. */
const MAX_ROUTINE_NAMES = 200;
/** What the data export shows in place of a name the person typed. The encrypted store and the pages keep the name itself. */
const TYPED_NAME_NOT_EXPORTED = '[typed name not exported]';

export interface AgentOptions {
  dataDir: string;
  /** 32-byte data key. The desktop app obtains it from the OS keychain. Losing it loses the twin. */
  dataKey: Buffer;
  now?: () => number;
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
 * The state with its effects worked out again from the steps. A stored list is never trusted: one saved before a step
 * was classified as an external effect would understate what the automation does, and the promotion gate reads it.
 */
function withEffects(state: AutonomyState, automation: Automation): AutonomyState {
  return { ...state, effects: effectsOf(automation) };
}

/**
 * Config keys removed with the OpenMausBot integration. A config saved before that still holds them, so they are
 * dropped before the strict schema reads it. Their values are not read, and the next save writes the config without them.
 */
const RETIRED_CONFIG_KEYS = ['openMausBotCommand', 'openMausBotTarget'] as const;

function withoutRetiredKeys(saved: unknown): unknown {
  if (typeof saved !== 'object' || saved === null) return saved;
  const kept: Record<string, unknown> = { ...(saved as Record<string, unknown>) };
  for (const key of RETIRED_CONFIG_KEYS) delete kept[key];
  return kept;
}

/**
 * The send time of a stored handoff record from an earlier version, or undefined when the row has none readable. Such a
 * row cannot be dated, so pruning removes it: a record that cannot be aged must not be kept past the window.
 */
function handoffSentAt(row: unknown): number | undefined {
  const sentAt = typeof row === 'object' && row !== null ? (row as { sentAt?: unknown }).sentAt : undefined;
  return typeof sentAt === 'number' && Number.isFinite(sentAt) ? sentAt : undefined;
}

/**
 * The twin's facade. Everything the desktop app does goes through here, so the privacy rules,
 * the policy and the autonomy gates cannot be skipped by a caller.
 */
export class TwinAgent {
  private readonly store: EncryptedStore;
  private readonly now: () => number;
  private config: TwinConfig;
  /** Advances whenever the global stop switch is turned off, so a quick off/on still cancels active runs. */
  private stopGeneration = 0;
  /** Turning unattended execution off also cancels an active level 4 run, including across a quick off/on. */
  private unattendedGeneration = 0;
  /** One run per automation at a time. Overlapping runs would overwrite each other's state. */
  private readonly running = new Set<string>();
  /** Names from the local model for detected routines. Memory only: a restart names them again. */
  private readonly routineNames = new Map<string, string>();
  private readonly routineKinds = new Map<string, KindLabeling>();
  /** Offers and declines. The declines are loaded from the config when the agent starts, and written back when they change. */
  private readonly gate: TriggerGate;

  constructor(options: AgentOptions) {
    this.store = new EncryptedStore(options.dataDir, options.dataKey);
    this.now = options.now ?? (() => Date.now());
    const saved = this.store.readAll<unknown>('settings').at(-1);
    this.config = saved ? TwinConfigSchema.parse(withoutRetiredKeys(saved)) : { ...DEFAULT_CONFIG };
    this.gate = new TriggerGate(this.now, this.config.declinedRoutines);
  }

  /** Closes the encrypted store. Windows will not delete the store's files while it is open, so tests close before cleanup. */
  close(): void {
    this.store.close();
  }

  get configuration(): TwinConfig {
    return { ...this.config, excludedApps: [...this.config.excludedApps], installedModels: [...this.config.installedModels] };
  }

  updateConfig(patch: Partial<TwinConfig>): TwinConfig {
    const parsed = TwinConfigSchema.parse({ ...this.config, ...patch });
    const excludedChanged = JSON.stringify(parsed.excludedApps) !== JSON.stringify(this.config.excludedApps);
    // The dismissed signatures that name an excluded app go with its events, from the saved config as well.
    const next = excludedChanged
      ? { ...parsed, dismissedRoutineSignatures: withoutExcludedApps(parsed.dismissedRoutineSignatures, parsed.excludedApps) }
      : parsed;
    if (this.config.automationsEnabled && !next.automationsEnabled) this.stopGeneration++;
    if (this.config.allowUnattended && !next.allowUnattended) this.unattendedGeneration++;
    this.config = next;
    this.store.replaceAll('settings', [next]);
    if (excludedChanged) this.purgeExcluded();
    return this.configuration;
  }

  /** An app added to the exclusion list is forgotten, not just ignored from now on. Its dismissed signatures go in updateConfig. */
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
    const segments = segment(this.minableEvents(ANALYSIS_DAYS), this.config.idleGapMs);
    const routines = mineRoutines(segments, DEFAULT_MINING);
    this.relinkLegacyRoutines(routines);
    this.adoptLegacyDismissals(routines);
    return { segments, routines };
  }

  /**
   * Detected routines that are neither accepted nor dismissed, each with the automation it would become. A near copy of
   * a dismissed routine is dismissed too.
   */
  suggestions(): Suggestion[] {
    // Analysed first, so a record moved to a new routine id is read after the move.
    const routines = this.analyze().routines;
    const accepted = new Set(this.readAutomations().map(automation => automation.routineId));
    return routines
      .filter(routine => !accepted.has(routine.id) && !this.isDismissed(routine))
      .map(routine => ({ routine, preview: compileRoutine(routine, this.routineNames.get(routine.id)) }));
  }

  /**
   * Detected routines the naming job may name: neither accepted nor dismissed, and able to compile. A routine whose
   * rule-based name is too long to compile is skipped, so it cannot stop the routines after it from being named.
   */
  routinesToName(): Routine[] {
    const routines = this.analyze().routines;
    const accepted = new Set(this.readAutomations().map(automation => automation.routineId));
    return routines.filter(routine => {
      if (accepted.has(routine.id) || this.isDismissed(routine)) return false;
      try {
        compileRoutine(routine, this.routineNames.get(routine.id));
        return true;
      } catch {
        return false;
      }
    });
  }

  /**
   * Sets the name shown for a detected routine, such as one the local model wrote. Without one, the rule-based
   * name is used. Accepting a routine keeps the name it had at that moment.
   */
  setRoutineName(routineId: string, name: string): void {
    this.routineNames.delete(routineId);
    this.routineNames.set(routineId, name);
    if (this.routineNames.size > MAX_ROUTINE_NAMES) {
      const oldest = this.routineNames.keys().next();
      if (!oldest.done) this.routineNames.delete(oldest.value);
    }
  }

  /** The kind label the decision model gave a routine, when it gave one. Otherwise undefined and the rules apply. */
  routineKind(routineId: string): KindLabeling | undefined {
    return this.routineKinds.get(routineId);
  }

  /** Stores a kind label for a routine. Bounded like the names, so memory does not grow with the history. */
  setRoutineKind(routineId: string, labeling: KindLabeling): void {
    this.routineKinds.delete(routineId);
    this.routineKinds.set(routineId, labeling);
    if (this.routineKinds.size > MAX_ROUTINE_NAMES) {
      const oldest = this.routineKinds.keys().next();
      if (!oldest.done) this.routineKinds.delete(oldest.value);
    }
  }

  /**
   * Routines the kind labeller may label: detected, neither accepted nor dismissed, not labelled yet, and with a step the
   * catalogue does not know. A routine made only of known apps is labelled by the rules, so it is never asked about.
   */
  routinesToLabelKind(): Array<{ routineId: string; steps: Array<{ app: string; windowClass: Routine['steps'][number]['windowClass'] }> }> {
    const routines = this.analyze().routines;
    const accepted = new Set(this.readAutomations().map(automation => automation.routineId));
    return routines
      .filter(
        routine =>
          !accepted.has(routine.id) &&
          !this.isDismissed(routine) &&
          !this.routineKinds.has(routine.id) &&
          hasUnknownStep(routine.steps),
      )
      .map(routine => ({ routineId: routine.id, steps: routine.steps.map(step => ({ app: step.app, windowClass: step.windowClass })) }));
  }

  /** The label a suggestion shows: the model's when it gave one, else the rule-based label of its steps. */
  kindOfRoutine(routine: Routine): { label: KindLabeling['kind']; source: 'model' | 'rule' } {
    const labeled = this.routineKinds.get(routine.id);
    if (labeled) return { label: labeled.kind, source: labeled.source };
    return { label: ruleKindOfSteps(routine.steps), source: 'rule' };
  }

  /**
   * Routines that may be offered when this app comes into focus. Only routines the person set to level 3 or
   * above are eligible, so an offer always follows a deliberate decision. Stopped automations offer nothing, and so
   * does a routine the person declined too recently.
   */
  triggerCandidates(app: string): AutomationView[] {
    if (!this.config.automationsEnabled) return [];
    const normalized = normalizeAppName(app);
    return this.automations().filter(
      view =>
        view.state.level >= 3 &&
        openingApps(view.automation).includes(normalized) &&
        this.gate.eligible(view.automation.routineId),
    );
  }

  /** An offer was made for this automation. It is not offered again until the offer cooldown ends. */
  recordOffer(automationId: string): void {
    this.gate.recordOffer(this.requireAutomation(automationId).routineId);
  }

  /** "Not now" on an offer. The routine waits, and waits longer each time the person declines it in a row. */
  recordDecline(automationId: string): void {
    this.gate.recordDecline(this.requireAutomation(automationId).routineId);
    this.updateConfig({ declinedRoutines: this.gate.declineRecords() });
  }

  /** After a run, the twin stays quiet for a short time, so the run's own app switches do not trigger an offer. */
  quietAfterRun(): void {
    this.gate.quietAfterRun();
  }

  /**
   * "Not a routine". The routine is not suggested again, and neither is one that differs from it by a single step. A
   * dismissal counts as a decline, so it lengthens the routine's wait the same way. A routine dismissed by an earlier
   * version has its id only, so dismissing it again stores its signature when it is still detected.
   */
  dismissRoutine(routineId: string): void {
    const routine = this.analyze().routines.find(candidate => candidate.id === routineId);
    const alreadyDismissed = this.config.dismissedRoutineIds.includes(routineId);
    const signatures = routine
      ? addSignature(this.config.dismissedRoutineSignatures, signatureOf(routine))
      : this.config.dismissedRoutineSignatures;
    // Already dismissed with its signature kept: nothing to change, and no decline is counted again.
    if (alreadyDismissed && signatures.length === this.config.dismissedRoutineSignatures.length) return;
    if (routine && !alreadyDismissed) this.gate.recordDecline(routineId);
    this.updateConfig({
      dismissedRoutineIds: alreadyDismissed
        ? this.config.dismissedRoutineIds
        : [...this.config.dismissedRoutineIds, routineId].slice(-500),
      dismissedRoutineSignatures: signatures,
      declinedRoutines: this.gate.declineRecords(),
    });
  }

  /**
   * "Reset" on a routine the person said no to. Its decline and wait go, and a dismissal is lifted with its signature, so the
   * routine can be suggested again as a new one would be. The signature is found by the routine's id, so this works when the
   * routine is no longer detected. An id with nothing to reset changes nothing.
   */
  resetDecline(routineId: string): void {
    const cleared = this.gate.resetDeclines(routineId);
    const dismissed = this.config.dismissedRoutineIds.includes(routineId);
    if (!cleared && !dismissed) return;
    this.updateConfig({
      declinedRoutines: this.gate.declineRecords(),
      dismissedRoutineIds: this.config.dismissedRoutineIds.filter(id => id !== routineId),
      dismissedRoutineSignatures: withoutRoutine(this.config.dismissedRoutineSignatures, routineId),
    });
  }

  /** Accepting a routine creates a draft automation at level 2. Nothing runs yet. */
  acceptRoutine(routineId: string, name?: string): AutomationView {
    const existing = this.readAutomations().find(automation => automation.routineId === routineId);
    if (existing) return this.view(existing);

    const routine = this.analyze().routines.find(candidate => candidate.id === routineId);
    if (!routine) throw new Error('That routine is no longer detected.');

    const automation = compileRoutine(routine, name ?? this.routineNames.get(routineId));
    this.writeAutomation(automation);
    this.writeState(initialState(automation.id, effectsOf(automation)));
    this.clearDeclines(routineId);
    return this.view(automation);
  }

  /**
   * Changes an automation's name. A longer name is cut to fit, as an accepted routine's name is. Only the name changes:
   * the level, the steps, the runs and the ids stay as they are. The name is typed, so the export leaves it out.
   */
  renameAutomation(automationId: string, name: string): AutomationView {
    const next = name.trim();
    if (!next) throw new Error('Give the automation a name.');
    const renamed = AutomationSchema.parse({ ...this.requireAutomation(automationId), name: fitName(next) });
    this.markRenamed(automationId);
    this.writeAutomation(renamed);
    return this.view(renamed);
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
    if (request.mode !== 'dry_run' && !this.config.automationsEnabled) {
      throw new Error('Automations are stopped. Resume them in settings first.');
    }
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
    const generationAtStart = this.stopGeneration;
    const unattendedGenerationAtStart = this.unattendedGeneration;
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
          currentPolicy: () => ({
            level: this.requireState(automationId).level,
            maxLevel: this.config.maxAutonomyLevel,
            unattended: request.mode === 'unattended',
            excludedApps: this.config.excludedApps,
          }),
          shouldStop: () =>
            generationAtStart !== this.stopGeneration ||
            !this.config.automationsEnabled ||
            (request.mode === 'unattended' &&
              (unattendedGenerationAtStart !== this.unattendedGeneration || !this.config.allowUnattended)),
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
        // A completed run shows the routine is wanted, so its declines start again. A failed run does not.
        if (result.status === 'completed') this.clearDeclines(automation.routineId);
      }
      return result;
    } finally {
      this.running.delete(automationId);
    }
  }

  /**
   * How much of each app's repeated work could run on its own, over the last seven days. The routines are the ones
   * Suggestions shows, mined from the same events, so the page and the suggestions agree.
   */
  readiness(): AppReadinessView {
    const routines = this.analyze().routines;
    return computeReadiness({
      now: this.now(),
      events: this.minableEvents(ANALYSIS_DAYS),
      idleGapMs: this.config.idleGapMs,
      routines,
      automations: this.automations(),
      // A near copy of a dismissed routine is shown as dismissed too, the way the routine list shows it.
      dismissedRoutineIds: routines.filter(routine => this.isDismissed(routine)).map(routine => routine.id),
    });
  }

  /**
   * How the person usually works, over the last four weeks. Rebuilt from the stored events on each call. Nothing is
   * stored, so wipe and export need no change.
   */
  habits(): HabitsView {
    return computeHabits(this.recentEvents(HABITS_WINDOW_DAYS), this.now(), this.config.idleGapMs);
  }

  /**
   * What the twin knows about the person's routines, for the What the twin knows page. It is rebuilt from the stored events on
   * each call. The declines and dismissals it shows are the ones kept in the config, so nothing new is stored.
   */
  knownRoutines(): KnownRoutinesView {
    return knownRoutinesView({
      routines: this.analyze().routines,
      accepted: this.automations().map(view => ({ automation: view.automation, level: view.state.level })),
      isDismissed: routine => this.isDismissed(routine),
      modelName: routineId => this.routineNames.get(routineId),
      dismissedIds: this.config.dismissedRoutineIds,
      declines: this.gate.declineRecords(),
    });
  }

  /** Every network call the twin has made. Stored sealed, shown to the person. */
  recordNetworkCall(entry: NetworkEntry): void {
    this.store.append('ledger', entry);
  }

  networkLedger(): NetworkEntry[] {
    return this.store.readAll<NetworkEntry>('ledger');
  }

  /**
   * The tasks of one local day, today by default: the rule-based grouping of the day's work with the person's decisions
   * applied. Rebuilt from the stored events on each call, so only the decisions are kept.
   */
  dayTasks(day: string = dayKeyOf(this.now())): DayTasksView {
    return tasksForDay(this.unexcludedEvents(), this.readTaskDecisions(), day, this.config.idleGapMs);
  }

  /**
   * Records one decision about a day's tasks. It is checked against the tasks as they stand, so a decision that no longer
   * fits (a task already merged away, say) is refused and nothing is stored. The record holds ids and the action only.
   */
  decideTask(input: unknown): void {
    const decision = parseTaskDecision(input);
    if (!decisionFits(this.unexcludedEvents(), this.readTaskDecisions(), this.config.idleGapMs, decision)) {
      throw new Error('That change no longer fits the tasks for that day. Refresh the review and try again.');
    }
    this.store.append('taskDecisions', decision);
  }

  /** Records a model that was downloaded and verified. A model with the same id is replaced. */
  markModelInstalled(model: InstalledModel): void {
    const others = this.config.installedModels.filter(installed => installed.id !== model.id);
    this.updateConfig({ installedModels: [...others, model] });
  }

  removeModelRecord(modelId: string): void {
    this.updateConfig({ installedModels: this.config.installedModels.filter(installed => installed.id !== modelId) });
  }

  completeSetup(): void {
    this.updateConfig({ setupCompleted: true });
  }

  /** Focus switches by weekday (0 = Monday) and hour, over the last four weeks. */
  activityGrid(days = 28): number[][] {
    const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    for (const event of this.recentEvents(days)) {
      if (event.kind !== 'focus' || !event.app) continue;
      const date = new Date(event.ts);
      const weekday = (date.getDay() + 6) % 7;
      grid[weekday][date.getHours()] += 1;
    }
    return grid;
  }

  /** Focus counts per app over the last N days plus the strongest mined pattern score. Names stay on this device. */
  appUsage(days = 7): Array<{
    app: string;
    windowClass: WindowClass;
    events: number;
    learningScore: number;
    patternCount: number;
    patternSupport: number;
    patternDays: number;
  }> {
    const counts = new Map<string, { windowClass: WindowClass; events: number }>();
    for (const event of this.recentEvents(days)) {
      if (event.kind !== 'focus' || !event.app || !event.windowClass) continue;
      const entry = counts.get(event.app) ?? { windowClass: event.windowClass, events: 0 };
      entry.events++;
      counts.set(event.app, entry);
    }
    const patternSignals = new Map<string, { count: number; score: number; support: number; days: number }>();
    for (const routine of this.analyze().routines) {
      const apps = new Set(routine.steps.flatMap(step => [step.app, ...step.options]));
      for (const app of apps) {
        const current = patternSignals.get(app) ?? { count: 0, score: 0, support: 0, days: 0 };
        current.count++;
        if (routine.score > current.score) {
          current.score = routine.score;
          current.support = routine.support;
          current.days = routine.days;
        }
        patternSignals.set(app, current);
      }
    }
    return [...counts.entries()]
      .map(([app, entry]) => {
        const signal = patternSignals.get(app);
        return {
          app,
          ...entry,
          learningScore: signal?.score ?? 0,
          patternCount: signal?.count ?? 0,
          patternSupport: signal?.support ?? 0,
          patternDays: signal?.days ?? 0,
        };
      })
      .sort((a, b) => b.events - a.events)
      .slice(0, 10);
  }

  /** Days since the first recorded event, and the number of focus events kept. */
  observed(): { observedDays: number; recordedFocusEvents: number } {
    const events = this.store.readAll<TwinEvent>('events').filter(event => event.kind === 'focus');
    if (events.length === 0) return { observedDays: 0, recordedFocusEvents: 0 };
    const first = Math.min(...events.map(event => event.ts));
    return { observedDays: Math.max(0, Math.floor((this.now() - first) / DAY_MS)), recordedFocusEvents: events.length };
  }

  storageBytes(): number {
    return this.store.sizeBytes();
  }

  /**
   * Drops events, handoff records, task decisions and dismissed signatures past the retention window. A signature goes
   * once the events no longer hold the sites or unknown apps it names. Returns how many records were removed.
   */
  prune(): number {
    const cutoff = this.now() - RETENTION_DAYS * DAY_MS;
    const all = this.store.readAll<TwinEvent>('events');
    const kept = all.filter(event => event.ts >= cutoff);
    if (kept.length !== all.length) this.store.replaceAll('events', kept);
    return (
      all.length - kept.length + this.pruneHandoffs(cutoff) + this.pruneTaskDecisions(cutoff) + this.pruneSignatures(kept)
    );
  }

  /**
   * Everything the twin holds about the person, for the person. Handoff rows from earlier versions are included as they
   * were stored, so the export does not lose them. Nothing else reads them. The export is plain text, so a name the
   * person typed, for a task or an automation, is replaced by a placeholder. A cleared task name holds no typed text.
   */
  exportAll(): object {
    const renamed = this.renamedAutomationIds();
    return {
      exportedAt: new Date(this.now()).toISOString(),
      config: this.configuration,
      events: this.store.readAll<TwinEvent>('events'),
      automations: this.readAutomations().map(automation =>
        renamed.has(automation.id) ? { ...automation, name: TYPED_NAME_NOT_EXPORTED } : automation,
      ),
      autonomy: this.readStates(),
      network: this.networkLedger(),
      handoffs: this.store.readAll<unknown>('handoffs'),
      taskDecisions: this.readTaskDecisions().map(decision =>
        decision.kind === 'rename' && decision.name !== '' ? { ...decision, name: TYPED_NAME_NOT_EXPORTED } : decision,
      ),
    };
  }

  /** Removes all stored data. The caller must also destroy the data key to make recovery impossible. */
  wipe(): void {
    this.store.wipe();
  }

  /** Dismissed by id, or a near copy of a dismissed routine (see matchesDismissed). */
  private isDismissed(routine: Routine): boolean {
    return matchesDismissed(routine, this.config.dismissedRoutineIds, this.config.dismissedRoutineSignatures);
  }

  /** An accept or a completed run starts the routine's count again. The config is written only when there was a count. */
  private clearDeclines(routineId: string): void {
    if (this.gate.resetDeclines(routineId)) this.updateConfig({ declinedRoutines: this.gate.declineRecords() });
  }

  private recentEvents(days: number): TwinEvent[] {
    const since = this.now() - days * DAY_MS;
    return this.store.readAll<TwinEvent>('events').filter(event => event.ts >= since);
  }

  /**
   * The events that mining and readiness may read. Capture and purge already keep an excluded app out of the store.
   * This filter is the last check, so no routine can name one.
   */
  private minableEvents(days: number): TwinEvent[] {
    return this.recentEvents(days).filter(event => !event.app || !isExcludedApp(event.app, this.config.excludedApps));
  }

  private autonomyConfig(): AutonomyConfig {
    return { maxLevel: this.config.maxAutonomyLevel, allowUnattended: this.config.allowUnattended };
  }

  private view(automation: Automation): AutomationView {
    const stored = this.readStates().find(candidate => candidate.automationId === automation.id);
    const state = stored ? withEffects(stored, automation) : initialState(automation.id, effectsOf(automation));
    return { automation, state, promotion: promotionCheck(state, this.now(), this.autonomyConfig()) };
  }

  /**
   * Stored automations and dismissals can name a routine by the id it had before a browser step kept its site (see
   * legacyRoutineIdOf). Where exactly one detected routine has that id, the record moves to the routine's id, so the
   * routine stays accepted or dismissed. A record that is already moved is not found again, so this writes only once.
   */
  private relinkLegacyRoutines(routines: readonly Routine[]): void {
    const relinks = legacyRelinks(routines);
    if (relinks.size === 0) return;
    const moved = (id: string): string => relinks.get(id)?.id ?? id;

    const records = this.store.readAll<Record<string, unknown>>('automations');
    const automationsMove = records.some(record => typeof record.routineId === 'string' && moved(record.routineId) !== record.routineId);
    if (automationsMove) {
      this.store.replaceAll(
        'automations',
        records.map(record => (typeof record.routineId === 'string' ? { ...record, routineId: moved(record.routineId) } : record)),
      );
    }

    const dismissed = [...new Set(this.config.dismissedRoutineIds.map(moved))];
    if (JSON.stringify(dismissed) !== JSON.stringify(this.config.dismissedRoutineIds)) {
      this.updateConfig({ dismissedRoutineIds: dismissed });
    }
  }

  private readAutomations(): Automation[] {
    return this.store.readAll<unknown>('automations').map(record => AutomationSchema.parse(record));
  }

  private readStates(): AutonomyState[] {
    return this.store.readAll<AutonomyState>('autonomy');
  }

  /** Every stored event except those of an excluded app. Task names come only from these, as the other readings do. */
  private unexcludedEvents(): TwinEvent[] {
    return this.store.readAll<TwinEvent>('events').filter(event => !event.app || !isExcludedApp(event.app, this.config.excludedApps));
  }

  /** The stored task decisions that fit the schema. A row that does not parse is left out rather than failing the read. */
  private readTaskDecisions(): TaskDecision[] {
    return this.store.readAll<unknown>('taskDecisions').flatMap(record => {
      const parsed = TaskDecisionSchema.safeParse(record);
      return parsed.success ? [parsed.data] : [];
    });
  }

  /** A decision is kept for as long as the events of its day are kept. Returns how many were removed. */
  private pruneTaskDecisions(cutoff: number): number {
    const cutoffDay = dayKeyOf(cutoff);
    const rows = this.store.readAll<unknown>('taskDecisions');
    const kept = rows.filter(row => {
      const parsed = TaskDecisionSchema.safeParse(row);
      return !parsed.success || parsed.data.day >= cutoffDay;
    });
    if (kept.length !== rows.length) this.store.replaceAll('taskDecisions', kept);
    return rows.length - kept.length;
  }

  /**
   * A dismissed signature names the sites and unknown apps it was copied from, so it is kept only while the events still
   * hold them, and lasts no longer than those events. One that names an excluded app goes too, even when the exclusion
   * was saved before this check existed. Returns how many were removed.
   */
  private pruneSignatures(events: readonly TwinEvent[]): number {
    const signatures = this.config.dismissedRoutineSignatures;
    const kept = signaturesWithNamesIn(withoutExcludedApps(signatures, this.config.excludedApps), events);
    if (kept.length === signatures.length) return 0;
    this.updateConfig({ dismissedRoutineSignatures: kept });
    return signatures.length - kept.length;
  }

  /**
   * A routine dismissed by an earlier version has its id only. When it is detected again, its signature is stored, so its
   * near copies are hidden too, as every other dismissal is. Written once per routine, and only when one is missing.
   */
  private adoptLegacyDismissals(routines: readonly Routine[]): void {
    const legacy = routines.filter(routine => this.config.dismissedRoutineIds.includes(routine.id));
    if (legacy.length === 0) return;
    const signatures = legacy.reduce<string[]>(
      (kept, routine) => addSignature(kept, signatureOf(routine)),
      this.config.dismissedRoutineSignatures,
    );
    if (signatures.length !== this.config.dismissedRoutineSignatures.length) {
      this.updateConfig({ dismissedRoutineSignatures: signatures });
    }
  }

  /**
   * A handoff record is kept for the same window as an event, counted from the time it was sent. A row with no readable
   * send time cannot be aged, so it is removed. Returns how many were removed.
   */
  private pruneHandoffs(cutoff: number): number {
    const rows = this.store.readAll<unknown>('handoffs');
    const kept = rows.filter(row => {
      const sentAt = handoffSentAt(row);
      return sentAt !== undefined && sentAt >= cutoff;
    });
    if (kept.length !== rows.length) this.store.replaceAll('handoffs', kept);
    return rows.length - kept.length;
  }

  private requireAutomation(automationId: string): Automation {
    const automation = this.readAutomations().find(candidate => candidate.id === automationId);
    if (!automation) throw new Error('Unknown automation.');
    return automation;
  }

  private requireState(automationId: string): AutonomyState {
    const state = this.readStates().find(candidate => candidate.automationId === automationId);
    if (!state) throw new Error('Unknown automation.');
    return withEffects(state, this.requireAutomation(automationId));
  }

  /** Writes an automation in its place, so a rename keeps the order of the list. A new automation goes last. */
  private writeAutomation(automation: Automation): void {
    const current = this.readAutomations();
    const exists = current.some(candidate => candidate.id === automation.id);
    const next = exists
      ? current.map(candidate => (candidate.id === automation.id ? automation : candidate))
      : [...current, automation];
    this.store.replaceAll('automations', next);
  }

  /** The automations whose name the person typed. The export replaces their names. */
  private renamedAutomationIds(): Set<string> {
    return new Set(this.store.readAll<{ automationId: string }>('renamedAutomations').map(row => row.automationId));
  }

  /** Records, once, that the person typed an automation's name. The mark holds the id only, never the name. */
  private markRenamed(automationId: string): void {
    if (!this.renamedAutomationIds().has(automationId)) this.store.append('renamedAutomations', { automationId });
  }

  private writeState(state: AutonomyState): void {
    const others = this.readStates().filter(candidate => candidate.automationId !== state.automationId);
    this.store.replaceAll('autonomy', [...others, state]);
  }
}
