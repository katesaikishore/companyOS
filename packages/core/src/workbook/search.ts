import type { WorkbookRow } from './sheet';

/**
 * Natural-language search over the rows of a workbook. Each row is one document, and each cell is written with its column
 * name and address, so a question can name a header ("sales"), a value ("1000") or a cell ("B7"). The keyword ranking is
 * BM25 over those words. When an embedder is given, its ranking is fused with the keyword one by reciprocal rank fusion.
 * Core does not run a model, so the caller supplies the embedder. Nothing here stores or sends a workbook.
 */

/** A row of a workbook, as the search reads it. */
export interface RowDocument {
  /** The file name, the sheet and the row, so a hit can be found again. */
  id: string;
  file: string;
  sheet: string;
  rowNumber: number;
  /** Every cell as "Header (B7): text", separated by semicolons. */
  text: string;
}

export interface SearchIndex {
  readonly documents: readonly RowDocument[];
  readonly terms: readonly (readonly string[])[];
  /** One unit vector per document, once embeddings have been added. */
  vectors?: readonly (readonly number[])[];
}

/** Turns texts into vectors. A role is "query" for a question and "document" for a row. */
export interface Embedder {
  embed(texts: string[], role: 'query' | 'document'): Promise<number[][]>;
}

export interface SearchHit {
  document: RowDocument;
  /** The fused score. Higher is better, and only its order means anything. */
  score: number;
}

/** A cell text that is a number, such as "120", "-3.5" or "1,000". */
const NUMBER = /^-?[\d.,]+$/;
/** Ranks lists by reciprocal rank fusion. The constant is the usual default. */
const FUSION_K = 60;
/** The dense ranking keeps this many rows before it is fused. A design value. */
const DENSE_DEPTH = 50;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** Words that carry no meaning for finding a row. Question words are included, since a question is what gets searched. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'this', 'that', 'are', 'was', 'were', 'will', 'has', 'have', 'had', 'not',
  'all', 'any', 'each', 'per', 'about', 'then', 'than', 'when', 'where', 'which', 'what', 'who', 'how', 'show', 'find',
  'list', 'give', 'get', 'many', 'much', 'row', 'rows', 'column', 'columns', 'cell', 'cells', 'sheet', 'sheets', 'there',
  'is', 'of', 'to', 'in', 'on', 'at', 'by', 'it', 'me', 'my', 'please', 'do', 'does', 'did',
]);

/**
 * Builds an index over the rows of one workbook. When `firstRowIsHeader` is true, the first row of each sheet names the
 * columns, so a cell reads as "Sales (C7): 120". When it is false, a cell reads with its address alone. When it is not
 * given, the first row counts as headers unless one of its cells is a number, since a row of numbers is data.
 */
export function buildIndex(file: string, rows: readonly WorkbookRow[], options: { firstRowIsHeader?: boolean } = {}): SearchIndex {
  const headers = new Map<string, Map<string, string>>();
  const firstRow = new Map<string, number>();
  for (const row of rows) firstRow.set(row.sheet, Math.min(firstRow.get(row.sheet) ?? Infinity, row.rowNumber));
  for (const row of rows) {
    if (row.rowNumber !== firstRow.get(row.sheet) || headers.has(row.sheet)) continue;
    const isHeader = options.firstRowIsHeader ?? !row.cells.some(cell => NUMBER.test(cell.text.trim()));
    if (isHeader) headers.set(row.sheet, new Map(row.cells.map(cell => [columnOf(cell.address), cell.text])));
  }
  const documents: RowDocument[] = rows.map(row => {
    const names = headers.get(row.sheet);
    const cells = row.cells.map(cell => {
      const header = names?.get(columnOf(cell.address));
      return header ? `${header} (${cell.address}): ${cell.text}` : `${cell.address}: ${cell.text}`;
    });
    return {
      id: `${file}!${row.sheet}!${row.rowNumber}`,
      file,
      sheet: row.sheet,
      rowNumber: row.rowNumber,
      text: `Sheet ${row.sheet}, row ${row.rowNumber}. ${cells.join('; ')}`,
    };
  });
  return { documents, terms: documents.map(document => termsOf(document.text)) };
}

