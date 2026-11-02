import { describe, expect, it } from 'vitest';
import {
  FOLDER_MAX_BYTES,
  folderItem,
  folderSourceId,
  htmlToText,
  selectFolderEntries,
  type FolderEntry,
} from '../../src/connectors/folder';

const entry = (relativePath: string, overrides: Partial<FolderEntry> = {}): FolderEntry => ({
  relativePath,
  mtimeMs: Date.UTC(2026, 2, 5, 9),
  size: 120,
  ...overrides,
});

describe('selectFolderEntries: which files are imported', () => {
  it('keeps .md, .markdown, .txt, .html and .htm files, in any letter case, and drops other files', () => {
    const selected = selectFolderEntries(
      [
        entry('notes/plan.md'),
        entry('notes/PLAN.MD'),
        entry('readme.markdown'),
        entry('todo.txt'),
        entry('page.html'),
        entry('page.HTM'),
        entry('photo.png'),
        entry('script.js'),
        entry('archive.md.zip'),
        entry('noext'),
      ],
      new Set(),
    );
    expect(selected.map((item) => item.relativePath)).toEqual([
      'notes/plan.md',
      'notes/PLAN.MD',
      'readme.markdown',
      'todo.txt',
      'page.html',
      'page.HTM',
    ]);
  });

  it('skips any path with a segment that starts with a dot, whether a directory or a file', () => {
    const selected = selectFolderEntries(
      [entry('.git/config.txt'), entry('docs/.hidden/x.md'), entry('.secret.md'), entry('docs/visible.md')],
      new Set(),
    );
    expect(selected.map((item) => item.relativePath)).toEqual(['docs/visible.md']);
  });

  it('skips files over 1 MB, and keeps a file of exactly 1 MB', () => {
    const selected = selectFolderEntries(
      [entry('big.md', { size: FOLDER_MAX_BYTES + 1 }), entry('exact.md', { size: FOLDER_MAX_BYTES })],
      new Set(),
    );
    expect(selected.map((item) => item.relativePath)).toEqual(['exact.md']);
  });

  it('skips files whose sourceId is already known, and keeps a file that has changed', () => {
    const known = entry('notes/plan.md');
    const changed = entry('notes/plan.md', { mtimeMs: known.mtimeMs + 1000 });
    const selected = selectFolderEntries([known, changed, entry('other.md')], new Set([folderSourceId(known)]));
    expect(selected.map((item) => item.mtimeMs)).toEqual([changed.mtimeMs, known.mtimeMs]);
    expect(selected.map((item) => item.relativePath)).toEqual(['notes/plan.md', 'other.md']);
  });

  it('gives the same sourceId for the same path and time, and a different one when the time changes', () => {
    const base = entry('notes/plan.md');
    expect(folderSourceId({ ...base })).toBe(folderSourceId(base));
    expect(folderSourceId({ ...base, mtimeMs: base.mtimeMs + 1 })).not.toBe(folderSourceId(base));
    expect(folderSourceId(entry('notes/other.md'))).not.toBe(folderSourceId(base));
    expect(folderSourceId(base)).toMatch(/^[0-9a-f]{32}$/);
    expect(folderSourceId(base)).not.toContain('plan');
  });
});

describe('folderItem: the item for one file', () => {
  it('keeps Markdown and plain text as they are, with the file name as the title and the modification time as ts', () => {
    const markdown = '# Plan\n\n- ship the parser\n';
    const item = folderItem(entry('notes/plan.md'), markdown);
    expect(item).toMatchObject({
      source: 'folder',
      title: 'plan',
      ts: Date.UTC(2026, 2, 5, 9),
      text: '# Plan\n\n- ship the parser',
      location: 'notes/plan.md',
    });
    expect(folderItem(entry('todo.txt'), 'buy milk').text).toBe('buy milk');
  });

  it('strips the scripts, styles and tags of an HTML file, and decodes its entities', () => {
    const html = [
      '<!DOCTYPE html><html><head><title>Ignored</title><style>body{color:red}</style></head>',
      '<body><script>var secret = "do not keep";</script><h1>Heading</h1>',
      '<p>Fish &amp; chips &lt;3 &#39;quoted&#39; &nbsp;done</p><!-- hidden comment -->',
      '<div>Second<br>line</div></body></html>',
    ].join('\n');
    const item = folderItem(entry('page.html'), html);
    expect(item.title).toBe('page');
    expect(item.text).not.toContain('secret');
    expect(item.text).not.toContain('hidden comment');
    expect(item.text).not.toContain('color:red');
    expect(item.text).not.toMatch(/<\/?(h1|p|div|body|script)\b/);
    expect(item.text).toContain('Heading');
    expect(item.text).toContain("Fish & chips <3 'quoted' done");
    expect(item.text).toContain('Second\nline');
  });

  it('turns an unclosed script into nothing, rather than keeping its code as text', () => {
    expect(htmlToText('<p>Visible</p><script>var x = 1;')).toBe('Visible');
  });

  it('decodes numeric references, and leaves an unknown entity as it is', () => {
    expect(htmlToText('<p>&#x41;&#66; &unknown; &#0;</p>')).toBe('AB &unknown; &#0;');
  });

  it('does not let an entity name that is also an Object property decode to something else', () => {
    expect(htmlToText('<p>&valueOf; &toString;</p>')).toBe('&valueOf; &toString;');
  });
});
