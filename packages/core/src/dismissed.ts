import { stepKey, type Routine } from './mine';
import { MAX_SIGNATURE_CHARS } from './types';

/** The most dismissed signatures kept. The oldest go first, as the dismissed ids do. */
const MAX_SIGNATURES = 500;
/**
 * Both routines need this many steps for a near match. A shorter routine matches only exactly, since one changed step
 * in two is half of it.
 */
const MIN_NEAR_STEPS = 3;

/**
 * The signature of a routine: its step keys in order, joined with '>'. A step key is its window class, or "other:" and
 * its app name, with its site after "@" for a browser (see stepKey). Those names are already stored, so nothing new is
 * kept.
 */
export function signatureOf(routine: Routine): string {
  return routine.steps.map(step => stepKey(step)).join('>');
}

/**
 * True when the routine is one the person dismissed: its id is dismissed, its signature is a dismissed signature, or it
 * differs from one by a single step added, removed or changed. The near match needs both routines to have at least
 * MIN_NEAR_STEPS steps.
 */
export function matchesDismissed(routine: Routine, dismissedIds: readonly string[], signatures: readonly string[]): boolean {
  if (dismissedIds.includes(routine.id)) return true;
  const keys = routine.steps.map(step => stepKey(step));
  const signature = keys.join('>');
  return signatures.some(stored => {
    if (stored === signature) return true;
    const other = stored.split('>');
    return keys.length >= MIN_NEAR_STEPS && other.length >= MIN_NEAR_STEPS && withinOneStep(keys, other);
  });
}

/**
 * The stored signatures with one more added. A signature already stored is not added twice. A signature longer than
 * MAX_SIGNATURE_CHARS is not stored, so its routine stays hidden by id only.
 */
export function addSignature(signatures: readonly string[], signature: string): string[] {
  if (signature.length > MAX_SIGNATURE_CHARS || signatures.includes(signature)) return [...signatures];
  return [...signatures, signature].slice(-MAX_SIGNATURES);
}

/** True when two step sequences are the same, or differ by one step: one added or removed, or one changed. */
function withinOneStep(a: readonly string[], b: readonly string[]): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  if (a.length === b.length) return a.slice(start + 1).every((key, offset) => key === b[start + 1 + offset]);
  const [longer, shorter] = a.length > b.length ? [a, b] : [b, a];
  return longer.slice(start + 1).every((key, offset) => key === shorter[start + offset]);
}
