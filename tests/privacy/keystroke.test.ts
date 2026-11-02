import { TwinAgent, type KeyEvent, type KeystrokeState } from '@companyos/twin-core';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { KeyboardSource, KeyListener } from '../../apps/desktop/src/main/keyboard';
import { KeystrokeService } from '../../apps/desktop/src/main/keystroke-service';
import { withoutTypedText } from '../../apps/desktop/src/main/local-api';
import { CANARIES, describeLeak, findLeaks, type Surface } from './canaries';
import { ConsoleCapture, diskSurfaces, errorText, refuseOutbound } from './surfaces';

/*
 * Typed text, planted through the real path: the keyboard source reports the key presses, the keystroke service runs the
 * policy and the buffer, and the agent stores the piece. Only the operating system is replaced, by a fake keyboard, a fake
 * app-in-front probe and a fake secure-input probe. Each refused piece is checked on every output surface the suite knows.
 */

const NOW = Date.UTC(2026, 9, 31, 12);
const DAY = 86_400_000;

/** Lets the pending reads and stores of the service finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
}

/** A keyboard the test presses keys on. It reports nothing until the service starts it. */
function fakeKeyboard(): KeyboardSource & { press(event: KeyEvent): void } {
  let listener: KeyListener | undefined;
  return {
    available: true,
    unavailableReason: '',
    start(onKey: KeyListener): boolean {
      listener = onKey;
      return true;
    },
    stop(): void {
      listener = undefined;
    },
    permissionGranted(): boolean {
      return listener !== undefined;
    },
    press(event: KeyEvent): void {
      listener?.(event);
    },
  };
}

interface Rig {
  root: string;
  storeDir: string;
  key: Buffer;
  agent: TwinAgent;
  service: KeystrokeService;
  keyboard: ReturnType<typeof fakeKeyboard>;
  /** The state the fake probes and policy inputs report. */
  world: { secure: boolean | 'unknown'; locked: boolean };
  outbound: string[];
  capture: ConsoleCapture;
  thrown: unknown[];
  /** Presses one key per character, then Enter, which ends the piece. */
  typeLine(text: string): Promise<void>;
  close(): void;
}

