// Runs the 50-task workbook test end to end: write a task sheet, read it back, allocate every task against the company
// brain, write the result sheet, and print how far the brain takes the work over and how often it agrees with the labels.
//
// Usage (after `npm run build -w @companyos/twin-core`):
//   node scripts/workbook-test/run.mjs [--out <folder>]
//
// The labels come from fixture.mjs, which was written by hand, so the agreement measures the matcher against those
// labels. It does not show how well the twin knows a real person. Use a real task sheet for that.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ROUTINES, TASKS } from './fixture.mjs';

const require = createRequire(import.meta.url);
const ExcelJS = require('exceljs');
const core = fileURLToPath(new URL('../../packages/core/dist/workbook/', import.meta.url));
const { readTaskSheet, writeResultSheet } = await import(`${core}sheet.js`);
const { allocateTasks, buildBrain, understanding } = await import(`${core}brain.js`);

const outIndex = process.argv.indexOf('--out');
const out = outIndex > -1 ? process.argv[outIndex + 1] : mkdtempSync(join(tmpdir(), 'companyos-workbook-'));
mkdirSync(out, { recursive: true });

// 1. Write the task sheet the way a person would have: a Task column and an Expected column.
const input = new ExcelJS.Workbook();
const inputSheet = input.addWorksheet('Tasks');
inputSheet.addRow(['Task', 'Expected']);
for (const [text, expected] of TASKS) inputSheet.addRow([text, expected]);
const inputPath = join(out, 'tasks-50.xlsx');
writeFileSync(inputPath, Buffer.from(await input.xlsx.writeBuffer()));

// 2. Read it back through the reader that the app will use.
const sheet = await readTaskSheet(readFileSync(inputPath));
const tasks = sheet.rows.map(row => ({ id: String(row.rowNumber), text: row.cells.Task }));
const expected = new Map(sheet.rows.map(row => [String(row.rowNumber), row.cells.Expected]));

// 3. Allocate every task against the brain.
const brain = buildBrain(ROUTINES);
const allocations = allocateTasks(tasks, brain);
const summary = understanding(allocations, expected);

// 4. Write the result sheet with the allocation columns added.
const columns = ['Routine', 'Confidence', 'Reason', 'Matches label'];
const outputs = allocations.map(allocation => {
  const wanted = expected.get(allocation.taskId);
  return {
    Routine: allocation.target,
    Confidence: allocation.confidence,
    Reason: allocation.reason,
    'Matches label': wanted === undefined ? '' : wanted === allocation.target ? 'yes' : 'no',
  };
});
const resultPath = join(out, 'tasks-50-result.xlsx');
writeFileSync(resultPath, await writeResultSheet(sheet, columns, outputs));

// 5. Report.
const percent = value => `${Math.round(value * 100)}%`;
console.log(`Tasks: ${summary.tasks}`);
console.log(`Given to a routine: ${summary.automated} (coverage ${percent(summary.coverage)})`);
console.log(`Mean confidence: ${summary.meanConfidence.toFixed(2)}`);
console.log(`Agreement with the labels: ${summary.agreement === undefined ? 'n/a' : percent(summary.agreement)} of ${summary.labelled}`);

const misses = allocations.filter(allocation => expected.get(allocation.taskId) !== allocation.target);
const wrongRoutine = misses.filter(a => a.target !== 'you' && expected.get(a.taskId) !== 'you');
const kept = misses.filter(a => a.target === 'you' && expected.get(a.taskId) !== 'you');
const overGiven = misses.filter(a => a.target !== 'you' && expected.get(a.taskId) === 'you');
console.log(`\nMisses: ${misses.length} (wrong routine ${wrongRoutine.length}, kept by you but a routine was expected ${kept.length}, given to a routine but kept by you ${overGiven.length})`);
for (const allocation of misses) {
  const row = sheet.rows.find(r => String(r.rowNumber) === allocation.taskId);
  console.log(`  row ${row.rowNumber}: "${row.cells.Task}" expected ${expected.get(allocation.taskId)}, got ${allocation.target} (confidence ${allocation.confidence})`);
}
console.log(`\nInput:  ${inputPath}`);
console.log(`Result: ${resultPath}`);
