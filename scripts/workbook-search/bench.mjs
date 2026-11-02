// Natural-language search over real workbooks: for each SpreadsheetBench task, the instruction is the question, and the
// rows that the golden answer sits in are the right answers. The search gives a hit when one of its top k rows is one of
// them. This is a proxy: the instruction names what to change, not the row to search for, so it measures whether the
// search finds the region a real question is about.
//
// Usage (after `npm run build -w @companyos/twin-core`):
//   node scripts/workbook-search/bench.mjs --data <folder with dataset.json> [--dense --model <gguf>] [--limit <n>]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = name => args.indexOf(name);
const data = args[flag('--data') + 1];
if (!data) throw new Error('Pass --data <folder with dataset.json>.');
const useDense = flag('--dense') >= 0;
const limit = flag('--limit') >= 0 ? Number(args[flag('--limit') + 1]) : Infinity;
const core = fileURLToPath(new URL('../../packages/core/dist/workbook/', import.meta.url));
const { readWorkbookRows } = await import(`${core}sheet.js`);
const { buildIndex, searchRows, addEmbeddings } = await import(`${core}search.js`);

let embedder;
if (useDense) {
  const { createNomicEmbedder } = await import('./nomic-embedder.mjs');
  embedder = await createNomicEmbedder(args[flag('--model') + 1]);
}

/**
 * Bytes of external-link parts in a workbook. ExcelJS runs out of memory on some workbooks that carry many large external
 * links, so the benchmark sets those aside and counts them, rather than letting one file stop the run.
 */
function externalLinkBytes(file) {
  const listing = execFileSync('unzip', ['-l', file], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return listing
    .split('\n')
    .filter(line => line.includes('xl/externalLinks/'))
    .reduce((sum, line) => sum + Number(line.trim().split(/\s+/)[0] || 0), 0);
}

/** The rows an answer position covers, such as "B7", "C2:C13" or "A3:D32, F1". */
function rowsOf(position) {
  const rows = new Set();
  for (const part of String(position).split(',')) {
    const [start, end = start] = part.trim().split(':');
    const a = Number((start.match(/\d+/) ?? [0])[0]);
    const b = Number((end.match(/\d+/) ?? [0])[0]);
    for (let r = Math.min(a, b); r <= Math.max(a, b); r++) rows.add(r);
  }
  return rows;
}

const base = data;
const tasks = JSON.parse(readFileSync(join(base, 'dataset.json'), 'utf8')).slice(0, Number.isFinite(limit) ? limit : undefined);
const hits = { 1: 0, 5: 0, 10: 0 };
const byType = {};
let scored = 0;
let skipped = 0;
let unreadable = 0;
let heavy = 0;

for (const task of tasks) {
  const folder = join(base, task.spreadsheet_path);
  const init = existsSync(folder) ? readdirSync(folder).find(name => name.endsWith('_init.xlsx')) : undefined;
  if (!init) { skipped++; continue; }
  const file = join(folder, init);
  if (externalLinkBytes(file) > 500_000) { heavy++; skipped++; continue; }
  let rows;
  try {
    rows = await readWorkbookRows(readFileSync(file));
  } catch {
    // ExcelJS throws on some real files, such as a table with no name. Those are counted, not hidden.
    unreadable++;
    skipped++;
    continue;
  }
  if (rows.length === 0) { skipped++; continue; }
  const sheetName = task.answer_sheet ?? rows[0].sheet;
  const wanted = rowsOf(task.answer_position);
  const gold = new Set(rows.filter(row => row.sheet === sheetName && wanted.has(row.rowNumber)).map(row => `${init}!${row.sheet}!${row.rowNumber}`));
  if (gold.size === 0) { skipped++; continue; }

  let index = buildIndex(init, rows, { firstRowIsHeader: true });
  if (embedder) index = await addEmbeddings(index, embedder);
  const found = await searchRows(index, task.instruction, { limit: 10, embedder });
  scored++;
  const type = task.instruction_type;
  byType[type] ??= { scored: 0, hit5: 0 };
  byType[type].scored++;
  for (const k of [1, 5, 10]) {
    if (found.slice(0, k).some(hit => gold.has(hit.document.id))) hits[k]++;
  }
  if (found.slice(0, 5).some(hit => gold.has(hit.document.id))) byType[type].hit5++;
}

const pct = n => (scored === 0 ? 'n/a' : `${((100 * n) / scored).toFixed(1)}%`);
console.log(JSON.stringify({
  mode: embedder ? 'hybrid (nomic + keyword)' : 'keyword (BM25)',
  tasks: tasks.length,
  scored,
  skipped,
  unreadable_by_exceljs: unreadable,
  skipped_for_large_external_links: heavy,
  recall_at_1: pct(hits[1]),
  recall_at_5: pct(hits[5]),
  recall_at_10: pct(hits[10]),
  by_type_recall_at_5: Object.fromEntries(Object.entries(byType).map(([type, v]) => [type, `${((100 * v.hit5) / v.scored).toFixed(1)}% of ${v.scored}`])),
}, null, 2));
