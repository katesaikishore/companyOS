import { describe, expect, it } from 'vitest';
import { WIN_FOCUS, WIN_PRESS, windowsProgram } from '../src/main/platform';

/**
 * Found on a hosted Windows runner: Start-Process with the bare name "notepad" ran the extensionless file
 * C:\Program Files\Git\usr\bin\notepad, and the shell showed its "Select an app to open" picker instead of opening the file.
 * The same name with ".exe" opened Notepad. windowsProgram is the rule that avoids the first case.
 */
describe('windowsProgram', () => {
  it('adds .exe to a bare program name', () => {
    expect(windowsProgram('notepad')).toBe('notepad.exe');
    expect(windowsProgram('chrome')).toBe('chrome.exe');
    expect(windowsProgram('Notepad++')).toBe('Notepad++.exe');
  });

  it('leaves a name that already has an extension', () => {
    expect(windowsProgram('notepad.exe')).toBe('notepad.exe');
    expect(windowsProgram('Code.EXE')).toBe('Code.EXE');
    expect(windowsProgram('tool.cmd')).toBe('tool.cmd');
  });

  it('leaves a path', () => {
    expect(windowsProgram('C:\\Windows\\System32\\notepad.exe')).toBe('C:\\Windows\\System32\\notepad.exe');
    expect(windowsProgram('C:\\Tools\\viewer')).toBe('C:\\Tools\\viewer');
    expect(windowsProgram('tools/viewer')).toBe('tools/viewer');
  });
});

/**
 * Found on the same runner: with Notepad minimized, WScript.Shell.AppActivate returned false three times out of three, so
 * focus and press returned false (exit code 3). Restoring the window first, then activating, worked in the same run. These
 * tests only guard the shape of the two scripts, because PowerShell cannot run in the unit tests. The behavior itself is
 * checked by the adapters workflow on a Windows runner.
 */
describe('Windows focus and press scripts restore a minimized window', () => {
  for (const [name, script] of [
    ['focus', WIN_FOCUS],
    ['press', WIN_PRESS],
  ] as const) {
    it(`${name}: activates first, restores only a minimized window, then activates again`, () => {
      const first = script.indexOf('AppActivate');
      const iconic = script.indexOf('IsIconic($process');
      const restore = script.indexOf('ShowWindowAsync($process.MainWindowHandle, 9)');
      const second = script.indexOf('AppActivate', first + 1);
      expect(first).toBeGreaterThan(-1);
      expect(iconic).toBeGreaterThan(first);
      expect(restore).toBeGreaterThan(iconic);
      expect(second).toBeGreaterThan(restore);
    });

    it(`${name}: still exits 3 when the window is not minimized or does not activate`, () => {
      expect(script.match(/exit 3/g)?.length).toBeGreaterThanOrEqual(2);
      expect(script).toMatch(/if \(-not \[Twin\.\w+\]::IsIconic\(\$process\.MainWindowHandle\)\) \{ exit 3 \}/);
    });
  }

  it('press keeps its wait for the foreground window and sends keys only after it', () => {
    expect(WIN_PRESS.indexOf('SendWait')).toBeGreaterThan(WIN_PRESS.indexOf('exit 4'));
  });
});
