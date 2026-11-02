import { APP_ORIGIN } from '../shared/ipc';

/**
 * The sources the capture window can hold. Microphone sound is what the person says, and system sound is what the computer
 * plays. Each source has its own page address, and the source is set by the main process, so a page cannot claim another.
 */
export const CAPTURE_SOURCES = ['microphone', 'system'] as const;
export type CaptureSource = (typeof CAPTURE_SOURCES)[number];

export function captureUrl(source: CaptureSource): string {
  return `${APP_ORIGIN}/capture.html?source=${source}`;
}

/** True when a page address is the system-sound capture page. Only that page may receive the screen's sound. */
export function isSystemCaptureUrl(url: string): boolean {
  return url === captureUrl('system');
}

/** True when a page address is the microphone capture page, query included. Only that page may hold the microphone. */
export function isMicrophoneCaptureUrl(url: string): boolean {
  return url === captureUrl('microphone');
}
