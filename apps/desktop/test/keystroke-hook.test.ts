import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKeyboardSource, type HookApi, type HookKeyEvent, type HookModule } from '../src/main/keyboard';
import { KeystrokeService } from '../src/main/keystroke-service';

/*
 * The hook source wired to the keystroke service, the way the runtime wires them. The hook is a fake that delivers key-down
 * presses on demand, so the real module is never loaded. Every key goes through the service and its gates, and the test
 * checks what reaches the store.
 */

interface World {
  /** The app in front. */
  front: string | undefined;
  /** The typed-text setting. */
  setting: boolean;
  secure: boolean | 'unknown';
  locked: boolean;
  paused: boolean;
  idle: boolean;
  windowExcluded: boolean;
  now: number;
}

function fakeHook() {
  const listeners = new Set<(event: HookKeyEvent) => void>();
  const calls = { start: 0, stop: 0 };
  const hook: HookApi & { emit(keycode: number, over?: Partial<HookKeyEvent>): void; listenerCount(): number; calls: typeof calls } = {
    calls,
    on(_event, listener) {
      listeners.add(listener);
      return hook;
    },
    off(_event, listener) {
      listeners.delete(listener);
      return hook;
    },
    start() {
      calls.start += 1;
    },
    stop() {
      calls.stop += 1;
    },
    emit(keycode, over = {}) {
      for (const listener of [...listeners]) {
        listener({ keycode, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...over });
      }
    },
    listenerCount() {
      return listeners.size;
    },
  };
  return hook;
}

/** Lets the pending reads and stores of the service finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
}

const KEY = { A: 0x1e, B: 0x30, C: 0x2e, D: 0x20, E: 0x12, H: 0x23, COMMA: 0x33, SPACE: 0x39, TWO: 0x03, ENTER: 0x1c };
const ENTER = KEY.ENTER;
const services: KeystrokeService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
});

function rig(options: { loader?: () => HookModule } = {}) {
  const hook = fakeHook();
  const world: World = {
    front: 'Notes',
    setting: true,
    secure: false,
    locked: false,
    paused: false,
    idle: false,
    windowExcluded: false,
    now: 1_000,
  };
  const source = createKeyboardSource('darwin', options.loader ?? (() => ({ uIOhook: hook })));
  const ingest = vi.fn((_piece: { ts: number; app: string; text: string }) => true);
  const service = new KeystrokeService({
    source,
    frontApp: async () => world.front,
    secureInput: async () => world.secure,
    state: app => ({
      enabled: world.setting,
      locked: world.locked,
      paused: world.paused,
      idle: world.idle,
      permissionGranted: source.permissionGranted(),
      appExcluded: app === undefined || app === '1Password',
      windowExcluded: world.windowExcluded,
      windowClass: app === 'Google Chrome' ? 'browser' : 'document',
    }),
    ingest,
    now: () => world.now,
  });
  services.push(service);
  return { hook, world, source, ingest, service };
}

/** Types the keys of "Hi, 2" and then Enter, which ends the piece. */
function typeHiTwo(hook: ReturnType<typeof fakeHook>): void {
  hook.emit(KEY.H, { shiftKey: true });
  hook.emit(0x17); // i
  hook.emit(KEY.COMMA);
  hook.emit(KEY.SPACE);
  hook.emit(KEY.TWO);
  hook.emit(ENTER);
}

describe('typed text through the hook', () => {
  it('keeps a piece under the app it was typed into, with the case and symbols the US layout gives', async () => {
    const { hook, ingest, service } = rig();
    service.setEnabled(true);
    typeHiTwo(hook);
    await settle();
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledWith({ ts: 1_000, app: 'Notes', text: 'Hi, 2' });
  });

  it('does not start the hook while the setting is off, and drops any press that reaches it', async () => {
    const { hook, ingest, service, world } = rig();
    world.setting = false;
    service.setEnabled(false);
    expect(hook.calls.start).toBe(0);
    typeHiTwo(hook);
    await settle();
    expect(ingest).not.toHaveBeenCalled();
  });

  const refusals: Array<[string, (world: World) => void]> = [
    ['the screen is locked', world => (world.locked = true)],
    ['capture is paused', world => (world.paused = true)],
    ['the person is away', world => (world.idle = true)],
    ['the app is excluded', world => (world.front = '1Password')],
    ['the window kind is excluded', world => (world.windowExcluded = true)],
    ['the app is a browser', world => (world.front = 'Google Chrome')],
    ['secure input is on', world => (world.secure = true)],
    ['secure input cannot be checked', world => (world.secure = 'unknown')],
  ];

  for (const [name, refuse] of refusals) {
    it(`delivers no piece to the store while the policy refuses, because ${name}`, async () => {
      const { hook, ingest, service, world } = rig();
      refuse(world);
      service.setEnabled(true);
      typeHiTwo(hook);
      await settle();
      expect(hook.listenerCount()).toBe(1);
      expect(ingest).not.toHaveBeenCalled();
    });
  }

  it('drops the open piece when a gate refuses partway through it, so nothing from before the refusal is kept', async () => {
    const { hook, ingest, service, world } = rig();
    service.setEnabled(true);
    hook.emit(KEY.A);
    hook.emit(KEY.B);
    await settle();
    world.locked = true;
    hook.emit(KEY.D);
    await settle();
    world.locked = false;
    hook.emit(ENTER);
    await settle();
    expect(ingest).not.toHaveBeenCalled();
  });

  it('drops the open piece when a password field appears partway through it', async () => {
    const { hook, ingest, service, world } = rig();
    service.setEnabled(true);
    hook.emit(KEY.A);
    hook.emit(KEY.B);
    await settle();
    world.secure = true;
    world.now = 4_000;
    hook.emit(KEY.C);
    hook.emit(ENTER);
    await settle();
    expect(ingest).not.toHaveBeenCalled();
  });

  it('starts the hook when the setting is on, stops it when the setting is off, and stops it on stop', () => {
    const { hook, service, world } = rig();
    service.setEnabled(true);
    expect(hook.calls.start).toBe(1);
    expect(hook.listenerCount()).toBe(1);

    world.setting = false;
    service.setEnabled(false);
    expect(hook.calls.stop).toBe(1);
    expect(hook.listenerCount()).toBe(0);

    world.setting = true;
    service.setEnabled(true);
    expect(hook.calls.start).toBe(2);

    service.stop();
    expect(hook.calls.stop).toBe(2);
    expect(hook.listenerCount()).toBe(0);
  });

  it('is off, with no hook started and no error, when the hook cannot load', async () => {
    const { service, ingest, world } = rig({
      loader: () => {
        throw new Error('Cannot find module');
      },
    });
    expect(service.available).toBe(false);
    expect(service.unavailableReason).toContain('did not load');
    expect(() => service.setEnabled(true)).not.toThrow();
    expect(service.permissionGranted).toBe(false);
    await settle();
    expect(ingest).not.toHaveBeenCalled();
    expect(world.setting).toBe(true);
  });

  it('logs nothing about the keys or the text it sees', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info')];
    try {
      const { hook, service } = rig();
      service.setEnabled(true);
      typeHiTwo(hook);
      hook.emit(KEY.A);
      await settle();
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
