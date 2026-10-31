import { describe, expect, it } from 'vitest';
import { modelThreads } from '../src';

describe('modelThreads', () => {
  it.each([
    [2, 1],
    [3, 1],
    [4, 2],
    [6, 3],
    [8, 4],
    [16, 8],
  ])('uses half of %i math cores: %i threads', (cores, threads) => {
    expect(modelThreads(cores)).toBe(threads);
  });

  it('never goes below one thread', () => {
    expect(modelThreads(1)).toBe(1);
    expect(modelThreads(0)).toBe(1);
    expect(modelThreads(-4)).toBe(1);
  });

  it('falls back to one thread for a count that is not a number', () => {
    expect(modelThreads(Number.NaN)).toBe(1);
    expect(modelThreads(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('always leaves at least one core free on a machine with two or more', () => {
    for (let cores = 2; cores <= 64; cores++) expect(modelThreads(cores)).toBeLessThan(cores);
  });
});
