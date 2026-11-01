import {
  DownloadError,
  HUGGING_FACE_HOSTS,
  LocalModelClient,
  RoutineNamingJob,
  WHISPER_BUNDLE,
  bundleDirectory,
  bundleSizesMatch,
  bundleTotalBytes,
  downloadBundle,
  downloadModel,
  findModel,
  modelUrl,
  modelWorkAllowed,
  verifyBundle,
  verifyModelFile,
  type BundleSpec,
  type DownloadState,
  type ModelSpec,
  type NetworkEntry,
  type TwinAgent,
  type WorkerChannel,
} from '@companyos/twin-core';
import { utilityProcess, type UtilityProcess } from 'electron';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Multi-file bundles this manager installs, such as the speech model. They use the same queue, progress and cancel as the
 * single-file catalog, and each file is checked against its pin before it is kept.
 */
const BUNDLES: readonly BundleSpec[] = [WHISPER_BUNDLE];

function findBundle(id: string): BundleSpec | undefined {
  return BUNDLES.find(bundle => bundle.id === id);
}

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
  /** Set when Delete everything starts. Nothing is queued after that, because the folder is about to go. */
  private wiping = false;

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

  /** The folder a bundle is installed in. The transcription worker checks every file in it before use. */
  bundlePath(bundle: BundleSpec): string {
    return bundleDirectory(this.options.modelsDir, bundle);
  }

  /** Queues an install. Resolves once it is queued; progress arrives through states(). */
  install(modelId: string): void {
    const target = findModel(modelId) ?? findBundle(modelId);
    if (!target) throw new Error('Unknown model.');
    if (this.wiping) throw new Error('The models are being deleted.');
    const existing = this.active.get(modelId);
    if (existing && existing.state.status === 'running') return;
    if (this.options.agent.configuration.installedModels.some(installed => installed.id === modelId)) return;

    const controller = new AbortController();
    const totalBytes = 'files' in target ? bundleTotalBytes(target) : target.sizeBytes;
    const state: DownloadState = { modelId, status: 'running', receivedBytes: 0, totalBytes };
    this.active.set(modelId, { controller, state });
    this.options.onChange();
    this.queue = this.queue.then(() =>
      'files' in target ? this.runBundle(target, controller.signal, state) : this.run(target, controller.signal, state),
    );
  }

  cancel(modelId: string): void {
    this.active.get(modelId)?.controller.abort();
  }

  /**
   * Cancels every download and waits until none is still writing, then removes the whole models folder. Delete
   * everything uses this, so no partial file is written back after the folder is gone.
   */
  async wipe(): Promise<void> {
    this.wiping = true;
    for (const entry of this.active.values()) entry.controller.abort();
    // A download still waiting its turn sees the abort when its turn comes, and returns before it touches the disk.
    await this.queue.catch(() => undefined);
    await rm(this.options.modelsDir, { recursive: true, force: true });
    this.active.clear();
    this.options.onChange();
  }

  /** Deletes an installed model file. Only files inside the models folder, named by the catalog, are removed. */
  async remove(modelId: string): Promise<void> {
    const target = findModel(modelId) ?? findBundle(modelId);
    if (!target) throw new Error('Unknown model.');
    if ('files' in target) await rm(this.bundlePath(target), { recursive: true, force: true });
    else await rm(join(this.options.modelsDir, target.file), { force: true });
    this.active.delete(modelId);
    this.options.agent.removeModelRecord(modelId);
    this.options.onChange();
  }

  /** Forgets installs whose file is gone or no longer the right size. Runs at launch. A bundle is kept only if every file is there. */
  async reconcile(): Promise<void> {
    for (const installed of this.options.agent.configuration.installedModels) {
      const bundle = findBundle(installed.id);
      if (bundle) {
        if (!(await bundleSizesMatch(bundle, this.bundlePath(bundle)))) this.options.agent.removeModelRecord(installed.id);
        continue;
      }
      const spec = findModel(installed.id);
      const path = spec ? join(this.options.modelsDir, spec.file) : undefined;
      const info = path ? await stat(path).catch(() => undefined) : undefined;
      if (!spec || !info || info.size !== spec.sizeBytes) this.options.agent.removeModelRecord(installed.id);
    }
  }

  async hasVerifiedFile(spec: ModelSpec): Promise<boolean> {
    return verifyModelFile(join(this.options.modelsDir, spec.file), spec);
  }

  /** True when every file of the bundle is present and matches its pin. Hashes each file. */
  async hasVerifiedBundle(bundle: BundleSpec): Promise<boolean> {
    return verifyBundle(bundle, this.bundlePath(bundle));
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

  /**
   * Installs a multi-file bundle. Each file is ledgered as it is requested, so the bundle needs no entry of its own. The
   * installed record carries the bundle digest, which covers the revision and every file.
   */
  private async runBundle(bundle: BundleSpec, signal: AbortSignal, state: DownloadState): Promise<void> {
    if (signal.aborted) {
      state.status = 'cancelled';
      this.options.onChange();
      return;
    }

    await mkdir(this.options.modelsDir, { recursive: true, mode: 0o700 });
    try {
      const result = await downloadBundle({
        spec: bundle,
        destinationDir: this.bundlePath(bundle),
        allowedHosts: HUGGING_FACE_HOSTS,
        signal,
        fetchImpl: this.options.fetchImpl,
        onProgress: received => {
          state.receivedBytes = received;
          this.options.onChange();
        },
        record: entry => this.options.agent.recordNetworkCall(entry),
      });
      this.options.agent.markModelInstalled({ id: bundle.id, sha256: result.digest, bytes: result.bytes, installedAt: Date.now() });
      state.status = 'done';
      state.receivedBytes = result.bytes;
    } catch (error) {
      const cancelled = error instanceof DownloadError && error.code === 'cancelled';
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
    openModel: (modelPath, template) =>
      new LocalModelClient({
        modelPath,
        modelsDir: models.directory,
        template,
        start: () => forkModelWorker(options.workerPath),
        idleStopMs: WORKER_IDLE_STOP_MS,
      }),
    allowed: () => modelWorkAllowed({ onBattery: options.onBattery(), idleSeconds: options.idleSeconds() }),
  });
}
