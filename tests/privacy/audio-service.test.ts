import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TwinAgent } from '@companyos/twin-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AudioCaptureService,
  CAPTURE_CHANNEL,
  WhisperTranscriber,
  type AudioRuntimeState,
} from '../../apps/desktop/src/main/audio-capture';
import { findLeaks, type Surface } from './canaries';
import { ConsoleCapture, diskSurfaces, refuseOutbound } from './surfaces';

// Electron is not running here. The capture window, the IPC channel and the speech process are replaced by the fakes
// below. The transcriber under test is the real WhisperTranscriber, which talks to the fake speech process.
const shared = vi.hoisted(() => ({
  listeners: new Map<string, (event: { sender: { id: number } }, payload: unknown) => void>(),
  windows: [] as Array<{ id: number; destroyed: boolean; sent: unknown[] }>,
  fork: (...args: unknown[]): unknown => {
    throw new Error(`No speech process was expected: ${args.length}`);
  },
}));

vi.mock('electron', () => ({
  BrowserWindow: class {
    readonly record: { id: number; destroyed: boolean; sent: unknown[] };
    readonly webContents: {
      id: number;
      setWindowOpenHandler: () => void;
      on: (event: string, handler: () => void) => void;
      send: (channel: string, message: unknown) => void;
    };
    private readonly handlers = new Map<string, () => void>();

    constructor() {
      this.record = { id: shared.windows.length + 1, destroyed: false, sent: [] };
      shared.windows.push(this.record);
      this.webContents = {
        id: this.record.id,
        setWindowOpenHandler: () => undefined,
        on: (event, handler) => {
          this.handlers.set(event, handler);
        },
        send: (_channel, message) => {
          this.record.sent.push(message);
        },
      };
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
      // The page finishes loading a moment after the window is created, as the real window does.
      queueMicrotask(() => this.handlers.get('did-finish-load')?.());
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
  systemPreferences: {
    getMediaAccessStatus: () => 'granted',
    askForMediaAccess: () => Promise.resolve(true),
  },
  utilityProcess: {
    fork: (...args: unknown[]) => shared.fork(...args),
  },
}));

/** The speech output the fake process returns. A test sets the text, and whether replies are held. */
interface Speech {
  text: string;
  hold: boolean;
}

/**
 * A speech process as the transcriber sees it: it answers load and transcribe requests. With hold set, a transcribe reply
 * waits until releaseHeld is called, so a test can change the state or stop capture while the segment is in flight.
 */
class FakeChild extends EventEmitter {
  readonly posted: Array<{ type: string; id: number }> = [];
  killed = false;
  private held: Array<{ id: number; text: string }> = [];

  constructor(private readonly speech: Speech) {
    super();
  }

  postMessage(message: { type: string; id: number }): void {
    this.posted.push(message);
    if (message.type === 'load') {
      this.reply({ type: 'loaded', id: message.id });
    } else if (message.type === 'transcribe') {
      if (this.speech.hold) this.held.push({ id: message.id, text: this.speech.text });
      else this.reply({ type: 'transcribed', id: message.id, text: this.speech.text });
    }
  }

  releaseHeld(): void {
    for (const { id, text } of this.held.splice(0)) this.reply({ type: 'transcribed', id, text });
  }

  kill(): void {
    this.killed = true;
  }

  private reply(message: unknown): void {
    queueMicrotask(() => this.emit('message', message));
  }
}

/** Lets every queued microtask run, and the reply to any request that was answered, before the next line. */
function settle(): Promise<void> {
  return new Promise<void>(resolve => setImmediate(resolve));
}

interface Fixture {
  agent: TwinAgent;
  service: AudioCaptureService;
  set(patch: Partial<AudioRuntimeState>): void;
  setMicrophone(granted: boolean): void;
  /** Sends one 30-second segment from the given page. By default, from the open capture window. */
  send(text: string, from?: number): void;
  windowId(): number | undefined;
  /** Transcribe requests sent to the speech process, across every process it started. */
  transcribes(): number;
  lastChild(): FakeChild | undefined;
  /** Holds every transcribe reply until releaseHeld is called. */
  holdReplies(value: boolean): void;
  releaseHeld(): void;
  /** Sends one segment of the given samples from the open capture window, or from the given page. */
  sendSamples(samples: Float32Array, from?: number): void;
  /** The commands the capture page has been sent, in order. */
  sentToPage(): unknown[];
  surfaces(): Surface[];
  close(): Promise<void>;
}

function open(initial: Partial<AudioRuntimeState> = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'audio-service-privacy-'));
  const storeDir = join(root, 'twin');
  const key = randomBytes(32);
  const outbound: string[] = [];
  const logs = new ConsoleCapture();
  const restoreOutbound = refuseOutbound(outbound);
  const agent = new TwinAgent({ dataDir: storeDir, dataKey: key, now: () => Date.now() });
  agent.updateConfig({ audioCaptureEnabled: true });

  const speech: Speech = { text: '', hold: false };
  const children: FakeChild[] = [];
  shared.fork = () => {
    const child = new FakeChild(speech);
    children.push(child);
    return child;
  };

  let context: AudioRuntimeState = { enabled: true, locked: false, paused: false, idle: false, ...initial };
  let granted = true;
  const transcriber = new WhisperTranscriber({
    workerPath: join(root, 'transcribe-worker.js'),
    modelsDir: join(root, 'models'),
    idleStopMs: 60_000,
  });
  const service = new AudioCaptureService({
    transcriber,
    sink: { ingestAudio: segment => agent.ingestAudio(segment) },
    now: () => Date.now(),
    microphoneGranted: () => granted,
  });
  service.setContext(context);
  service.start();

  const windowId = (): number | undefined => {
    const live = shared.windows.filter(window => !window.destroyed);
    return live[live.length - 1]?.id;
  };

  const sendSamples = (samples: Float32Array, from: number = windowId() ?? -1): void => {
    shared.listeners.get(CAPTURE_CHANNEL.segment)?.(
      { sender: { id: from } },
      { samples: samples.buffer, durationMs: 30_000 },
    );
  };

  return {
    agent,
    service,
    sendSamples,
    sentToPage() {
      return shared.windows[shared.windows.length - 1]?.sent ?? [];
    },
    set(patch) {
      context = { ...context, ...patch };
      service.setContext(context);
    },
    setMicrophone(value) {
      granted = value;
    },
    send(text, from = windowId() ?? -1) {
      speech.text = text;
      sendSamples(new Float32Array(16_000), from);
    },
    windowId,
    transcribes() {
      return children.reduce((sum, child) => sum + child.posted.filter(message => message.type === 'transcribe').length, 0);
    },
    lastChild() {
      return children[children.length - 1];
    },
    holdReplies(value) {
      speech.hold = value;
    },
    releaseHeld() {
      for (const child of children) child.releaseHeld();
    },
    surfaces() {
      return [
        ...diskSurfaces(root, storeDir, key),
        { name: 'console', text: logs.text() },
        { name: 'outbound:fetch', text: outbound.join('\n') },
      ];
    },
    async close() {
      service.stop();
      logs.restore();
      restoreOutbound();
      agent.close();
      rmSync(root, { recursive: true, force: true });
      shared.listeners.clear();
    },
  };
}

