import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudConnectorError, type Tokens } from '../../src/main/connectors-cloud/oauth';
import type { CloudProviderId } from '../../src/main/connectors-cloud/providers';
import { createFileTokenStore } from '../../src/main/connectors-cloud/token-store';

const MARK = Buffer.from('FAKESEAL1', 'utf8');
const KEY = 0x5a;
const TOKENS: Tokens = { accessToken: 'ACCESS-SECRET-1', refreshToken: 'REFRESH-SECRET-1', expiresAt: 1_800_000_000_000 };

/** A stand-in for safeStorage: reversible, but it is not real encryption. The tests only check where plain text goes. */
const fakeSeal = (plain: Buffer): Buffer => Buffer.concat([MARK, Buffer.from(Array.from(plain, (byte) => byte ^ KEY))]);
const fakeOpen = (sealed: Buffer): Buffer => {
  if (!sealed.subarray(0, MARK.length).equals(MARK)) throw new Error('not sealed');
  return Buffer.from(Array.from(sealed.subarray(MARK.length), (byte) => byte ^ KEY));
};

const directories: string[] = [];

function freshDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'companyos-cloud-tokens-'));
  directories.push(directory);
  return join(directory, 'connectors');
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('file token store', () => {
  it('round-trips tokens through the seal and open functions', async () => {
    const store = createFileTokenStore({ directory: freshDirectory(), seal: fakeSeal, open: fakeOpen });

    await store.save('googleCalendar', TOKENS);

    expect(await store.load('googleCalendar')).toEqual(TOKENS);
    expect(await store.load('github')).toBeUndefined();
  });

  it('never writes a token in clear: the file holds only sealed bytes', async () => {
    const directory = freshDirectory();
    const seal = vi.fn(fakeSeal);
    const store = createFileTokenStore({ directory, seal, open: fakeOpen });

    await store.save('googleCalendar', TOKENS);

    expect(seal).toHaveBeenCalledTimes(1);
    const raw = readFileSync(join(directory, 'googleCalendar.bin'));
    expect(raw.includes(Buffer.from('ACCESS-SECRET-1', 'utf8'))).toBe(false);
    expect(raw.includes(Buffer.from('REFRESH-SECRET-1', 'utf8'))).toBe(false);
    expect(raw.toString('utf8')).not.toContain('accessToken');
    expect(raw.toString('base64')).not.toContain(Buffer.from('ACCESS-SECRET-1', 'utf8').toString('base64'));
  });

  it('leaves no temporary file behind after a save', async () => {
    const directory = freshDirectory();
    const store = createFileTokenStore({ directory, seal: fakeSeal, open: fakeOpen });

    await store.save('github', { accessToken: 'GH-TOKEN', expiresAt: 1 });

    expect(readdirSync(directory)).toEqual(['github.bin']);
  });

  it('keeps the previous tokens when a save fails part way', async () => {
    const directory = freshDirectory();
    let failNext = false;
    const store = createFileTokenStore({
      directory,
      seal: (plain) => {
        if (failNext) throw new Error('seal failed');
        return fakeSeal(plain);
      },
      open: fakeOpen,
    });
    await store.save('googleCalendar', TOKENS);

    failNext = true;
    await expect(store.save('googleCalendar', { accessToken: 'ACCESS-SECRET-2', expiresAt: 2 })).rejects.toThrow();

    expect(await store.load('googleCalendar')).toEqual(TOKENS);
    expect(readdirSync(directory)).toEqual(['googleCalendar.bin']);
  });

  it('removes a provider\'s tokens on disconnect, and is safe to call twice', async () => {
    const directory = freshDirectory();
    const store = createFileTokenStore({ directory, seal: fakeSeal, open: fakeOpen });
    await store.save('googleCalendar', TOKENS);

    await store.remove('googleCalendar');
    await store.remove('googleCalendar');

    expect(existsSync(join(directory, 'googleCalendar.bin'))).toBe(false);
    expect(await store.load('googleCalendar')).toBeUndefined();
  });

  it('refuses an unknown connector before it touches the disk', async () => {
    const directory = freshDirectory();
    const store = createFileTokenStore({ directory, seal: fakeSeal, open: fakeOpen });

    const error: unknown = await store.save('../escape' as CloudProviderId, TOKENS).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CloudConnectorError);
    expect(error).toMatchObject({ code: 'store' });
    expect(existsSync(directory)).toBe(false);
  });

  it('runs the guard before every seal and open, and writes nothing when the guard refuses', async () => {
    const directory = freshDirectory();
    const guard = vi.fn(() => {
      throw new Error('keyring unavailable');
    });
    const seal = vi.fn(fakeSeal);
    const store = createFileTokenStore({ directory, seal, open: fakeOpen, guard });

    await expect(store.save('googleCalendar', TOKENS)).rejects.toThrow('keyring unavailable');

    expect(guard).toHaveBeenCalled();
    expect(seal).not.toHaveBeenCalled();
    expect(existsSync(join(directory, 'googleCalendar.bin'))).toBe(false);
  });

  it('reports an unreadable saved file with a fixed sentence that carries no token', async () => {
    const directory = freshDirectory();
    const store = createFileTokenStore({
      directory,
      seal: fakeSeal,
      open: () => {
        throw new Error('bad key ACCESS-SECRET-1');
      },
    });
    await store.save('googleCalendar', TOKENS);
    const reader = createFileTokenStore({
      directory,
      seal: fakeSeal,
      open: () => {
        throw new Error('bad key ACCESS-SECRET-1');
      },
    });

    const error: unknown = await reader.load('googleCalendar').catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'store', message: 'The saved connection could not be opened. Connect the account again.' });
    expect((error as Error).message).not.toContain('ACCESS-SECRET-1');
  });

  it('treats an opened file that is not a token record as unreadable', async () => {
    const directory = freshDirectory();
    const store = createFileTokenStore({
      directory,
      seal: fakeSeal,
      open: () => Buffer.from('{"expiresAt":"soon"}', 'utf8'),
    });
    await store.save('github', { accessToken: 'GH-TOKEN', expiresAt: 1 });

    const error: unknown = await store.load('github').catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'store' });
  });
});
