import { utilityProcess, type UtilityProcess } from 'electron';
import { parseSpeakerReply, SPEAKER_EMBEDDING_VALUES, type SpeakerReply } from './speaker-protocol';

/** A request that takes longer than this is abandoned, and the speaker process is stopped. */
const EMBED_TIMEOUT_MS = 60_000;
/** The speaker process stops after this long with no segment, so the model is not held in memory while nothing is said. */
const WORKER_IDLE_STOP_MS = 5 * 60_000;

type Body = { type: 'load'; modelsDir: string } | { type: 'embed'; samples: ArrayBuffer };

interface Waiter {
  resolve: (reply: SpeakerReply) => void;
  reject: (error: Error) => void;
}

/**
 * Runs the speaker model in its own utility process, apart from the speech process. The process starts with the first segment
 * and stops after a few idle minutes. Requests run one at a time. Nothing is logged. A failed request resolves to undefined,
 * so a segment is still kept, just without a speaker.
 */
export class SpeakerEmbedder {
  private child: UtilityProcess | undefined;
  private loaded = false;
  private nextId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly waiting = new Map<number, Waiter>();

  constructor(private readonly options: { workerPath: string; modelsDir: string; idleStopMs?: number }) {}

  /** The voice embedding of a segment of 16 kHz mono audio, or undefined when it cannot be made. */
  embed(samples: Float32Array): Promise<Float32Array | undefined> {
    const run = this.queue.then(() => this.run(samples));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Stops the speaker process now. Anything still waiting is refused. The next segment starts the process again. */
  stop(): void {
    this.clearIdle();
    for (const [id, waiter] of this.waiting) {
      this.waiting.delete(id);
      waiter.reject(new Error('The speaker process stopped.'));
    }
    const child = this.child;
    this.child = undefined;
    this.loaded = false;
    child?.kill();
  }

  private async run(samples: Float32Array): Promise<Float32Array | undefined> {
    this.clearIdle();
    try {
      const child = this.child ?? this.spawn();
      if (!this.loaded) {
        const loaded = await this.call(child, { type: 'load', modelsDir: this.options.modelsDir });
        if (loaded.type !== 'loaded') return undefined;
        this.loaded = true;
      }
      // A copy, so the buffer is exactly the samples and nothing else is sent.
      const reply = await this.call(child, { type: 'embed', samples: samples.slice().buffer });
      if (reply.type !== 'embedded') return undefined;
      const vector = new Float32Array(reply.vector);
      return vector.length === SPEAKER_EMBEDDING_VALUES ? vector : undefined;
    } catch {
      return undefined;
    } finally {
      this.armIdle();
    }
  }

  private call(child: UtilityProcess, body: Body): Promise<SpeakerReply> {
    const id = this.nextId++;
    return new Promise<SpeakerReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error('The speaker check timed out.'));
        this.stop();
      }, EMBED_TIMEOUT_MS);
      this.waiting.set(id, {
        resolve: reply => {
          clearTimeout(timer);
          resolve(reply);
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        child.postMessage({ ...body, id });
      } catch {
        this.waiting.get(id)?.reject(new Error('The speaker process is not running.'));
      }
    });
  }

  private spawn(): UtilityProcess {
    const child = utilityProcess.fork(this.options.workerPath, [], {
      serviceName: 'companyOS speaker',
      // Output is dropped on purpose. The audio is personal data, so nothing it produces may reach a log.
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.on('message', (message: unknown) => this.onMessage(message));
    child.once('exit', () => this.onExit(child));
    this.child = child;
    this.loaded = false;
    return child;
  }

  private onMessage(message: unknown): void {
    const reply = parseSpeakerReply(message);
    if (!reply) return;
    const waiter = this.waiting.get(reply.id);
    if (!waiter) return;
    this.waiting.delete(reply.id);
    waiter.resolve(reply);
  }

  /** Only the current process counts. An old one that exits after a restart must not refuse the new one's requests. */
  private onExit(child: UtilityProcess): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.loaded = false;
    for (const [id, waiter] of this.waiting) {
      this.waiting.delete(id);
      waiter.reject(new Error('The speaker process stopped.'));
    }
  }

  private armIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => this.stop(), this.options.idleStopMs ?? WORKER_IDLE_STOP_MS);
  }

  private clearIdle(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}
