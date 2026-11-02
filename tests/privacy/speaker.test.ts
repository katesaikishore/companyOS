import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TwinAgent, unitVector } from '@companyos/twin-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioCaptureService, CAPTURE_CHANNEL, type Transcriber } from '../../apps/desktop/src/main/audio-capture';
import { findLeaks, type Surface } from './canaries';
import { ConsoleCapture, diskSurfaces, refuseOutbound } from './surfaces';

// Electron is not running here. The capture window and its IPC channel are replaced by the fakes below. The audio service and
// the engine are the real ones. The speech model and the speaker model are replaced: what matters here is what reaches each
// output, not how the models work.
const shared = vi.hoisted(() => ({
  listeners: new Map<string, (event: { sender: { id: number } }, payload: unknown) => void>(),
  windows: [] as Array<{ id: number; destroyed: boolean }>,
}));

vi.mock('electron', () => ({
  BrowserWindow: class {
    private readonly record: { id: number; destroyed: boolean };
    readonly webContents: { id: number; setWindowOpenHandler: () => void; on: () => void; send: () => void };

    constructor() {
      this.record = { id: shared.windows.length + 1, destroyed: false };
      shared.windows.push(this.record);
      this.webContents = { id: this.record.id, setWindowOpenHandler: () => undefined, on: () => undefined, send: () => undefined };
    }

    isDestroyed(): boolean {
      return this.record.destroyed;
    }

    destroy(): void {
      this.record.destroyed = true;
    }

    on(): void {
      return undefined;
    }

    loadURL(): Promise<void> {
      return Promise.resolve();
    }
  },
  ipcMain: {
    on: (channel: string, listener: (event: { sender: { id: number } }, payload: unknown) => void) => {
      shared.listeners.set(channel, listener);
    },
    removeListener: (channel: string) => {
      shared.listeners.delete(channel);
    },
  },
  systemPreferences: { getMediaAccessStatus: () => 'granted' },
  utilityProcess: { fork: () => undefined },
}));

/** The raw samples carry this value. Float32 prints it as 0.3141592741..., so the canary is its shortest unique prefix. */
const RAW_SAMPLE = 0.31415927;
const RAW_SAMPLE_CANARY = '0.31415927';
const TRANSCRIPT_CANARY = 'CANARY_SPEAKER_TRANSCRIPT_6D21B8';
const AT = Date.UTC(2026, 10, 2, 9);

/** A deterministic unit embedding of a segment. Its values are what the embedding canary is taken from. */
function embeddingOf(samples: Float32Array): Float32Array {
  const raw = new Float32Array(256);
  let state = Math.round(samples[0] * 1e6) + 1;
  for (let i = 0; i < raw.length; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    raw[i] = state / 0x7fffffff - 0.5;
  }
  return unitVector(raw)!;
}

const EMBEDDING_CANARY_INDEX = 7;

