
/**
 * File and photo search on this device: an index of the person's files with a compressed embedding of each, a small
 * knowledge graph of the names they mention, and a plan read from a question in plain words by fast rules. Ranking
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
  /** True for a file whose content is only in iCloud. It is indexed by name only, and never previewed. */
  cloudOnly?: boolean;
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
  /** Inclusive bounds on the file's date, epoch milliseconds, from a relative time such as "last month". */
  after?: number;
  before?: number;
  /** A named month or year: files from then rank higher, and the others are still found. */
  prefer?: { after: number; before: number };
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
  /** Each word of each name, to the names it is part of, so "priya" finds "priya shah" without scanning every name. */
  words: Map<string, string[]>;
  /** Each name's three closest neighbours, sorted once when the graph is built. */
  near: Map<string, string[]>;
}

export function buildGraph(records: readonly FileRecord[]): FileGraph {
  const files = new Map<string, string[]>();
  const neighbours = new Map<string, Map<string, number>>();
  const words = new Map<string, string[]>();
  for (const record of records) {
    for (const entity of record.entities) {
      const paths = files.get(entity);
      if (paths) paths.push(record.path);
      else {
        files.set(entity, [record.path]);
        for (const word of entity.split(/[^a-z0-9@.]+/).filter(word => word.length >= 2)) {
          const named = words.get(word);
          if (named) named.push(entity);
          else words.set(word, [entity]);
        }
      }
      for (const other of record.entities) {
        if (other === entity) continue;
        const row = neighbours.get(entity) ?? new Map<string, number>();
        row.set(other, (row.get(other) ?? 0) + 1);
        neighbours.set(entity, row);
      }
    }
  }
  const near = new Map<string, string[]>();
  for (const [entity, row] of neighbours) near.set(entity, [...row].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([other]) => other));
  return { files, neighbours, words, near };
}

/**
 * How strongly the graph ties each file to the words of a query: a file that names one of them directly scores 1, and a
 * file that names one of their closest neighbours scores less. A word ties to every name it is a whole word of, so "priya"
 * finds "priya shah". Looked up in the word map, so it costs the same however many names there are.
 */
