import { z } from 'zod';
import { laplace, systemUniform } from './noise';
import { COMPANY_PARAMETERS } from './params';

/**
 * One item and how many times one device used it. Only anonymised contributions reach this module: it never sees a
 * device or subject identifier, and the schema refuses any extra field.
 */
export const ContributionSchema = z
  .object({
    item: z.string().min(1).max(200),
    count: z.number().int().nonnegative(),
  })
  .strict();
export type Contribution = z.infer<typeof ContributionSchema>;

/** One released item. The numbers are noisy, rounded, and only published when the cohort is large enough. */
export const CohortItemSchema = z
  .object({
    item: z.string().min(1).max(200),
    devices: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .strict();

/** What leaves the aggregator. It names items and noisy totals, never a device. */
export const CohortReleaseSchema = z
  .object({
    epsilon: z.number().positive(),
    items: z.array(CohortItemSchema),
  })
  .strict();
export type CohortItem = z.infer<typeof CohortItemSchema>;
export type CohortRelease = z.infer<typeof CohortReleaseSchema>;

/** Epsilon left for one period. Each release spends from it, and a release that would overspend is refused. */
export class PrivacyBudget {
  private spent = 0;

  constructor(readonly total: number = COMPANY_PARAMETERS.budgetTotal) {}

  remaining(): number {
    return this.total - this.spent;
  }

  spend(epsilon: number): void {
    if (epsilon > this.remaining() + 1e-12) throw new Error('The privacy budget for this period is spent.');
    this.spent += epsilon;
  }
}

/** The Laplace scales a release uses. Epsilon is split evenly between device counts and totals. */
export function releaseScales(): { countScale: number; sumScale: number } {
  const { epsilonPerRelease, maxItemsPerDevice, maxCountPerItem } = COMPANY_PARAMETERS;
  const half = epsilonPerRelease / 2;
  return {
    // One device moves at most maxItemsPerDevice device counts by one each.
    countScale: maxItemsPerDevice / half,
    // One device moves at most maxItemsPerDevice totals, each by at most maxCountPerItem.
    sumScale: (maxItemsPerDevice * maxCountPerItem) / half,
  };
}

/**
 * Brings one device's contribution within the limits: repeated items are merged, each count is capped, zero counts
 * are dropped, and at most maxItemsPerDevice items are kept (largest first, then by name, so the choice is repeatable).
 */
export function clampDevice(contributions: readonly Contribution[]): Array<{ item: string; count: number }> {
  const { maxItemsPerDevice, maxCountPerItem } = COMPANY_PARAMETERS;
  const merged = new Map<string, number>();
  for (const { item, count } of contributions) merged.set(item, (merged.get(item) ?? 0) + count);
  return [...merged]
    .map(([item, count]) => ({ item, count: Math.min(count, maxCountPerItem) }))
    .filter(entry => entry.count > 0)
    .sort((a, b) => b.count - a.count || (a.item < b.item ? -1 : a.item > b.item ? 1 : 0))
    .slice(0, maxItemsPerDevice);
}

/**
 * One release over a set of anonymised device contributions. An item is published only when its noisy device count
 * reaches the cohort minimum, so an item used by a few people is not published. The decision uses only the noisy
 * count, so the set of published items is itself noisy.
 *
 * The guarantee is approximate: publishing by threshold is not pure differential privacy, and the delta it gives has
 * not been derived yet. The release stays pending legal and statistical review (plan 8.2).
 */
export function releaseCohorts(
  devices: ReadonlyArray<readonly Contribution[]>,
  budget: PrivacyBudget,
  uniform: () => number = systemUniform,
): CohortRelease {
  const checked = devices.map(device => z.array(ContributionSchema).parse(device));
  // Charge the budget before any noise is drawn, so a release that fails part way has still been paid for.
  budget.spend(COMPANY_PARAMETERS.epsilonPerRelease);

  const { countScale, sumScale } = releaseScales();
  const devicesPerItem = new Map<string, number>();
  const totalPerItem = new Map<string, number>();
  for (const device of checked) {
    for (const { item, count } of clampDevice(device)) {
      devicesPerItem.set(item, (devicesPerItem.get(item) ?? 0) + 1);
      totalPerItem.set(item, (totalPerItem.get(item) ?? 0) + count);
    }
  }

  const items: CohortItem[] = [];
  for (const item of [...devicesPerItem.keys()].sort()) {
    const noisyDevices = (devicesPerItem.get(item) ?? 0) + laplace(countScale, uniform);
    if (noisyDevices < COMPANY_PARAMETERS.cohortMin) continue;
    const noisyTotal = (totalPerItem.get(item) ?? 0) + laplace(sumScale, uniform);
    items.push({ item, devices: Math.round(noisyDevices), total: Math.max(0, Math.round(noisyTotal)) });
  }
  return CohortReleaseSchema.parse({ epsilon: COMPANY_PARAMETERS.epsilonPerRelease, items });
}
