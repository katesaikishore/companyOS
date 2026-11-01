import { describe, expect, it } from 'vitest';
import {
  MAX_SIGNATURE_CHARS,
  addSignature,
  matchesDismissed,
  routineIdOf,
  signatureOf,
  withoutRoutine,
  type Routine,
  type RoutineStep,
  type WindowClass,
} from '../src';

/** A routine of plain steps, one per window class, the way mining keys a step that is not an unknown app. */
function routine(id: string, classes: WindowClass[]): Routine {
  const steps: RoutineStep[] = classes.map(windowClass => ({ windowClass, app: windowClass, options: [windowClass] }));
  return { id, steps, support: 5, days: 5, score: 0.5, segmentIds: [], durationMs: 0, occurrencesPerWeek: 1, lastSeenAt: 0 };
}

const SHEET_FLOW: WindowClass[] = ['spreadsheet', 'document', 'chat', 'design'];
const DISMISSED = signatureOf(routine('dismissed', SHEET_FLOW));

describe('withoutRoutine', () => {
  it('drops the signature whose hash is the routine id, and keeps the others', () => {
    const other = signatureOf(routine('other', ['editor', 'chat']));
    expect(withoutRoutine([DISMISSED, other], routineIdOf(DISMISSED))).toEqual([other]);
    expect(withoutRoutine([DISMISSED, other], routineIdOf('unrelated'))).toEqual([DISMISSED, other]);
  });
});

describe('signatureOf', () => {
  it('joins the step keys in order: a site follows an @, and an unknown app is keyed by its name', () => {
    const steps: RoutineStep[] = [
      { windowClass: 'browser', app: 'google chrome', urlTemplate: 'docs.example.com/doc', options: ['google chrome'] },
      { windowClass: 'other', app: 'Random App', options: ['random app'] },
      { windowClass: 'chat', app: 'slack', options: ['slack'] },
    ];
    expect(signatureOf({ ...routine('mixed', []), steps })).toBe('browser@docs.example.com/doc>other:random app>chat');
  });
});

describe('matchesDismissed', () => {
  it('hides a dismissed routine by its id, and a routine with the same steps by its signature', () => {
    expect(matchesDismissed(routine('dismissed', SHEET_FLOW), ['dismissed'], [])).toBe(true);
    expect(matchesDismissed(routine('again', SHEET_FLOW), [], [DISMISSED])).toBe(true);
  });

  it('hides a near copy that changes one step', () => {
    expect(matchesDismissed(routine('changed', ['spreadsheet', 'document', 'mail', 'design']), [], [DISMISSED])).toBe(true);
  });

  it('hides a near copy that adds one step, or that drops one', () => {
    expect(matchesDismissed(routine('added', ['spreadsheet', 'document', 'chat', 'design', 'mail']), [], [DISMISSED])).toBe(true);
    expect(matchesDismissed(routine('dropped', ['spreadsheet', 'document', 'design']), [], [DISMISSED])).toBe(true);
  });

  it('leaves alone a routine that differs in two steps, or one that shares no steps', () => {
    expect(matchesDismissed(routine('two', ['spreadsheet', 'mail', 'chat', 'editor']), [], [DISMISSED])).toBe(false);
    expect(matchesDismissed(routine('other', ['mail', 'editor', 'terminal']), [], [DISMISSED])).toBe(false);
  });

  it('matches a two-step routine only exactly, and never a near copy of a three-step one', () => {
    const pair = signatureOf(routine('pair', ['spreadsheet', 'chat']));
    expect(matchesDismissed(routine('same', ['spreadsheet', 'chat']), [], [pair])).toBe(true);
    expect(matchesDismissed(routine('half', ['spreadsheet', 'mail']), [], [pair])).toBe(false);
    const three = signatureOf(routine('three', ['spreadsheet', 'document', 'chat']));
    expect(matchesDismissed(routine('short', ['spreadsheet', 'document']), [], [three])).toBe(false);
  });
});

describe('addSignature', () => {
  it('stores a signature once, and leaves out one too long to store', () => {
    const once = addSignature([], 'a>b>c');
    expect(addSignature(once, 'a>b>c')).toEqual(['a>b>c']);
    expect(addSignature(once, 'x'.repeat(MAX_SIGNATURE_CHARS + 1))).toEqual(['a>b>c']);
  });

  it('keeps the newest 500, as the dismissed ids are kept', () => {
    let signatures: string[] = [];
    for (let index = 0; index < 501; index++) signatures = addSignature(signatures, `step${index}`);
    expect(signatures).toHaveLength(500);
    expect(signatures[0]).toBe('step1');
    expect(signatures.at(-1)).toBe('step500');
  });
});
