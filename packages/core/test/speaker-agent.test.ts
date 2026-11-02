import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TwinAgent } from '../src/agent';
import { SPEAKER_EMBEDDING_DIM } from '../src/models/speaker';
import { unitVector } from '../src/speaker/match';
import { DEFAULT_CONFIG } from '../src/types';

const AT = Date.UTC(2026, 10, 2, 9);
const WIDE = { from: 0, to: AT + 3_600_000 };

/** A voice that points along one axis, with a small fixed wobble. Two axes give two voices that are not alike. */
function voice(index: number, seed = 7): Float32Array {
  const v = new Float32Array(SPEAKER_EMBEDDING_DIM);
  let state = seed;
  for (let i = 0; i < v.length; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    v[i] = ((state / 0x7fffffff) - 0.5) * 0.05;
  }
  v[index] = 1;
  return unitVector(v)!;
}

describe('speaker identification in the engine', () => {
  let dir: string;
  let key: Buffer;
  let agent: TwinAgent;

  const open = (): TwinAgent => new TwinAgent({ dataDir: join(dir, 'twin'), dataKey: key, now: () => AT });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'speaker-agent-'));
    key = randomBytes(32);
    agent = open();
  });

  afterEach(() => {
    agent.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Keeps one microphone segment, with an optional speaker label. Returns whether the engine kept it. */
  function keep(text: string, speaker?: string): boolean {
    return agent.ingestAudio({ ts: AT, durationMs: 20_000, text, ...(speaker === undefined ? {} : { speaker }) });
  }

  function speakingOn(): void {
    agent.updateConfig({ audioCaptureEnabled: true, speakerIdentificationEnabled: true });
  }

  it('is off by default, and gives no speaker while it is off', () => {
    expect(DEFAULT_CONFIG.speakerIdentificationEnabled).toBe(false);
    agent.updateConfig({ audioCaptureEnabled: true });
    expect(agent.identifySpeaker(voice(0))).toBeUndefined();
  });

  it('drops a speaker label sent while identification is off, and keeps the text', () => {
    agent.updateConfig({ audioCaptureEnabled: true });
    expect(keep('hello from the desk', 'Ada')).toBe(true);
    expect(agent.searchCapture({ text: '', ...WIDE, speaker: 'Ada' })).toEqual([]);
    const [hit] = agent.searchCapture({ text: 'desk', ...WIDE });
    expect(hit).toBeDefined();
    expect(hit).not.toHaveProperty('speaker');
  });

  it('keeps a label once identification is on, and searches by it', () => {
    speakingOn();
    keep('the budget review', 'Speaker 1');
    keep('the budget again', 'Ada');
    keep('no label at all');
    expect(agent.searchCapture({ text: '', ...WIDE, speaker: 'Speaker 1' })).toEqual([expect.objectContaining({ speaker: 'Speaker 1' })]);
    expect(agent.searchCapture({ text: '', ...WIDE, speaker: 'Ada' })).toHaveLength(1);
    expect(agent.searchCapture({ text: '', ...WIDE })).toHaveLength(3);
  });

  it('refuses a label that is neither a name nor a session label', () => {
    speakingOn();
    expect(() => keep('x', 'Speaker 0')).toThrow();
    expect(() => keep('x', 'speaker 12')).toThrow();
    expect(() => agent.searchCapture({ text: '', ...WIDE, speaker: 'a'.repeat(41) })).toThrow();
  });

  it('labels a voice with Speaker 1, then Speaker 2 for a different voice, and keeps the same label for the same voice', () => {
    speakingOn();
    expect(agent.identifySpeaker(voice(0))).toBe('Speaker 1');
    expect(agent.identifySpeaker(voice(0, 99))).toBe('Speaker 1');
    expect(agent.identifySpeaker(voice(1))).toBe('Speaker 2');
  });

  it('refuses an embedding of the wrong length, or one with a value that is not finite', () => {
    speakingOn();
    expect(agent.identifySpeaker(new Float32Array(12))).toBeUndefined();
    const broken = voice(0).map((value, i) => (i === 3 ? Number.NaN : value));
    expect(agent.identifySpeaker(broken)).toBeUndefined();
  });

  it('names a session speaker, relabels its items, and matches the voice from then on', () => {
    speakingOn();
    expect(agent.identifySpeaker(voice(0))).toBe('Speaker 1');
    expect(agent.identifySpeaker(voice(1))).toBe('Speaker 2');
    keep('first from two', 'Speaker 2');
    keep('second from two', 'Speaker 2');
    keep('from one', 'Speaker 1');

    agent.nameSessionSpeaker('Speaker 2', '  Ada  ');

    expect(agent.speakerProfileCount()).toBe(1);
    expect(agent.searchCapture({ text: '', ...WIDE, speaker: 'Ada' })).toHaveLength(2);
    expect(agent.searchCapture({ text: '', ...WIDE, speaker: 'Speaker 2' })).toHaveLength(0);
    expect(agent.searchCapture({ text: 'from one', ...WIDE })).toHaveLength(1);
    expect(agent.identifySpeaker(voice(1, 42))).toBe('Ada');
    // The number is not reused once it has been named.
    expect(agent.identifySpeaker(voice(2))).toBe('Speaker 3');
  });

  it('refuses to name when identification is off, a label that is unknown, a label already named, or a bad name', () => {
    agent.updateConfig({ audioCaptureEnabled: true });
    expect(() => agent.nameSessionSpeaker('Speaker 1', 'Ada')).toThrow('Speaker identification is off.');
    speakingOn();
    agent.identifySpeaker(voice(0));
    expect(() => agent.nameSessionSpeaker('Speaker 9', 'Ada')).toThrow('not in this session');
    expect(() => agent.nameSessionSpeaker('Ada', 'Ben')).toThrow('Invalid speaker');
    expect(() => agent.nameSessionSpeaker('Speaker 1', '   ')).toThrow('Invalid speaker');
    expect(() => agent.nameSessionSpeaker('Speaker 1', 'Speaker 4')).toThrow('Invalid speaker');
    agent.nameSessionSpeaker('Speaker 1', 'Ada');
    expect(() => agent.nameSessionSpeaker('Speaker 1', 'Ben')).toThrow('not in this session');
    expect(agent.speakerProfileCount()).toBe(1);
  });

  it('keeps the names through a restart, and forgets the session speakers at a restart', () => {
    speakingOn();
    agent.identifySpeaker(voice(0));
    agent.nameSessionSpeaker('Speaker 1', 'Ada');
    agent.close();

    agent = open();
    expect(agent.speakerProfileCount()).toBe(1);
    expect(agent.identifySpeaker(voice(0, 13))).toBe('Ada');
    // A voice nobody named is not carried across a restart: it starts again at Speaker 1.
    expect(agent.identifySpeaker(voice(5))).toBe('Speaker 1');
  });

  it('forgets every profile on request, and leaves the names already on past items', () => {
    speakingOn();
    agent.identifySpeaker(voice(0));
    keep('before forgetting', 'Speaker 1');
    agent.nameSessionSpeaker('Speaker 1', 'Ada');
    expect(agent.speakerProfileCount()).toBe(1);

    agent.forgetSpeakers();

    expect(agent.speakerProfileCount()).toBe(0);
    expect(agent.identifySpeaker(voice(0))).toBe('Speaker 1');
    expect(agent.searchCapture({ text: '', ...WIDE, speaker: 'Ada' })).toHaveLength(1);
  });

  it('deleting the text keeps the profiles, since they are not text', () => {
    speakingOn();
    agent.identifySpeaker(voice(0));
    agent.nameSessionSpeaker('Speaker 1', 'Ada');
    keep('something said');
    agent.deleteAllCapture();
    expect(agent.speakerProfileCount()).toBe(1);
    expect(agent.identifySpeaker(voice(0, 3))).toBe('Ada');
  });

  it('cannot name a session speaker whose voice came from audio that was deleted', () => {
    speakingOn();
    agent.identifySpeaker(voice(0));
    keep('said before the delete', 'Speaker 1');
    agent.deleteAllCapture();
    expect(() => agent.nameSessionSpeaker('Speaker 1', 'Ada')).toThrow('That speaker is not in this session any more.');
    expect(agent.speakerProfileCount()).toBe(0);
  });

  it('exports how many profiles there are, and never a name or a voice', () => {
    speakingOn();
    agent.identifySpeaker(voice(0));
    agent.nameSessionSpeaker('Speaker 1', 'Ada');
    const exported = agent.exportAll() as { speakers: unknown };
    expect(exported.speakers).toEqual({ profiles: 1 });
    const text = JSON.stringify(agent.exportAll());
    expect(text).not.toContain('centroid');
    expect(text).not.toContain('Ada');
  });

  it('never returns a voice in a search hit', () => {
    speakingOn();
    agent.identifySpeaker(voice(0));
    keep('a line about the plan', 'Speaker 1');
    const hits = agent.searchCapture({ text: 'plan', ...WIDE });
    expect(JSON.stringify(hits)).not.toMatch(/centroid|\[-?0\.\d/);
    expect(hits[0]).toMatchObject({ kind: 'audio', speaker: 'Speaker 1' });
    // A word search and a speaker filter combine: the words narrow the speaker's own lines.
    expect(agent.searchCapture({ text: 'plan', ...WIDE, speaker: 'Speaker 1' })).toHaveLength(1);
    expect(agent.searchCapture({ text: 'plan', ...WIDE, speaker: 'Speaker 2' })).toHaveLength(0);
    expect(agent.searchCapture({ text: 'budget', ...WIDE, speaker: 'Speaker 1' })).toHaveLength(0);
  });
});
