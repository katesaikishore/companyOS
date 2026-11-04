import { asksForOwn, factCard, factKind, factValue, factWords, identityWithFiles, isOwnFact, periodRange, typesAskedFor, type Identity } from './file-knowledge';

/**
 * File and photo search on this device: an index of the person's files with a compressed embedding of each, a knowledge
 * graph of the typed facts read from their text (what each file is, who issued it, who and which account it is about,
 * the months it covers), and a plan read from a question in plain words by fast rules. Ranking mixes meaning (the
 * embedding), the graph (how much of the question, rare words weighing most, the file's facts cover) and the shape
 * rules a question asks for, such as a passport photo.
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
  /**
   * The file's knowledge, compressed to a few typed facts read from all of its text, such as "type:bank statement" or
   * "org:icici bank" (see file-knowledge.ts). They are the file's nodes in the knowledge graph. A record from before facts
   * were read has none, and the next pass reads them.
   */
  facts?: string[];
  /** The version of the rules that read the facts (FACTS_VERSION). Facts from other rules are read again. */
  factsVersion?: number;
  /** True for a file whose content is only in iCloud. It is indexed by name only, and never previewed. */
  cloudOnly?: boolean;
  /** The embedding, compressed to one signed byte per number, and its scale, as base64. */
  vector?: string;
  scale?: number;
  /** The model that made the vector. A vector from another model is made again, from the record's text and facts. */
  vectorModel?: string;
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
  /** The question asks for the person's own files, with "my", "mine" or "me": files that name them rank higher. */
  mine?: boolean;
}

export interface FileHit {
  record: FileRecord;
  score: number;
  /** Why it matched, in a few words, such as "one face, passport shape". */
  why: string[];
}

const TEXT_CHARS = 1500;
/** How much each signal adds to a file's score. Shape and a preferred period add 0.1 each. */
const GRAPH_WEIGHTS = { meaning: 0.4, graph: 0.35, type: 0.1, name: 0.1, text: 0.05, own: 0.15 };

/**
 * The text an embedding is made from: name, folder, the card of the file's facts, labels and the start of the text. The
 * card comes before the text, so a statement's meaning is "bank statement, icici bank" and not its first rows of numbers,
 * and the model, which reads only its first 256 tokens, always sees it.
 */
export function embeddingText(record: Pick<FileRecord, 'name' | 'folder' | 'labels' | 'text' | 'facts'>): string {
  return [record.name, record.folder, factCard(record.facts ?? []), (record.labels ?? []).join(' '), record.text.slice(0, 400)].filter(Boolean).join(' | ');
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

/** Facts that name someone or something, between which the graph keeps neighbours. */
const NAME_KINDS = new Set(['org', 'person', 'email', 'project']);
/** How close two names must be, by how often they appear together against how common each is, to be neighbours. */
const NEAR_THRESHOLD = 0.3;
/** The tie a file gets from a neighbour of a fact the question names, against 1 for the fact itself. */
const NEAR_TIE = 0.4;
/** The tie a file gets from an organisation it only mentions, such as another bank in a statement's transactions. */
const MENTION_TIE = 0.5;

/**
 * The knowledge graph: facts and the files they are facts of, the words that reach them, and neighbours between names.
 * Files are their rows in the records the graph was built from, so a search adds up ties in one array.
 */
export interface FileGraph {
  /** The path of each row. */
  paths: string[];
  /** Each row's facts. */
  rowFacts: string[][];
  /** For each fact, the rows of the files it is a fact of. */
  files: Map<string, number[]>;
  /** For each word, the facts it reaches (see factWords), so "icici" finds "org:icici bank" without a scan of every fact. */
  words: Map<string, string[]>;
  /**
   * How rare each word is among the files its facts belong to, as an inverse document frequency: "icici" in three files
   * weighs far more than "bank" in three hundred, so a question's rare words decide which files tie to it.
   */
  rarity: Map<string, number>;
  /** The rarity of a word no fact has, the most a word can weigh. */
  unknownRarity: number;
  /**
   * Each name's closest names: seen in the same files often against how common each is (cosine of their files), so a
   * name in every file, such as the person's own, is nobody's neighbour. Up to three, sorted once when the graph is built.
   */
  near: Map<string, string[]>;
}

export function buildGraph(records: readonly FileRecord[]): FileGraph {
  const files = new Map<string, number[]>();
  const together = new Map<string, Map<string, number>>();
  const rowFacts = records.map(record => record.facts ?? []);
  rowFacts.forEach((facts, row) => {
    for (const fact of facts) {
      const rows = files.get(fact);
      if (rows) rows.push(row);
      else files.set(fact, [row]);
    }
    const names = facts.filter(fact => NAME_KINDS.has(factKind(fact)));
    for (const fact of names) {
      for (const other of names) {
        if (other === fact) continue;
        const counts = together.get(fact) ?? new Map<string, number>();
        counts.set(other, (counts.get(other) ?? 0) + 1);
        together.set(fact, counts);
      }
    }
  });
  const words = new Map<string, string[]>();
  const reach = new Map<string, Set<number>>();
  for (const [fact, rows] of files) {
    for (const word of factWords(fact)) {
      const facts = words.get(word);
      if (facts) facts.push(fact);
      else words.set(word, [fact]);
      const seen = reach.get(word) ?? new Set<number>();
      for (const row of rows) seen.add(row);
      reach.set(word, seen);
    }
  }
  const total = Math.max(1, records.length);
  const rarity = new Map<string, number>();
  for (const [word, rows] of reach) rarity.set(word, Math.log(1 + total / rows.size));
  const near = new Map<string, string[]>();
  for (const [fact, counts] of together) {
    const own = files.get(fact)?.length ?? 1;
    const closest = [...counts]
      .filter(([, count]) => count >= 2)
      .map(([other, count]) => [other, count / Math.sqrt(own * (files.get(other)?.length ?? 1))] as const)
      .filter(([, closeness]) => closeness >= NEAR_THRESHOLD)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([other]) => other);
    if (closest.length > 0) near.set(fact, closest);
  }
  return { paths: records.map(record => record.path), rowFacts, files, words, rarity, unknownRarity: Math.log(1 + total), near };
}

