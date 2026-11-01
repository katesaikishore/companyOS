import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload for the hidden microphone window. It exposes two functions and nothing else, so this window cannot reach the
 * twin bridge. Sandboxed preloads may only require 'electron', so the channel names are repeated here. They must match
 * CAPTURE_CHANNEL in audio-capture.ts.
 */
const CHANNEL = {
  segment: 'capture:segment',
  command: 'capture:command',
} as const;

contextBridge.exposeInMainWorld('captureBridge', {
  /** Sends one cut segment: 16 kHz mono 32-bit float samples, and how long the segment is. */
  sendSegment: (samples: ArrayBuffer, durationMs: number) => {
    ipcRenderer.send(CHANNEL.segment, { samples, durationMs });
  },
  /** Listens for the main process telling the window to start or stop listening. Returns a function that stops listening. */
  onCommand: (listener: (command: string) => void) => {
    const handler = (_event: unknown, command: unknown) => {
      if (command === 'start' || command === 'stop') listener(command);
    };
    ipcRenderer.on(CHANNEL.command, handler);
    return () => {
      ipcRenderer.removeListener(CHANNEL.command, handler);
    };
  },
});
