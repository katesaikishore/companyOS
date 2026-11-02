import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IPC } from '../src/shared/ipc';
import {
  CONNECTOR_LABEL_MAX,
  CONNECTOR_PATH_MAX,
  CONNECTOR_SOURCE_MAX,
  LOCAL_CONNECTOR_KINDS,
  connectorIdArg,
  connectorKindArg,
  connectorLabel,
  connectorPathArg,
  connectorPickerOptions,
} from '../src/main/connectors-validate';

const DESKTOP = join(__dirname, '..');

describe('connectorKindArg', () => {
  it('accepts the four local kinds', () => {
    for (const kind of ['folder', 'git', 'calendar', 'mail']) expect(connectorKindArg(kind)).toBe(kind);
    expect([...LOCAL_CONNECTOR_KINDS]).toEqual(['folder', 'git', 'calendar', 'mail']);
  });

  it('refuses the cloud kinds, near misses and every other type, with a fixed sentence', () => {
    for (const value of ['github', 'google-calendar', 'Folder', ' folder', 'folder ', '', 1, null, undefined, ['folder'], { kind: 'folder' }]) {
      expect(() => connectorKindArg(value)).toThrow('Invalid source kind.');
    }
  });
});

describe('connectorIdArg', () => {
  it('accepts an id of 16 to 64 letters, digits, hyphens and underscores', () => {
    expect(connectorIdArg('a'.repeat(16))).toBe('a'.repeat(16));
    expect(connectorIdArg('a'.repeat(64))).toBe('a'.repeat(64));
    expect(connectorIdArg('0123456789abcdef_-XYZ')).toBe('0123456789abcdef_-XYZ');
  });

  it('refuses a shorter or longer id, a path, and anything that is not text', () => {
    for (const value of ['a'.repeat(15), 'a'.repeat(65), '../../etc/passwd', 'abc def ghi jkl mno', '', 42, null]) {
      expect(() => connectorIdArg(value)).toThrow('Invalid source id.');
    }
  });
});

describe('connectorPathArg', () => {
  it('accepts an absolute path of up to 1000 characters', () => {
    expect(connectorPathArg('/home/person/notes')).toBe('/home/person/notes');
    const long = `/${'a'.repeat(CONNECTOR_PATH_MAX - 1)}`;
    expect(connectorPathArg(long)).toBe(long);
  });

  it('refuses a relative path, an empty one, a control character, a longer one, and anything that is not text', () => {
    for (const value of ['notes', '', '/a\u0000b', '/a\nb', '/a\u0085b', `/${'a'.repeat(CONNECTOR_PATH_MAX)}`, 7, undefined]) {
      expect(() => connectorPathArg(value)).toThrow('Invalid path.');
    }
  });
});

describe('connectorLabel', () => {
  it('uses the name of the folder or file', () => {
    expect(connectorLabel('folder', '/home/person/Notes')).toBe('Notes');
    expect(connectorLabel('mail', '/mail/Inbox')).toBe('Inbox');
  });

  it('falls back to the kind name when there is no name to show', () => {
    expect(connectorLabel('git', '/')).toBe('Git repository');
    expect(connectorLabel('calendar', '/cal/   ')).toBe('Calendar file');
  });

  it('is at most 60 characters, and a cut never leaves half of a surrogate pair', () => {
    const name = `${'x'.repeat(59)}😀tail`;
    const label = connectorLabel('folder', `/work/${name}`);
    expect(label.length).toBeLessThanOrEqual(CONNECTOR_LABEL_MAX);
    expect(label).toBe('x'.repeat(59));
    const plain = connectorLabel('folder', `/work/${'y'.repeat(100)}`);
    expect(plain).toHaveLength(CONNECTOR_LABEL_MAX);
  });

  it('replaces control characters with spaces, and keeps one line', () => {
    expect(connectorLabel('folder', '/work/Two\tlines\u0007here')).toBe('Two lines here');
  });
});

describe('connectorPickerOptions', () => {
  it('asks for a folder for a folder and for a Git repository', () => {
    expect(connectorPickerOptions('folder').properties).toEqual(['openDirectory']);
    expect(connectorPickerOptions('git').properties).toEqual(['openDirectory']);
  });

  it('asks for one file for a calendar file and a mail archive, with a filter for its type', () => {
    const calendar = connectorPickerOptions('calendar');
    expect(calendar.properties).toEqual(['openFile']);
    expect(calendar.filters?.[0]?.extensions).toEqual(['ics', 'ical']);
    const mail = connectorPickerOptions('mail');
    expect(mail.properties).toEqual(['openFile']);
    expect(mail.filters?.[0]?.extensions).toEqual(['mbox']);
  });
});

describe('the connector channels in the IPC map, the preload and the handlers', () => {
  const preload = readFileSync(join(DESKTOP, 'src/main/preload.ts'), 'utf8');
  const index = readFileSync(join(DESKTOP, 'src/main/index.ts'), 'utf8');

  it('use the same channel names in the shared map and in the preload', () => {
    const channels = {
      addConnector: 'twin:add-connector',
      removeConnector: 'twin:remove-connector',
      importConnector: 'twin:import-connector',
    } as const;
    for (const [name, channel] of Object.entries(channels)) {
      expect(IPC[name as keyof typeof IPC]).toBe(channel);
      expect(preload).toContain(`${name}: '${channel}'`);
    }
  });

  it('check every value they receive before the runtime sees it', () => {
    expect(index).toContain('connectorKindArg(kind)');
    expect(index).toContain('connectorPathArg(picked.filePaths[0])');
    expect(index).toContain('removeConnector(connectorIdArg(id))');
    expect(index).toContain('importConnector(connectorIdArg(id))');
  });

  it('show the system dialog for the path, so the page never sends one', () => {
    expect(index).toContain('dialog.showOpenDialog(');
    expect(index).toContain('connectorPickerOptions(chosen)');
  });
});

describe('the source limit', () => {
  it('is twenty, as the engine allows', () => {
    expect(CONNECTOR_SOURCE_MAX).toBe(20);
  });
});
