import {
  RETENTION_DAYS,
  TRIGGER_RULES,
  TwinAgent,
  TwinConfigSchema,
  KindLabelJob,
  describeWhen,
  effectOfOp,
  effectsOf,
  modelWorkAllowed,
  planSetup,
  resolveStep,
  type Automation,
  type AutomationView,
  type AutonomyLevel,
  type Decision,
  type DraftStep,
  type Executor,
  type HardwareProfile,
  type NetworkEntry,
  type RunResult,
  type SetupPlan,
  type Step,
  type SuggestionView,
  type TwinConfig,
  type TwinStatus,
  type PendingRunView,
  type RoutineNamingJob,
  normalizeAppName,
} from '@companyos/twin-core';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BROWSER_APP_NAMES, startBrowserBridge, type BrowserBridge, type BrowserVisit } from './browser-bridge';
import { CaptureService } from './capture';
import { destroyStoredSecrets, loadOrCreateDataKey } from './keys';
import { detectHardware } from './hardware';
import { LayaBundleManager, type LayaTestOptions } from './laya';
import { LayaDecisionModel } from './decision-laya';
import { ModelManager, createRoutineNamer } from './models';
import { browserCapturePaths, installNativeHost, isBrowserCaptureSupported, removeNativeHost } from './native-host-install';
import { handsExecutor } from './agent-desktop';
import { choosePlatform, executorFor, type Platform } from './platform';

export interface RuntimeOptions {
  userData: string;
  /** Asks a person to approve one step. The main process shows a native dialog. */
  approve: (automation: Automation, step: Step, decision: Decision) => Promise<boolean>;
  /** Seconds since the last keyboard or mouse input. */
  idleSeconds: () => number;
  /** True when the device runs on battery. Model work waits for AC power or idleness (plan §5.5). */
  onBattery: () => boolean;
  /** Called when model downloads change, so open pages refresh. */
  onChange: () => void;
  /** Called when a routine is offered. The main process shows the tray and a notification. */
  onOffer: (offer: PendingRunView) => void;
  /** Called after a level 4 run so the owner can see that it ran or stopped. */
  onUnattendedRun?: (result: RunResult) => void;
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

/**
 * Connects the twin engine to the operating system and to the model installer. It is the only thing the IPC
 * layer talks to, so the page never receives a key, a raw event, or a path it did not ask for.
 */
export class TwinRuntime {
  private readonly agent: TwinAgent;
  private readonly capture: CaptureService;
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

  private constructor(
    private readonly options: RuntimeOptions,
    platform: Platform | undefined,
    detail: string,
    dataKey: Buffer,
  ) {
    this.platform = platform;
    this.agent = new TwinAgent({ dataDir: join(options.userData, 'twin'), dataKey });
    this.capture = new CaptureService(
      {
        agent: this.agent,
        platform,
        idleSeconds: options.idleSeconds,
        bridgeRunning: () => this.browserBridge !== undefined,
        onFocus: app => this.observeFocus(app),
      },
      detail,
    );
    this.models = new ModelManager({
      modelsDir: join(options.userData, 'models'),
      agent: this.agent,
      onChange: options.onChange,
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
  }

  static async create(options: RuntimeOptions): Promise<TwinRuntime> {
    const dataKey = await loadOrCreateDataKey(options.userData);
    const { platform, detail } = await choosePlatform();
    return new TwinRuntime(options, platform, detail, dataKey);
  }

  async start(): Promise<void> {
    this.agent.prune();
    await this.models.reconcile();
    await this.laya.reconcile();
    this.capture.start();
    // A bridge that cannot start leaves the setting on with no browser URLs. The app still starts, and the capture card says why.
    if (this.agent.configuration.watchBrowsers) {
      await this.setBrowserCapture(true).catch(error => {
        this.browserProblem = error instanceof Error ? error.message : 'Watch browsers could not start.';
      });
    }
    this.namer.start();
    this.startKindLabels();
    setInterval(() => this.agent.prune(), DAY_MS).unref();
  }

  stop(): void {
    this.capture.stop();
    this.browserBridge?.stop();
    this.browserBridge = undefined;
    this.namer.stop();
    this.stopKindLabels();
  }

  setLocked(locked: boolean): void {
    this.capture.setLocked(locked);
  }

  setPaused(paused: boolean): void {
    this.capture.setPaused(paused);
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
      capture: this.browserProblem ? { ...this.capture.status, detail: this.browserProblem } : this.capture.status,
      browserCaptureSupported: isBrowserCaptureSupported(),
      config,
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
  async updateConfig(patch: Partial<TwinConfig>): Promise<TwinConfig> {
    const parsed = TwinConfigSchema.partial().parse(patch);
    if (parsed.watchBrowsers !== undefined) {
      await this.setBrowserCapture(parsed.watchBrowsers);
      this.browserProblem = undefined;
    }
    return this.agent.updateConfig(parsed);
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
        this.runExecutor(platform),
      );
    });
  }

  /**
   * The executor for one run. An empty agent-desktop path keeps the built-in adapters, so focus and key steps work as
   * before. A path sends those two steps through the program, and an unusable path blocks them with the reason. The
   * program's exit status, the CLI's error code when it gave one, and the duration are logged. Nothing it was given, and
   * no error message, is.
   */
  private runExecutor(platform: Platform): Executor {
    const native = executorFor(platform);
    const binary = this.agent.configuration.agentDesktopPath.trim();
    if (binary === '') return native;
    return handsExecutor(native, {
      binary,
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
    try {
      const result = await this.withRun(() =>
        this.agent.run(
          automationId,
          { mode: 'unattended' },
          this.runExecutor(platform),
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
   * Destroys the stored data, the key and the installed models, including the decision-model bundle. Downloads are
   * cancelled before the models folder goes, so none can write back into it. Nothing can be recovered afterwards.
   */
  async deleteAll(): Promise<void> {
    this.stop();
    this.disableBrowserCapture();
    await this.laya.wipe();
    await this.models.wipe();
    this.agent.wipe();
    destroyStoredSecrets(this.options.userData);
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