export interface GraphTie {
  /** How much of the question the file's facts cover, from 0 to 1, each word weighed by its rarity. */
  score: number;
  /** The file's own facts the question's words reached, for the reason shown with the result. */
  facts: string[];
}

const tieOf = (fact: string): number => (factKind(fact) === 'mention' ? MENTION_TIE : 1);

/**
 * How strongly the graph ties each row to a question's words, each given with its other forms, such as a singular. A
 * word ties a file fully when it reaches one of the file's facts, by half when the file only mentions what it reaches,
 * and less when it reaches a neighbour of one of its facts. The ties add up across the words, each weighed by its rarity,
 * and are divided by the weight of all the words, so a file that is an ICICI bank statement covers "icici bank
 * statement" and a receipt from another bank covers only "bank". Looked up in the word map, so it costs the same however
 * many facts there are.
 */
export function graphTies(graph: FileGraph, words: readonly (readonly string[])[]): Float64Array {
  const scores = new Float64Array(graph.paths.length);
  // The best tie of each row for one word, so a word that reaches two of a file's facts counts once.
  const best = new Float32Array(graph.paths.length);
  let weight = 0;
  for (const forms of words) {
    if (forms.length === 0) continue;
    const rarity = Math.max(...forms.map(form => graph.rarity.get(form) ?? 0)) || graph.unknownRarity;
    weight += rarity;
    best.fill(0);
    for (const form of forms) {
      for (const fact of graph.words.get(form) ?? []) {
        const tie = tieOf(fact);
        for (const row of graph.files.get(fact) ?? []) if (best[row] < tie) best[row] = tie;
        for (const other of graph.near.get(fact) ?? []) for (const row of graph.files.get(other) ?? []) if (best[row] < NEAR_TIE) best[row] = NEAR_TIE;
      }
    }
    for (let row = 0; row < best.length; row++) if (best[row] > 0) scores[row] += rarity * best[row];
  }
  if (weight > 0) for (let row = 0; row < scores.length; row++) scores[row] /= weight;
  return scores;
}

/** The facts of one row that a question's words reach, the strongest for each word, in the order of the words. */
export function reachedFacts(graph: FileGraph, row: number, words: readonly (readonly string[])[]): string[] {
  const reached: string[] = [];
  for (const forms of words) {
    let chosen: string | undefined;
    for (const fact of graph.rowFacts[row] ?? []) {
      if (!factWords(fact).some(word => forms.includes(word))) continue;
      if (!chosen || tieOf(fact) > tieOf(chosen)) chosen = fact;
    }
    if (chosen && !reached.includes(chosen)) reached.push(chosen);
  }
  return reached;
}

