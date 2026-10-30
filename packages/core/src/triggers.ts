import type { Automation } from './automation';
import { normalizeAppName } from './classify';

/**
 * When the twin may offer to run a routine. An offer only ever asks; a person approves each run.
 * These limits keep offers from becoming noise. They are design values, not sourced standards.
 */
export const TRIGGER_RULES = {
  /** After an offer, the same routine is not offered again for this long. */
  offerCooldownMs: 60 * 60_000,
  /** After "Not now", the routine is left alone for this long. */
  declineCooldownMs: 4 * 60 * 60_000,
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

/**
 * Remembers when each routine was offered or declined, and answers whether it may be offered now.
 * It lives in memory on purpose: a restart can cause one extra offer, and it never causes a run.
 */
export class TriggerGate {
  private readonly offered = new Map<string, number>();
  private readonly declined = new Map<string, number>();
  private readonly offersToday = new Map<string, { day: string; count: number }>();
  private quietUntil = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  eligible(automationId: string): boolean {
    const time = this.now();
    if (time < this.quietUntil) return false;
    const lastOffer = this.offered.get(automationId);
    if (lastOffer !== undefined && time - lastOffer < TRIGGER_RULES.offerCooldownMs) return false;
    const lastDecline = this.declined.get(automationId);
    if (lastDecline !== undefined && time - lastDecline < TRIGGER_RULES.declineCooldownMs) return false;
    const today = this.offersToday.get(automationId);
    if (today && today.day === dayKey(time) && today.count >= TRIGGER_RULES.maxOffersPerDay) return false;
    return true;
  }

  recordOffer(automationId: string): void {
    const time = this.now();
    this.offered.set(automationId, time);
    const today = this.offersToday.get(automationId);
    const count = today && today.day === dayKey(time) ? today.count + 1 : 1;
    this.offersToday.set(automationId, { day: dayKey(time), count });
  }

  recordDecline(automationId: string): void {
    this.declined.set(automationId, this.now());
  }

  quietAfterRun(): void {
    this.quietUntil = this.now() + TRIGGER_RULES.quietAfterRunMs;
  }
}
