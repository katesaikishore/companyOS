import { describe, expect, it } from 'vitest';
import { readinessSentence, routineUseLabel } from '../src/renderer/views/readiness';
import { routeFromHash, routeKey } from '../src/renderer/store';

describe('readiness sentence', () => {
  it.each([0, 19, 20, 39, 40, 59, 60, 100])('states %i%% as the figure, with no band', automatablePct => {
    expect(readinessSentence(automatablePct)).toBe(`${automatablePct}% of your app switches could run on its own.`);
  });
});

describe('routineUseLabel', () => {
  it('agrees the verb with the count of routines', () => {
    expect(routineUseLabel(0)).toBe('0 routines use this app');
    expect(routineUseLabel(1)).toBe('1 routine uses this app');
    expect(routineUseLabel(2)).toBe('2 routines use this app');
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