/** The graph's ties of every file the question's words reach, by path, with the facts they reached. */
export function graphScores(graph: FileGraph, words: readonly (readonly string[])[]): Map<string, GraphTie> {
  const scores = graphTies(graph, words);
  const ties = new Map<string, GraphTie>();
  scores.forEach((score, row) => {
    if (score > 0) ties.set(graph.paths[row], { score, facts: reachedFacts(graph, row, words) });
  });
  return ties;
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
  const mine = asksForOwn(text);
  const words = (text.match(/[a-z0-9@.]+/g) ?? [])
    .map(word => word.replace(/^\.+|\.+$/g, ''))
    .filter(word => word.length >= 2 && !FILLER.has(word) && !KIND_WORDS.has(word) && !(relative && TIME_WORDS.has(word)) && !(relative && /^\d{1,3}$/.test(word)));
  return { kind: photo ? 'image' : document ? 'document' : 'any', about: words.join(' ') || text, names: words, shape, ...time, ...(mine ? { mine: true } : {}) };
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
  /** Each file's document type, from its facts, and the months its text covers. */
  private readonly types: Array<string | undefined>;
  private readonly periods: Array<Array<{ after: number; before: number }>>;
  /** Whether each file names the person who uses this computer, so a question that says "my" finds theirs first. */
  private readonly own: Uint8Array;
  /** Who "my" means, as the search bar shows it, when it is known. */
  readonly me: string | undefined;

  constructor(records: readonly FileRecord[], identity: Identity = { names: [] }) {
    this.records = records;
    this.graph = buildGraph(records);
    const self = identityWithFiles(identity, this.graph.rowFacts);
    this.me = self.names.length > 0 ? self.shown : undefined;
    this.own = Uint8Array.from(this.graph.rowFacts, facts => (self.names.length > 0 && facts.some(fact => isOwnFact(fact, self)) ? 1 : 0));
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
    this.types = records.map(record => {
      const type = (record.facts ?? []).find(fact => factKind(fact) === 'type');
      return type ? factValue(type) : undefined;
    });
    this.periods = records.map(record =>
      (record.facts ?? []).filter(fact => factKind(fact) === 'period').flatMap(fact => {
        const range = periodRange(fact);
        return range ? [range] : [];
      }),
    );
  }

  has(path: string): boolean {
    return this.byPath.has(path);
  }

  get(path: string): FileRecord | undefined {
    const row = this.byPath.get(path);
    return row === undefined ? undefined : this.records[row];
  }

  /**
   * The best matches for a plan. Kind, shape and dates filter; meaning, the graph, the kind of document, the file name and
   * the file's text decide the order. The query vector, when there is one, must come from the same embedding model as the
   * index.
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
    const words = plan.names.map(variants);
    const tied = graphTies(this.graph, words);
    const wanted = typesAskedFor(plan.about);
    const scored: Array<{ row: number; score: number; shape: string; nameHits: number; textHits: number; typeFit: boolean; inPeriod: boolean; yours: boolean }> = [];
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
      const graphTie = tied[row];
      const type = this.types[row];
      const typeFit = type !== undefined && wanted.includes(type);
      const nameHits = words.filter(forms => forms.some(form => this.lowerNames[row].includes(form))).length;
      const textHits = words.filter(forms => forms.some(form => this.lowerText[row].includes(form))).length;
      const share = (count: number) => (words.length === 0 ? 0 : count / words.length);
      // A named month or year prefers files from then: saved then, or whose text covers then, as a statement for March
      // saved in April does.
      const prefer = plan.prefer;
      const inPeriod =
        prefer !== undefined &&
        ((record.mtime >= prefer.after && record.mtime <= prefer.before) || this.periods[row].some(range => range.after <= prefer.before && range.before >= prefer.after));
      const yours = plan.mine === true && this.own[row] === 1;
      const score =
        (yours ? GRAPH_WEIGHTS.own : 0) +
        meaning * GRAPH_WEIGHTS.meaning +
        graphTie * GRAPH_WEIGHTS.graph +
        (typeFit ? GRAPH_WEIGHTS.type : 0) +
        share(nameHits) * GRAPH_WEIGHTS.name +
        share(textHits) * GRAPH_WEIGHTS.text +
        (shape ? 0.1 : 0) +
        (inPeriod ? 0.1 : 0);
      // A query of words keeps only files that match them somehow. A query that is only a kind, a shape or a time keeps
      // every file that fits, newest first.
      if (words.length > 0 && score <= 0) continue;
      scored.push({ row, score, shape, nameHits, textHits, typeFit, inPeriod, yours });
    }
    scored.sort((a, b) => b.score - a.score || this.records[b.row].mtime - this.records[a.row].mtime);
    // Why each one matched is put into words only for the results shown, not for every file that scored.
    return scored.slice(0, limit).map(({ row, score, shape, nameHits, textHits, typeFit, inPeriod, yours }) => {
      const record = this.records[row];
      const reached = tied[row] > 0 ? reachedFacts(this.graph, row, words) : [];
      const type = this.types[row];
      const why: string[] = shape ? [shape] : [];
      if (yours) why.push('yours');
      if (reached.length > 0) why.push(factCard(reached));
      else if (tied[row] > 0) why.push('linked to it');
      if (typeFit && type && !reached.includes(`type:${type}`)) why.push(type);
      if (nameHits > 0) why.push('name matches');
      else if (textHits > 0) why.push('text matches');
      if (inPeriod) why.push('from then');
      return { record, score, why };
    });
  }
}

/** A number long enough to be an account, card or Aadhaar number, whole or written in groups of four. */
const LONG_NUMBER = /\b\d{4}(?:[ -]?\d{4}){2,3}\b|\b\d{9,18}\b/g;

/**
 * The record's text cut to the size the index keeps, with long numbers hidden but their last four digits, as statements
 * print them: the index needs to know an account ends in 4321, never the whole number.
 */
export function clipText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TEXT_CHARS)
    .replace(LONG_NUMBER, number => `XXXX${number.replace(/\D/g, '').slice(-4)}`);
}
