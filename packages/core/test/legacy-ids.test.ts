import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { legacyRelinks, legacyRoutineIdOf, routineIdOf, type Routine, type RoutineStep } from '../src';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12);

function step(windowClass: RoutineStep['windowClass'], app: string, urlTemplate?: string): RoutineStep {
  return { windowClass, app, options: [app], ...(urlTemplate ? { urlTemplate, site: urlTemplate } : {}) };
}

/** A routine with only the fields the id helpers read. */
function routine(id: string, steps: RoutineStep[]): Routine {
  return { id, steps } as unknown as Routine;
}

describe('legacyRoutineIdOf', () => {
  it('is the hash of the window classes in order, as the id was before a site was kept', () => {
    const steps = [step('browser', 'Google Chrome', 'mail.example.com/inbox'), step('spreadsheet', 'Excel'), step('browser', 'Google Chrome', 'docs.example.com/doc')];
    expect(legacyRoutineIdOf({ steps })).toBe(sha('browser>spreadsheet>browser'));
    expect(legacyRoutineIdOf({ steps })).not.toBe(routineIdOf('browser@mail.example.com/inbox>spreadsheet>browser@docs.example.com/doc'));
  });

  it('merges consecutive steps of one class, as the old mining did', () => {
    const steps = [step('browser', 'Google Chrome', 'a.example.com'), step('browser', 'Google Chrome', 'b.example.com'), step('spreadsheet', 'Excel')];
    expect(legacyRoutineIdOf({ steps })).toBe(sha('browser>spreadsheet'));
  });

  it('is the routine\'s own id when no step has a site, so it needs no move', () => {
    const steps = [step('mail', 'Outlook'), step('spreadsheet', 'Excel')];
    expect(legacyRoutineIdOf({ steps })).toBe(routineIdOf('mail>spreadsheet'));
  });

  it('is undefined for a routine with an unknown app, which the old mining never found', () => {
    const steps = [step('browser', 'Google Chrome', 'a.example.com'), step('other', 'Vendor Tool')];
    expect(legacyRoutineIdOf({ steps })).toBeUndefined();
  });
});

describe('legacyRelinks', () => {
  it('maps a legacy id to the one routine that has it', () => {
    const site = routine('new-id', [step('browser', 'Chrome', 'a.example.com'), step('spreadsheet', 'Excel')]);
    const relinks = legacyRelinks([site]);
    expect(relinks.get(sha('browser>spreadsheet'))).toBe(site);
  });

  it('maps nothing when two routines share a legacy id, because nothing says which one a record meant', () => {
    const first = routine('id-a', [step('browser', 'Chrome', 'a.example.com'), step('spreadsheet', 'Excel')]);
    const second = routine('id-b', [step('browser', 'Chrome', 'b.example.com'), step('spreadsheet', 'Excel')]);
    expect(legacyRelinks([first, second]).size).toBe(0);
  });

  it('leaves out a routine whose legacy id is already its id', () => {
    const plain = routine(routineIdOf('mail>spreadsheet'), [step('mail', 'Outlook'), step('spreadsheet', 'Excel')]);
    expect(legacyRelinks([plain]).size).toBe(0);
  });
});
