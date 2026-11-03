import { z } from 'zod';
import type { OperatorModel } from './operator/loop';

/**
 * File and photo search on this device: an index of the person's files with a compressed embedding of each, a small
 * knowledge graph of the names they mention, and a plan the local model makes from a question in plain words. Ranking
 * mixes meaning (the embedding), the graph (files that share a name with the question, or with its neighbours) and the
 * shape rules a question asks for, such as a passport photo.
 */

export type FileKind = 'image' | 'document' | 'other';

export interface FileRecord {
  path: string;
  name: string;
  /** The folder the file sits in, from the indexed root down, such as "Downloads/visa". */
  folder: string;
  kind: FileKind;
  size: number;
  mtime: number;
  width?: number;
  height?: number;
  /** Face boxes relative to the image: x, y, width, height. */
  faces?: number[][];
  /** Scene labels from the image recogniser, such as "people" or "document". */
  labels?: string[];
  /** The start of the file's text, or the text in an image. */
  text: string;
  /** Names, organisations, emails and projects found in the file. Lower case. */
  entities: string[];
  /** The embedding, compressed to one signed byte per number, and its scale, as base64. */
  vector?: string;
  scale?: number;
}

/** What one query asks for, as the local model reads it. */
export interface FilePlan {
  kind: FileKind | 'any';
  /** What the file is about, in a few words, for the embedding. */
  about: string;
  /** Names of people, organisations or projects the question mentions. */
  names: string[];
  /** A photo shape the question asks for. */
  shape: 'passport' | 'portrait' | 'landscape' | 'screenshot' | 'any';
  /** Inclusive bounds on the file's date, epoch milliseconds. */
  after?: number;
  before?: number;
}

export interface FileHit {
  record: FileRecord;
  score: number;
  /** Why it matched, in a few words, such as "one face, passport shape". */
  why: string[];
}

const TEXT_CHARS = 1500;

/** The text an embedding is made from: name, folder, labels and the start of the text. */
export function embeddingText(record: Pick<FileRecord, 'name' | 'folder' | 'labels' | 'text'>): string {
  return [record.name, record.folder, (record.labels ?? []).join(' '), record.text.slice(0, 600)].filter(Boolean).join(' | ');
}

/** A vector as one signed byte per number and a scale: a quarter of the size of 32-bit floats, enough for ranking. */
export function compress(vector: readonly number[]): { vector: string; scale: number } {
  const max = Math.max(1e-9, ...vector.map(Math.abs));
  const scale = max / 127;
  const bytes = Int8Array.from(vector, value => Math.round(value / scale));
  return { vector: Buffer.from(bytes.buffer).toString('base64'), scale };
}

export function expand(vector: string, scale: number): Float32Array {
  const bytes = Buffer.from(vector, 'base64');
  const values = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length);
  return Float32Array.from(values, value => value * scale);
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'page', 'date', 'name', 'total', 'invoice', 'copy', 'final', 'new', 'img', 'image', 'screenshot', 'scan', 'document', 'file', 'untitled', 'download']);
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** Two to four capitalised words in a row, such as "Priya Shah" or "Acme Supplies Ltd". */
const PROPER = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/g;
/** One all-capitals word of three or more letters, such as "ACME" or "GST". */
const ACRONYM = /\b([A-Z]{3,10})\b/g;

/**
 * The names a file mentions, by simple rules: emails, runs of capitalised words, capitalised acronyms, and the folder names
 * under the root, which are usually projects. Lower case, each once, at most twenty.
 */
export function extractEntities(record: Pick<FileRecord, 'name' | 'folder' | 'text'>): string[] {
  const found = new Set<string>();
  const add = (value: string) => {
    const clean = value.toLowerCase().replace(/\s+/g, ' ').trim();
    if (clean.length >= 3 && clean.length <= 60 && !STOP.has(clean)) found.add(clean);
  };
  const source = `${record.name.replace(/[_-]+/g, ' ').replace(/\.[a-z0-9]+$/i, '')}\n${record.text}`;
  for (const match of source.matchAll(EMAIL)) add(match[0]);
  for (const match of source.matchAll(PROPER)) add(match[1]);
  for (const match of source.matchAll(ACRONYM)) add(match[1]);
  for (const part of record.folder.split('/').slice(1)) add(part);
  return [...found].slice(0, 20);
}

