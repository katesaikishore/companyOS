import { describe, expect, it } from 'vitest';
import {
  MAX_SESSION_SPEAKERS,
  SESSION_SPEAKER_THRESHOLD,
  SPEAKER_MATCH_THRESHOLD,
  SessionSpeakers,
  bestProfile,
  centroidOf,
  cosine,
  isSessionSpeakerLabel,
  isSpeakerName,
  sessionSpeakerLabel,
  unitVector,
  type SpeakerProfile,
} from '../src/speaker/match';

const DIM = 256;

/** A unit vector along one axis. Two of these on different axes are orthogonal. */
function axis(index: number, value = 1): Float32Array {
  const v = new Float32Array(DIM);
  v[index] = value;
  return v;
}

/** A voice that is close to one axis: the axis plus a small, fixed wobble in the other dimensions. Deterministic. */
function voiceNear(index: number, wobble = 0.05, seed = 7): Float32Array {
  const v = new Float32Array(DIM);
  let state = seed;
  for (let i = 0; i < DIM; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    v[i] = ((state / 0x7fffffff) - 0.5) * wobble;
  }
  v[index] = 1;
  return unitVector(v)!;
}

describe('cosine and vectors', () => {
  it('is 1 for the same vector, 0 for orthogonal ones, and -1 for opposite ones', () => {
    expect(cosine(axis(3), axis(3))).toBeCloseTo(1, 10);
    expect(cosine(axis(3), axis(4))).toBe(0);
    expect(cosine(axis(3), axis(3, -1))).toBeCloseTo(-1, 10);
  });

  it('is ignored in length: scaling a vector does not change its cosine', () => {
    expect(cosine(axis(0, 5), axis(0, 0.2))).toBeCloseTo(1, 10);
  });

  it('is 0 for vectors of different lengths, or for a zero vector, so they can never match', () => {
    expect(cosine([1, 0], [1, 0, 0])).toBe(0);
    expect(cosine(new Float32Array(DIM), axis(0))).toBe(0);
    expect(cosine([], [])).toBe(0);
  });

  it('unitVector gives unit length, and refuses a zero, non-finite or wrong-length vector', () => {
    const unit = unitVector([3, 4, 0].concat(new Array(DIM - 3).fill(0)));
    expect(unit).toBeDefined();
    expect(Math.hypot(unit![0], unit![1])).toBeCloseTo(1, 6);
    expect(unitVector(new Float32Array(DIM))).toBeUndefined();
    expect(unitVector(axis(0).map((v, i) => (i === 1 ? Number.NaN : v)))).toBeUndefined();
    expect(unitVector([1, 2, 3])).toBeUndefined();
  });

  it('centroidOf is the normalised mean: two orthogonal voices give a point halfway between them', () => {
    const centre = centroidOf([axis(0), axis(1)])!;
    expect(centre[0]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(centre[1]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(Math.hypot(centre[0], centre[1])).toBeCloseTo(1, 6);
    expect(centroidOf([])).toBeUndefined();
    expect(centroidOf([axis(0), [1, 2, 3]])).toBeUndefined();
  });
});

describe('assigning an enrolled speaker', () => {
  const ada: SpeakerProfile = { id: 'p1', name: 'Ada', centroid: axis(0) };
  const ben: SpeakerProfile = { id: 'p2', name: 'Ben', centroid: axis(1) };

  it('names the closest profile when it is at or above the threshold', () => {
    expect(bestProfile(voiceNear(0), [ada, ben])).toMatchObject({ id: 'p1', name: 'Ada' });
    expect(bestProfile(voiceNear(1), [ada, ben])).toMatchObject({ id: 'p2', name: 'Ben' });
  });

  it('gives no name for a voice that is close to nobody', () => {
    expect(bestProfile(axis(5), [ada, ben])).toBeUndefined();
    expect(bestProfile(axis(0), [])).toBeUndefined();
  });

  it('matches at exactly the threshold, and not just below it', () => {
    const embedding = voiceNear(0, 0.9, 11);
    const score = cosine(embedding, ada.centroid);
    expect(bestProfile(embedding, [ada], score)).toMatchObject({ name: 'Ada' });
    expect(bestProfile(embedding, [ada], score + 1e-9)).toBeUndefined();
  });

  it('uses the default threshold of 0.6, unless one is given', () => {
    expect(SPEAKER_MATCH_THRESHOLD).toBe(0.6);
    // A voice at cosine 0.5 to Ada: below the default, so no name; a lower threshold gives one.
    const half = unitVector([0.5, Math.sqrt(0.75), ...new Array(DIM - 2).fill(0)])!;
    expect(cosine(half, ada.centroid)).toBeCloseTo(0.5, 6);
    expect(bestProfile(half, [ada])).toBeUndefined();
    expect(bestProfile(half, [ada], 0.49)).toMatchObject({ name: 'Ada' });
  });

  it('keeps the earlier profile on a tie', () => {
    const twin: SpeakerProfile = { id: 'p3', name: 'Twin', centroid: axis(0) };
    expect(bestProfile(axis(0), [ada, twin])).toMatchObject({ id: 'p1' });
  });
});

describe('session speakers', () => {
  it('opens Speaker 1 for the first voice, and the same voice keeps that label', () => {
    const speakers = new SessionSpeakers();
    expect(speakers.assign(voiceNear(0))).toBe('Speaker 1');
    expect(speakers.assign(voiceNear(0, 0.05, 99))).toBe('Speaker 1');
    expect(speakers.labels).toEqual(['Speaker 1']);
  });

  it('opens Speaker 2 for a voice that is not close to Speaker 1', () => {
    const speakers = new SessionSpeakers();
    expect(speakers.assign(axis(0))).toBe('Speaker 1');
    expect(speakers.assign(axis(1))).toBe('Speaker 2');
    expect(speakers.assign(axis(0))).toBe('Speaker 1');
    expect(speakers.assign(axis(1))).toBe('Speaker 2');
  });

  it('joins a voice that is just at the session threshold, and opens a new one just above it', () => {
    // The threshold is compared with a cosine computed in floating point, so the edge is probed a millionth either side.
    const edge = unitVector([SESSION_SPEAKER_THRESHOLD, Math.sqrt(1 - SESSION_SPEAKER_THRESHOLD ** 2), ...new Array(DIM - 2).fill(0)])!;
    const score = cosine(edge, axis(0));
    expect(score).toBeCloseTo(SESSION_SPEAKER_THRESHOLD, 6);

    const joins = new SessionSpeakers(score - 1e-6);
    expect(joins.assign(axis(0))).toBe('Speaker 1');
    expect(joins.assign(edge)).toBe('Speaker 1');

    const apart = new SessionSpeakers(score + 1e-6);
    expect(apart.assign(axis(0))).toBe('Speaker 1');
    expect(apart.assign(edge)).toBe('Speaker 2');
  });

  it('refuses a vector that is not usable, and gives no label to it', () => {
    const speakers = new SessionSpeakers();
    expect(speakers.assign(new Float32Array(DIM))).toBeUndefined();
    expect(speakers.assign([1, 2, 3])).toBeUndefined();
    expect(speakers.labels).toEqual([]);
  });

  it('stops opening new speakers at the limit, but still labels a voice it has heard', () => {
    const speakers = new SessionSpeakers(SESSION_SPEAKER_THRESHOLD, 2);
    expect(speakers.assign(axis(0))).toBe('Speaker 1');
    expect(speakers.assign(axis(1))).toBe('Speaker 2');
    expect(speakers.assign(axis(2))).toBeUndefined();
    expect(speakers.assign(axis(1))).toBe('Speaker 2');
    expect(MAX_SESSION_SPEAKERS).toBe(20);
  });

  it('removes a named speaker, and never reuses its number', () => {
    const speakers = new SessionSpeakers();
    speakers.assign(axis(0));
    speakers.assign(axis(1));
    expect(speakers.remove('Speaker 1')).toBe(true);
    expect(speakers.remove('Speaker 1')).toBe(false);
    expect(speakers.assign(axis(2))).toBe('Speaker 3');
    expect(speakers.labels).toEqual(['Speaker 2', 'Speaker 3']);
  });

  it('gives the centroid of a session speaker, as a unit vector', () => {
    const speakers = new SessionSpeakers();
    speakers.assign(axis(0));
    speakers.assign(voiceNear(0));
    const centre = speakers.centroidOf('Speaker 1')!;
    expect(Math.hypot(...Array.from(centre))).toBeCloseTo(1, 5);
    expect(cosine(centre, axis(0))).toBeGreaterThan(0.99);
    expect(speakers.centroidOf('Speaker 9')).toBeUndefined();
  });

  it('clear forgets every speaker and starts the numbering again', () => {
    const speakers = new SessionSpeakers();
    speakers.assign(axis(0));
    speakers.assign(axis(1));
    speakers.clear();
    expect(speakers.labels).toEqual([]);
    expect(speakers.assign(axis(0))).toBe('Speaker 1');
  });
});

describe('labels and names', () => {
  it('recognises session labels, and only those', () => {
    expect(sessionSpeakerLabel(2)).toBe('Speaker 2');
    expect(isSessionSpeakerLabel('Speaker 2')).toBe(true);
    expect(isSessionSpeakerLabel('Speaker 120')).toBe(true);
    for (const label of ['Speaker 0', 'Speaker 01', 'speaker 2', 'Speaker 2 ', 'Speaker 1000', 'Ada', 'Speaker']) {
      expect(isSessionSpeakerLabel(label)).toBe(false);
    }
  });

  it('accepts a name of up to 40 characters, trimmed, and refuses one that reads as a session label', () => {
    expect(isSpeakerName('Ada')).toBe(true);
    expect(isSpeakerName('  Ada Lovelace  ')).toBe(true);
    expect(isSpeakerName('a'.repeat(40))).toBe(true);
    expect(isSpeakerName('a'.repeat(41))).toBe(false);
    expect(isSpeakerName('')).toBe(false);
    expect(isSpeakerName('   ')).toBe(false);
    expect(isSpeakerName('Speaker 2')).toBe(false);
    expect(isSpeakerName('Speaker 0')).toBe(false);
    expect(isSpeakerName('speaker 12')).toBe(false);
    expect(isSpeakerName('Speaker Smith')).toBe(true);
    expect(isSpeakerName('Ada\nBen')).toBe(false);
    expect(isSpeakerName('Ada\u0007')).toBe(false);
  });
});
