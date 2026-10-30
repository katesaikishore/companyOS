import { describe, expect, it } from 'vitest';
import {
  COMPANY_PARAMETERS,
  CohortReleaseSchema,
  PrivacyBudget,
  clampDevice,
  laplace,
  releaseCohorts,
  releaseScales,
  systemUniform,
  type Contribution,
} from '../src';

/** A repeatable uniform source (mulberry32), so the noise tests do not flake. Values are strictly between 0 and 1. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967296;
  };
}

const noNoise = () => 0.5;

/** Ten devices that each use the same single item once. */
function devices(count: number, item: string): Contribution[][] {
  return Array.from({ length: count }, () => [{ item, count: 1 }]);
}

describe('releaseCohorts', () => {
  it('publishes an item only when at least cohortMin devices use it', () => {
    const budget = new PrivacyBudget(10);
    const release = releaseCohorts([...devices(9, 'alpha'), ...devices(10, 'beta')], budget, noNoise);
    expect(release.items).toEqual([{ item: 'beta', devices: 10, total: 10 }]);
  });

  it('caps each device at maxItemsPerDevice items and maxCountPerItem per item', () => {
    const { maxItemsPerDevice, maxCountPerItem } = COMPANY_PARAMETERS;
    const letters = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const heavy: Contribution[] = letters.map(item => ({ item, count: 1000 }));
    const budget = new PrivacyBudget(10);
    const release = releaseCohorts(Array.from({ length: 10 }, () => heavy), budget, noNoise);

    const kept = letters.slice(0, maxItemsPerDevice);
    expect(release.items.map(item => item.item)).toEqual(kept);
    for (const item of release.items) {
      expect(item.devices).toBe(10);
      expect(item.total).toBe(10 * maxCountPerItem);
    }
  });

  it('refuses a release that would overspend the budget, and draws no noise for it', () => {
    const budget = new PrivacyBudget(0);
    let draws = 0;
    expect(() =>
      releaseCohorts(devices(10, 'a'), budget, () => {
        draws += 1;
        return 0.5;
      }),
    ).toThrow('privacy budget');
    expect(draws).toBe(0);
  });

  it('spends one release of epsilon per release, and stops when the budget is gone', () => {
    const budget = new PrivacyBudget(2);
    releaseCohorts(devices(10, 'a'), budget, noNoise);
    releaseCohorts(devices(10, 'a'), budget, noNoise);
    expect(budget.remaining()).toBeCloseTo(0);
    expect(() => releaseCohorts(devices(10, 'a'), budget, noNoise)).toThrow('privacy budget');
  });

  it('never publishes a negative total, however the noise falls', () => {
    // The first draw is the device-count noise (zero), the second is a large negative total noise.
    let call = 0;
    const uniform = () => (call++ % 2 === 0 ? 0.5 : 0.0001);
    const release = releaseCohorts(devices(10, 'a'), new PrivacyBudget(10), uniform);
    expect(release.items).toEqual([{ item: 'a', devices: 10, total: 0 }]);
  });

  it('refuses a release with a device identifier or any other extra field', () => {
    const budget = new PrivacyBudget(10);
    expect(() => releaseCohorts([[{ item: 'a', count: 1, deviceId: 'd-1' } as Contribution]], budget, noNoise)).toThrow();
    expect(() => releaseCohorts([[{ item: 'a', count: -1 }]], budget, noNoise)).toThrow();
    expect(() => releaseCohorts([[{ item: 'a', count: 1.5 }]], budget, noNoise)).toThrow();
  });
});

describe('clampDevice', () => {
  it('merges repeated items, caps counts and drops zero counts', () => {
    const { maxCountPerItem } = COMPANY_PARAMETERS;
    expect(
      clampDevice([
        { item: 'x', count: 3 },
        { item: 'x', count: 4 },
        { item: 'y', count: 0 },
        { item: 'z', count: maxCountPerItem * 10 },
      ]),
    ).toEqual([
      { item: 'z', count: maxCountPerItem },
      { item: 'x', count: 7 },
    ]);
  });
});

describe('noise', () => {
  it('has the Laplace scale it is asked for: mean absolute value equal to the scale, and mean near zero', () => {
    const uniform = seeded(7);
    const scale = 2;
    const draws = Array.from({ length: 40000 }, () => laplace(scale, uniform));
    const meanAbsolute = draws.reduce((sum, value) => sum + Math.abs(value), 0) / draws.length;
    const mean = draws.reduce((sum, value) => sum + value, 0) / draws.length;
    expect(meanAbsolute).toBeGreaterThan(scale * 0.95);
    expect(meanAbsolute).toBeLessThan(scale * 1.05);
    expect(Math.abs(mean)).toBeLessThan(0.05);
  });

  it('gives the scales that follow from the per-device limits and the epsilon split', () => {
    const { epsilonPerRelease, maxItemsPerDevice, maxCountPerItem } = COMPANY_PARAMETERS;
    const half = epsilonPerRelease / 2;
    const scales = releaseScales();
    expect(scales.countScale).toBeCloseTo(maxItemsPerDevice / half);
    expect(scales.sumScale).toBeCloseTo((maxItemsPerDevice * maxCountPerItem) / half);
  });

  it('system randomness is always strictly between 0 and 1', () => {
    for (let i = 0; i < 20000; i += 1) {
      const value = systemUniform();
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('the release shape', () => {
  it('parses against the strict schema, and the schema refuses extra fields', () => {
    const release = releaseCohorts(devices(10, 'a'), new PrivacyBudget(10), noNoise);
    expect(CohortReleaseSchema.safeParse(release).success).toBe(true);
    expect(CohortReleaseSchema.safeParse({ ...release, deviceId: 'd-1' }).success).toBe(false);
    expect(CohortReleaseSchema.safeParse({ ...release, items: [{ item: 'a', devices: 10, total: 10, who: 'x' }] }).success).toBe(false);
  });

  it('carries the parameters it was made under, so a published release states what it spent', () => {
    const release = releaseCohorts(devices(10, 'a'), new PrivacyBudget(10), noNoise);
    expect(release.epsilon).toBe(COMPANY_PARAMETERS.epsilonPerRelease);
    expect(COMPANY_PARAMETERS.status).toContain('pending legal review');
  });
});
