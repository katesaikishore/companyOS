import type { WorkerRequest, WorkerResponse } from './protocol';
import type { CompletionRequest, LocalCompleter } from './types';

/** One worker process as the client sees it. The desktop app wraps a utility process, and tests wrap a fake. */
export interface WorkerChannel {
  post(message: WorkerRequest): void;
  onMessage(listener: (message: WorkerResponse) => void): void;
  onExit(listener: () => void): void;
  kill(): void;
}

export interface LocalModelClientOptions {
  /** The model file to run. The caller has already checked its digest. */
  modelPath: string;
  /** The directory the model must live in. */
  modelsDir: string;
  /** Starts a worker process. Called again after a worker stops. */
  start: () => WorkerChannel;
  contextSize?: number;
  /** Stops the worker after this long with no request, so the model's memory is returned. */
  idleStopMs?: number;
  loadTimeoutMs?: number;
}

const DEFAULT_CONTEXT_SIZE = 2048;
const DEFAULT_IDLE_STOP_MS = 5 * 60_000;
const DEFAULT_LOAD_TIMEOUT_MS = 3 * 60_000;

interface Waiter {
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
}

/**
 * Runs one local model in a worker process. Requests are served one at a time. The worker starts on first use and
 * stops after a quiet period. A cancelled generation cannot be resumed, so cancelling also stops the worker. Nothing
 * here keeps the model's text beyond the result it asked for.
 */
export class LocalModelClient implements LocalCompleter {
  private channel: WorkerChannel | undefined;
  private loaded = false;
  private nextId = 1;
  private readonly waiters = new Map<number, Waiter>();
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: LocalModelClientOptions) {}

  complete(request: CompletionRequest): Promise<unknown> {
    if (request.signal?.aborted) return Promise.reject(new Error('The local model request was cancelled.'));
    return this.serial(async () => {
      try {
        const channel = await this.ensureLoaded();
        const reply = await this.exchange(
          channel,
          id => ({
            type: 'complete',
            id,
            system: request.system,
            prompt: request.prompt,
            schema: request.schema,
            maxTokens: request.maxTokens,
          }),
          request.signal,
        );
        if (reply.type !== 'completed') throw new Error('The local model did not finish.');
        return reply.value;
      } finally {
        this.restartIdleClock();
      }
    });
  }

  /**
   * Loads the model now, so the first request does not spend its time limit on loading. Loading has its own, longer
   * limit (loadTimeoutMs), so a slow disk does not look like a slow answer.
   */
  warm(): Promise<void> {
    return this.serial(async () => {
      try {
        await this.ensureLoaded();
      } finally {
        this.restartIdleClock();
      }
    });
  }

  /** Stops the worker now and returns the model's memory. The next request starts a new worker. */
  stop(): void {
    const channel = this.channel;
    this.forget();
    channel?.kill();
    this.failWaiters(new Error('The local model stopped.'));
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      clearTimeout(this.idleTimer);
      return task();
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async ensureLoaded(): Promise<WorkerChannel> {
    if (this.channel && this.loaded) return this.channel;
    const channel = this.channel ?? this.spawn();
    const reply = await this.exchange(
      channel,
      id => ({
        type: 'load',
        id,
        modelsDir: this.options.modelsDir,
        modelPath: this.options.modelPath,
        contextSize: this.options.contextSize ?? DEFAULT_CONTEXT_SIZE,
      }),
      undefined,
      this.options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS,
    );
    if (reply.type !== 'loaded') {
      this.stop();
      throw new Error('The local model could not be loaded.');
    }
    this.loaded = true;
    return channel;
  }

  private spawn(): WorkerChannel {
    const channel = this.options.start();
    channel.onMessage(message => this.waiters.get(message.id)?.resolve(message));
    channel.onExit(() => {
      // An exit from a worker this client already replaced is not news.
      if (this.channel !== channel) return;
      this.forget();
      this.failWaiters(new Error('The local model stopped.'));
    });
    this.channel = channel;
    return channel;
  }

  private exchange(
    channel: WorkerChannel,
    build: (id: number) => WorkerRequest,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<WorkerResponse> {
    if (signal?.aborted) return Promise.reject(new Error('The local model request was cancelled.'));
    const id = this.nextId++;
    return new Promise<WorkerResponse>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.waiters.delete(id);
      };
      const onAbort = (): void => {
        settle();
        this.stop();
        reject(new Error('The local model request was cancelled.'));
      };
      this.waiters.set(id, {
        resolve: response => {
          settle();
          resolve(response);
        },
        reject: error => {
          settle();
          reject(error);
        },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      // A worker that never answers is stopped, which rejects this request through failWaiters().
      if (timeoutMs !== undefined) timer = setTimeout(() => this.stop(), timeoutMs);
      try {
        channel.post(build(id));
      } catch {
        this.stop();
      }
    });
  }

  /** Counts the quiet period again, but only while a worker is running. */
  private restartIdleClock(): void {
    if (!this.channel) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), this.options.idleStopMs ?? DEFAULT_IDLE_STOP_MS);
    this.idleTimer.unref?.();
  }

  private forget(): void {
    this.channel = undefined;
    this.loaded = false;
    clearTimeout(this.idleTimer);
  }

  private failWaiters(error: Error): void {
    for (const waiter of [...this.waiters.values()]) waiter.reject(error);
  }
}
