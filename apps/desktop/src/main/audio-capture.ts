import { audioDecision, type AudioState } from '@companyos/twin-core';
import { BrowserWindow, ipcMain, systemPreferences, utilityProcess, type UtilityProcess } from 'electron';
import { join } from 'node:path';
import { APP_ORIGIN } from '../shared/ipc';
import type { TranscribeReply } from './transcribe-worker';

/**
 * Microphone capture. A hidden window holds the microphone and cuts it into 30 second segments. This module decides whether
 * each segment may be kept, turns it into text in a utility process, and stores the text through the twin. The window is
 * open only while the policy allows listening, so the microphone is released as soon as it is not allowed.
 */

/** Channel names. capture-preload.ts repeats them, because sandboxed preloads cannot import modules. */
export const CAPTURE_CHANNEL = {
  segment: 'capture:segment',
  command: 'capture:command',
} as const;

/** The longest segment the window may send. The transcription worker refuses anything longer. */
const MAX_SEGMENT_SAMPLES = 16_000 * 60;
const MAX_SEGMENT_MS = 60_000;
/** A transcription that takes longer than this is abandoned, and the speech process is stopped. */
const TRANSCRIBE_TIMEOUT_MS = 120_000;
/** The speech process stops after this long with no segment, so the model is not held in memory while nothing is said. */
const WORKER_IDLE_STOP_MS = 5 * 60_000;

/** What the runtime knows. The runtime sets it on every change to the setting, the lock, the pause or the idle state. */
export interface AudioRuntimeState {
  /** The microphone setting. Off until the person turns it on. */
  enabled: boolean;
  locked: boolean;
  paused: boolean;
  idle: boolean;
}

/** Turns one segment into text. Rejects on failure, with a message that never holds speech. */
export interface Transcriber {
  transcribe(samples: Float32Array): Promise<string>;
  /** Releases the model, if the transcriber holds one. */
  stop?(): void;
}

/** Where kept text goes. The twin's agent satisfies this. */
export interface AudioSink {
  ingestAudio(segment: { ts: number; durationMs: number; text: string }): boolean;
}

export interface AudioCaptureOptions {
  transcriber: Transcriber;
  sink: AudioSink;
  now?: () => number;
  /** Whether the operating system lets this app use the microphone now. Tests replace it. */
  microphoneGranted?: () => boolean;
}

interface Segment {
  samples: Float32Array;
  durationMs: number;
}

/** Whether the operating system lets this app use the microphone. Linux has no such setting, so it is always granted there. */
export function microphoneGranted(platform: string = process.platform): boolean {
  if (platform === 'darwin' || platform === 'win32') return systemPreferences.getMediaAccessStatus('microphone') === 'granted';
  return true;
}

/** Checks the shape of a segment from the capture window. Anything malformed is dropped without a word. */
function parseSegment(payload: unknown): Segment | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const { samples, durationMs } = payload as { samples?: unknown; durationMs?: unknown };
  if (!(samples instanceof ArrayBuffer) || samples.byteLength === 0 || samples.byteLength % 4 !== 0) return undefined;
  const values = new Float32Array(samples);
  if (values.length > MAX_SEGMENT_SAMPLES) return undefined;
  const duration = typeof durationMs === 'number' ? durationMs : Number.NaN;
  if (!Number.isInteger(duration) || duration < 1 || duration > MAX_SEGMENT_MS) return undefined;
  for (const value of values) {
    if (!Number.isFinite(value)) return undefined;
  }
  return { samples: values, durationMs: duration };
}

/**
 * Owns the microphone window. The window opens only when the policy says capture may run, and it is destroyed when the
 * setting is switched off. Segments are accepted only from that window's own page.
 */
export class AudioCaptureService {
  private context: AudioRuntimeState = { enabled: false, locked: false, paused: false, idle: false };
  private window: BrowserWindow | undefined;
  private windowReady = false;
  private want: 'start' | 'stop' = 'stop';
  private listening = false;
  /** One segment at a time. A segment that arrives while another is being transcribed is dropped, not queued. */
  private busy = false;
  private readonly granted: () => boolean;

  constructor(private readonly options: AudioCaptureOptions) {
    this.granted = options.microphoneGranted ?? (() => microphoneGranted());
  }

  /** Starts listening for segments. Nothing opens until the setting is on and the policy allows capture. */
  start(): void {
    if (!this.listening) {
      ipcMain.on(CAPTURE_CHANNEL.segment, this.onSegment);
      this.listening = true;
    }
    this.apply();
  }

  /** Closes the window, which releases the microphone, and stops the speech process. */
  stop(): void {
    if (this.listening) {
      ipcMain.removeListener(CAPTURE_CHANNEL.segment, this.onSegment);
      this.listening = false;
    }
    this.close();
    this.options.transcriber.stop?.();
  }

  /** The runtime calls this whenever the setting, the lock, the pause or the idle state changes. */
  setContext(state: AudioRuntimeState): void {
    this.context = { ...state };
    if (this.listening) this.apply();
  }

  /** The capture page's id while its window is open. The permission handler grants the microphone to this page only. */
  get captureWebContentsId(): number | undefined {
    return this.window && !this.window.isDestroyed() ? this.window.webContents.id : undefined;
  }

  /** Asks macOS for microphone access. Other systems ask when the window first opens, so they report granted. */
  async requestPermission(): Promise<boolean> {
    if (process.platform !== 'darwin') return true;
    return systemPreferences.askForMediaAccess('microphone');
  }

  private state(): AudioState {
    return { ...this.context, permissionGranted: this.granted() };
  }

