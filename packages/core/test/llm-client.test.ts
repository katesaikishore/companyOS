import { describe, expect, it, vi } from 'vitest';
import { LocalModelClient, type WorkerChannel, type WorkerRequest, type WorkerResponse } from '../src';

type Responder = (request: WorkerRequest) => WorkerResponse | undefined;

/**
 * A fake worker process. It answers each request through a responder. A responder that returns nothing leaves the
 * request unanswered, which is how the tests model a worker that hangs or dies.
 */
class FakeWorker implements WorkerChannel {
  readonly requests: WorkerRequest[] = [];
  killed = false;
  private messageListener: ((message: WorkerResponse) => void) | undefined;
  private exitListener: (() => void) | undefined;

  constructor(private readonly respond: Responder) {}

  post(message: WorkerRequest): void {
    this.requests.push(message);
    const reply = this.respond(message);
    if (reply) queueMicrotask(() => !this.killed && this.messageListener?.(reply));
  }

  onMessage(listener: (message: WorkerResponse) => void): void {
    this.messageListener = listener;
  }

  onExit(listener: () => void): void {
    this.exitListener = listener;
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.exitListener?.();
  }

  /** The worker died on its own, as a crash would. */
  crash(): void {
    this.exitListener?.();
  }

  emit(message: WorkerResponse): void {
    this.messageListener?.(message);
  }
}

const loads: Responder = request => (request.type === 'load' ? { type: 'loaded', id: request.id } : undefined);
const answers =
  (value: unknown): Responder =>
  request => {
    if (request.type === 'load') return { type: 'loaded', id: request.id };
    return { type: 'completed', id: request.id, value };
  };

const completion = { system: 'Name it.', prompt: 'Steps: a, b, c', schema: { type: 'object' }, maxTokens: 32 };
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

function clientWith(workers: FakeWorker[], options: { idleStopMs?: number; loadTimeoutMs?: number } = {}) {
  let starts = 0;
  const client = new LocalModelClient({
    modelPath: '/models/Qwen3-4B-Q4_K_M.gguf',
    modelsDir: '/models',
    start: () => {
      const worker = workers[Math.min(starts, workers.length - 1)];
      starts++;
      return worker;
    },
    ...options,
  });
  return { client, starts: () => starts };
}

