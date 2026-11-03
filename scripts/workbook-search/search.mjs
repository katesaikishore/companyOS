// Searches one workbook in plain language and prints the best rows. Keyword search always runs. With --dense and
// --model, the nomic embeddings are fused with it.
//
// Usage (after `npm run build -w @companyos/twin-core`):
//   node scripts/workbook-search/search.mjs <file.xlsx> "<question>" [--limit 5] [--dense --model <gguf>]
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flagValue = name => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
const file = args[0];
const useDense = args.includes('--dense');
const limit = Number(flagValue('--limit') ?? 5);
const skipValues = new Set([flagValue('--limit'), flagValue('--model')]);
const question = args.slice(1).filter(arg => !arg.startsWith('--') && !skipValues.has(arg)).join(' ').trim();
if (!file || !question) throw new Error('Usage: search.mjs <file.xlsx> "<question>"');

const core = fileURLToPath(new URL('../../packages/core/dist/workbook/', import.meta.url));
const { readWorkbookRows } = await import(`${core}sheet.js`);
const { buildIndex, addEmbeddings, searchRows } = await import(`${core}search.js`);

const rows = await readWorkbookRows(readFileSync(file));
let index = buildIndex(basename(file), rows);
let embedder;
if (useDense) {
  const { createNomicEmbedder } = await import('./nomic-embedder.mjs');
  embedder = await createNomicEmbedder(flagValue('--model'));
  index = await addEmbeddings(index, embedder);
}
const hits = await searchRows(index, question, { limit, embedder });
console.log(`${index.documents.length} rows searched, ${hits.length} shown for: ${question}`);
for (const hit of hits) {
  console.log(`\n${hit.score.toFixed(4)}  ${hit.document.sheet}, row ${hit.document.rowNumber}`);
  console.log(`  ${hit.document.text}`);
}