function openRig(): Rig {
  const root = mkdtempSync(join(tmpdir(), 'twin-privacy-keystroke-'));
  const storeDir = join(root, 'twin');
  const key = randomBytes(32);
  const outbound: string[] = [];
  const restoreOutbound = refuseOutbound(outbound);
  const capture = new ConsoleCapture();
  const agent = new TwinAgent({ dataDir: storeDir, dataKey: key, now: () => NOW });
  agent.updateConfig({ keystrokeCaptureEnabled: true });
  const keyboard = fakeKeyboard();
  const world: Rig['world'] = { secure: false, locked: false };
  const thrown: unknown[] = [];
  const service = new KeystrokeService({
    source: keyboard,
    frontApp: async () => 'Notes',
    secureInput: async () => world.secure,
    state: (app: string | undefined): Omit<KeystrokeState, 'secureInput'> => ({
      enabled: agent.configuration.keystrokeCaptureEnabled,
      locked: world.locked,
      paused: false,
      idle: false,
      permissionGranted: true,
      appExcluded: app === undefined,
      windowExcluded: false,
      windowClass: 'document',
    }),
    ingest: piece => {
      try {
        return agent.ingestKeystrokes({ ts: piece.ts, app: piece.app, windowClass: 'document', text: piece.text });
      } catch (error) {
        thrown.push(error);
        return false;
      }
    },
    now: () => NOW,
  });
  return {
    root,
    storeDir,
    key,
    agent,
    service,
    keyboard,
    world,
    outbound,
    capture,
    thrown,
    async typeLine(text: string): Promise<void> {
      for (const char of text) keyboard.press({ kind: 'text', text: char });
      keyboard.press({ kind: 'enter' });
      await settle();
    },
    close(): void {
      service.setEnabled(false);
      restoreOutbound();
      capture.restore();
      agent.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Every surface that leaves the store or the app, as the attacker would see it, plus the local API's reply. The Recall page
 * shows stored text to the person by design, so its reply is not one of these; the local API's reply is, and it must not
 * carry typed text.
 */
function surfacesOf(rig: Rig): Surface[] {
  const everything = { from: NOW - 365 * DAY, to: NOW + DAY };
  return [
    ...diskSurfaces(rig.root, rig.storeDir, rig.key),
    { name: 'export', text: JSON.stringify(rig.agent.exportAll(), null, 2) },
    { name: 'console', text: rig.capture.text() },
    { name: 'errors', text: rig.thrown.map(errorText).join('\n') },
    { name: 'outbound:fetch', text: rig.outbound.join('\n') },
    {
      name: 'local-api:search',
      text: JSON.stringify(withoutTypedText(rig.agent.searchCapture({ text: '', ...everything })), null, 2),
    },
  ];
}

describe('typed text is refused on every path it must not take', () => {
  let rig: Rig | undefined;
  afterEach(() => {
    rig?.close();
    rig = undefined;
  });

  it('keeps nothing typed while a password field may have focus, and no canary reaches an output', async () => {
    rig = openRig();
    rig.world.secure = true;
    rig.service.setEnabled(true);
    await rig.typeLine(`${CANARIES.keystrokeSecure} hunter two`);
    expect(rig.agent.captureSummary()).toMatchObject({ keystrokeCount: 0 });
    const surfaces = surfacesOf(rig);
    expect(surfaces.length).toBeGreaterThan(0);
    expect(findLeaks(surfaces).map(describeLeak)).toEqual([]);
  });

  it('keeps nothing typed while secure input cannot be checked, and no canary reaches an output', async () => {
    rig = openRig();
    rig.world.secure = 'unknown';
    rig.service.setEnabled(true);
    await rig.typeLine(`${CANARIES.keystrokeUnknown} typed`);
    expect(rig.agent.captureSummary()).toMatchObject({ keystrokeCount: 0 });
    const surfaces = surfacesOf(rig);
    expect(surfaces.length).toBeGreaterThan(0);
    expect(findLeaks(surfaces).map(describeLeak)).toEqual([]);
  });

  it('keeps nothing typed while the screen is locked, and does not keep it after the unlock either', async () => {
    rig = openRig();
    rig.service.setEnabled(true);
    rig.world.locked = true;
    await rig.typeLine(`${CANARIES.keystrokeLocked} locked`);
    rig.world.locked = false;
    await rig.typeLine('after the unlock');
    // Only the piece typed after the unlock is kept. The locked one was dropped as it was pressed, so it is not flushed later.
    expect(rig.agent.captureSummary()).toMatchObject({ keystrokeCount: 1 });
    const surfaces = surfacesOf(rig);
    expect(surfaces.length).toBeGreaterThan(0);
    expect(findLeaks(surfaces).map(describeLeak)).toEqual([]);
  });
});

describe('typed text is kept, redacted, only when allowed', () => {
  let rig: Rig | undefined;
  afterEach(() => {
    rig?.close();
    rig = undefined;
  });

  it('stores the allowed piece with its card-like number and key-like token replaced, and no surface carries them', async () => {
    rig = openRig();
    rig.service.setEnabled(true);
    await rig.typeLine(`${CANARIES.keystrokeStored} card ${CANARIES.keystrokeCard} key ${CANARIES.keystrokeKey}`);
    expect(rig.agent.captureSummary()).toMatchObject({ keystrokeCount: 1 });

    const surfaces = surfacesOf(rig);
    // The held-by-design exception is the encrypted index only. Its check below proves the piece really is there.
    expect(findLeaks(surfaces).map(describeLeak)).toEqual([]);
    const index = surfaces.find(surface => surface.name === 'store:decrypted:capture')?.text ?? '';
    expect(index).toContain(CANARIES.keystrokeStored);
    expect(index).toContain('[card number]');
    expect(index).toContain('[key]');
  });

  it('keeps the typed text out of the records themselves, which hold only a time and a window kind', async () => {
    rig = openRig();
    rig.service.setEnabled(true);
    await rig.typeLine(`${CANARIES.keystrokeStored} plain words`);
    const records = surfacesOf(rig).find(surface => surface.name === 'store:decrypted:keystrokeText')?.text ?? '';
    expect(records).toContain('windowClass');
    expect(records).not.toContain(CANARIES.keystrokeStored);
  });

  it('serves no typed text through the local API, even for a search that matches it', async () => {
    rig = openRig();
    rig.service.setEnabled(true);
    await rig.typeLine(`${CANARIES.keystrokeStored} needle`);
    const everything = { from: NOW - 365 * DAY, to: NOW + DAY };
    expect(rig.agent.searchCapture({ text: 'needle', ...everything })).toHaveLength(1);
    expect(withoutTypedText(rig.agent.searchCapture({ text: 'needle', ...everything }))).toEqual([]);
  });
});

describe('a refused keystroke never reaches an output', () => {
  let rig: Rig | undefined;
  afterEach(() => {
    rig?.close();
    rig = undefined;
  });

  it('refuses an invalid typed piece with a fixed sentence that does not echo it', () => {
    rig = openRig();
    const bad = { ts: NOW, app: 'Notes', windowClass: 'document', text: 'x', extra: CANARIES.keystrokeSecure };
    try {
      rig.agent.ingestKeystrokes(bad as never);
    } catch (error) {
      rig.thrown.push(error);
    }
    const errors = surfacesOf(rig).find(surface => surface.name === 'errors')?.text ?? '';
    expect(errors).toContain('Invalid capture: it has a field or value the twin does not accept.');
    expect(findLeaks([{ name: 'errors', text: errors }])).toEqual([]);
  });
});
