import { describe, expect, it } from 'vitest';
import { readinessSentence } from '../src/renderer/views/readiness';
import { routeFromHash, routeKey } from '../src/renderer/store';

describe('readiness sentence', () => {
  it.each([
    [0, 'Little of your repeated app work could run on its own yet.'],
    [19, 'Little of your repeated app work could run on its own yet.'],
    [20, 'About a third of your repeated app work could run on its own.'],
    [39, 'About a third of your repeated app work could run on its own.'],
    [40, 'About half of your repeated app work could run on its own.'],
    [59, 'About half of your repeated app work could run on its own.'],
    [60, 'Most of your repeated app work could run on its own.'],
    [100, 'Most of your repeated app work could run on its own.'],
  ])('reads %i%% as the matching sentence', (automatablePct, sentence) => {
    expect(readinessSentence(automatablePct)).toBe(sentence);
  });
});

describe('readiness routes', () => {
  it('opens the list, and one app from the hash', () => {
    expect(routeFromHash('#/readiness')).toEqual({ name: 'readiness' });
    expect(routeFromHash('#/readiness/')).toEqual({ name: 'readiness' });
    expect(routeFromHash('#/readiness/microsoft%20excel')).toEqual({ name: 'readiness', app: 'microsoft excel' });
  });

  it('round-trips an app route through the key the links use', () => {
    const route = { name: 'readiness', app: 'microsoft excel' } as const;
    expect(routeKey(route)).toBe('#/readiness/microsoft%20excel');
    expect(routeFromHash(routeKey(route))).toEqual(route);
  });

  it('keeps the list route the same as before', () => {
    expect(routeKey({ name: 'readiness' })).toBe('#/readiness');
  });

  it('does not throw on a malformed app name', () => {
    expect(routeFromHash('#/readiness/%E0%A4%A')).toEqual({ name: 'readiness', app: '%E0%A4%A' });
  });
});
