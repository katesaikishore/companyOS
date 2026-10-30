import { describe, expect, it } from 'vitest';
import type { Param, Step } from '../src';
// The workflow labels are plain functions, so they are tested here, where the test runner is. The desktop has no runner of its own.
import { fileNameOf, hostOf, stepDetail, stepTitle } from '../../../apps/desktop/src/renderer/labels';

const NO_PARAMS: Param[] = [];

describe('workflow titles for the new steps', () => {
  it('names the host of a link, and the browser it opens in', () => {
    const step: Step = { op: 'open_url', app: 'google chrome', url: 'https://docs.example.com/doc' };
    expect(stepTitle(step, NO_PARAMS)).toBe('Open docs.example.com');
    expect(stepDetail(step, NO_PARAMS)).toBe('google chrome');
  });

  it('names the file, without its folders, for an open file step', () => {
    expect(stepTitle({ op: 'open_file', app: 'microsoft excel', path: '/Users/me/Documents/budget.xlsx' }, NO_PARAMS)).toBe('Open budget.xlsx');
    expect(stepTitle({ op: 'open_file', app: 'microsoft excel', path: 'C:\\Users\\me\\Documents\\budget 2026.xlsx' }, NO_PARAMS)).toBe(
      'Open budget 2026.xlsx',
    );
    expect(stepDetail({ op: 'open_file', app: 'microsoft excel', path: '/Users/me/Documents/budget.xlsx' }, NO_PARAMS)).toBe('microsoft excel');
  });

  it('names the chord for a press shortcut step', () => {
    expect(stepTitle({ op: 'press_shortcut', app: 'microsoft excel', shortcut: 'cmd+shift+k' }, NO_PARAMS)).toBe('Press cmd+shift+k');
    expect(stepDetail({ op: 'press_shortcut', app: 'microsoft excel', shortcut: 'cmd+shift+k' }, NO_PARAMS)).toBe('microsoft excel');
  });

  it('gives each new step a title that is more than its operation name', () => {
    const steps: Step[] = [
      { op: 'open_url', app: 'google chrome', url: 'https://docs.example.com/doc' },
      { op: 'open_file', app: 'microsoft excel', path: '/Users/me/Documents/budget.xlsx' },
      { op: 'press_shortcut', app: 'microsoft excel', shortcut: 'cmd+shift+k' },
    ];
    for (const step of steps) {
      expect(stepTitle(step, NO_PARAMS)).not.toBe(step.op);
      expect(stepTitle(step, NO_PARAMS)).not.toBe('Expected app is in front');
    }
  });
});

describe('workflow titles for the existing steps', () => {
  it('keeps the wording of a check and a focus', () => {
    expect(stepTitle({ op: 'check_focus', app: 'slack' }, NO_PARAMS)).toBe('Expected app is in front');
    expect(stepDetail({ op: 'check_focus', app: 'slack' }, NO_PARAMS)).toBe('slack');
    expect(stepTitle({ op: 'focus_app', app: 'slack' }, NO_PARAMS)).toBe('slack');
    expect(stepDetail({ op: 'focus_app', app: 'slack' }, NO_PARAMS)).toBeUndefined();
  });

  it('shows the options when the app varies between runs', () => {
    const params: Param[] = [{ name: 'p0', options: ['microsoft excel', 'libreoffice calc'], default: 'microsoft excel' }];
    expect(stepTitle({ op: 'focus_app', app: '$p0' }, params)).toBe('App chosen for this run');
    expect(stepDetail({ op: 'focus_app', app: '$p0' }, params)).toBe('varies: microsoft excel or libreoffice calc');
    expect(stepDetail({ op: 'check_focus', app: '$p0' }, params)).toBe('varies: microsoft excel or libreoffice calc');
  });

  it('shows the hosts of the options when the link varies between runs', () => {
    const params: Param[] = [
      {
        name: 'p1',
        options: ['https://docs.example.com/doc/a1', 'https://intranet.example.org/b2'],
        default: 'https://docs.example.com/doc/a1',
      },
    ];
    const step: Step = { op: 'open_url', app: 'google chrome', url: '$p1' };
    expect(stepTitle(step, params)).toBe('Link chosen for this run');
    expect(stepDetail(step, params)).toBe('google chrome · varies: docs.example.com or intranet.example.org');
  });
});

describe('address and file name helpers', () => {
  it('reads the host of an address and leaves the path and query out', () => {
    expect(hostOf('https://docs.example.com/doc/1ab2?x=1')).toBe('docs.example.com');
    expect(hostOf('not a url')).toBe('not a url');
  });

  it('reads the file name with either separator', () => {
    expect(fileNameOf('/Users/me/Documents/budget.xlsx')).toBe('budget.xlsx');
    expect(fileNameOf('C:\\Users\\me\\budget.xlsx')).toBe('budget.xlsx');
    expect(fileNameOf('budget.xlsx')).toBe('budget.xlsx');
  });
});
