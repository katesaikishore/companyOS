import type { Automation } from './automation';
import { normalizeAppName } from './classify';
import { MAX_DECLINE_STREAK } from './types';

/**
 * When the twin may offer to run a routine. An offer only ever asks; a person approves each run.
 * These limits keep offers from becoming noise. They are design values, not sourced standards.
 */
export const TRIGGER_RULES = {
  /** After an offer, the same routine is not offered again for this long. */
  offerCooldownMs: 60 * 60_000,
  /**
   * After "Not now" or a dismissal, the routine is left alone for this long. Each decline in a row, with no accept or
   * completed run in between, doubles the wait, up to declineCooldownCapMs.
   */
  declineCooldownMs: 4 * 60 * 60_000,
  /** The longest a decline cooldown grows to: seven days. */
  declineCooldownCapMs: 7 * 24 * 60 * 60_000,
  /** At most this many offers per routine per local day. */
  maxOffersPerDay: 6,
  /** An offer nobody answers expires after this long. */
  offerTtlMs: 10 * 60_000,
  /** After a run, the twin stays quiet for this long, so the run's own app switches do not trigger offers. */
  quietAfterRunMs: 2 * 60_000,
} as const;

/** The applications that open a routine: the apps its first step can focus. */
export function openingApps(automation: Automation): string[] {
  const first = automation.steps[0];
  if (!first || first.op !== 'focus_app') return [];
  const reference = /^\$(p\d+)$/.exec(first.app);
  if (!reference) return [normalizeAppName(first.app)];
  const param = automation.params.find(candidate => candidate.name === reference[1]);
  return (param?.options ?? []).map(normalizeAppName);
}

function dayKey(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/** The most decline records kept. The oldest are dropped first. The stored list is bounded the same way (types.ts). */
const MAX_DECLINE_RECORDS = 500;

/** One routine's declines: when the latest was, and how many came in a row with no accept or completed run between. */
export interface DeclineRecord {
  routineId: string;
  /** When the latest decline or dismissal happened, in ms. */
  at: number;
  count: number;
}

/** How long a routine is left alone after its latest decline. The wait doubles with each decline in a row, up to the cap. */
function declineCooldownMs(count: number): number {
  return Math.min(TRIGGER_RULES.declineCooldownMs * 2 ** (count - 1), TRIGGER_RULES.declineCooldownCapMs);
}

/**
 * Remembers when each routine was offered or declined, and answers whether it may be offered now. Declines are kept in
 * the encrypted config, so a restart does not offer a routine again that the person just declined. That is safe because
 * a restart can never start a run. Offers and the quiet time after a run stay in memory: a restart can cause one extra
 * offer, and it never causes a run.
 */
export class TriggerGate {
  private readonly offered = new Map<string, number>();
  /** Insertion order follows the latest decline, so the oldest records come first. */
  private readonly declines = new Map<string, DeclineRecord>();
  private readonly offersToday = new Map<string, { day: string; count: number }>();
  private quietUntil = 0;

  /** `saved` holds the declines kept from an earlier run. The agent loads them when it starts. */
  constructor(
    private readonly now: () => number = () => Date.now(),
    saved: readonly DeclineRecord[] = [],
  ) {
    for (const record of saved) this.declines.set(record.routineId, record);
  }

  eligible(routineId: string): boolean {
    const time = this.now();
    if (time < this.quietUntil) return false;
    const lastOffer = this.offered.get(routineId);
    if (lastOffer !== undefined && time - lastOffer < TRIGGER_RULES.offerCooldownMs) return false;
    const decline = this.declines.get(routineId);
    if (decline && time - decline.at < declineCooldownMs(decline.count)) return false;
    const today = this.offersToday.get(routineId);
    if (today && today.day === dayKey(time) && today.count >= TRIGGER_RULES.maxOffersPerDay) return false;
    return true;
  }

  recordOffer(routineId: string): void {
    const time = this.now();
    this.offered.set(routineId, time);
    const today = this.offersToday.get(routineId);
    const count = today && today.day === dayKey(time) ? today.count + 1 : 1;
    this.offersToday.set(routineId, { day: dayKey(time), count });
  }

  /** "Not now", or a dismissal. Each one in a row, with no accept or completed run between, lengthens the wait. */
  recordDecline(routineId: string): void {
    const count = Math.min((this.declines.get(routineId)?.count ?? 0) + 1, MAX_DECLINE_STREAK);
    // Removed first, so the record moves to the end and the oldest are the ones dropped when the list is full.
    this.declines.delete(routineId);
    this.declines.set(routineId, { routineId, at: this.now(), count });
    if (this.declines.size > MAX_DECLINE_RECORDS) {
      const oldest = this.declines.keys().next();
      if (!oldest.done) this.declines.delete(oldest.value);
    }
  }

  /** An accept or a completed run starts the count again. Returns whether there was a count to clear. */
  resetDeclines(routineId: string): boolean {
    return this.declines.delete(routineId);
  }

  /** Every decline record, oldest first. The agent writes these to the encrypted config. */
  declineRecords(): DeclineRecord[] {
    return [...this.declines.values()];
  }

  quietAfterRun(): void {
    this.quietUntil = this.now() + TRIGGER_RULES.quietAfterRunMs;
  }
}
