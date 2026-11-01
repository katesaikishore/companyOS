import { describe, expect, it } from 'vitest';
import { isSystemProcess } from '../src';

describe('isSystemProcess', () => {
  it.each([
    'Finder',
    'Finder.app',
    'Dock',
    'loginwindow',
    'SystemUIServer',
    'Spotlight',
    'Control Center',
    'ControlCenter',
    'Window Server',
    'WindowServer',
    'explorer',
    'explorer.exe',
    'explorer.exe.',
    'ShellExperienceHost',
    'StartMenuExperienceHost',
    'SearchHost',
    'LockApp',
    'gnome-shell',
    'plasmashell',
    'kwin',
  ])('recognises %s', name => {
    expect(isSystemProcess(name)).toBe(true);
  });

  it.each(['Docker', 'Dockside', 'Spotlighter', 'Explorer Pro', 'Slack', 'Microsoft Excel', 'Google Chrome'])(
    'does not treat %s as a system process',
    name => {
      expect(isSystemProcess(name)).toBe(false);
    },
  );
});
