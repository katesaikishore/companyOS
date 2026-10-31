import { describe, expect, it } from 'vitest';
import { DAY_MS, handoffStateLabel, noticedPerWeek, summarySourceLabel, titleCase, titleCaseSequence } from '../src/renderer/format';
import {
  networkCallsThisWeek,
  networkSummary,
  NETWORK_DAYS,
  rhythmLevels,
  routineChain,
  summaryLine,
} from '../src/renderer/overview-model';

const PRIVACY = 'Your data stays encrypted on this device.';

describe('summaryLine', () => {
  it('uses the recorded switches and the days observed', () => {
    expect(summaryLine(70, 10)).toBe(`70 app switches over 10 days. ${PRIVACY}`);
  });

  it('reads a first day without saying zero days', () => {
    expect(summaryLine(1, 0)).toBe(`1 app switch today. ${PRIVACY}`);
  });

  it('says so when nothing has been recorded yet', () => {
    expect(summaryLine(0, 0)).toBe(`No app switches recorded yet. ${PRIVACY}`);
  });
});

describe('networkSummary', () => {
  const now = new Date(2026, 9, 31, 12).getTime();
  const MB = 1024 * 1024;

  it('counts calls, bytes and hosts in the window, by local day', () => {
    const network = [
      {
        ts: new Date(2026, 9, 27, 9).getTime(),
        purpose: 'model_download' as const,
        host: 'huggingface.co',
        path: '/model',
        bytes: 610 * MB,
        outcome: 'ok' as const,
      },
      {
        ts: now - 60_000,
        purpose: 'update_check' as const,
        host: 'huggingface.co',
        path: '/feed',
        bytes: 0,
        outcome: 'ok' as const,
      },
      {
        ts: new Date(2026, 9, 1, 9).getTime(),
        purpose: 'model_download' as const,
        host: 'example.org',
        path: '/old',
        bytes: 5 * MB,
        outcome: 'ok' as const,
      },
    ];
    const summary = networkSummary(network, now);

    expect(summary.calls).toBe(2);
    expect(summary.bytes).toBe(610 * MB);
    expect(summary.downloads).toBe(1);
    expect(summary.checks).toBe(1);
    expect(summary.hosts).toEqual(['huggingface.co']);
  });

  it('lays out one day per column, oldest first and ending today', () => {
    const summary = networkSummary([], now);

    expect(summary.days).toHaveLength(NETWORK_DAYS);
    expect(summary.days[0].label).toBe('18 Oct');
    expect(summary.days[NETWORK_DAYS - 1].label).toBe('31 Oct');
  });

  it('puts each call on its own day', () => {
    const network = [
      {
        ts: new Date(2026, 9, 27, 9).getTime(),
        purpose: 'model_download' as const,
        host: 'huggingface.co',
        path: '/model',
        bytes: 1,
        outcome: 'ok' as const,
      },
    ];
    const { days } = networkSummary(network, now);

    expect(days[9].downloads).toBe(1);
    expect(days.reduce((sum, day) => sum + day.downloads + day.checks, 0)).toBe(1);
  });

  it('is empty with no calls', () => {
    const summary = networkSummary([], now);
    expect(summary.calls).toBe(0);
    expect(summary.hosts).toEqual([]);
  });
});

describe('routineChain', () => {
  it('lists the apps the routine moves focus to, in order, title-cased', () => {
    const steps = [
      { kind: 'act' as const, app: 'excel' },
      { kind: 'check' as const, app: 'excel' },
      { kind: 'act' as const, app: 'word' },
      { kind: 'act' as const, app: 'word' },
      { kind: 'act' as const, app: 'outlook' },
    ];
    expect(routineChain(steps)).toEqual(['Excel', 'Word', 'Outlook']);
  });

  it('is empty when no step moves focus', () => {
    expect(routineChain([])).toEqual([]);
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
