import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The page's bridge, captured when the renderer loads. The renderer reads it at load time, so a stand-in is set first. */
const page = vi.hoisted(() => {
  const state: { onCommand?: (command: string) => void } = {};
  Object.assign(globalThis, {
    window: {
      captureBridge: {
        sendSegment: () => undefined,
        onCommand: (listener: (command: string) => void) => {
          state.onCommand = listener;
          return () => undefined;
        },
      },
    },
  });
  return state;
});

import { mayStart, START_RETRY_MS, type StartGate } from '../src/renderer/capture-renderer';

describe('capture start gate', () => {
  const never = Number.NEGATIVE_INFINITY;

  it('allows a start when nothing is pending and nothing has failed', () => {
    expect(mayStart({ pending: false, failedAt: never }, 0)).toBe(true);
  });

  it('ignores a start while an acquisition is pending', () => {
    expect(mayStart({ pending: true, failedAt: never }, 0)).toBe(false);
  });

  it('ignores starts for the retry wait after a failure, and allows one when it has passed', () => {
    const gate: StartGate = { pending: false, failedAt: 1_000 };
    expect(mayStart(gate, 1_000)).toBe(false);
    expect(mayStart(gate, 1_000 + START_RETRY_MS - 1)).toBe(false);
    expect(mayStart(gate, 1_000 + START_RETRY_MS)).toBe(true);
  });

  it('keeps a pending start blocked even after the wait has passed', () => {
    expect(mayStart({ pending: true, failedAt: 0 }, 10 * START_RETRY_MS)).toBe(false);
  });
});

/** Lets the pending acquisition and its failure handling finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
}

/** Each test starts at a clock far past the last one, so a failure from an earlier test is never inside the wait. */
let clock = 1_000_000;

describe('capture start, with the microphone refused', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    clock += 10 * START_RETRY_MS;
    vi.setSystemTime(clock);
    vi.stubGlobal('location', { search: '?source=microphone' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('asks for the microphone once while starts keep coming, and again only after the wait', async () => {
    const getUserMedia = vi.fn(async (_constraints: unknown) => {
      throw new Error('denied');
    });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });

    page.onCommand?.('start');
    await settle();
    page.onCommand?.('start');
    page.onCommand?.('start');
    await settle();
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    vi.setSystemTime(clock + START_RETRY_MS);
    page.onCommand?.('start');
    await settle();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('ignores a start while the first request is still waiting for the permission', async () => {
    let refuse: () => void = () => undefined;
    const getUserMedia = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          refuse = () => reject(new Error('denied'));
        }),
    );
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });

    page.onCommand?.('start');
    page.onCommand?.('start');
    await settle();
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    refuse();
    await settle();
  });
});