/** Adds one vector per document, so a search can also rank by meaning. */
export async function addEmbeddings(index: SearchIndex, embedder: Embedder): Promise<SearchIndex> {
  if (index.documents.length === 0) return { ...index, vectors: [] };
  const vectors = await embedder.embed(
    index.documents.map(document => document.text),
    'document',
  );
  if (vectors.length !== index.documents.length) throw new Error('The embedder did not return one vector per row.');
  return { ...index, vectors: vectors.map(normalise) };
}

/**
 * The rows that best match a question, best first. Without an embedder the ranking is keyword only. With one, the keyword
 * ranking and the meaning ranking are fused, so a row can rank high by either.
 */
export async function searchRows(
  index: SearchIndex,
  question: string,
  options: { limit?: number; embedder?: Embedder } = {},
): Promise<SearchHit[]> {
  const limit = options.limit ?? 10;
  const keyword = keywordRanking(index, termsOf(question));
  const lists: number[][] = [keyword];
  if (options.embedder && index.vectors && index.vectors.length > 0) {
    const [query] = await options.embedder.embed([question], 'query');
    lists.push(denseRanking(index.vectors, normalise(query)));
  }

  const fused = new Map<number, number>();
  for (const list of lists) {
    list.forEach((position, rank) => fused.set(position, (fused.get(position) ?? 0) + 1 / (FUSION_K + rank + 1)));
  }
  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, limit)
    .map(([position, score]) => ({ document: index.documents[position], score }));
}

/** The documents that share a term with the question, best first. Documents that share none are left out. */
function keywordRanking(index: SearchIndex, questionTerms: readonly string[]): number[] {
  const count = index.documents.length;
  if (count === 0 || questionTerms.length === 0) return [];
  const df = new Map<string, number>();
  for (const terms of index.terms) for (const term of new Set(terms)) df.set(term, (df.get(term) ?? 0) + 1);
  const average = index.terms.reduce((sum, terms) => sum + terms.length, 0) / count;
  const scored: { position: number; score: number }[] = [];
  index.terms.forEach((terms, position) => {
    const frequency = new Map<string, number>();
    for (const term of terms) frequency.set(term, (frequency.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of new Set(questionTerms)) {
      const f = frequency.get(term);
      if (!f) continue;
      const idf = Math.log(1 + (count - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
      score += idf * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + (BM25_B * terms.length) / average)));
    }
    if (score > 0) scored.push({ position, score });
  });
  return scored.sort((a, b) => b.score - a.score || a.position - b.position).map(entry => entry.position);
}

function denseRanking(vectors: readonly (readonly number[])[], query: readonly number[]): number[] {
  return vectors
    .map((vector, position) => ({ position, score: dot(vector, query) }))
    .sort((a, b) => b.score - a.score || a.position - b.position)
    .slice(0, DENSE_DEPTH)
    .map(entry => entry.position);
}

/**
 * The words of a text: lower case, split on anything that is not a letter or digit, with a plural "s" dropped from longer
 * words (so "expenses" meets "expense") and stop-words removed. Words ending in "ss" are kept whole.
 */
export function termsOf(text: string): string[] {
  const terms = new Set<string>();
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!word || STOP_WORDS.has(word) || (word.length === 1 && !/\d/.test(word))) continue;
    const term = word.length > 4 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
    terms.add(term);
  }
  return [...terms];
}

/** The column part of a cell address: "B7" gives "B". */
function columnOf(address: string): string {
  return address.replace(/\d+$/, '');
}

function normalise(vector: readonly number[]): number[] {
  const length = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0)) || 1;
  return vector.map(x => x / length);
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a.reduce((sum, x, i) => sum + x * b[i], 0);
}
