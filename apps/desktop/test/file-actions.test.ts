import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StepRefusedError } from '@companyos/twin-core';
import { gatherDuplicates } from '../src/main/file-actions';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gather-home-'));
  homes.push(dir);
  return dir;
}

function file(path: string, body: string, ageDays = 0): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
  const when = Date.now() / 1000 - ageDays * 86_400;
  utimesSync(path, when, when);
}

const NOW = () => new Date('2026-11-03T12:00:00Z');

describe.runIf(process.platform !== 'win32')('gatherDuplicates', () => {
  it('moves every copy but the oldest into the review folder, under its old place, and writes a manifest', async () => {
    const h = home();
    file(join(h, 'Downloads', 'report.pdf'), 'same bytes', 3);
    file(join(h, 'Downloads', 'report (1).pdf'), 'same bytes', 1);
    file(join(h, 'Desktop', 'old', 'report copy.pdf'), 'same bytes', 2);
    file(join(h, 'Desktop', 'unique.txt'), 'only one');
    file(join(h, 'Desktop', 'same-size.txt'), 'same bytez');
    const result = await gatherDuplicates(h, ['~/Downloads', '~/Desktop'], '~/Duplicates', NOW);
    expect(result).toMatchObject({ moved: 2, bytes: 20 });
    expect(existsSync(join(h, 'Downloads', 'report.pdf'))).toBe(true);
    expect(existsSync(join(h, 'Downloads', 'report (1).pdf'))).toBe(false);
    expect(existsSync(join(h, 'Duplicates', 'Downloads', 'report (1).pdf'))).toBe(true);
    expect(existsSync(join(h, 'Duplicates', 'Desktop', 'old', 'report copy.pdf'))).toBe(true);
    expect(existsSync(join(h, 'Desktop', 'unique.txt'))).toBe(true);
    expect(existsSync(join(h, 'Desktop', 'same-size.txt'))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(h, 'Duplicates', result.manifest), 'utf8'));
    expect(manifest.moves).toHaveLength(2);
    expect(manifest.moves.every((m: { kept: string }) => m.kept.endsWith(join('Downloads', 'report.pdf')))).toBe(true);
  });

  it('skips hidden files, bundles, symbolic links and the review folder, and deletes nothing', async () => {
    const h = home();
    file(join(h, 'Downloads', 'a.txt'), 'dup', 2);
    file(join(h, 'Downloads', '.hidden.txt'), 'dup', 1);
    file(join(h, 'Downloads', 'Tool.app', 'inside.txt'), 'dup', 1);
    file(join(h, 'Review', 'earlier.txt'), 'dup', 5);
    symlinkSync(join(h, 'Downloads', 'a.txt'), join(h, 'Downloads', 'link.txt'));
    const before = readdirSync(join(h, 'Downloads')).sort();
    const result = await gatherDuplicates(h, ['~/Downloads'], '~/Review', NOW);
    expect(result.moved).toBe(0);
    expect(readdirSync(join(h, 'Downloads')).sort()).toEqual(before);
    expect(existsSync(join(h, 'Review', 'earlier.txt'))).toBe(true);
  });

  it('never moves a file out of a code project or a dependency folder', async () => {
    const h = home();
    file(join(h, 'Downloads', 'products.csv'), 'id,name', 3);
    file(join(h, 'Downloads', 'app', 'package.json'), '{}', 2);
    file(join(h, 'Downloads', 'app', 'public', 'products.csv'), 'id,name', 1);
    file(join(h, 'Downloads', 'tool', 'node_modules', 'x', 'products.csv'), 'id,name', 1);
    const result = await gatherDuplicates(h, ['~/Downloads'], '~/Review', NOW);
    expect(result.moved).toBe(0);
    expect(existsSync(join(h, 'Downloads', 'app', 'public', 'products.csv'))).toBe(true);
  });

  it('refuses a folder outside home, a missing folder, and a review folder inside a scanned one, before moving anything', async () => {
    const h = home();
    file(join(h, 'Downloads', 'a.txt'), 'dup', 2);
    file(join(h, 'Downloads', 'b.txt'), 'dup', 1);
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    homes.push(outside);
    symlinkSync(outside, join(h, 'Elsewhere'));
    await expect(gatherDuplicates(h, ['~/Elsewhere'], '~/Review', NOW)).rejects.toThrow(StepRefusedError);
    await expect(gatherDuplicates(h, ['~/Nowhere'], '~/Review', NOW)).rejects.toThrow(/does not exist/);
    await expect(gatherDuplicates(h, ['~/Downloads'], '~/Downloads/Review', NOW)).rejects.toThrow(/inside a scanned folder/);
    expect(existsSync(join(h, 'Downloads', 'b.txt'))).toBe(true);
  });

  it('keeps both names when a moved copy would land on an earlier one', async () => {
    const h = home();
    file(join(h, 'Downloads', 'x.txt'), 'dup', 3);
    file(join(h, 'Downloads', 'y', 'x.txt'), 'dup', 2);
    file(join(h, 'Review', 'Downloads', 'y', 'x.txt'), 'earlier review', 9);
    const result = await gatherDuplicates(h, ['~/Downloads'], '~/Review', NOW);
    expect(result.moved).toBe(1);
    expect(existsSync(join(h, 'Review', 'Downloads', 'y', 'x (2).txt'))).toBe(true);
    expect(readFileSync(join(h, 'Review', 'Downloads', 'y', 'x.txt'), 'utf8')).toBe('earlier review');
  });
});
