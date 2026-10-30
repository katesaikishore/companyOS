import {
  TwinAgent,
  TwinConfigSchema,
  effectOfOp,
  effectsOf,
  planSetup,
  resolveStep,
  type Automation,
  type AutomationView,
  type AutonomyLevel,
  type Decision,
  type DraftStep,
  type Executor,
  type HardwareProfile,
  type RunResult,
  type SetupPlan,
  type Step,
  type SuggestionView,
  type TwinConfig,
  type TwinStatus,
} from '@companyos/twin-core';
import { join } from 'node:path';
import { CaptureService } from './capture';
import { destroyStoredSecrets, loadOrCreateDataKey } from './keys';
import { detectHardware } from './hardware';
import { ModelManager } from './models';
import { choosePlatform, type Platform } from './platform';

export interface RuntimeOptions {
  userData: string;
  /** Asks a person to approve one step. The main process shows a native dialog. */
  approve: (automation: Automation, step: Step, decision: Decision) => Promise<boolean>;
  /** Seconds since the last keyboard or mouse input. */
  idleSeconds: () => number;
  /** Called when model downloads change, so open pages refresh. */
  onChange: () => void;
  fetchImpl?: typeof fetch;
}

const NO_CONTROL: Executor = {
  focusApp: async () => {
    throw new Error('App control is not available on this system yet.');
  },
  frontmostApp: async () => undefined,
};

const DAY_MS = 86_400_000;

/**
 * Connects the twin engine to the operating system and to the model installer. It is the only thing the IPC
 * layer talks to, so the page never receives a key, a raw event, or a path it did not ask for.
 */
export class TwinRuntime {
  private readonly agent: TwinAgent;
  private readonly capture: CaptureService;
  private readonly platform: Platform | undefined;
  private readonly models: ModelManager;
  private hardwareProfile: Promise<HardwareProfile> | undefined;

  private constructor(
    private readonly options: RuntimeOptions,
    platform: Platform | undefined,
    detail: string,
    dataKey: Buffer,
  ) {
    this.platform = platform;
    this.agent = new TwinAgent({ dataDir: join(options.userData, 'twin'), dataKey });
    this.capture = new CaptureService({ agent: this.agent, platform, idleSeconds: options.idleSeconds }, detail);
    this.models = new ModelManager({
      modelsDir: join(options.userData, 'models'),
      agent: this.agent,
      onChange: options.onChange,
      fetchImpl: options.fetchImpl,
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
    this.capture.start();
    setInterval(() => this.agent.prune(), DAY_MS).unref();
  }

  stop(): void {
    this.capture.stop();
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

  completeSetup(): void {
    this.agent.completeSetup();
  }

  status(): TwinStatus {
    const suggestions = this.suggestionViews();
    const automations = this.agent.automations();
    const drafts = automations.filter(view => view.state.level === 2).length;
    const minutesBack = automations
      .filter(view => view.state.level >= 3)
      .reduce((sum, view) => sum + (view.automation.estimate?.minutesPerWeek ?? 0), 0);
    const observed = this.agent.observed();
    return {
      capture: this.capture.status,
      config: this.agent.configuration,
      usage: this.agent.appUsage(7).map(entry => ({ app: entry.app, windowClass: entry.windowClass, events: entry.events })),
      suggestions,
      automations,
      network: this.agent.networkLedger(),
      activity: this.agent.activityGrid(28),
      recordedFocusEvents: observed.recordedFocusEvents,
      storageBytes: this.agent.storageBytes(),
      stats: {
        routinesLearned: suggestions.length + automations.length,
        waiting: suggestions.length + drafts,
        runningOwn: automations.filter(view => view.state.level === 4).length,
        minutesBackPerWeek: Math.round(minutesBack * 10) / 10,
        observedDays: observed.observedDays,
      },
      downloads: this.models.states(),
    };
  }

  updateConfig(patch: Partial<TwinConfig>): TwinConfig {
    return this.agent.updateConfig(TwinConfigSchema.partial().parse(patch));
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
      { focusApp: app => platform.focus(app), frontmostApp: () => platform.frontmost() },
    );
  }

  exportData(): string {
    return JSON.stringify(this.agent.exportAll(), null, 2);
  }

  /** Destroys the stored data and the key. Nothing can be recovered afterwards. */
  deleteAll(): void {
    this.stop();
    this.agent.wipe();
    destroyStoredSecrets(this.options.userData);
  }

  private suggestionViews(): SuggestionView[] {
    return this.agent.suggestions().map(({ routine, preview }) => {
      const drafted: DraftStep[] = preview.steps.map(step => {
        const param = preview.params.find(candidate => `$${candidate.name}` === step.app);
        const app = resolveStep(step, preview.params, {}).app;
        return {
          kind: step.op === 'focus_app' ? 'act' : 'check',
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
        drafted,
        effects: effectsOf(preview),
        parameters: preview.params.map(param => ({ name: param.name, options: [...param.options] })),
      };
    });
  }
}
