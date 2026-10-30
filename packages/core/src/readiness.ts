import type { AppReadinessView } from './contract';

/** The readiness view before any switches are recorded. The engine fills it in. */
export function emptyReadiness(): AppReadinessView {
  return { switches: 0, apps: 0, automatablePct: 0, approvalPct: 0, notYetPct: 0, rows: [] };
}
