import Anthropic from '@anthropic-ai/sdk';
import {
  TwinAgent,
  type Automation,
  type AutomationView,
  type AutonomyLevel,
  type Decision,
  type Executor,
  type MessagesClient,
  type NameSuggestion,
  type RunResult,
  type Step,
  type TwinConfig,
} from '@companyos/twin-core';
import { join } from 'node:path';
import type { AppUsageView, SuggestionView, TwinStatus } from '@companyos/twin-core';
import { CaptureService } from './capture';
import { destroyStoredSecrets, loadApiKey, loadOrCreateDataKey, saveApiKey } from './keys';
import { choosePlatform, type Platform } from './platform';

export interface RuntimeOptions {
  userData: string;
  /** Asks a person to approve one step. The main process shows a native dialog. */
  approve: (automation: Automation, step: Step, decision: Decision) => Promise<boolean>;
  /** Seconds since the last keyboard or mouse input. */
  idleSeconds: () => number;
}

const NO_CONTROL: Executor = {
  focusApp: async () => {
    throw new Error('App control is not available on this system yet.');
  },
  frontmostApp: async () => undefined,
};

/**
 * Connects the twin engine to the operating system. It holds the data key and the Claude client,
 * and it is the only thing the IPC layer talks to. The renderer never receives a key or a raw event.
 */
export class TwinRuntime {
  private readonly agent: TwinAgent;
  private readonly capture: CaptureService;
  private readonly platform: Platform | undefined;
  private claude: Anthropic | undefined;

  private constructor(
    private readonly options: RuntimeOptions,
    platform: Platform | undefined,
    detail: string,
    dataKey: Buffer,
    apiKey: string | undefined,
  ) {
    this.platform = platform;
    this.claude = apiKey ? new Anthropic({ apiKey }) : undefined;
    const claude: MessagesClient = {
      messages: {
        create: async body => {
          if (!this.claude) throw new Error('No Claude API key is configured.');
          // The request body is the JSON shape the core builds; the SDK's typed params accept it at runtime.
          return (await this.claude.messages.create(body as never)) as never;
        },
      },
    };
    this.agent = new TwinAgent({ dataDir: join(options.userData, 'twin'), dataKey, claude });
    this.capture = new CaptureService({ agent: this.agent, platform, idleSeconds: options.idleSeconds }, detail);
  }

  static async create(options: RuntimeOptions): Promise<TwinRuntime> {
    const dataKey = await loadOrCreateDataKey(options.userData);
    const apiKey = await loadApiKey(options.userData);
    const { platform, detail } = await choosePlatform();
    return new TwinRuntime(options, platform, detail, dataKey, apiKey);
  }

  start(): void {
    // Retention is enforced at launch as well as daily, so an app restarted more often than once a day still prunes.
    this.agent.prune();
    this.capture.start();
    setInterval(() => this.agent.prune(), 24 * 60 * 60 * 1000).unref();
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

  status(): TwinStatus {
    const usage: AppUsageView[] = this.agent.appUsage(7).map(entry => ({
      app: entry.app,
      windowClass: entry.windowClass,
      events: entry.events,
    }));
    const suggestions: SuggestionView[] = this.agent.suggestions().map(({ routine, preview }) => ({
      routineId: routine.id,
      support: routine.support,
      days: routine.days,
      score: routine.score,
      steps: routine.steps.map(step => ({
        windowClass: step.windowClass,
        app: step.app,
        alternatives: step.options.length,
      })),
      previewName: preview.name,
    }));
    return {
      capture: this.capture.status,
      config: this.agent.configuration,
      apiKeyConfigured: this.claude !== undefined,
      usage,
      suggestions,
      automations: this.agent.automations(),
      ledger: this.agent.ledger(),
      recordedFocusEvents: this.agent.appUsage(90).reduce((sum, entry) => sum + entry.events, 0),
    };
  }

  updateConfig(patch: Partial<TwinConfig>): TwinConfig {
    return this.agent.updateConfig(patch);
  }

  acceptRoutine(routineId: string, name?: string): AutomationView {
    return this.agent.acceptRoutine(routineId, name);
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

  requestName(routineId: string): Promise<NameSuggestion | undefined> {
    return this.agent.requestName(routineId);
  }

  async setApiKey(key: string): Promise<boolean> {
    const trimmed = key.trim();
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(trimmed)) throw new Error('That does not look like a Claude API key.');
    await saveApiKey(this.options.userData, trimmed);
    this.claude = new Anthropic({ apiKey: trimmed });
    return true;
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
}
