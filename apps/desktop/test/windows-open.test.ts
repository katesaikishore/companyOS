import { describe, expect, it } from 'vitest';
import { windowsProgram } from '../src/main/platform';

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
