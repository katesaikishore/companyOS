import {
  DownloadError,
  HUGGING_FACE_HOSTS,
  LocalModelClient,
  RoutineNamingJob,
  downloadModel,
  findModel,
  modelUrl,
  modelWorkAllowed,
  verifyModelFile,
  type DownloadState,
  type ModelSpec,
  type NetworkEntry,
  type TwinAgent,
  type WorkerChannel,
} from '@companyos/twin-core';
import { utilityProcess, type UtilityProcess } from 'electron';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface ModelManagerOptions {
  modelsDir: string;
  agent: TwinAgent;
  /** Called whenever progress or state changes, so the page can refresh. */
  onChange: () => void;
  /** Injected for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

interface Active {
  controller: AbortController;
  state: DownloadState;
}

/**
 * Installs open models one at a time. Each download is checked against the catalog digest before it is kept, and
 * every network call is written to the ledger. A model is only ever installed from its own Hugging Face file.
 */
export class ModelManager {
  private readonly active = new Map<string, Active>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: ModelManagerOptions) {}

  /** Downloads currently running, queued, or finished in this session. */
  states(): DownloadState[] {
    return [...this.active.values()].map(entry => ({ ...entry.state }));
  }

  /** The models folder. Nothing outside it is ever loaded as a model. */
  get directory(): string {
    return this.options.modelsDir;
  }

  pathFor(spec: ModelSpec): string {
    return join(this.options.modelsDir, spec.file);
  }

  /** Queues an install. Resolves once it is queued; progress arrives through states(). */
  install(modelId: string): void {
    const spec = findModel(modelId);
    if (!spec) throw new Error('Unknown model.');
    const existing = this.active.get(modelId);
    if (existing && existing.state.status === 'running') return;
    if (this.options.agent.configuration.installedModels.some(installed => installed.id === modelId)) return;

    const controller = new AbortController();
    const state: DownloadState = { modelId, status: 'running', receivedBytes: 0, totalBytes: spec.sizeBytes };
    this.active.set(modelId, { controller, state });
    this.options.onChange();
    this.queue = this.queue.then(() => this.run(spec, controller.signal, state));
  }

  cancel(modelId: string): void {
    this.active.get(modelId)?.controller.abort();
  }

  /** Deletes an installed model file. Only files inside the models folder, named by the catalog, are removed. */
  async remove(modelId: string): Promise<void> {
    const spec = findModel(modelId);
    if (!spec) throw new Error('Unknown model.');
    await rm(join(this.options.modelsDir, spec.file), { force: true });
    this.active.delete(modelId);
    this.options.agent.removeModelRecord(modelId);
    this.options.onChange();
  }

  /** Forgets installs whose file is gone or no longer the right size. Runs at launch. */
  async reconcile(): Promise<void> {
    for (const installed of this.options.agent.configuration.installedModels) {
      const spec = findModel(installed.id);
      const path = spec ? join(this.options.modelsDir, spec.file) : undefined;
      const info = path ? await stat(path).catch(() => undefined) : undefined;
      if (!spec || !info || info.size !== spec.sizeBytes) this.options.agent.removeModelRecord(installed.id);
    }
  }

  async hasVerifiedFile(spec: ModelSpec): Promise<boolean> {
    return verifyModelFile(join(this.options.modelsDir, spec.file), spec);
  }

  private async run(spec: ModelSpec, signal: AbortSignal, state: DownloadState): Promise<void> {
    const url = new URL(modelUrl(spec));
    const path = url.pathname;
    const record = (outcome: NetworkEntry['outcome'], bytes: number, verified: boolean, host: string): void => {
      this.options.agent.recordNetworkCall({
        ts: Date.now(),
        purpose: 'model_download',
        modelId: spec.id,
        host,
        path,
        bytes,
        sha256Verified: verified,
        outcome,
      });
    };

    if (signal.aborted) {
      state.status = 'cancelled';
      this.options.onChange();
      return;
    }

    await mkdir(this.options.modelsDir, { recursive: true, mode: 0o700 });
    try {
      const result = await downloadModel({
        spec,
        destinationDir: this.options.modelsDir,
        allowedHosts: HUGGING_FACE_HOSTS,
        signal,
        fetchImpl: this.options.fetchImpl,
        onProgress: received => {
          state.receivedBytes = received;
          this.options.onChange();
        },
      });
      record('ok', result.bytes, true, result.hosts.at(-1) ?? url.hostname);
      this.options.agent.markModelInstalled({ id: spec.id, sha256: result.sha256, bytes: result.bytes, installedAt: Date.now() });
      state.status = 'done';
      state.receivedBytes = result.bytes;
    } catch (error) {
      const cancelled = error instanceof DownloadError && error.code === 'cancelled';
      record(cancelled ? 'cancelled' : 'failed', state.receivedBytes, false, url.hostname);
      state.status = cancelled ? 'cancelled' : 'failed';
      state.message = cancelled ? undefined : error instanceof Error ? error.message : 'The download failed.';
    }
    this.options.onChange();
  }
}

/** Starts the model worker in an Electron utility process, so inference never runs on the main thread. */
export function forkModelWorker(workerPath: string): WorkerChannel {
  const child: UtilityProcess = utilityProcess.fork(workerPath, [], {
    serviceName: 'companyOS model',
    // The worker's output is dropped on purpose. It must never reach a log, because prompts are routine data.
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return {
    post: message => child.postMessage(message),
    onMessage: listener => child.on('message', listener),
    onExit: listener => {
      child.once('exit', listener);
    },
    kill: () => {
      child.kill();
    },
  };
}

export interface RoutineNamerOptions {
  agent: TwinAgent;
  models: ModelManager;
  /** The compiled worker, next to this module. */
  workerPath: string;
  /** Seconds since the last keyboard or mouse input. */
  idleSeconds: () => number;
  onBattery: () => boolean;
  /** The chat model this device was recommended, when there is one. */
  preferredModelId: () => Promise<string | undefined>;
}

/** The worker keeps the model in memory only while it is in use, then stops. */
const WORKER_IDLE_STOP_MS = 5 * 60_000;

/**
 * Wires the engine's naming job to this device: the models folder, the utility process that runs the model, and the
 * power and idle state. The job itself is in the engine, where it is tested with fakes. A new name is not pushed to
 * the page. An open page reads it on its next status poll, within two seconds while the window is visible.
 */
export function createRoutineNamer(options: RoutineNamerOptions): RoutineNamingJob {
  const { agent, models } = options;
  return new RoutineNamingJob({
    routines: () => agent.routinesToName(),
    rename: (routineId, name) => agent.setRoutineName(routineId, name),
    installed: () => agent.configuration.installedModels,
    preferredModelId: options.preferredModelId,
    modelPath: spec => models.pathFor(spec),
    verify: spec => models.hasVerifiedFile(spec),
    openModel: modelPath =>
      new LocalModelClient({
        modelPath,
        modelsDir: models.directory,
        start: () => forkModelWorker(options.workerPath),
        idleStopMs: WORKER_IDLE_STOP_MS,
      }),
    allowed: () => modelWorkAllowed({ onBattery: options.onBattery(), idleSeconds: options.idleSeconds() }),
  });
}
