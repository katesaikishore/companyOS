import type { KeyEvent, KeystrokeState, WindowClass } from '@companyos/twin-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KeyboardSource, KeyListener } from '../src/main/keyboard';
import { KeystrokeService } from '../src/main/keystroke-service';

/** A keyboard source the test presses keys on. */
function fakeSource(): KeyboardSource & { press(event: KeyEvent): void; running(): boolean } {
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
    running(): boolean {
      return listener !== undefined;
    },
  };
}

/** Lets the pending reads and stores finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
}

const T = (text: string): KeyEvent => ({ kind: 'text', text });

interface Harness {
  service: KeystrokeService;
  source: ReturnType<typeof fakeSource>;
  ingest: ReturnType<typeof vi.fn<(piece: { ts: number; app: string; text: string }) => boolean>>;
  /** The app in front, as the probe reports it. */
  front: { app: string | undefined };
  secure: { value: boolean | 'unknown' };
  /** The policy's flags, as the runtime would give them. */
  flags: { locked: boolean; paused: boolean; idle: boolean; windowClass: WindowClass };
  probes: { count: number };
  clock: { now: number };
}

function harness(): Harness {
  const source = fakeSource();
  const ingest = vi.fn((_piece: { ts: number; app: string; text: string }) => true);
  const front: Harness['front'] = { app: 'Notes' };
  const secure: Harness['secure'] = { value: false };
  const flags: Harness['flags'] = { locked: false, paused: false, idle: false, windowClass: 'document' };
  const probes = { count: 0 };
  const clock = { now: 1_000 };
  const service = new KeystrokeService({
    source,
    frontApp: async () => front.app,
    secureInput: async () => {
      probes.count += 1;
      return secure.value;
    },
    state: (app: string | undefined): Omit<KeystrokeState, 'secureInput'> => ({
      enabled: true,
      locked: flags.locked,
      paused: flags.paused,
      idle: flags.idle,
      permissionGranted: source.running(),
      appExcluded: app === undefined || app === '1Password',
      windowExcluded: false,
      windowClass: app === 'Google Chrome' ? 'browser' : flags.windowClass,
    }),
    ingest,
    now: () => clock.now,
  });
  return { service, source, ingest, front, secure, flags, probes, clock };
}

