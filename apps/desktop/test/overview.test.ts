import type { DraftStep } from '@companyos/twin-core';
import { describe, expect, it } from 'vitest';
import { DAY_MS, handoffStateLabel, noticedPerWeek, summarySourceLabel, titleCase, titleCaseSequence } from '../src/renderer/format';
import {
  heroLede,
  hoursBack,
  ladderCounts,
  lastSeenLabel,
  networkCallsThisWeek,
  readyTitle,
  rhythmLevels,
  routineApps,
  routineEvidence,
} from '../src/renderer/overview-model';

describe('readyTitle', () => {
  it('says no new routines are ready when there are no suggestions', () => {
    expect(readyTitle(0)).toBe('No new routines are ready for your review.');
  });

  it('uses the singular for one routine', () => {
    expect(readyTitle(1)).toBe('One routine is ready for your review.');
  });

  it('spells out a small count and keeps the digits for a large one', () => {
    expect(readyTitle(2)).toBe('Two routines are ready for your review.');
    expect(readyTitle(3)).toBe('Three routines are ready for your review.');
    expect(readyTitle(13)).toBe('13 routines are ready for your review.');
  });
});

const RUN_RULE = 'Nothing runs unless you start it, or you have turned on unattended runs for an automation at level 4.';

describe('heroLede', () => {
  it('uses the recorded switches and the days observed', () => {
    expect(heroLede(70, 10)).toBe(`Your twin noticed 70 app switches over 10 days. ${RUN_RULE}`);
  });

  it('reads a first day without saying zero days', () => {
    expect(heroLede(1, 0)).toBe(`Your twin noticed 1 app switch today. ${RUN_RULE}`);
  });

  it('says so when nothing has been recorded yet', () => {
    expect(heroLede(0, 0)).toBe(
      `Your twin has not recorded any app switches yet. It learns from app switches and their timing. ${RUN_RULE}`,
    );
  });
});