  private apply(): void {
    if (!this.context.enabled) {
      this.want = 'stop';
      this.close();
      return;
    }
    const decision = audioDecision(this.state());
    this.want = decision.capture ? 'start' : 'stop';
    if (decision.capture && !this.window) this.window = this.openWindow();
    this.send();
  }

  private send(): void {
    if (!this.window || this.window.isDestroyed() || !this.windowReady) return;
    this.window.webContents.send(CAPTURE_CHANNEL.command, this.want);
  }

  private openWindow(): BrowserWindow {
    const window = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        // The window must keep listening while it is in the background, so Chromium must not throttle it.
        backgroundThrottling: false,
        preload: join(__dirname, 'capture-preload.js'),
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('did-finish-load', () => {
      this.windowReady = true;
      this.send();
    });
    window.on('closed', () => {
      if (this.window === window) {
        this.window = undefined;
        this.windowReady = false;
      }
    });
    void window.loadURL(`${APP_ORIGIN}/capture.html`);
    return window;
  }

  private close(): void {
    const window = this.window;
    this.window = undefined;
    this.windowReady = false;
    if (window && !window.isDestroyed()) window.destroy();
  }

  private readonly onSegment = (event: { sender: { id: number } }, payload: unknown): void => {
    // Only the capture window may send segments. Anything else is dropped without a word.
    if (!this.window || this.window.isDestroyed() || event.sender.id !== this.window.webContents.id) return;
    const segment = parseSegment(payload);
    if (!segment) return;
    if (this.busy || !audioDecision(this.state()).capture) return;
    this.busy = true;
    void this.keep(segment).finally(() => {
      this.busy = false;
    });
  };

  /** Transcribes one segment and stores its text. Nothing is stored, and nothing is logged, when a check or the transcription fails. */
  private async keep(segment: Segment): Promise<void> {
    const ts = this.options.now?.() ?? Date.now();
    let text: string;
    try {
      text = await this.options.transcriber.transcribe(segment.samples);
    } catch {
      return;
    }
    // Checked again, because the person may have paused or locked the screen while the segment was being transcribed.
    if (!audioDecision(this.state()).capture) return;
    try {
      this.options.sink.ingestAudio({ ts, durationMs: segment.durationMs, text });
    } catch {
      // The store refused the segment. Its reason is not shown, because it can echo the text.
    }
  }
}

type Body = { type: 'load'; modelsDir: string } | { type: 'transcribe'; samples: ArrayBuffer };

interface Waiter {
  resolve: (reply: TranscribeReply) => void;
  reject: (error: Error) => void;
}

function parseReply(value: unknown): TranscribeReply | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { type, id, text, stage } = value as Record<string, unknown>;
  if (typeof id !== 'number') return undefined;
  if (type === 'loaded') return { type, id };
  if (type === 'transcribed' && typeof text === 'string') return { type, id, text };
  if (type === 'failed' && (stage === 'load' || stage === 'transcribe')) return { type, id, stage };
  return undefined;
}

/**
 * Runs the speech model in a utility process. The process starts with the first segment and stops after a few idle
 * minutes, so the model is in memory only while there is speech to read. Requests run one at a time.
 */
export class WhisperTranscriber implements Transcriber {
  private child: UtilityProcess | undefined;
  private loaded = false;
  private nextId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly waiting = new Map<number, Waiter>();

  constructor(private readonly options: { workerPath: string; modelsDir: string; idleStopMs?: number }) {}

  transcribe(samples: Float32Array): Promise<string> {
    const run = this.queue.then(() => this.run(samples));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Stops the speech process now. Anything still waiting is refused. The next segment starts the process again. */
  stop(): void {
    this.clearIdle();
    for (const [id, waiter] of this.waiting) {
      this.waiting.delete(id);
      waiter.reject(new Error('The speech process stopped.'));
    }
    const child = this.child;
    this.child = undefined;
    this.loaded = false;
    child?.kill();
  }

  private async run(samples: Float32Array): Promise<string> {
    this.clearIdle();
    try {
      const child = this.child ?? this.spawn();
      if (!this.loaded) {
        const loaded = await this.call(child, { type: 'load', modelsDir: this.options.modelsDir });
        if (loaded.type !== 'loaded') throw new Error('The speech model could not be loaded.');
        this.loaded = true;
      }
      // A copy, so the buffer is exactly the samples and nothing else is sent.
      const reply = await this.call(child, { type: 'transcribe', samples: samples.slice().buffer });
      if (reply.type !== 'transcribed') throw new Error('The speech model could not transcribe the segment.');
      return reply.text;
    } finally {
      this.armIdle();
    }
  }

  private call(child: UtilityProcess, body: Body): Promise<TranscribeReply> {
    const id = this.nextId++;
    return new Promise<TranscribeReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error('The transcription timed out.'));
        this.stop();
      }, TRANSCRIBE_TIMEOUT_MS);
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
        this.waiting.get(id)?.reject(new Error('The speech process is not running.'));
      }
    });
  }

  private spawn(): UtilityProcess {
    const child = utilityProcess.fork(this.options.workerPath, [], {
      serviceName: 'companyOS speech',
      // Output is dropped on purpose. A transcript is personal data, so it must never reach a log.
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.on('message', (message: unknown) => this.onMessage(message));
    child.once('exit', () => this.onExit(child));
    this.child = child;
    this.loaded = false;
    return child;
  }

  private onMessage(message: unknown): void {
    const reply = parseReply(message);
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
      waiter.reject(new Error('The speech process stopped.'));
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
