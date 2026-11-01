import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TwinAgent, mergeConfigPatch } from '../src';
import { tempFolders } from './temp-folders';

const temps = tempFolders();

const SAVED = {
  screenCaptureEnabled: true,
  audioCaptureEnabled: true,
  localApiEnabled: true,
  frameRetentionDays: 14 as const,
  dismissedRoutineSignatures: ['mail>sheet'],
  declinedRoutines: [{ routineId: 'routine-1', at: 1_700_000_000_000, count: 2 }],
};

/** An agent with settings the person has changed, which a later patch must keep. */
function agentWithSavedSettings(): TwinAgent {
  const agent = temps.track(new TwinAgent({ dataDir: temps.folder('twin-config-patch-'), dataKey: randomBytes(32) }));
  agent.updateConfig(SAVED);
  return agent;
}

describe('settings patches', () => {
  it('a theme change keeps the screen capture, the dismissed routines and the declined routines', () => {
    const agent = agentWithSavedSettings();
    // The desktop app's path: the patch is checked as the saved config with the change applied, then saved.
    agent.updateConfig(mergeConfigPatch(agent.configuration, { theme: 'dark' }));
    expect(agent.configuration).toMatchObject({ theme: 'dark', ...SAVED });
  });

  it('the merged config is the saved config with only the named keys changed', () => {
    const agent = agentWithSavedSettings();
    expect(mergeConfigPatch(agent.configuration, { theme: 'dark' })).toEqual({ ...agent.configuration, theme: 'dark' });
  });

  it('a key whose value is undefined is not a change', () => {
    const agent = agentWithSavedSettings();
    const merged = mergeConfigPatch(agent.configuration, { theme: undefined, screenCaptureEnabled: undefined });
    expect(merged).toEqual(agent.configuration);
  });

  it('refuses an unknown key, a value the schema does not accept, or a patch that is not an object', () => {
    const agent = agentWithSavedSettings();
    expect(() => mergeConfigPatch(agent.configuration, { notASetting: true })).toThrow();
    expect(() => mergeConfigPatch(agent.configuration, { theme: 'blue' })).toThrow();
    expect(() => mergeConfigPatch(agent.configuration, { frameRetentionDays: 30 })).toThrow();
    expect(() => mergeConfigPatch(agent.configuration, 'dark')).toThrow('Invalid settings.');
    expect(() => mergeConfigPatch(agent.configuration, null)).toThrow('Invalid settings.');
    expect(() => mergeConfigPatch(agent.configuration, ['dark'])).toThrow('Invalid settings.');
    expect(agent.configuration).toMatchObject(SAVED);
  });
});