export function graphScores(graph: FileGraph, words: readonly string[]): Map<string, number> {
  const scores = new Map<string, number>();
  const raise = (path: string, value: number) => scores.set(path, Math.max(scores.get(path) ?? 0, value));
  for (const word of words) {
    for (const entity of graph.words.get(word) ?? []) {
      for (const path of graph.files.get(entity) ?? []) raise(path, 1);
      for (const other of graph.near.get(entity) ?? []) for (const path of graph.files.get(other) ?? []) raise(path, 0.4);
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

/** Words that carry no meaning for a file search, dropped before matching and embedding. */
const FILLER = new Set(['find', 'me', 'my', 'mine', 'the', 'a', 'an', 'of', 'please', 'show', 'get', 'open', 'where', 'is', 'are', 'that', 'this', 'i', 'file', 'files', 'some', 'any', 'all', 'with', 'from', 'for', 'in', 'on', 'to', 'and', 'or', 'which', 'what', 'had', 'have', 'saved', 'sent', 'during', 'since', 'size', 'sized']);
/** Words that only say what kind of file is wanted. They set the kind, and need not appear in the file. */
const KIND_WORDS = new Set(['photo', 'photos', 'picture', 'pictures', 'pic', 'pics', 'image', 'images', 'jpg', 'jpeg', 'png', 'heic', 'pdf', 'pdfs', 'document', 'documents', 'doc', 'docs', 'docx', 'screenshot', 'screenshots', 'selfie', 'selfies']);
/** A request for a passport, visa or ID photo, as opposed to a passport or visa document. */
const PASSPORT_PHOTO = /\b(passport|visa)[ -]?(size[d]? )?(photo|photos|pic|pics|picture|image|headshot)\b|\b(passport[ -]size[d]?|headshot|head shot|id photo|photo id|profile photo)\b/i;
const PHOTO = /\b(photo|photos|picture|pictures|pic|pics|image|images|selfie|selfies|snap|jpg|jpeg|png|heic)\b/i;
const SCREENSHOT = /\b(screenshot|screenshots|screen shot|screen grab)\b/i;
const DOCUMENT = /\b(pdf|pdfs|document|documents|doc|docs|docx|invoice|invoices|receipt|receipts|resume|cv|letter|letters|report|reports|contract|contracts|statement|statements|bill|bills|form|forms|certificate|certificates|notes|agreement|payslip|slip|scan|scans)\b/i;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** Words of a relative time, which filter by the file's date and are not matched as words. */
const TIME_WORDS = new Set(['today', 'yesterday', 'last', 'this', 'past', 'week', 'month', 'year', 'days', 'day']);

function startOfDay(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** The same calendar day, a number of days back, so a change of clocks does not move it by an hour. */
function daysBack(today: number, days: number): number {
  const date = new Date(today);
  date.setDate(date.getDate() - days);
  return date.getTime();
}

/**
 * The time the words ask for. A relative time (today, yesterday, the last few days, this or last week, month or year) is a
 * filter on the file's date. A named month or year is only a preference: files from then rank higher, and the month or
 * year stays a word, because a file such as Form16_2023.pdf is often saved long after the year it is about. A month counts
 * only in a time phrase, "in May", "from March", "during June", or followed by a year, so "may mention" is not a date.
 */
function timeOf(text: string, now: number): { after?: number; before?: number; prefer?: { after: number; before: number } } {
  const today = startOfDay(now);
  const date = new Date(now);
  if (/\btoday\b/.test(text)) return { after: today };
  if (/\byesterday\b/.test(text)) return { after: daysBack(today, 1), before: today - 1 };
  const days = /\b(?:last|past) (\d{1,3}) days?\b/.exec(text);
  if (days) return { after: daysBack(today, Number(days[1])) };
  if (/\b(this|past) week\b/.test(text)) return { after: daysBack(today, 7) };
  if (/\blast week\b/.test(text)) return { after: daysBack(today, 14), before: daysBack(today, 7) - 1 };
  if (/\bthis month\b/.test(text)) return { after: new Date(date.getFullYear(), date.getMonth(), 1).getTime() };
  if (/\blast month\b/.test(text)) return { after: new Date(date.getFullYear(), date.getMonth() - 1, 1).getTime(), before: new Date(date.getFullYear(), date.getMonth(), 1).getTime() - 1 };
  if (/\bthis year\b/.test(text)) return { after: new Date(date.getFullYear(), 0, 1).getTime() };
  if (/\blast year\b/.test(text)) return { after: new Date(date.getFullYear() - 1, 0, 1).getTime(), before: new Date(date.getFullYear(), 0, 1).getTime() - 1 };
  const year = /\b(19|20)\d{2}\b/.exec(text);
  const month = MONTHS.findIndex(name => new RegExp(`\\b(in|from|during|since|around) ${name}\\b|\\b${name},? (19|20)\\d{2}\\b`).test(text));
  if (month >= 0) {
    // A month without a year is its latest one that has started.
    const y = year ? Number(year[0]) : month <= date.getMonth() ? date.getFullYear() : date.getFullYear() - 1;
    return { prefer: { after: new Date(y, month, 1).getTime(), before: new Date(y, month + 1, 1).getTime() - 1 } };
  }
  if (year) return { prefer: { after: new Date(Number(year[0]), 0, 1).getTime(), before: new Date(Number(year[0]) + 1, 0, 1).getTime() - 1 } };
  return {};
}

/**
 * What a query asks for, read by rules in well under a millisecond: the kind of file, a photo shape, its time, and the words
 * that carry its meaning. The words are matched against file names, text and the knowledge graph, and embedded.
 */
export function parseQuery(query: string, now = Date.now()): FilePlan {
  const text = query.toLowerCase().replace(/\s+/g, ' ').trim();
  const passport = PASSPORT_PHOTO.test(text);
  const screenshot = SCREENSHOT.test(text);
  const photo = passport || screenshot || PHOTO.test(text);
  const document = !photo && DOCUMENT.test(text);
  const shape: FilePlan['shape'] = passport ? 'passport' : screenshot ? 'screenshot' : photo && /\blandscape\b/.test(text) ? 'landscape' : photo && /\bportrait\b/.test(text) ? 'portrait' : 'any';
  const time = timeOf(text, now);
  const relative = time.after !== undefined || time.before !== undefined;
  const words = (text.match(/[a-z0-9@.]+/g) ?? [])
    .map(word => word.replace(/^\.+|\.+$/g, ''))
    .filter(word => word.length >= 2 && !FILLER.has(word) && !KIND_WORDS.has(word) && !(relative && TIME_WORDS.has(word)) && !(relative && /^\d{1,3}$/.test(word)));
  return { kind: photo ? 'image' : document ? 'document' : 'any', about: words.join(' ') || text, names: words, shape, ...time };
}

/** A query word and its singular, so "invoices" also finds "Invoice_2024.pdf". */
function variants(word: string): string[] {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? [word, word.slice(0, -1)] : [word];
}

/**
 * The search index: built once from the stored records, so a search does no unpacking, no parsing and no scan of the graph.
 * Vectors are unpacked into one matrix and normalised, so meaning is a dot product.
 */
export class FileSearchIndex {
  readonly records: readonly FileRecord[];
  readonly graph: FileGraph;
  private readonly matrix: Float32Array;
  private readonly hasVector: Uint8Array;
  private readonly dim: number;
  private readonly lowerNames: string[];
  private readonly lowerText: string[];
  private readonly byPath: Map<string, number>;

  constructor(records: readonly FileRecord[]) {
    this.records = records;
    this.graph = buildGraph(records);
    const first = records.find(record => record.vector && record.scale);
    this.dim = first?.vector ? Buffer.from(first.vector, 'base64').length : 0;
    this.matrix = new Float32Array(records.length * this.dim);
    this.hasVector = new Uint8Array(records.length);
    records.forEach((record, row) => {
      if (!record.vector || !record.scale || this.dim === 0) return;
      const values = expand(record.vector, record.scale);
      if (values.length !== this.dim) return;
      let norm = 0;
      for (let i = 0; i < this.dim; i++) norm += values[i] * values[i];
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < this.dim; i++) this.matrix[row * this.dim + i] = values[i] / norm;
      this.hasVector[row] = 1;
    });
    this.lowerNames = records.map(record => record.name.toLowerCase());
    this.lowerText = records.map(record => `${record.folder} ${(record.labels ?? []).join(' ')} ${record.text}`.toLowerCase());
    this.byPath = new Map(records.map((record, row) => [record.path, row]));
  }

  has(path: string): boolean {
    return this.byPath.has(path);
  }

  get(path: string): FileRecord | undefined {
    const row = this.byPath.get(path);
    return row === undefined ? undefined : this.records[row];
  }

  /**
   * The best matches for a plan. Kind, shape and dates filter; meaning, the graph, the file name and the file's text decide
   * the order. The query vector, when there is one, must come from the same embedding model as the index.
   */
  search(plan: FilePlan, queryVector: ArrayLike<number> | undefined, limit = 20): FileHit[] {
    let query: Float32Array | undefined;
    if (queryVector && queryVector.length === this.dim && this.dim > 0) {
      query = Float32Array.from(queryVector);
      let norm = 0;
      for (let i = 0; i < this.dim; i++) norm += query[i] * query[i];
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < this.dim; i++) query[i] /= norm;
    }
    const tied = graphScores(this.graph, plan.names.flatMap(variants));
    const words = plan.names.map(variants);
    const hits: FileHit[] = [];
    for (let row = 0; row < this.records.length; row++) {
      const record = this.records[row];
      if (plan.kind !== 'any' && record.kind !== plan.kind) continue;
      if (plan.after !== undefined && record.mtime < plan.after) continue;
      if (plan.before !== undefined && record.mtime > plan.before) continue;
      const shape = shapeFit(record, plan.shape);
      if (shape === undefined) continue;
      let meaning = 0;
      if (query && this.hasVector[row]) {
        const offset = row * this.dim;
        for (let i = 0; i < this.dim; i++) meaning += query[i] * this.matrix[offset + i];
      }
      const graphTie = tied.get(record.path) ?? 0;
      const nameHits = words.filter(forms => forms.some(form => this.lowerNames[row].includes(form))).length;
      const textHits = words.filter(forms => forms.some(form => this.lowerText[row].includes(form))).length;
      const share = (count: number) => (words.length === 0 ? 0 : count / words.length);
      const inPeriod = plan.prefer !== undefined && record.mtime >= plan.prefer.after && record.mtime <= plan.prefer.before;
      const score = meaning * 0.5 + graphTie * 0.2 + share(nameHits) * 0.15 + share(textHits) * 0.1 + (shape ? 0.1 : 0) + (inPeriod ? 0.1 : 0);
      // A query of words keeps only files that match them somehow. A query that is only a kind, a shape or a time keeps
      // every file that fits, newest first.
      if (words.length > 0 && score <= 0) continue;
      const why: string[] = shape ? [shape] : [];
      if (graphTie > 0) why.push(graphTie >= 1 ? 'names what you asked for' : 'linked to it');
      if (nameHits > 0) why.push('name matches');
      else if (textHits > 0) why.push('text matches');
      if (inPeriod) why.push('from then');
      hits.push({ record, score, why });
    }
    return hits.sort((a, b) => b.score - a.score || b.record.mtime - a.record.mtime).slice(0, limit);
  }
}

/** The record's text cut to the size the index keeps. */
export function clipText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, TEXT_CHARS);
}
