import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureUrl } from '../src/main/capture-source';
import {
  AudioCaptureService,
  CAPTURE_CHANNEL,
  type AudioCaptureOptions,
  type AudioRuntimeState,
} from '../src/main/audio-capture';

/** What the fake main process holds: the windows opened, and the listeners registered for the capture channels. */
const electron = vi.hoisted(() => ({
  windows: [] as Array<{ url: string; id: number; destroyed: boolean }>,
  listeners: new Map<string, (event: { sender: { id: number } }, payload: unknown) => void>(),
  nextId: 1,
}));

vi.mock('electron', () => {
  class BrowserWindow {
    readonly webContents: { id: number; setWindowOpenHandler: () => void; on: () => void; send: () => void };
    private readonly record: { url: string; id: number; destroyed: boolean };

    constructor() {
      const id = electron.nextId++;
      this.record = { url: '', id, destroyed: false };
      electron.windows.push(this.record);
      this.webContents = { id, setWindowOpenHandler: () => undefined, on: () => undefined, send: () => undefined };
    }

    loadURL(url: string): Promise<void> {
      this.record.url = url;
      return Promise.resolve();
    }

    on(): void {
      // No window events are needed here.
    }

    isDestroyed(): boolean {
      return this.record.destroyed;
    }

    destroy(): void {
      this.record.destroyed = true;
    }
  }

  return {
    BrowserWindow,
    ipcMain: {
      on: (channel: string, listener: (event: { sender: { id: number } }, payload: unknown) => void) => {
        electron.listeners.set(channel, listener);
      },
      removeListener: (channel: string) => {
        electron.listeners.delete(channel);
      },
    },
    systemPreferences: { getMediaAccessStatus: () => 'granted', askForMediaAccess: async () => true },
    utilityProcess: {
      fork: () => {
        throw new Error('The speech process is not used in these tests.');
      },
    },
  };
});

const ON: AudioRuntimeState = { enabled: true, locked: false, paused: false, idle: false };

/** Lets the pending transcription, identification and store finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
}

const services: AudioCaptureService[] = [];

/** A service whose transcriber always says `text`, with a sink and a speaker identifier the test can read. */
function rig(text: string, overrides: Partial<AudioCaptureOptions> = {}) {
  const sink = { ingestAudio: vi.fn((_segment: { speaker?: string }) => true) };
  const identify = vi.fn(async (_samples: Float32Array) => 'Speaker 1' as string | undefined);
  const service = new AudioCaptureService({
    transcriber: { transcribe: vi.fn(async (_samples: Float32Array) => text) },
    sink,
    now: () => 5_000,
    microphoneGranted: () => true,
    speakers: { identify },
    speakersEnabled: () => true,
    ...overrides,
  });
  services.push(service);
  return { service, sink, identify };
}

/** Sends one 30 second segment from the capture window, as the capture page would. */
async function sendSegment(service: AudioCaptureService): Promise<void> {
  const id = service.captureWebContentsId;
  if (id === undefined) throw new Error('The capture window is not open.');
  const samples = new Float32Array([0.1, -0.2, 0.3, 0.05]).buffer;
  electron.listeners.get(CAPTURE_CHANNEL.segment)?.({ sender: { id } }, { samples, durationMs: 30_000 });
  await settle();
}

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  electron.windows.length = 0;
  electron.listeners.clear();
});

describe('AudioCaptureService speaker identification', () => {
  it('identifies a kept segment and stores it with the speaker', async () => {
    const { service, sink, identify } = rig('hello there');
    service.start();
    service.setContext(ON);
    await sendSegment(service);
    expect(identify).toHaveBeenCalledTimes(1);
    expect(sink.ingestAudio).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'hello there', speaker: 'Speaker 1', source: 'microphone' }),
    );
  });

  it('never identifies an empty transcript, and stores nothing', async () => {
    const { service, sink, identify } = rig('');
    service.start();
    service.setContext(ON);
    await sendSegment(service);
    expect(identify).not.toHaveBeenCalled();
    expect(sink.ingestAudio).not.toHaveBeenCalled();
  });

  it('never identifies a transcript the store would clean to nothing, such as a tag', async () => {
    const { service, sink, identify } = rig('[BLANK_AUDIO]');
    service.start();
    service.setContext(ON);
    await sendSegment(service);
    expect(identify).not.toHaveBeenCalled();
    expect(sink.ingestAudio).not.toHaveBeenCalled();
  });

  it('does not identify when speaker identification is off, and stores the text without a speaker', async () => {
    const { service, sink, identify } = rig('hello there', { speakersEnabled: () => false });
    service.start();
    service.setContext(ON);
    await sendSegment(service);
    expect(identify).not.toHaveBeenCalled();
    expect(sink.ingestAudio).toHaveBeenCalledTimes(1);
    expect(sink.ingestAudio.mock.calls[0][0]).not.toHaveProperty('speaker');
  });

  it('does not identify when speakersEnabled is left out', async () => {
    const { service, identify } = rig('hello there', { speakersEnabled: undefined });
    service.start();
    service.setContext(ON);
    await sendSegment(service);
    expect(identify).not.toHaveBeenCalled();
  });

  it('starts identifying as soon as speaker identification is switched on', async () => {
    let on = false;
    const { service, identify } = rig('hello there', { speakersEnabled: () => on });
    service.start();
    service.setContext(ON);
    await sendSegment(service);
    expect(identify).not.toHaveBeenCalled();
    on = true;
    await sendSegment(service);
    expect(identify).toHaveBeenCalledTimes(1);
  });
});

describe('AudioCaptureService permissions by sound', () => {
  it('opens the system page on its own permission, even when the microphone is not granted', () => {
    const { service } = rig('x', { source: 'system', microphoneGranted: () => false, permissionGranted: () => true });
    service.start();
    service.setContext(ON);
    expect(electron.windows.map(window => window.url)).toEqual([captureUrl('system')]);
  });

  it('does not open the system page without its own permission, even when the microphone is granted', () => {
    const { service } = rig('x', { source: 'system', microphoneGranted: () => true, permissionGranted: () => false });
    service.start();
    service.setContext(ON);
    expect(electron.windows).toEqual([]);
  });
});
