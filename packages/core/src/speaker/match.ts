import { SPEAKER_EMBEDDING_DIM } from '../models/speaker';

/**
 * Tells speakers apart by comparing voice embeddings with cosine similarity. Pure functions, so the rules can be tested
 * with synthetic vectors. Nothing here stores anything or reads a file.
 *
 * A segment gets the name of an enrolled speaker when its similarity to that speaker's centroid is at or above
 * SPEAKER_MATCH_THRESHOLD. Otherwise it gets a session label, 'Speaker 1', 'Speaker 2' and so on, from SessionSpeakers.
 * Session speakers exist only in memory and are never written down: a session speaker becomes a profile only when the person
 * names it. The thresholds are not tuned on real recordings yet. They are set high on purpose, so a voice is more often
 * left as 'Speaker N' than given the wrong name.
 */

/** Cosine similarity at or above which an embedding is the enrolled speaker's. */
export const SPEAKER_MATCH_THRESHOLD = 0.6;
/** Cosine similarity at or above which an embedding joins an existing session speaker rather than opening a new one. */
export const SESSION_SPEAKER_THRESHOLD = 0.6;
/** Session speakers kept at once. Past this, a new voice gets no label, so the list cannot grow without limit. */
export const MAX_SESSION_SPEAKERS = 20;
/** Shorter segments are too short to tell voices apart, so they get no speaker. One second of 16 kHz audio. */
export const SPEAKER_MIN_SAMPLES = 16_000;
/** Longest name a person may give a speaker. */
export const SPEAKER_NAME_MAX_CHARS = 40;

/** A session label: 'Speaker' and a number from 1 to 999, with no leading zero. */
const SESSION_LABEL = /^Speaker [1-9][0-9]{0,2}$/;
/** 'Speaker' and any number, which a name must not be, so no name looks like an unnamed speaker. */
const UNNAMED_LOOK_ALIKE = /^speaker \d+$/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function sessionSpeakerLabel(number: number): string {
  return `Speaker ${number}`;
}

export function isSessionSpeakerLabel(label: string): boolean {
  return SESSION_LABEL.test(label);
}

/**
 * A name a person may give a speaker: one line of text, trimmed, up to SPEAKER_NAME_MAX_CHARS. A name never reads as an
 * unnamed speaker, so 'Speaker' followed by any number, such as 'Speaker 2' or 'Speaker 0', is refused.
 */
export function isSpeakerName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > SPEAKER_NAME_MAX_CHARS) return false;
  if (CONTROL_CHARACTERS.test(trimmed)) return false;
  return !UNNAMED_LOOK_ALIKE.test(trimmed);
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/** A unit-length copy of the vector, or undefined when it is the wrong length, has a value that is not finite, or is zero. */
export function unitVector(values: ArrayLike<number>, length: number = SPEAKER_EMBEDDING_DIM): Float32Array | undefined {
  if (values.length !== length) return undefined;
  let sum = 0;
  for (let i = 0; i < length; i++) {
    const value = values[i];
    if (!Number.isFinite(value)) return undefined;
    sum += value * value;
  }
  if (sum === 0) return undefined;
  const scale = 1 / Math.sqrt(sum);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = values[i] * scale;
  return out;
}

/**
 * Cosine similarity, in [-1, 1]. A pair of different lengths, or one with a zero vector, is 0: it is not similar to anything,
 * so it can never match a threshold above zero.
 */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (Math.sqrt(na) * Math.sqrt(nb));
}

/** The centroid of unit vectors: their mean, scaled back to unit length. Undefined when there are none, or the mean is zero. */
export function centroidOf(units: readonly ArrayLike<number>[]): Float32Array | undefined {
  if (units.length === 0) return undefined;
  const length = units[0].length;
  const sum = new Float64Array(length);
  for (const unit of units) {
    if (unit.length !== length) return undefined;
    for (let i = 0; i < length; i++) sum[i] += unit[i];
  }
  return unitVector(sum, length);
}

export interface SpeakerProfile {
  id: string;
  name: string;
  /** Unit length. Kept in memory and in the encrypted store. Never returned by any view. */
  centroid: Float32Array;
}

export interface ProfileMatch {
  id: string;
  name: string;
  score: number;
}

/**
 * The enrolled speaker whose centroid is most similar, when that similarity is at or above the threshold. Ties keep the
 * earlier profile. Undefined when no profile reaches the threshold, including when there are none.
 */
export function bestProfile(
  embedding: ArrayLike<number>,
  profiles: readonly SpeakerProfile[],
  threshold: number = SPEAKER_MATCH_THRESHOLD,
): ProfileMatch | undefined {
  let best: ProfileMatch | undefined;
  for (const profile of profiles) {
    const score = cosine(embedding, profile.centroid);
    if (score >= threshold && (best === undefined || score > best.score)) {
      best = { id: profile.id, name: profile.name, score };
    }
  }
  return best;
}

interface SessionCluster {
  label: string;
  /** Sum of the unit vectors assigned to this speaker. Its direction is the centroid. */
  sum: Float64Array;
  centroid: Float32Array;
}

/**
 * The speakers heard in this run of the app that nobody has named. Each new voice opens 'Speaker N', with N counting up
 * from 1, and later segments that are close enough join it. Held in memory only. A restart starts again from Speaker 1.
 */
export class SessionSpeakers {
  private readonly clusters: SessionCluster[] = [];
  private nextNumber = 1;

  constructor(
    private readonly threshold: number = SESSION_SPEAKER_THRESHOLD,
    private readonly limit: number = MAX_SESSION_SPEAKERS,
  ) {}

  /**
   * The label for one embedding: the closest session speaker at or above the threshold, or a new label. Undefined when the
   * embedding is not usable, or when it matches nobody and the limit is reached.
   */
  assign(embedding: ArrayLike<number>): string | undefined {
    const unit = unitVector(embedding);
    if (!unit) return undefined;
    let best: SessionCluster | undefined;
    let bestScore = -Infinity;
    for (const cluster of this.clusters) {
      const score = cosine(unit, cluster.centroid);
      if (score >= this.threshold && score > bestScore) {
        best = cluster;
        bestScore = score;
      }
    }
    if (best) {
      this.add(best, unit);
      return best.label;
    }
    if (this.clusters.length >= this.limit) return undefined;
    const cluster: SessionCluster = {
      label: sessionSpeakerLabel(this.nextNumber++),
      sum: new Float64Array(unit.length),
      centroid: unit,
    };
    this.add(cluster, unit);
    this.clusters.push(cluster);
    return cluster.label;
  }

  /** The centroid of a session speaker, for enrolling it. Undefined when the label is not in this session. */
  centroidOf(label: string): Float32Array | undefined {
    return this.clusters.find(cluster => cluster.label === label)?.centroid;
  }

  /** Takes a speaker out of the session, after it has been named. Returns whether it was there. */
  remove(label: string): boolean {
    const index = this.clusters.findIndex(cluster => cluster.label === label);
    if (index < 0) return false;
    this.clusters.splice(index, 1);
    return true;
  }

  /** The labels in this session, oldest first. */
  get labels(): string[] {
    return this.clusters.map(cluster => cluster.label);
  }

  /** Forgets every session speaker. The numbering starts again from 1. */
  clear(): void {
    this.clusters.length = 0;
    this.nextNumber = 1;
  }

  private add(cluster: SessionCluster, unit: Float32Array): void {
    for (let i = 0; i < unit.length; i++) cluster.sum[i] += unit[i];
    cluster.centroid = unitVector(cluster.sum, unit.length) ?? cluster.centroid;
  }
}