describe('ladderCounts', () => {
  it('counts automations at each level from L0 to L4', () => {
    const automations = [{ state: { level: 2 } }, { state: { level: 2 } }, { state: { level: 4 } }];
    expect(ladderCounts(automations)).toEqual([0, 0, 2, 0, 1, 0]);
  });

  it('is all zeros with no automations', () => {
    expect(ladderCounts([])).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('keeps L5 at zero, because external runs are not built', () => {
    expect(ladderCounts([{ state: { level: 5 } }])).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe('networkCallsThisWeek', () => {
  const now = 100 * DAY_MS;

  it('counts the calls made in the last seven days', () => {
    const network = [{ ts: now - 1 }, { ts: now - 6 * DAY_MS }, { ts: now - 8 * DAY_MS }];
    expect(networkCallsThisWeek(network, now)).toBe(2);
  });

  it('includes a call exactly seven days old and nothing older', () => {
    expect(networkCallsThisWeek([{ ts: now - 7 * DAY_MS }, { ts: now - 7 * DAY_MS - 1 }], now)).toBe(1);
  });

  it('is zero with an empty ledger', () => {
    expect(networkCallsThisWeek([], now)).toBe(0);
  });
});

describe('lastSeenLabel', () => {
  const now = new Date(2026, 9, 14, 12, 0).getTime();

  it('names today and yesterday in words', () => {
    expect(lastSeenLabel(new Date(2026, 9, 14, 9, 14).getTime(), now)).toBe('Last seen today 09:14');
    expect(lastSeenLabel(new Date(2026, 9, 13, 18, 2).getTime(), now)).toBe('Last seen yesterday 18:02');
  });
});

describe('routineEvidence and hoursBack', () => {
  it('states the repeats in the 30-day window, the days, and the labelled hand-time estimate', () => {
    expect(routineEvidence(6, 4, 3.6)).toBe('6 times in the last 30 days, across 4 days · about 4 min / week by hand (estimate)');
  });

  it('keeps the singular for one repeat on one day', () => {
    expect(routineEvidence(1, 1, 0.4)).toBe('1 time in the last 30 days, across 1 day · about 0 min / week by hand (estimate)');
  });

  it('shows minutes as hours with one decimal place', () => {
    expect(hoursBack(0)).toBe('0.0');
    expect(hoursBack(90)).toBe('1.5');
  });
});

describe('titleCase', () => {
  it('capitalises each word of an app name', () => {
    expect(titleCase('microsoft word')).toBe('Microsoft Word');
    expect(titleCase('libreoffice calc')).toBe('Libreoffice Calc');
    expect(titleCase('slack')).toBe('Slack');
  });

  it('capitalises after a hyphen, and leaves an empty name empty', () => {
    expect(titleCase('visual-studio-code')).toBe('Visual-Studio-Code');
    expect(titleCase('')).toBe('');
  });
});

describe('titleCaseSequence', () => {
  it('keeps the step and option joins and title-cases the names between them', () => {
    expect(titleCaseSequence('microsoft excel → microsoft word or slack')).toBe('Microsoft Excel → Microsoft Word or Slack');
  });

  it('leaves the dash of an empty summary as it is', () => {
    expect(titleCaseSequence('—')).toBe('—');
  });
});

describe('noticedPerWeek', () => {
  it('reads a rate that rounds to one as about once a week', () => {
    expect(noticedPerWeek(0.96)).toBe('Noticed about once a week.');
    expect(noticedPerWeek(1)).toBe('Noticed about once a week.');
    expect(noticedPerWeek(1.4)).toBe('Noticed about once a week.');
  });

  it('gives any other rate in digits', () => {
    expect(noticedPerWeek(3)).toBe('Noticed 3 times a week.');
    expect(noticedPerWeek(0.5)).toBe('Noticed 0.5 times a week.');
  });
});

describe('summarySourceLabel', () => {
  it('names OpenMausBot when companyOS did not fail', () => {
    expect(summarySourceLabel(false)).toBe('From OpenMausBot');
  });

  it('names companyOS when companyOS itself failed', () => {
    expect(summarySourceLabel(true)).toBe('From companyOS');
  });
});

describe('handoffStateLabel', () => {
  it('reads a state as itself, and the unknown state as a status', () => {
    expect(handoffStateLabel('completed')).toBe('completed');
    expect(handoffStateLabel('unknown')).toBe('Status unknown');
  });
});

describe('rhythmLevels', () => {
  const emptyWeek = (): number[][] => Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));

  it('scales each hour against the busiest one shown', () => {
    const activity = emptyWeek();
    activity[0][9] = 10;
    activity[0][10] = 2;
    activity[0][11] = 5;
    const row = rhythmLevels(activity)[0];

    expect(row).toHaveLength(11);
    expect(row[0]).toEqual({ level: 0, count: 0 });
    expect(row[1]).toEqual({ level: 3, count: 10 });
    expect(row[2]).toEqual({ level: 1, count: 2 });
    expect(row[3]).toEqual({ level: 2, count: 5 });
  });

  it('leaves every cell empty when there is no activity', () => {
    expect(rhythmLevels(emptyWeek()).flat().every(cell => cell.level === 0)).toBe(true);
  });
});

describe('routineApps', () => {
  const act = (app: string, alternatives = 0): DraftStep => ({ kind: 'act', app, alternatives, effect: 'read_only' });
  const check = (app: string): DraftStep => ({ kind: 'check', app, alternatives: 0, effect: 'read_only' });

  it('keeps the order of the apps a routine opens', () => {
    expect(routineApps([act('microsoft excel'), act('microsoft word'), act('microsoft outlook')]).map(step => step.app)).toEqual([
      'microsoft excel',
      'microsoft word',
      'microsoft outlook',
    ]);
  });

  it('leaves out checks and an app repeated straight after itself', () => {
    const steps = [act('microsoft excel'), act('microsoft excel'), check('slack'), act('slack')];
    expect(routineApps(steps).map(step => step.app)).toEqual(['microsoft excel', 'slack']);
  });

  it('keeps the count of other apps seen at a step', () => {
    expect(routineApps([act('microsoft excel', 1)])).toEqual([{ app: 'microsoft excel', alternatives: 1 }]);
  });
});
