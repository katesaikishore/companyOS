import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { OcrEngine } from './screen-capture';

/**
 * Screen text through Apple's Vision framework, the on-device engine behind Live Text. The work happens in companyos-ocr, a
 * small helper built from native/macos-ocr/main.swift and shipped in the app's resources. It runs outside the main process,
 * so a frame never blocks the app, and it makes no network calls. It stays running between frames, and one frame is read
 * at a time: a frame is the length as four big-endian bytes and then the PNG, and each reply is one JSON line.
 */

const OCR_FAILED = 'The frame could not be read.';
/** A frame that takes longer than this ends the helper, and the next frame starts a fresh one. */
const OCR_TIMEOUT_MS = 60_000;

interface Waiting {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
}

export interface NativeOcrOptions {
  /** Arguments for the helper. Tests run a stand-in script through Node. */
  args?: string[];
  timeoutMs?: number;
}

export function spawnNativeOcr(command: string, options: NativeOcrOptions = {}): OcrEngine {
  const args = options.args ?? [];
  const timeoutMs = options.timeoutMs ?? OCR_TIMEOUT_MS;
  let child: ChildProcessWithoutNullStreams | undefined;
  let buffered = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Replies come back in the order the frames were sent.
  const waiting: Waiting[] = [];

  const failAll = (): void => {
    for (const entry of waiting.splice(0)) entry.reject(new Error(OCR_FAILED));
  };
  const stop = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    child?.kill();
    child = undefined;
    buffered = '';
    failAll();
  };
  const armTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = waiting.length > 0 ? setTimeout(stop, timeoutMs) : undefined;
  };

  const ensureChild = (): ChildProcessWithoutNullStreams => {
    if (child) return child;
    const started = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    // The helper's own messages are dropped on purpose. They must never reach a log, because they could describe the screen.
    started.stderr.resume();
    started.stdout.setEncoding('utf8');
    started.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const entry = waiting.shift();
        let reply: { text?: unknown } | undefined;
        try {
          reply = JSON.parse(line) as { text?: unknown };
        } catch {
          reply = undefined;
        }
        if (entry && typeof reply?.text === 'string') entry.resolve(reply.text);
        else entry?.reject(new Error(OCR_FAILED));
        newline = buffered.indexOf('\n');
      }
      armTimer();
    });
    // A helper that cannot start, or that exits, fails the frames it holds. The next frame starts it again.
    started.on('error', () => {
      if (child === started) stop();
    });
    started.once('exit', () => {
      if (child === started) stop();
    });
    started.stdin.on('error', () => undefined);
    child = started;
    return started;
  };

  return {
    recognise(png: Buffer): Promise<string> {
      // A build without the helper, such as one made where Swift was not installed, has no screen text.
      if (!existsSync(command)) return Promise.reject(new Error(OCR_FAILED));
      return new Promise<string>((resolve, reject) => {
        const helper = ensureChild();
        waiting.push({ resolve, reject });
        const header = Buffer.alloc(4);
        header.writeUInt32BE(png.length);
        helper.stdin.write(Buffer.concat([header, png]));
        armTimer();
      });
    },
  };
}
