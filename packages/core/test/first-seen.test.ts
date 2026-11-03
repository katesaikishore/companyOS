import { describe, expect, it } from 'vitest';
import { FirstSeen } from '../src/apps/first-seen';

describe('FirstSeen', () => {
  it('reports an application once, however often it comes to the front', () => {
    const watch = new FirstSeen();
    expect(watch.observe('Slack')).toBe(true);
    expect(watch.observe('Slack')).toBe(false);
  });

  it('treats two spellings of one application as one', () => {
    const watch = new FirstSeen();
    expect(watch.observe('Slack.app')).toBe(true);
    expect(watch.observe('slack')).toBe(false);
  });

  it('never counts a system process', () => {
    const watch = new FirstSeen();
    expect(watch.observe('loginwindow')).toBe(false);
    expect(watch.names()).toEqual([]);
  });

  it('remembers the names it was given, so a restart does not ask again', () => {
    const first = new FirstSeen();
    first.observe('Zoom');
    const after = new FirstSeen(first.names());
    expect(after.observe('Zoom.exe')).toBe(false);
    expect(after.observe('Cursor')).toBe(true);
  });

  it('ignores an empty name', () => {
    expect(new FirstSeen().observe('   ')).toBe(false);
  });
});
