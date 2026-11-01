import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TwinAgent, deriveMediaKey } from '@companyos/twin-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaStore } from '../../apps/desktop/src/main/media-store';
import {
  ScreenCaptureService,
  type Frame,
  type FrameSource,
  type OcrEngine,
  type ScreenContext,
} from '../../apps/desktop/src/main/screen-capture';
import { findLeaks, type Surface } from './canaries';
import { ConsoleCapture, diskSurfaces, listFiles, refuseOutbound } from './surfaces';

// Electron is not running here. The grab and the OCR are replaced by the fakes below, and the JPEG encoder returns a fixed
// stand-in with no screen content in it, so an image file can never carry a planted canary.
vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: (png: Buffer) => {
      const image = {
        isEmpty: () => png.length === 0,
        getSize: () => ({ width: 800, height: 450 }),
        toJPEG: () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 0x42)]),
      };
      return { ...image, resize: () => image };
    },
  },
  desktopCapturer: { getSources: () => Promise.resolve([]) },
  screen: { getPrimaryDisplay: () => ({}) },
  utilityProcess: { fork: () => undefined },
}));

/**
 * Planted in the text of frames that must not be stored, or in errors that quote the screen. Each canary is checked
 * only on the outputs. The allowed frame's canary is the one copy the store may hold, and the test that pins it says so.
 */
const CANARY_SERVICE = {
  paused: 'CANARY_SERVICE_PAUSED_0A6D31',
  locked: 'CANARY_SERVICE_LOCKED_7B2E94',
  idle: 'CANARY_SERVICE_IDLE_C4F018',
  excluded: 'CANARY_SERVICE_EXCLUDED_19E7B5',
  browser: 'CANARY_SERVICE_BROWSER_E83A6C',
  password: 'CANARY_SERVICE_PASSWORD_4D0C27',
  unchecked: 'CANARY_SERVICE_UNCHECKED_F92B0E',
  writing: 'CANARY_SERVICE_WRITING_6A81D3',
  restart: 'CANARY_SERVICE_RESTART_2E5F79',
  grabError: 'CANARY_SERVICE_GRAB_8C3B10',
  ocrError: 'CANARY_SERVICE_OCR_D17A4F',
  allowed: 'CANARY_SERVICE_ALLOWED_B95C3D',
  behindBrowser: 'CANARY_SERVICE_BEHIND_0F6E82',
} as const;

const OPEN: ScreenContext = {
  enabled: true,
  locked: false,
  paused: false,
  idle: false,
  appExcluded: false,
  windowClass: 'editor',
  permissionGranted: true,
  app: 'Notes',
};

/** A frame where every pixel has one value, so two frames with different values never look alike to the dedupe. */
function frameOf(label: string, shade: number): Frame {
  const width = 16;
  const height = 9;
  return { width, height, bgra: Buffer.alloc(width * height * 4, shade), png: Buffer.from(label) };
}

class FakeSource implements FrameSource {
  next: Frame | null = null;
  grabs = 0;
  failWith: string | undefined;

  async grab(): Promise<Frame | null> {
    this.grabs++;
    if (this.failWith !== undefined) throw new Error(this.failWith);
    return this.next;
  }
}

/** Returns the text planted for each frame's label. It records every call, so a test can see whether OCR ran at all. */
class FakeOcr implements OcrEngine {
  readonly calls: string[] = [];
  readonly reads = new Map<string, string>();
  gate: Promise<void> | undefined;
  failWith: string | undefined;

  async recognise(png: Buffer): Promise<string> {
    const label = png.toString();
    this.calls.push(label);
    if (this.gate) await this.gate;
    if (this.failWith !== undefined) throw new Error(this.failWith);
    return this.reads.get(label) ?? '';
  }
}

interface Fixture {
  agent: TwinAgent;
  service: ScreenCaptureService;
  source: FakeSource;
  ocr: FakeOcr;
  /** How many times an image write has begun, held or not. */
  readonly writeStarts: number;
  /** Changes the policy inputs the service reads. */
  set(patch: Partial<ScreenContext>): void;
  setSecure(value: boolean | 'unknown'): void;
  /** Holds OCR until the returned release is called. The read in progress is the one held. */
  holdOcr(): () => void;
  /** Holds every image write until the returned release is called. */
  holdWrites(): () => void;
  /** Shows the service one frame with the given text, and waits for the frame to be taken or dropped, not for its read. */
  shot(text: string): Promise<void>;
  /** Resolves once no read is in flight. The service keeps its drain private, so the wait reads it here. */
  idle(): Promise<void>;
  /** Every output the suite inspects, after the run. */
  surfaces(): Surface[];
  /** Sealed image files in the media folder. */
  mediaFiles(): number;
  close(): Promise<void>;
}

