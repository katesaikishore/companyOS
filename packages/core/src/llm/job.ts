import type { InstalledModel, ModelSpec } from '../models/types';
import type { Routine } from '../mine';
import { chooseChatModel } from './select';
import { nameRoutine } from './namer';
import type { LocalCompleter } from './types';

/** Timing of the background naming job. Design values, not sourced standards. */
export const NAMING_TIMING = {
  /** Wait after start-up before the first pass, so launching the app is not slowed. */
  firstPassMs: 60_000,
  /** Between passes once a pass has finished. */
  passIntervalMs: 10 * 60_000,
  /** Used when model work is not allowed now, or the model failed, so the pass is tried again soon. */
  retryMs: 60_000,
} as const;

/** A model the job asks for names, with the lifecycle the job manages. */
export interface NamingModel extends LocalCompleter {
  /** Loads the model before it is asked anything, so loading does not count against a naming time limit. */
  warm(): Promise<void>;
  /** Frees the model's memory. */
  stop(): void;
}

export interface RoutineNamingJobOptions {
  /** The routines the person would see as suggestions right now. */
  routines: () => Routine[];
  /** Keeps a model name for a routine. The engine shows it from then on. */
  rename: (routineId: string, name: string) => void;
  installed: () => readonly InstalledModel[];
  preferredModelId: () => Promise<string | undefined>;
  /** Where a model's file lives. */
  modelPath: (spec: ModelSpec) => string;
  /** True when the file on disk is exactly the catalogue model. Checked once per file, because it reads the whole file. */
  verify: (spec: ModelSpec) => Promise<boolean>;
  /** Makes a model for a verified file. Nothing is started until the job asks for a name. */
  openModel: (modelPath: string) => NamingModel;
  /** False while model work must wait (plan §5.5). */
  allowed: () => boolean;
  /** Called after a pass that changed at least one name. */
  changed?: () => void;
}

/** The apps a routine was seen with. A routine is named again only when these change. */
function dataOf(routine: Routine): string {
  return routine.steps.map(step => step.options.join('|')).join('>');
}

/**
 * Names detected routines with the local model, in the background. It runs only when model work is allowed, names
 * each routine once for its current apps, and keeps the rule-based name for anything it cannot name. Names are held by
 * the engine in memory. This job never throws, and it never writes anything to disk.
 */
export class RoutineNamingJob {
  private model: NamingModel | undefined;
  private modelPath: string | undefined;
  private readonly verified = new Set<string>();
  private readonly named = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  /** Set by stop(). A halted job runs no more passes until start() is called again. */
  private halted = false;

  constructor(private readonly options: RoutineNamingJobOptions) {}

  start(delayMs: number = NAMING_TIMING.firstPassMs): void {
    this.halted = false;
    this.schedule(delayMs);
  }

  stop(): void {
    this.halted = true;
    clearTimeout(this.timer);
    this.releaseModel();
  }

  /** One pass. A pass that starts while another is running does nothing. */
  async pass(): Promise<void> {
    if (this.running || this.halted) return;
    this.running = true;
    let retryIn: number = NAMING_TIMING.passIntervalMs;
    try {
      if (this.options.allowed()) {
        const model = await this.modelForPass();
        if (model) {
          await model.warm();
          retryIn = await this.nameRoutines(model);
        }
      } else {
        retryIn = NAMING_TIMING.retryMs;
      }
    } catch {
      // Nothing here is shown. The rule-based names stay, and the next pass tries again.
      retryIn = NAMING_TIMING.retryMs;
    } finally {
      this.running = false;
      this.schedule(retryIn);
    }
  }

  private async nameRoutines(model: NamingModel): Promise<number> {
    let changed = false;
    try {
      for (const routine of this.options.routines()) {
        if (this.halted) break;
        if (!this.options.allowed()) return NAMING_TIMING.retryMs;
        const data = dataOf(routine);
        if (this.named.get(routine.id) === data) continue;

        const naming = await nameRoutine(routine, { completer: model });
        if (naming.source === 'model') {
          this.options.rename(routine.id, naming.name);
          this.named.set(routine.id, data);
          changed = true;
        } else if (naming.reason === 'invalid_output') {
          // The model answered, just not usefully. Do not ask again for the same data.
          this.named.set(routine.id, data);
        } else {
          // The model timed out or failed. Stop this pass and try again later.
          return NAMING_TIMING.retryMs;
        }
      }
    } finally {
      if (changed) this.options.changed?.();
    }
    return NAMING_TIMING.passIntervalMs;
  }

  /** The model for the recommended chat model. Undefined when none is installed or its file does not verify. */
  private async modelForPass(): Promise<NamingModel | undefined> {
    const spec = chooseChatModel(this.options.installed(), await this.options.preferredModelId());
    if (!spec) {
      this.releaseModel();
      return undefined;
    }
    const path = this.options.modelPath(spec);
    if (this.model && this.modelPath === path) return this.model;
    if (!this.verified.has(path)) {
      if (!(await this.options.verify(spec))) {
        this.releaseModel();
        return undefined;
      }
      this.verified.add(path);
    }
    this.releaseModel();
    this.modelPath = path;
    this.model = this.options.openModel(path);
    return this.model;
  }

  private releaseModel(): void {
    this.model?.stop();
    this.model = undefined;
    this.modelPath = undefined;
  }

  private schedule(delayMs: number): void {
    clearTimeout(this.timer);
    if (this.halted) return;
    this.timer = setTimeout(() => void this.pass(), delayMs);
    this.timer.unref?.();
  }
}
