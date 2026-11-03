import { describe, expect, it } from 'vitest';
import { InputLock, type InputLockEntry } from '../src/main/input-lock';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('InputLock', () => {
  it('runs holders one at a time, first come first served', async () => {
    const lock = new InputLock();
    const events: string[] = [];
    const holder = (name: string, ms: number) =>
      lock.run(name, async () => {
        events.push(`${name}:in`);
        await pause(ms);
        events.push(`${name}:out`);
        return name;
      });
    const results = await Promise.all([holder('a', 30), holder('b', 5), holder('c', 1)]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(events).toEqual(['a:in', 'a:out', 'b:in', 'b:out', 'c:in', 'c:out']);
  });

  it('releases the lock when a holder throws, and passes the error on', async () => {
    const lock = new InputLock();
    await expect(lock.run('a', async () => Promise.reject(new Error('step failed')))).rejects.toThrow('step failed');
    await expect(lock.run('b', async () => 'next')).resolves.toBe('next');
  });

  it('records who held it, how long they waited and how long they held it', async () => {
    const entries: InputLockEntry[] = [];
    const lock = new InputLock(entry => entries.push(entry));
    await Promise.all([lock.run('first', () => pause(40)), lock.run('second', () => pause(1))]);
    expect(entries.map(entry => entry.owner)).toEqual(['first', 'second']);
    expect(entries[0].heldMs).toBeGreaterThanOrEqual(30);
    expect(entries[1].waitedMs).toBeGreaterThanOrEqual(30);
  });

  it('keeps working when its log throws', async () => {
    const lock = new InputLock(() => {
      throw new Error('log broke');
    });
    await expect(lock.run('a', async () => 1)).resolves.toBe(1);
    await expect(lock.run('b', async () => 2)).resolves.toBe(2);
  });
});