describe('LocalModelClient', () => {
  it('loads the model once, then reuses the worker', async () => {
    const worker = new FakeWorker(answers({ name: 'Monthly invoice check' }));
    const { client, starts } = clientWith([worker]);

    expect(await client.complete(completion)).toEqual({ name: 'Monthly invoice check' });
    expect(await client.complete(completion)).toEqual({ name: 'Monthly invoice check' });

    expect(starts()).toBe(1);
    expect(worker.requests.map(request => request.type)).toEqual(['load', 'complete', 'complete']);
    expect(worker.requests[0]).toMatchObject({
      type: 'load',
      modelsDir: '/models',
      modelPath: '/models/Qwen3-4B-Q4_K_M.gguf',
      contextSize: 2048,
    });
  });

  it('warm() loads the model without sending a request, and reports a failed load', async () => {
    const worker = new FakeWorker(loads);
    const { client, starts } = clientWith([worker]);
    await client.warm();
    expect(starts()).toBe(1);
    expect(worker.requests.map(request => request.type)).toEqual(['load']);

    const failing = new FakeWorker(request =>
      request.type === 'load' ? { type: 'failed', id: request.id, stage: 'load' } : undefined,
    );
    await expect(clientWith([failing]).client.warm()).rejects.toThrow(/could not be loaded/);
  });

  it('passes the prompt, schema and token cap to the worker, and nothing else', async () => {
    const worker = new FakeWorker(answers({ name: 'Monthly invoice check' }));
    const { client } = clientWith([worker]);
    await client.complete({ ...completion, signal: new AbortController().signal });
    expect(worker.requests[1]).toEqual({
      type: 'complete',
      id: expect.any(Number),
      system: completion.system,
      prompt: completion.prompt,
      schema: completion.schema,
      maxTokens: completion.maxTokens,
    });
  });

  it('fails the request and stops the worker when the model cannot be loaded', async () => {
    const worker = new FakeWorker(request =>
      request.type === 'load' ? { type: 'failed', id: request.id, stage: 'load' } : undefined,
    );
    const { client } = clientWith([worker]);
    await expect(client.complete(completion)).rejects.toThrow(/could not be loaded/);
    expect(worker.killed).toBe(true);
  });

  it('fails a request when its worker exits, and starts a new worker for the next one', async () => {
    const dying = new FakeWorker(request => (request.type === 'load' ? { type: 'loaded', id: request.id } : undefined));
    const fresh = new FakeWorker(answers({ name: 'Recovered name' }));
    const { client, starts } = clientWith([dying, fresh]);

    const pending = client.complete(completion);
    await tick();
    dying.crash();
    await expect(pending).rejects.toThrow(/stopped/);

    expect(await client.complete(completion)).toEqual({ name: 'Recovered name' });
    expect(starts()).toBe(2);
  });

  it('cancels a request by stopping the worker, since a generation cannot be resumed', async () => {
    const worker = new FakeWorker(request => (request.type === 'load' ? { type: 'loaded', id: request.id } : undefined));
    const { client } = clientWith([worker]);
    const controller = new AbortController();

    const pending = client.complete({ ...completion, signal: controller.signal });
    await tick();
    controller.abort();

    await expect(pending).rejects.toThrow(/cancelled/);
    expect(worker.killed).toBe(true);
  });

  it('does not start a worker for a request that was already cancelled', async () => {
    const worker = new FakeWorker(answers({ name: 'Never sent' }));
    const { client, starts } = clientWith([worker]);
    const controller = new AbortController();
    controller.abort();
    await expect(client.complete({ ...completion, signal: controller.signal })).rejects.toThrow(/cancelled/);
    expect(starts()).toBe(0);
  });

  it('stops a worker that never answers its load, once the load timeout passes', async () => {
    const silent = new FakeWorker(() => undefined);
    const { client } = clientWith([silent], { loadTimeoutMs: 10 });
    await expect(client.complete(completion)).rejects.toThrow();
    expect(silent.killed).toBe(true);
  });

  it('serves one request at a time', async () => {
    const worker = new FakeWorker(request => (request.type === 'load' ? { type: 'loaded', id: request.id } : undefined));
    const { client } = clientWith([worker]);

    const first = client.complete(completion);
    const second = client.complete({ ...completion, prompt: 'second' });
    await tick();
    const sentCompletions = () => worker.requests.filter(request => request.type === 'complete');
    expect(sentCompletions()).toHaveLength(1);

    const firstId = sentCompletions()[0].id;
    worker.emit({ type: 'completed', id: firstId, value: { name: 'First name' } });
    expect(await first).toEqual({ name: 'First name' });
    await tick();
    expect(sentCompletions()).toHaveLength(2);
    worker.emit({ type: 'completed', id: sentCompletions()[1].id, value: { name: 'Second name' } });
    expect(await second).toEqual({ name: 'Second name' });
  });

  it('ignores replies for requests it is not waiting on', async () => {
    const worker = new FakeWorker(answers({ name: 'Real answer' }));
    const { client } = clientWith([worker]);
    expect(await client.complete(completion)).toEqual({ name: 'Real answer' });
    worker.emit({ type: 'completed', id: 999, value: { name: 'Stray' } });
    expect(await client.complete(completion)).toEqual({ name: 'Real answer' });
  });

  it('stops the worker after a quiet period, so its memory is returned', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker(answers({ name: 'Quiet name' }));
      const { client } = clientWith([worker], { idleStopMs: 1_000 });

      await client.complete(completion);
      expect(worker.killed).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(worker.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still stops an idle worker after a request that failed', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker(request =>
        request.type === 'load' ? { type: 'loaded', id: request.id } : { type: 'failed', id: request.id, stage: 'complete' },
      );
      const { client } = clientWith([worker], { idleStopMs: 1_000 });
      await expect(client.complete(completion)).rejects.toThrow(/did not finish/);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(worker.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() kills the worker and rejects anything waiting', async () => {
    const worker = new FakeWorker(request => (request.type === 'load' ? { type: 'loaded', id: request.id } : undefined));
    const { client } = clientWith([worker]);
    const pending = client.complete(completion);
    await tick();
    client.stop();
    await expect(pending).rejects.toThrow(/stopped/);
    expect(worker.killed).toBe(true);
  });
});