/** Each case changes the policy before a segment arrives, so the segment must never reach the speech process. */
const BEFORE_SEGMENT: Array<{ name: string; canary: string; apply: (fx: Fixture) => void }> = [
  { name: 'paused', canary: 'CANARY_AUDIO_BEFORE_PAUSED_A1B2C3', apply: fx => fx.set({ paused: true }) },
  { name: 'locked', canary: 'CANARY_AUDIO_BEFORE_LOCKED_D4E5F6', apply: fx => fx.set({ locked: true }) },
  { name: 'idle', canary: 'CANARY_AUDIO_BEFORE_IDLE_1A2B3C', apply: fx => fx.set({ idle: true }) },
  { name: 'microphone permission denied', canary: 'CANARY_AUDIO_BEFORE_DENIED_4D5E6F', apply: fx => fx.setMicrophone(false) },
  { name: 'microphone setting off', canary: 'CANARY_AUDIO_BEFORE_OFF_7A8B9C', apply: fx => fx.set({ enabled: false }) },
];

/** Each case changes the policy while a segment is being transcribed. The text must then never be stored. */
const DURING_SEGMENT: Array<{ name: string; canary: string; apply: (fx: Fixture) => void }> = [
  { name: 'paused', canary: 'CANARY_AUDIO_DURING_PAUSED_0F1E2D', apply: fx => fx.set({ paused: true }) },
  { name: 'locked', canary: 'CANARY_AUDIO_DURING_LOCKED_3C4B5A', apply: fx => fx.set({ locked: true }) },
  { name: 'idle', canary: 'CANARY_AUDIO_DURING_IDLE_6D7E8F', apply: fx => fx.set({ idle: true }) },
  { name: 'microphone permission denied', canary: 'CANARY_AUDIO_DURING_DENIED_9A0B1C', apply: fx => fx.setMicrophone(false) },
  { name: 'microphone setting off', canary: 'CANARY_AUDIO_DURING_OFF_2D3E4F', apply: fx => fx.set({ enabled: false }) },
];

