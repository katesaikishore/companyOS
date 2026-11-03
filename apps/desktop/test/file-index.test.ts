import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { walkFolders } from '../src/main/file-index';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function home(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'file-index-'));
  homes.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe('walkFolders', () => {
  it('finds photos, documents and other files, and skips hidden folders, app bundles and code projects', () => {
    const root = home({
      'Downloads/passport.jpg': 'x',
      'Downloads/visa/letter.pdf': 'x',
      'Documents/notes.md': 'x',
      'Documents/.secret/key.txt': 'x',
      'Documents/Tool.app/Contents/Info.plist': 'x',
      'Desktop/project/package.json': '{}',
      'Desktop/project/src/index.ts': 'x',
      'Desktop/repo/.git/HEAD': 'x',
      'Desktop/repo/readme.md': 'x',
      'Desktop/archive.zip': 'x',
    });
    const found = walkFolders(root).map(file => [file.path.slice(root.length + 1), file.kind, file.cloudOnly]);
    expect(found).toEqual([
      ['Downloads/passport.jpg', 'image', false],
      ['Downloads/visa/letter.pdf', 'document', false],
      ['Documents/notes.md', 'document', false],
      ['Desktop/archive.zip', 'other', false],
    ]);
  });
});