describe('KeystrokeService', () => {
  let active: Harness | undefined;
  afterEach(() => {
    active?.service.setEnabled(false);
    active = undefined;
  });

  function start(): Harness {
    active = harness();
    active.service.setEnabled(true);
    return active;
  }

  it('keeps nothing while the setting is off, and starts no source', () => {
    const h = harness();
    expect(h.source.running()).toBe(false);
    h.source.press(T('secret'));
    expect(h.ingest).not.toHaveBeenCalled();
    expect(h.probes.count).toBe(0);
  });

  it('keeps a typed piece under the app it was typed into, once Enter ends it', async () => {
    const h = start();
    h.clock.now = 1_000;
    h.source.press(T('h'));
    await settle();
    h.clock.now = 1_100;
    h.source.press(T('i'));
    h.clock.now = 1_500;
    h.source.press({ kind: 'enter' });
    await settle();
    expect(h.ingest).toHaveBeenCalledTimes(1);
    expect(h.ingest).toHaveBeenCalledWith({ ts: 1_000, app: 'Notes', text: 'hi' });
  });

  it('never keeps a modifier, a shortcut or a backspace-only piece as text', async () => {
    const h = start();
    h.source.press({ kind: 'modifier' });
    h.source.press({ kind: 'shortcut' });
    h.source.press({ kind: 'backspace' });
    h.source.press({ kind: 'enter' });
    await settle();
    expect(h.ingest).not.toHaveBeenCalled();
  });

  it('keeps the text typed before a shortcut, and not the shortcut itself', async () => {
    const h = start();
    h.source.press(T('draft'));
    await settle();
    h.clock.now = 1_200;
    h.source.press({ kind: 'shortcut' });
    await settle();
    expect(h.ingest).toHaveBeenCalledWith({ ts: 1_000, app: 'Notes', text: 'draft' });
  });

  it('ends a piece after five seconds with no key, and not before', async () => {
    const h = start();
    h.source.press(T('pause'));
    await settle();
    h.clock.now = 5_999;
    h.service.tick();
    await settle();
    expect(h.ingest).not.toHaveBeenCalled();
    h.clock.now = 6_000;
    h.service.tick();
    await settle();
    expect(h.ingest).toHaveBeenCalledWith({ ts: 1_000, app: 'Notes', text: 'pause' });
  });

  it('refuses a piece while a password field may have focus, and keeps none of it', async () => {
    const h = start();
    h.secure.value = true;
    h.source.press(T('hunter2'));
    await settle();
    h.source.press({ kind: 'enter' });
    await settle();
    expect(h.ingest).not.toHaveBeenCalled();
  });

  it('refuses a piece when secure input cannot be checked', async () => {
    const h = start();
    h.secure.value = 'unknown';
    h.source.press(T('typed'));
    await settle();
    h.source.press({ kind: 'enter' });
    await settle();
    expect(h.ingest).not.toHaveBeenCalled();
  });

  it.each<[string, (h: Harness) => void]>([
    ['the screen is locked', h => (h.flags.locked = true)],
    ['capture is paused', h => (h.flags.paused = true)],
    ['the person is idle', h => (h.flags.idle = true)],
    ['the window kind is a browser', h => (h.flags.windowClass = 'browser')],
  ])('refuses while %s', async (_name, change) => {
    const h = start();
    change(h);
    h.source.press(T('nope'));
    await settle();
    h.source.press({ kind: 'enter' });
    await settle();
    expect(h.ingest).not.toHaveBeenCalled();
  });

  it('refuses a piece in an app that is excluded, and an app that cannot be named', async () => {
    const h = start();
    h.front.app = '1Password';
    h.source.press(T('vault'));
    await settle();
    h.source.press({ kind: 'enter' });
    await settle();
    expect(h.ingest).not.toHaveBeenCalled();
    h.front.app = undefined;
    h.source.press(T('lost'));
    await settle();
    h.source.press({ kind: 'enter' });
    await settle();
    expect(h.ingest).not.toHaveBeenCalled();
  });

  it('drops the open piece when the screen locks, so nothing from a refused time is ended later', async () => {
    const h = start();
    h.source.press(T('before'));
    await settle();
    h.flags.locked = true;
    h.service.refresh();
    h.flags.locked = false;
    h.clock.now = 9_000;
    h.source.press(T('after'));
    await settle();
    h.source.press({ kind: 'enter' });
    await settle();
    expect(h.ingest).toHaveBeenCalledTimes(1);
    expect(h.ingest).toHaveBeenCalledWith({ ts: 9_000, app: 'Notes', text: 'after' });
  });

  it('drops keys pressed while the screen is locked, rather than keeping them', async () => {
    const h = start();
    h.flags.locked = true;
    h.source.press(T('while locked'));
    await settle();
    h.flags.locked = false;
    h.source.press({ kind: 'enter' });
    await settle();
    expect(h.ingest).not.toHaveBeenCalled();
  });

  it('files a piece under its own app when the switch to an allowed app is seen', async () => {
    const h = start();
    h.source.press(T('notes text'));
    await settle();
    h.front.app = 'Mail';
    h.service.noteFront('Mail');
    await settle();
    expect(h.ingest).toHaveBeenCalledWith({ ts: 1_000, app: 'Notes', text: 'notes text' });
  });

  it('keeps no piece that ends on a switch to an excluded app', async () => {
    const h = start();
    h.source.press(T('notes text'));
    await settle();
    h.front.app = '1Password';
    h.service.noteFront('1Password');
    await settle();
    expect(h.ingest).not.toHaveBeenCalled();
  });

  it('keeps nothing typed in an excluded app after the switch to it is seen', async () => {
    const h = start();
    h.source.press(T('notes'));
    await settle();
    h.front.app = '1Password';
    h.service.noteFront('1Password');
    await settle();
    h.source.press(T('vault'));
    h.source.press({ kind: 'enter' });
    await settle();
    expect(h.ingest).not.toHaveBeenCalled();
  });

  it('keeps no piece that ends on Enter after an unseen switch to another app', async () => {
    const h = start();
    h.source.press(T('typed in notes'));
    await settle();
    // The switch is not reported to the service, so the probe alone shows the app now in front.
    h.front.app = 'Mail';
    h.source.press({ kind: 'enter' });
    await settle();
    expect(h.ingest).not.toHaveBeenCalled();
  });

  it('keeps the keys that wait for a reading, in the order they were pressed', async () => {
    const h = start();
    h.source.press(T('a'));
    h.source.press(T('b'));
    h.source.press(T('c'));
    h.source.press({ kind: 'enter' });
    await settle();
    expect(h.ingest).toHaveBeenCalledWith({ ts: 1_000, app: 'Notes', text: 'abc' });
  });

  it('drops a piece that overflows the wait, and keeps nothing from its gap, until a key ends a piece', async () => {
    const h = start();
    // Keys pressed while the first reading is still under way: more than the wait can hold.
    h.source.press(T('x'));
    for (let i = 0; i < 300; i++) h.source.press(T('y'));
    h.source.press({ kind: 'backspace' });
    h.source.press(T('z'));
    await settle();
    h.source.press({ kind: 'enter' });
    await settle();
    expect(h.ingest).not.toHaveBeenCalled();
    h.source.press(T('ok'));
    h.source.press({ kind: 'enter' });
    await settle();
    expect(h.ingest).toHaveBeenCalledTimes(1);
    expect(h.ingest).toHaveBeenCalledWith({ ts: 1_000, app: 'Notes', text: 'ok' });
  });

  it('reads secure input again only after its reading is old, not for every key', async () => {
    const h = start();
    h.source.press(T('a'));
    await settle();
    const after = h.probes.count;
    h.clock.now = 1_500;
    h.source.press(T('b'));
    h.source.press(T('c'));
    await settle();
    expect(h.probes.count).toBe(after);
    h.clock.now = 4_000;
    h.source.press(T('d'));
    await settle();
    expect(h.probes.count).toBeGreaterThan(after);
  });

  it('drops the open piece when turned off, and stops the source', async () => {
    const h = start();
    h.source.press(T('unsent'));
    await settle();
    h.service.setEnabled(false);
    expect(h.source.running()).toBe(false);
    h.service.setEnabled(true);
    h.source.press({ kind: 'enter' });
    await settle();
    expect(h.ingest).not.toHaveBeenCalled();
  });

  it('keeps nothing when the store throws, and reports no error text', async () => {
    const h = start();
    h.ingest.mockImplementationOnce(() => {
      throw new Error('the text was echoed here');
    });
    h.source.press(T('oops'));
    await settle();
    expect(() => h.source.press({ kind: 'enter' })).not.toThrow();
    await settle();
    expect(h.ingest).toHaveBeenCalledTimes(1);
  });

  it('writes nothing for a piece whose store is still in flight when discard runs', async () => {
    const h = start();
    h.source.press(T('deleted soon'));
    await settle();
    // Enter ends the piece and starts its store, which is still reading the app. Delete runs before the reads finish.
    h.source.press({ kind: 'enter' });
    h.service.discard();
    await settle();
    expect(h.ingest).not.toHaveBeenCalled();
  });

  it('writes nothing for a piece whose store is still in flight when the service stops', async () => {
    const h = start();
    h.source.press(T('stopped soon'));
    await settle();
    h.source.press({ kind: 'enter' });
    h.service.setEnabled(false);
    await settle();
    expect(h.ingest).not.toHaveBeenCalled();
  });

  it('still writes a piece that is not discarded while its store runs', async () => {
    const h = start();
    h.source.press(T('kept'));
    await settle();
    h.source.press({ kind: 'enter' });
    await settle();
    expect(h.ingest).toHaveBeenCalledWith({ ts: 1_000, app: 'Notes', text: 'kept' });
  });
});
