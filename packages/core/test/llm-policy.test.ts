import { describe, expect, it } from 'vitest';
import { CATALOG, MODEL_IDLE_SECONDS, chooseChatModel, modelWorkAllowed } from '../src';

describe('modelWorkAllowed', () => {
  it('runs on AC power whether or not the person is active', () => {
    expect(modelWorkAllowed({ onBattery: false, idleSeconds: 0 })).toBe(true);
    expect(modelWorkAllowed({ onBattery: false, idleSeconds: 5 })).toBe(true);
  });

  it('waits on battery while the person is active', () => {
    expect(modelWorkAllowed({ onBattery: true, idleSeconds: 0 })).toBe(false);
    expect(modelWorkAllowed({ onBattery: true, idleSeconds: MODEL_IDLE_SECONDS - 1 })).toBe(false);
  });

  it('runs on battery once the person has been idle long enough', () => {
    expect(modelWorkAllowed({ onBattery: true, idleSeconds: MODEL_IDLE_SECONDS })).toBe(true);
    expect(modelWorkAllowed({ onBattery: true, idleSeconds: 3_600 })).toBe(true);
  });
});

describe('chooseChatModel', () => {
  const at = (id: string) => ({ id, sha256: 'a'.repeat(64), bytes: 1, installedAt: 1 });

  it('chooses nothing when no chat model is installed', () => {
    expect(chooseChatModel([])).toBeUndefined();
    expect(chooseChatModel([at('nomic-embed-text-v1.5')])).toBeUndefined();
  });

  it('prefers the recommended model when it is installed', () => {
    expect(chooseChatModel([at('qwen3-1.7b'), at('qwen3-4b')], 'qwen3-4b')?.id).toBe('qwen3-4b');
  });

  it('falls back to the smallest installed chat model when the recommendation is not installed', () => {
    expect(chooseChatModel([at('qwen3-4b'), at('qwen3-1.7b')], 'qwen3-8b')?.id).toBe('qwen3-1.7b');
    expect(chooseChatModel([at('qwen3-4b'), at('qwen3-1.7b')])?.id).toBe('qwen3-1.7b');
  });

  it('only ever returns a chat model from the catalogue', () => {
    const spec = chooseChatModel([at('qwen3-0.6b'), at('nomic-embed-text-v1.5')]);
    expect(spec?.role).toBe('chat');
    expect(CATALOG).toContain(spec);
  });
});