function open(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'screen-service-privacy-'));
  const storeDir = join(root, 'twin');
  const mediaDir = join(root, 'media');
  const key = randomBytes(32);
  const outbound: string[] = [];
  const logs = new ConsoleCapture();
  const restoreOutbound = refuseOutbound(outbound);
  const agent = new TwinAgent({ dataDir: storeDir, dataKey: key, now: () => Date.now() });
  agent.updateConfig({ screenCaptureEnabled: true });
  const media = new MediaStore(mediaDir, deriveMediaKey(key));
  const source = new FakeSource();
  const ocr = new FakeOcr();

  let context: ScreenContext = { ...OPEN };
  let secure: boolean | 'unknown' = false;
  let writeGate: Promise<void> | undefined;
  let writeStarts = 0;
  let frames = 0;

  const service = new ScreenCaptureService({
    source,
    ocr,
    media: {
      write: async (id, bytes) => {
        writeStarts += 1;
        if (writeGate) await writeGate;
        return media.write(id, bytes);
      },
      remove: ids => media.remove(ids),
    },
    // The real sink: the engine decides the browser, excluded-app and capture-setting rules itself.
    sink: { ingestScreen: read => agent.ingestScreen(read) },
    now: () => Date.now(),
    secureInput: async () => secure,
  });
  service.setContext(context);
  service.start(60_000);

  return {
    agent,
    service,
    source,
    ocr,
    get writeStarts() {
      return writeStarts;
    },
    set(patch) {
      context = { ...context, ...patch };
      service.setContext(context);
    },
    setSecure(value) {
      secure = value;
    },
    holdOcr() {
      let release: () => void = () => undefined;
      ocr.gate = new Promise<void>(resolve => {
        release = resolve;
      });
      return () => {
        ocr.gate = undefined;
        release();
      };
    },
    holdWrites() {
      let release: () => void = () => undefined;
      writeGate = new Promise<void>(resolve => {
        release = resolve;
      });
      return () => {
        writeGate = undefined;
        release();
      };
    },
    async shot(text) {
      frames += 1;
      const label = `frame ${frames}`;
      ocr.reads.set(label, text);
      source.next = frameOf(label, frames * 20);
      await service.requestFrame('interval');
    },
    async idle() {
      await vi.waitFor(() => expect(service['draining']).toBeUndefined());
    },
    surfaces() {
      return [
        ...diskSurfaces(root, storeDir, key, mediaDir),
        { name: 'console', text: logs.text() },
        { name: 'outbound:fetch', text: outbound.join('\n') },
      ];
    },
    mediaFiles() {
      return existsSync(mediaDir) ? listFiles(mediaDir).filter(path => path.endsWith('.bin')).length : 0;
    },
    async close() {
      await service.stop();
      logs.restore();
      restoreOutbound();
      agent.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Each case changes the policy before the screen is grabbed, so the service must not grab or read the frame at all. */
const BEFORE_GRAB: Array<{ name: string; canary: string; apply: (fx: Fixture) => void }> = [
  { name: 'paused', canary: CANARY_SERVICE.paused, apply: fx => fx.set({ paused: true }) },
  { name: 'locked', canary: CANARY_SERVICE.locked, apply: fx => fx.set({ locked: true }) },
  { name: 'an excluded app in front', canary: CANARY_SERVICE.excluded, apply: fx => fx.set({ appExcluded: true }) },
  { name: 'a password field in focus', canary: CANARY_SERVICE.password, apply: fx => fx.setSecure(true) },
  { name: 'the secure input check unknown', canary: CANARY_SERVICE.unchecked, apply: fx => fx.setSecure('unknown') },
];

/** Each case changes the policy while OCR is reading the frame. The read must then store nothing. */
const DURING_READ: Array<{ name: string; canary: string; apply: (fx: Fixture) => void }> = [
  { name: 'paused', canary: CANARY_SERVICE.paused, apply: fx => fx.set({ paused: true }) },
  { name: 'locked', canary: CANARY_SERVICE.locked, apply: fx => fx.set({ locked: true }) },
  { name: 'idle', canary: CANARY_SERVICE.idle, apply: fx => fx.set({ idle: true }) },
  { name: 'an excluded app takes the front', canary: CANARY_SERVICE.excluded, apply: fx => fx.set({ appExcluded: true }) },
  {
    name: 'a browser comes to the front',
    canary: CANARY_SERVICE.browser,
    apply: fx => fx.set({ app: 'Google Chrome', windowClass: 'browser' }),
  },
  { name: 'a password field takes focus', canary: CANARY_SERVICE.password, apply: fx => fx.setSecure(true) },
  { name: 'the secure input check fails', canary: CANARY_SERVICE.unchecked, apply: fx => fx.setSecure('unknown') },
];

describe('ScreenCaptureService, against planted canaries', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = open();
  });

  afterEach(async () => {
    await fx.close();
  });

  it('stores an allowed frame, so the scan has a real copy to find', async () => {
    await fx.shot(`Invoice total ${CANARY_SERVICE.allowed}`);
    await fx.idle();
    expect(fx.agent.captureSummary().screenCount).toBe(1);
    expect(fx.mediaFiles()).toBe(1);
    const surfaces = fx.surfaces();
    expect(surfaces.find(surface => surface.name === 'store:decrypted:capture')?.text).toContain(CANARY_SERVICE.allowed);
    // The scan finds the stored copy in the decrypted index. Without this, a clean result could mean the scan is blind.
    expect(findLeaks(surfaces, { allowed: CANARY_SERVICE.allowed })).toContainEqual(
      expect.objectContaining({ surface: 'store:decrypted:capture', encoding: 'raw' }),
    );
  });

  it.each(BEFORE_GRAB)('does not grab or read the screen while $name', async ({ name, canary, apply }) => {
    apply(fx);
    await fx.shot(`Visible ${canary}`);
    await fx.idle();
    expect(fx.source.grabs).toBe(0);
    expect(fx.ocr.calls).toEqual([]);
    expect(fx.agent.captureSummary().screenCount).toBe(0);
    expect(fx.mediaFiles()).toBe(0);
    expect(findLeaks(fx.surfaces(), { [name]: canary })).toEqual([]);
  });

  it.each(DURING_READ)('stores nothing read while $name', async ({ name, canary, apply }) => {
    const release = fx.holdOcr();
    await fx.shot(`Visible ${canary}`);
    // OCR has started before the change, so the check that runs after the read is the one under test.
    expect(fx.ocr.calls).toHaveLength(1);
    apply(fx);
    release();
    await fx.idle();
    // The policy is checked again before an image is written, so no write begins, not even one that is removed later.
    expect(fx.writeStarts).toBe(0);
    expect(fx.agent.captureSummary().screenCount).toBe(0);
    expect(fx.mediaFiles()).toBe(0);
    expect(findLeaks(fx.surfaces(), { [name]: canary })).toEqual([]);
  });

  it('removes the image when a password field takes focus while the image is written', async () => {
    const releaseWrites = fx.holdWrites();
    await fx.shot(`Visible ${CANARY_SERVICE.writing}`);
    await vi.waitFor(() => expect(fx.writeStarts).toBe(1));
    fx.setSecure(true);
    releaseWrites();
    await fx.idle();
    expect(fx.agent.captureSummary().screenCount).toBe(0);
    expect(fx.mediaFiles()).toBe(0);
    expect(findLeaks(fx.surfaces(), { writing: CANARY_SERVICE.writing })).toEqual([]);
  });

  it('stores nothing from a read that was in flight when capture stopped and restarted', async () => {
    const release = fx.holdOcr();
    await fx.shot(`Visible ${CANARY_SERVICE.restart}`);
    expect(fx.ocr.calls).toHaveLength(1);
    const stopped = fx.service.stop();
    fx.service.start(60_000);
    release();
    await stopped;
    await fx.idle();
    expect(fx.agent.captureSummary().screenCount).toBe(0);

    // Capture carries on after the restart, and the next frame is stored as usual.
    await fx.shot('Second frame');
    await fx.idle();
    expect(fx.agent.captureSummary().screenCount).toBe(1);
    expect(fx.surfaces().find(surface => surface.name === 'store:decrypted:capture')?.text).toContain('Second frame');
    expect(findLeaks(fx.surfaces(), { restart: CANARY_SERVICE.restart })).toEqual([]);
  });

  it('keeps no trace of an error that quotes the screen', async () => {
    fx.source.failWith = `Grab failed on ${CANARY_SERVICE.grabError}`;
    await fx.shot('Unused frame');
    await fx.idle();
    fx.source.failWith = undefined;

    fx.ocr.failWith = `Read failed on ${CANARY_SERVICE.ocrError}`;
    await fx.shot(`Visible ${CANARY_SERVICE.ocrError}`);
    await fx.idle();

    expect(fx.agent.captureSummary().screenCount).toBe(0);
    expect(fx.mediaFiles()).toBe(0);
    expect(
      findLeaks(fx.surfaces(), { grabError: CANARY_SERVICE.grabError, ocrError: CANARY_SERVICE.ocrError }),
    ).toEqual([]);
  });

  it('pinned: text of a browser window visible behind an allowed app is stored under that app', async () => {
    // The browser is not in front, so the frame is read, and the text goes in under the app in front. Recall documents this.
    await fx.shot(`Quarterly notes next to a tab ${CANARY_SERVICE.behindBrowser}`);
    await fx.idle();
    expect(fx.agent.captureSummary().screenCount).toBe(1);

    // Only the decrypted index holds the text. The raw bytes, the console, the network log and the images do not.
    const leaks = findLeaks(fx.surfaces(), { behindBrowser: CANARY_SERVICE.behindBrowser });
    expect(leaks.some(leak => leak.surface === 'store:decrypted:capture')).toBe(true);
    expect(leaks.every(leak => leak.surface === 'store:decrypted:capture' && leak.encoding === 'raw')).toBe(true);

    // Excluding the browser does not remove that text, because it is filed under the app in front.
    fx.agent.updateConfig({ excludedApps: ['Google Chrome'] });
    expect(fx.agent.captureSummary().screenCount).toBe(1);
    // Excluding the app in front does remove it.
    fx.agent.updateConfig({ excludedApps: ['Google Chrome', 'Notes'] });
    expect(fx.agent.captureSummary().screenCount).toBe(0);
  });
});
