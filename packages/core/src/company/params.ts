/**
 * Parameters for company aggregates (plan 8.2). These are design recommendations, not legal requirements. Every value is
 * marked pending until counsel and a statistician sign off, and every release records the epsilon it spent.
 */
export const COMPANY_PARAMETERS = {
  status: 'pending legal review (plan 8.2)',
  /** Minimum number of devices in a cohort before any of its numbers can leave the aggregator (plan 8.2: k >= 10). */
  cohortMin: 10,
  /** Epsilon spent by one release. Split evenly between the device counts and the totals. */
  epsilonPerRelease: 1,
  /** Most items one device may contribute to a release. Bounds how much one device can move a release. */
  maxItemsPerDevice: 5,
  /** Largest count one device may contribute for one item. Bounds how much one device can move a total. */
  maxCountPerItem: 20,
  /** Epsilon available for one period across all releases. */
  budgetTotal: 10,
} as const;