describe('AudioCaptureService with the real speech transcriber, against planted canaries', () => {
  let fx: Fixture;

  beforeEach(() => {
    shared.windows.length = 0;
    shared.listeners.clear();
    fx = open();
  });

  afterEach(async () => {
    await fx.close();
  });

  it('stores a permitted segment, so the scan has a real copy to find', async () => {
    fx.send('Meeting notes CANARY_AUDIO_ALLOWED_3F8A20');
    await settle();
    expect(fx.transcribes()).toBe(1);
    expect(fx.agent.captureSummary().audioCount).toBe(1);
    // The scan finds the stored copy in a decrypted store surface. Without this, a clean result could mean the scan is blind.
    const leaks = findLeaks(fx.surfaces(), { allowed: 'CANARY_AUDIO_ALLOWED_3F8A20' });
    expect(leaks.some(leak => leak.surface.startsWith('store:decrypted:') && leak.encoding === 'raw')).toBe(true);
  });

  it.each(BEFORE_SEGMENT)('does not send a segment to the speech process while $name', async ({ name, canary, apply }) => {
    apply(fx);
    fx.send(`Heard ${canary}`);
    await settle();
    expect(fx.transcribes()).toBe(0);
    expect(fx.agent.captureSummary().audioCount).toBe(0);
    expect(findLeaks(fx.surfaces(), { [name]: canary })).toEqual([]);
  });

  it.each(DURING_SEGMENT)('stores nothing transcribed while $name', async ({ name, canary, apply }) => {
    // Holds the reply, so the policy changes while the segment is in flight.
    fx.holdReplies(true);
    fx.send(`Heard ${canary}`);
    await settle();
    expect(fx.transcribes()).toBe(1);
    apply(fx);
    fx.releaseHeld();
    await settle();
    expect(fx.agent.captureSummary().audioCount).toBe(0);
    expect(findLeaks(fx.surfaces(), { [name]: canary })).toEqual([]);
  });

  it('ignores a segment from a page that is not the capture window', async () => {
    fx.send('Heard CANARY_AUDIO_SENDER_72F6C3', -1);
    await settle();
    expect(fx.transcribes()).toBe(0);
    expect(fx.agent.captureSummary().audioCount).toBe(0);
    expect(findLeaks(fx.surfaces(), { sender: 'CANARY_AUDIO_SENDER_72F6C3' })).toEqual([]);
  });

  it('stores nothing from a segment still being transcribed when capture stops', async () => {
    fx.holdReplies(true);
    fx.send('Heard CANARY_AUDIO_STOPPED_1C9E4B');
    await settle();
    expect(fx.transcribes()).toBe(1);
    // The runtime's delete stops capture first. Stopping the speech process refuses the request that is waiting.
    fx.service.stop();
    fx.releaseHeld();
    await settle();
    expect(fx.lastChild()?.killed).toBe(true);
    expect(fx.agent.captureSummary().audioCount).toBe(0);
    expect(findLeaks(fx.surfaces(), { stopped: 'CANARY_AUDIO_STOPPED_1C9E4B' })).toEqual([]);
  });

  it('tells the capture page to stop when capture is paused', async () => {
    await settle();
    expect(fx.sentToPage()).toEqual(['start']);
    // Without this command the page keeps the microphone open while the person has paused capture.
    fx.set({ paused: true });
    expect(fx.sentToPage()).toEqual(['start', 'stop']);
  });

  it('drops a segment that arrives while another is being transcribed', async () => {
    fx.holdReplies(true);
    fx.send('First part');
    fx.send('Second part');
    await settle();
    expect(fx.transcribes()).toBe(1);
    fx.releaseHeld();
    await settle();
    // A request queued behind the first would be sent now, and held like it. Release that one too, and count again.
    fx.releaseHeld();
    await settle();
    expect(fx.transcribes()).toBe(1);
    expect(fx.agent.captureSummary().audioCount).toBe(1);
  });

  it('drops a segment that holds a non-finite sample', async () => {
    const samples = new Float32Array(16_000);
    samples[3] = Number.NaN;
    fx.sendSamples(samples);
    await settle();
    expect(fx.transcribes()).toBe(0);
    expect(fx.agent.captureSummary().audioCount).toBe(0);
  });

  it('opens no capture page while capture is paused', async () => {
    await fx.close();
    shared.windows.length = 0;
    fx = open({ paused: true });
    await settle();
    expect(shared.windows).toHaveLength(0);
  });

  it('stores segments again once capture restarts', async () => {
    fx.service.stop();
    fx.service.start();
    fx.send('Second note');
    await settle();
    expect(fx.agent.captureSummary().audioCount).toBe(1);
    expect(fx.surfaces().find(surface => surface.name === 'store:decrypted:capture')?.text).toContain('Second note');
  });
});
