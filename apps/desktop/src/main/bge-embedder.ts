import { utilityProcess, type UtilityProcess } from 'electron';
import type { TextEmbedder } from '@companyos/twin-core';
import { BGE_VECTOR_VALUES, MAX_BGE_TEXT_CHARS, MAX_BGE_TEXTS, parseBgeReply, type BgeReply } from './bge-protocol';

/** A request that takes longer than this is abandoned, and the embedding process is stopped. Loading is included. */
const EMBED_TIMEOUT_MS = 120_000;
/** The embedding process stops after this long with nothing to embed, so the model is not held in memory for nothing. */
const WORKER_IDLE_STOP_MS = 5 * 60_000;

type Body = { type: 'load'; modelsDir: string } | { type: 'embed'; texts: string[] };

interface Waiter {
  resolve: (reply: BgeReply) => void;
  reject: (error: Error) => void;
}

interface BgeEmbedderOptions {
  workerPath: string;
  modelsDir: string;
  /** Whether the BGE bundle is installed and checked. */
  installed: () => boolean;
  /** Starts the BGE download, once. Every file is ledgered and checked against its pin. */
  install: () => void;
  idleStopMs?: number;
}

/**
 * Embeds text with BGE base on this Mac, in its own utility process. The process starts with the first request and stops
 * after a few idle minutes; requests run one at a time, in batches the process accepts. Until the model is installed a
 * request fails at once and starts the download, so search goes on by names, text and the graph meanwhile.
 */
export class BgeEmbedder implements TextEmbedder {
  private child: UtilityProcess | undefined;
  private loaded = false;
  private nextId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly waiting = new Map<number, Waiter>();

  constructor(private readonly options: BgeEmbedderOptions) {}

  async embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    if (!this.options.installed()) {
      this.options.install();
      throw new Error('The embedding model is still downloading.');
    }
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += MAX_BGE_TEXTS) {
      const batch = texts.slice(start, start + MAX_BGE_TEXTS).map(text => text.slice(0, MAX_BGE_TEXT_CHARS));
      const run = this.queue.then(() => this.run(batch, signal));
      this.queue = run.catch(() => undefined);
      vectors.push(...(await run));
    }
    return vectors;
  }

  /** Stops the embedding process now. Anything still waiting is refused. The next request starts the process again. */
  stop(): void {
    this.clearIdle();
    for (const [id, waiter] of this.waiting) {
      this.waiting.delete(id);
      waiter.reject(new Error('The embedding process stopped.'));
    }
    const child = this.child;
    this.child = undefined;
    this.loaded = false;
    child?.kill();
  }

  private async run(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    this.clearIdle();
    try {
      if (signal?.aborted) throw new Error('The embedding was cancelled.');
      const child = this.child ?? this.spawn();
      if (!this.loaded) {
        const loaded = await this.call(child, { type: 'load', modelsDir: this.options.modelsDir }, signal);
        if (loaded.type !== 'loaded') throw new Error('The embedding model could not load.');
        this.loaded = true;
      }
      const reply = await this.call(child, { type: 'embed', texts }, signal);
      if (reply.type !== 'embedded') throw new Error('The embedding model could not embed the text.');
      const values = new Float32Array(reply.vectors);
      if (values.length !== texts.length * BGE_VECTOR_VALUES) throw new Error('The embedding model gave vectors of another size.');
      return texts.map((_, index) => Array.from(values.subarray(index * BGE_VECTOR_VALUES, (index + 1) * BGE_VECTOR_VALUES)));
    } finally {
      this.armIdle();
    }
  }

  /** One request. A caller that gives up is answered at once; the process still finishes the request and its reply is dropped. */
  private call(child: UtilityProcess, body: Body, signal?: AbortSignal): Promise<BgeReply> {
    const id = this.nextId++;
    return new Promise<BgeReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error('The embedding timed out.'));
        this.stop();
      }, EMBED_TIMEOUT_MS);
      const onAbort = () => {
        this.waiting.delete(id);
        clearTimeout(timer);
        reject(new Error('The embedding was cancelled.'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.set(id, {
        resolve: reply => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(reply);
        },
        reject: error => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      });
      try {
        child.postMessage({ ...body, id });
      } catch {
        this.waiting.get(id)?.reject(new Error('The embedding process is not running.'));
      }
    });
  }

  private spawn(): UtilityProcess {
    const child = utilityProcess.fork(this.options.workerPath, [], {
      serviceName: 'companyOS embeddings',
      // Output is dropped on purpose. The texts are file contents, so nothing they produce may reach a log.
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.on('message', (message: unknown) => this.onMessage(message));
    child.once('exit', () => this.onExit(child));
    this.child = child;
    this.loaded = false;
    return child;
  }

  private onMessage(message: unknown): void {
    const reply = parseBgeReply(message);
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
      waiter.reject(new Error('The embedding process stopped.'));
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
