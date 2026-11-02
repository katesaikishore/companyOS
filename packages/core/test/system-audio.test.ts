import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TwinAgent } from '../src/agent';
import { DEFAULT_CONFIG } from '../src/types';

const AT = Date.UTC(2026, 10, 2, 9);

describe('system audio', () => {
  let dir: string;
  let agent: TwinAgent;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'system-audio-'));
    agent = new TwinAgent({ dataDir: join(dir, 'twin'), dataKey: randomBytes(32), now: () => AT });
  });

  afterEach(() => {
    agent.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is off by default', () => {
    expect(DEFAULT_CONFIG.systemAudioCaptureEnabled).toBe(false);
  });

  it('refuses system sound while its own switch is off, even when the microphone is on', () => {
    agent.updateConfig({ audioCaptureEnabled: true, systemAudioCaptureEnabled: false });
    expect(agent.ingestAudio({ ts: AT, durationMs: 30_000, text: 'a call', source: 'system' })).toBe(false);
    expect(agent.captureSummary().audioCount).toBe(0);
  });

  it('keeps system sound once its switch is on, labelled with its source', () => {
    agent.updateConfig({ systemAudioCaptureEnabled: true });
    expect(agent.ingestAudio({ ts: AT, durationMs: 30_000, text: 'a call', source: 'system' })).toBe(true);
    expect(agent.captureSummary().audioCount).toBe(1);
  });

  it('keeps microphone sound under the microphone switch, and treats a segment with no source as microphone', () => {
    agent.updateConfig({ audioCaptureEnabled: true, systemAudioCaptureEnabled: false });
    expect(agent.ingestAudio({ ts: AT, durationMs: 30_000, text: 'my voice' })).toBe(true);
    expect(agent.captureSummary().audioCount).toBe(1);
  });
});