/** The knowledge graph: for each name, the files that mention it, and the names seen with it in the same files. */
export interface FileGraph {
  files: Map<string, string[]>;
  neighbours: Map<string, Map<string, number>>;
}

export function buildGraph(records: readonly FileRecord[]): FileGraph {
  const files = new Map<string, string[]>();
  const neighbours = new Map<string, Map<string, number>>();
  for (const record of records) {
    for (const entity of record.entities) {
      files.set(entity, [...(files.get(entity) ?? []), record.path]);
      for (const other of record.entities) {
        if (other === entity) continue;
        const row = neighbours.get(entity) ?? new Map<string, number>();
        row.set(other, (row.get(other) ?? 0) + 1);
        neighbours.set(entity, row);
      }
    }
  }
  return { files, neighbours };
}

/**
 * How strongly the graph ties each file to the names in a query: a file that names one of them directly scores 1, and a
 * file that names one of their closest neighbours scores less. Names match on whole words, so "priya" finds "priya shah".
 */
export function graphScores(graph: FileGraph, names: readonly string[]): Map<string, number> {
  const scores = new Map<string, number>();
  const raise = (path: string, value: number) => scores.set(path, Math.max(scores.get(path) ?? 0, value));
  for (const name of names.map(n => n.toLowerCase().trim()).filter(n => n.length >= 2)) {
    const pattern = new RegExp(`(^|[^a-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
    for (const [entity, paths] of graph.files) {
      if (!pattern.test(entity)) continue;
      for (const path of paths) raise(path, 1);
      const near = [...(graph.neighbours.get(entity) ?? new Map<string, number>())].sort((a, b) => b[1] - a[1]).slice(0, 3);
      for (const [other] of near) for (const path of graph.files.get(other) ?? []) raise(path, 0.4);
    }
  }
  return scores;
}

/** Why a photo fits a shape, or undefined when it does not. A passport photo has one face that fills much of a portrait or square frame. */
export function shapeFit(record: FileRecord, shape: FilePlan['shape']): string | undefined {
  if (shape === 'any') return '';
  if (record.kind !== 'image' || !record.width || !record.height) return undefined;
  const aspect = record.width / record.height;
  const labels = record.labels ?? [];
  if (shape === 'screenshot') return labels.includes('screenshot') ? 'screenshot' : undefined;
  if (shape === 'landscape') return aspect > 1.15 ? 'landscape' : undefined;
  if (shape === 'portrait') return aspect < 0.9 ? 'portrait' : undefined;
  const faces = record.faces ?? [];
  if (faces.length !== 1) return undefined;
  const [, , width, height] = faces[0];
  const area = width * height;
  // A passport or visa photo is portrait or square, with one face filling a large part of the frame.
  if (aspect < 0.65 || aspect > 1.05 || area < 0.08) return undefined;
  return `one face, ${aspect > 0.95 ? 'square' : 'passport shape'}`;
}

const PLAN_SYSTEM = [
  'You turn a person’s request to find a file on their computer into a search plan.',
  'kind is image for photos and pictures, document for PDFs, letters, invoices, spreadsheets and text, any when unsure.',
  'about is a few words on what the file shows or contains. names lists people, companies or projects the request names.',
  'shape is only for photos: passport for a passport, visa or ID photo, portrait, landscape, screenshot; any for everything else, and always any for documents.',
  'after and before are dates as YYYY-MM-DD only when the request gives a time, else empty.',
  'Reply only with JSON: {"kind": "...", "about": "...", "names": [], "shape": "...", "after": "", "before": ""}.',
].join(' ');

const PlanReply = z.object({
  kind: z.enum(['image', 'document', 'other', 'any']).catch('any'),
  about: z.string().max(200).catch(''),
  names: z.array(z.string().max(60)).max(6).catch([]),
  shape: z.enum(['passport', 'portrait', 'landscape', 'screenshot', 'any']).catch('any'),
  after: z.string().max(20).optional().catch(undefined),
  before: z.string().max(20).optional().catch(undefined),
});

function day(value: string | undefined, end: boolean): number | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const ts = new Date(`${value}T${end ? '23:59:59' : '00:00:00'}`).getTime();
  return Number.isNaN(ts) ? undefined : ts;
}

/** Words that say a request is about a time. Without one, a date the model adds is dropped. */
const TIME_WORDS = /\b(today|yesterday|tomorrow|week|month|year|ago|last|since|before|after|recent|latest|old|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|(19|20)\d{2})\b/i;

/** The plan for a query. Without a model, or when it fails, the whole query is the topic. */
export async function planQuery(query: string, model: OperatorModel | undefined, today = new Date()): Promise<FilePlan> {
  const fallback: FilePlan = { kind: 'any', about: query, names: [], shape: /passport|visa|id photo/i.test(query) ? 'passport' : 'any' };
  if (!model) return fallback;
  try {
    const reply = PlanReply.parse(
      await model.complete({
        system: PLAN_SYSTEM,
        prompt: `Today is ${today.toISOString().slice(0, 10)}.\nRequest: ${query}\n/no_think`,
        schema: {
          type: 'object',
          properties: { kind: { type: 'string' }, about: { type: 'string' }, names: { type: 'array', items: { type: 'string' } }, shape: { type: 'string' }, after: { type: 'string' }, before: { type: 'string' } },
          required: ['kind', 'about', 'names', 'shape'],
        },
        maxTokens: 200,
      }),
    );
    const timed = TIME_WORDS.test(query);
    // A shape is about photos: a request for a document, or one that names no photo shape, gets none.
    const shape = reply.kind === 'document' ? 'any' : reply.shape;
    return {
      kind: shape !== 'any' && reply.kind === 'any' ? 'image' : reply.kind,
      about: reply.about.trim() || query,
      names: reply.names,
      shape,
      after: timed ? day(reply.after, false) : undefined,
      before: timed ? day(reply.before, true) : undefined,
    };
  } catch {
    return fallback;
  }
}

/**
 * Ranks the indexed files for a plan. Kind, shape and dates filter; meaning, the graph and the file name decide the order.
 * Returns the best few with the reasons they matched.
 */
export function rankFiles(plan: FilePlan, records: readonly FileRecord[], queryVector: ArrayLike<number> | undefined, graph: FileGraph, limit = 20): FileHit[] {
  const tied = graphScores(graph, plan.names);
  const words = [...new Set(`${plan.about} ${plan.names.join(' ')}`.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])];
  const hits: FileHit[] = [];
  for (const record of records) {
    if (plan.kind !== 'any' && record.kind !== plan.kind) continue;
    if (plan.after !== undefined && record.mtime < plan.after) continue;
    if (plan.before !== undefined && record.mtime > plan.before) continue;
    const shape = shapeFit(record, plan.shape);
    if (shape === undefined) continue;
    const why: string[] = shape ? [shape] : [];
    const meaning = queryVector && record.vector && record.scale ? cosine(queryVector, expand(record.vector, record.scale)) : 0;
    const graphTie = tied.get(record.path) ?? 0;
    if (graphTie > 0) why.push(graphTie >= 1 ? 'names what you asked for' : 'linked to it');
    const lowerName = record.name.toLowerCase();
    const nameHits = words.filter(word => lowerName.includes(word)).length;
    if (nameHits > 0) why.push('name matches');
    const score = meaning * 0.6 + graphTie * 0.25 + Math.min(1, nameHits / 2) * 0.15 + (shape ? 0.1 : 0);
    hits.push({ record, score, why });
  }
  return hits.sort((a, b) => b.score - a.score || b.record.mtime - a.record.mtime).slice(0, limit);
}

/** The record's text cut to the size the index keeps. */
export function clipText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, TEXT_CHARS);
}
