import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATALOG, type TwinAgent } from '@companyos/twin-core';
import { ModelManager } from '../src/main/models';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

const [first, second] = CATALOG;

/** A download that sends one chunk, then stalls until it is aborted, as a slow connection would. */
function stalledFetch() {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4096));
        signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
      },
    });
    return new Response(body, { status: 200 });
  });
}

function fakeAgent() {
  return {
    configuration: { installedModels: [] },
    recordNetworkCall: vi.fn(),
    markModelInstalled: vi.fn(),
    removeModelRecord: vi.fn(),
  };
}

describe('ModelManager.wipe', () => {
  let base: string;
  let modelsDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'models-test-'));
    modelsDir = join(base, 'models');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function managerWith(fetchImpl: ReturnType<typeof stalledFetch>) {
    const agent = fakeAgent();
    const manager = new ModelManager({
      modelsDir,
      agent: agent as unknown as TwinAgent,
      onChange: vi.fn(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    return { agent, manager };
  }

  it('cancels a running download, removes its partial file and removes the models folder', async () => {
    const fetchImpl = stalledFetch();
    const { agent, manager } = managerWith(fetchImpl);
    manager.install(first.id);
    await vi.waitFor(() => expect(manager.states()[0]?.receivedBytes).toBeGreaterThan(0));
    expect(existsSync(join(modelsDir, `${first.file}.part`))).toBe(true);

    await manager.wipe();

    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(agent.recordNetworkCall).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'model_download', modelId: first.id, outcome: 'cancelled' }),
    );
    expect(existsSync(modelsDir)).toBe(false);
    expect(manager.states()).toEqual([]);
    // The cancelled download must not write anything back into the folder once wipe has returned.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(existsSync(modelsDir)).toBe(false);
  });

  it('never starts a download that was still waiting its turn', async () => {
    const fetchImpl = stalledFetch();
    const { manager } = managerWith(fetchImpl);
    manager.install(first.id);
    manager.install(second.id);
    await vi.waitFor(() => expect(manager.states().find(state => state.modelId === first.id)?.receivedBytes).toBeGreaterThan(0));

    await manager.wipe();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(manager.states()).toEqual([]);
    expect(existsSync(modelsDir)).toBe(false);
  });

  it('removes installed model files along with the folder', async () => {
    mkdirSync(modelsDir, { recursive: true });
    writeFileSync(join(modelsDir, first.file), 'installed model');
    const { manager } = managerWith(stalledFetch());

    await manager.wipe();

    expect(existsSync(join(modelsDir, first.file))).toBe(false);
    expect(existsSync(modelsDir)).toBe(false);
  });

  it('does nothing when no model was ever downloaded', async () => {
    const { manager } = managerWith(stalledFetch());

    await expect(manager.wipe()).resolves.toBeUndefined();
    expect(existsSync(modelsDir)).toBe(false);
  });

  it('refuses a new install once deleting has started', async () => {
    const { manager } = managerWith(stalledFetch());
    await manager.wipe();

    expect(() => manager.install(first.id)).toThrow('The models are being deleted.');
    expect(existsSync(modelsDir)).toBe(false);
  });
});
