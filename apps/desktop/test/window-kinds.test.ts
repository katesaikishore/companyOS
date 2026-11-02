import { WINDOW_CLASSES } from '@companyos/twin-core';
import { describe, expect, it } from 'vitest';
import { WINDOW_KIND_IDS, WINDOW_KIND_LABELS } from '../src/renderer/window-kinds';

describe('window kinds in the renderer', () => {
  it('lists the same kinds as the twin engine, in the same order', () => {
    expect([...WINDOW_KIND_IDS]).toEqual([...WINDOW_CLASSES]);
  });

  it('has a label for every kind', () => {
    for (const kind of WINDOW_KIND_IDS) expect(WINDOW_KIND_LABELS[kind]).toBeTruthy();
  });
});