describe('speaker identification leaves no raw audio, transcript or voice on an output surface', () => {
  let root: string;
  let agent: TwinAgent;
  let logs: ConsoleCapture;
  let outbound: string[];
  let restoreOutbound: () => void;
  let service: AudioCaptureService;
  let embeddingCanary: string;
  let identified: number;
  let dataKey: Buffer;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'speaker-privacy-'));
    logs = new ConsoleCapture();
    outbound = [];
    restoreOutbound = refuseOutbound(outbound);
    dataKey = randomBytes(32);
    agent = new TwinAgent({ dataDir: join(root, 'twin'), dataKey, now: () => AT });
    agent.updateConfig({ audioCaptureEnabled: true, speakerIdentificationEnabled: true });
    embeddingCanary = '';
    identified = 0;

    const transcriber: Transcriber = { transcribe: async () => `${TRANSCRIPT_CANARY} is what was said` };
    service = new AudioCaptureService({
      transcriber,
      sink: { ingestAudio: segment => agent.ingestAudio(segment) },
      now: () => AT,
      microphoneGranted: () => true,
      speakers: {
        identify: async samples => {
          identified++;
          const voice = embeddingOf(samples);
          embeddingCanary = String(voice[EMBEDDING_CANARY_INDEX]);
          return agent.identifySpeaker(voice);
        },
      },
      // Read on each segment, as the runtime reads the setting, so switching it off stops the voice comparison at once.
      speakersEnabled: () => agent.configuration.speakerIdentificationEnabled,
    });
    service.setContext({ enabled: true, locked: false, paused: false, idle: false });
    service.start();
  });

  afterEach(() => {
    service.stop();
    logs.restore();
    restoreOutbound();
    agent.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function settle(): Promise<void> {
    for (let i = 0; i < 30; i++) await new Promise<void>(resolve => setImmediate(resolve));
  }

  /** The surfaces an outsider could read: what the console printed, the export, the network ledger, and the search hits. */
  function outputs(): Surface[] {
    return [
      { name: 'console', text: logs.text() },
      { name: 'export', text: JSON.stringify(agent.exportAll()) },
      { name: 'network ledger', text: JSON.stringify(agent.networkLedger()) },
      { name: 'search hits', text: JSON.stringify(agent.searchCapture({ text: '', from: 0, to: AT + 1000 })) },
    ];
  }

  it('keeps a labelled segment, and none of its raw audio, transcript or voice reaches an output', async () => {
    const samples = new Float32Array(16_000).fill(RAW_SAMPLE);
    shared.listeners.get(CAPTURE_CHANNEL.segment)?.({ sender: { id: shared.windows.at(-1)!.id } }, { samples: samples.buffer, durationMs: 1000 });
    await settle();

    // The positive control: the segment was identified and stored, so the check below is not an empty one.
    expect(identified).toBe(1);
    expect(agent.captureSummary().audioCount).toBe(1);
    expect(agent.searchCapture({ text: '', from: 0, to: AT + 1000 })[0]).toMatchObject({ kind: 'audio', speaker: 'Speaker 1' });
    expect(embeddingCanary).not.toBe('');

    const leaks = findLeaks(outputs(), {
      rawSample: RAW_SAMPLE_CANARY,
      embedding: embeddingCanary,
    });
    expect(leaks).toEqual([]);
    expect(findLeaks(outputs().filter(surface => surface.name !== 'search hits'), { transcript: TRANSCRIPT_CANARY })).toEqual([]);
    expect(outbound).toEqual([]);

    // The person names the speaker, which makes a voiceprint profile. The outputs are checked again, now with that profile.
    agent.nameSessionSpeaker('Speaker 1', 'Dana Reviewer');
    expect(agent.speakerProfileCount()).toBe(1);
    expect(findLeaks(outputs(), { rawSample: RAW_SAMPLE_CANARY, embedding: embeddingCanary })).toEqual([]);

    // On disk, the voice and the transcript are sealed. Only the decrypted speaker store holds the voice, so the disk check
    // below is read beside that positive control, and the store is not an empty pass.
    const disk = diskSurfaces(root, join(root, 'twin'), dataKey);
    const onDisk = disk.filter(surface => !surface.name.startsWith('store:decrypted:'));
    expect(onDisk.length).toBeGreaterThan(0);
    expect(findLeaks(onDisk, { embedding: embeddingCanary, transcript: TRANSCRIPT_CANARY })).toEqual([]);
    expect(disk.find(surface => surface.name === 'store:decrypted:speakers')?.text ?? '').toContain(embeddingCanary);
  });

  it('keeps the text without a label, and identifies nobody, when the setting is off', async () => {
    agent.updateConfig({ speakerIdentificationEnabled: false });
    const samples = new Float32Array(16_000).fill(RAW_SAMPLE);
    // The voice this segment would have. Nothing computes it here, so its canary must stay off every output. It is not blank.
    const canary = String(embeddingOf(samples)[EMBEDDING_CANARY_INDEX]);
    expect(canary).not.toBe('');
    shared.listeners.get(CAPTURE_CHANNEL.segment)?.({ sender: { id: shared.windows.at(-1)!.id } }, { samples: samples.buffer, durationMs: 1000 });
    await settle();
    // The speaker model is never asked, so the setting stops the voice comparison itself, not only the label it would give.
    expect(identified).toBe(0);
    expect(agent.captureSummary().audioCount).toBe(1);
    expect(agent.searchCapture({ text: '', from: 0, to: AT + 1000 })[0]).not.toHaveProperty('speaker');
    expect(findLeaks(outputs(), { embedding: canary })).toEqual([]);
  });
});
