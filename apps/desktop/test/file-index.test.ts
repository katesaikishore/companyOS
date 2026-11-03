import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { QueryVectors, walkFolders } from '../src/main/file-index';

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
  it('finds photos, documents and other files, and skips hidden folders, app bundles and code projects', async () => {
    const root = home({
      'Downloads/passport.jpg': 'x',
      'Downloads/visa/letter.pdf': 'x',
      'Documents/notes.md': 'x',
      'Documents/.secret/key.txt': 'x',
      'Documents/Tool.app/Contents/Info.plist': 'x',
      'Pictures/Photos Library.photoslibrary/originals/A/1.heic': 'x',
      'Desktop/project/package.json': '{}',
      'Desktop/project/src/index.ts': 'x',
      'Desktop/repo/.git/HEAD': 'x',
      'Desktop/repo/readme.md': 'x',
      'Desktop/archive.zip': 'x',
    });
    const found = (await walkFolders(root)).map(file => [file.path.slice(root.length + 1), file.kind, file.cloudOnly]);
    expect(found).toEqual([
      ['Downloads/passport.jpg', 'image', false],
      ['Downloads/visa/letter.pdf', 'document', false],
      ['Documents/notes.md', 'document', false],
      ['Desktop/archive.zip', 'other', false],
    ]);
  });
});

/** An embedder whose answers the test gives by hand, recording each call's words and signal. */
function slowEmbedder() {
  const calls: { words: string; signal?: AbortSignal; answer: (vector: number[]) => void; fail: () => void }[] = [];
  return {
    calls,
    embed: (texts: readonly string[], signal?: AbortSignal) =>
      new Promise<number[][]>((resolve, reject) => {
        calls.push({ words: texts[0], signal, answer: vector => resolve([vector]), fail: () => reject(new Error('down')) });
      }),
  };
}

describe('QueryVectors', () => {
  it('lets a slow call finish after the search stops waiting, so the model loads and the next search has the vector', async () => {
    const embedder = slowEmbedder();
    const vectors = new QueryVectors(embedder);
    expect(await vectors.get('salary slip', 5)).toBeUndefined();
    expect(embedder.calls[0].signal?.aborted).toBe(false);
    embedder.calls[0].answer([1, 0]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(await vectors.get('salary slip', 5)).toEqual([1, 0]);
    expect(embedder.calls).toHaveLength(1);
  });

  it('asks once for words already on their way, and answers a search that waits long enough', async () => {
    const embedder = slowEmbedder();
    const vectors = new QueryVectors(embedder);
    void vectors.get('resume', 0);
    const waiting = vectors.get('resume', 1_000);
    embedder.calls[0].answer([0, 1]);
    expect(await waiting).toEqual([0, 1]);
    expect(embedder.calls).toHaveLength(1);
  });

  it('asks again after a failed call, and keeps nothing a call answers after clear', async () => {
    const embedder = slowEmbedder();
    const vectors = new QueryVectors(embedder);
    const failed = vectors.get('visa', 1_000);
    embedder.calls[0].fail();
    expect(await failed).toBeUndefined();
    void vectors.get('visa', 0);
    expect(embedder.calls).toHaveLength(2);
    vectors.clear();
    embedder.calls[1].answer([1, 1]);
    await new Promise(resolve => setTimeout(resolve, 0));
    void vectors.get('visa', 0);
    expect(embedder.calls).toHaveLength(3);
  });

  it('starts no more calls while four are waiting on the model', async () => {
    const embedder = slowEmbedder();
    const vectors = new QueryVectors(embedder);
    for (const words of ['a', 'ab', 'abc', 'abcd']) void vectors.get(words, 0);
    expect(await vectors.get('abcde', 5)).toBeUndefined();
    expect(embedder.calls.map(call => call.words)).toEqual(['a', 'ab', 'abc', 'abcd']);
    embedder.calls[0].answer([1]);
    await new Promise(resolve => setTimeout(resolve, 0));
    void vectors.get('abcde', 0);
    expect(embedder.calls).toHaveLength(5);
  });
});
