import ExcelJS from 'exceljs';

/** One row of a sheet. Its cells are keyed by column name and hold text only. */
export interface TaskRow {
  /** The 1-based row of the original sheet, so a person can find the row again. */
  rowNumber: number;
  cells: Record<string, string>;
}

/** The first worksheet of a workbook: where its column names are, and the rows that hold any text. */
export interface TaskSheet {
  /** The 1-based row that holds the column names. */
  headerRow: number;
  headers: string[];
  rows: TaskRow[];
}

/**
 * One change to a cell. A formula is written as a formula, with `result` as the value it shows until a spreadsheet
 * recalculates it. Otherwise `value` is written as a plain value. Every other cell of the workbook is left as it was.
 */
export interface CellEdit {
  /** An address such as "B7". The first worksheet is edited. */
  address: string;
  value?: string | number;
  /** The formula without its leading "=", for example "VLOOKUP(A7,$A$1:$B$5,2,FALSE)". */
  formula?: string;
  result?: string | number;
}

/** The column names that hold the task text, in lower case. A sheet can name its task column any of these ways. */
const TASK_COLUMN_NAMES = new Set(['task', 'task name', 'description', 'title']);

/**
 * Reads the first worksheet of an .xlsx file. The headers are the first non-empty row, and the rows are the non-empty
 * ones after it. Values are strings, trimmed. A formula gives its result. A column with no header is named "Column N", and
 * a repeated name gets " (2)" and so on, so no column's text is lost when the cells are keyed by name. Throws when the
 * sheet has no data rows. The error never includes cell text, since the sheets hold private text.
 */
export async function readSheet(data: Buffer): Promise<TaskSheet> {
  const workbook = await load(data);
  const lines: { rowNumber: number; texts: string[]; width: number }[] = [];
  workbook.worksheets[0]?.eachRow((row, rowNumber) => {
    const texts: string[] = [];
    row.eachCell((cell, column) => {
      texts[column - 1] = cellText(cell.value);
    });
    const width = texts.reduce((last, text, index) => (text ? index + 1 : last), 0);
    if (width > 0) lines.push({ rowNumber, texts, width });
  });

  const [first, ...body] = lines;
  if (!first || body.length === 0) throw new Error('The sheet has no rows.');
  const width = lines.reduce((max, line) => Math.max(max, line.width), 0);
  const headers = uniqueNames(Array.from({ length: width }, (_, index) => first.texts[index] || `Column ${index + 1}`));

  const rows = body.map(line => ({
    rowNumber: line.rowNumber,
    cells: Object.fromEntries(headers.map((name, index) => [name, line.texts[index] ?? ''])),
  }));
  return { headerRow: first.rowNumber, headers, rows };
}

/** Reads a sheet that has a column of task text, as the task list needs. Throws when there is no such column. */
export async function readTaskSheet(data: Buffer): Promise<TaskSheet> {
  const sheet = await readSheet(data);
  if (taskColumnOf(sheet.headers) === undefined) throw new Error('The sheet has no task column.');
  return sheet;
}

/**
 * Finds the column that holds the task text. Matches case-insensitively after trimming: 'task', 'task name', 'description'
 * or 'title'. When more than one column matches, the first from the left wins. Returns undefined when none match.
 */
export function taskColumnOf(headers: readonly string[]): string | undefined {
  return headers.find(header => TASK_COLUMN_NAMES.has(header.trim().toLowerCase()));
}

/**
 * Adds result columns to the original workbook and returns it. Every cell that is not in a result column is left as it
 * was, so formulas, formats and other sheets survive. A column that is already in the sheet takes the new values in its own
 * place, and a new one is added to the right of the last column, so running the tool twice does not duplicate it.
 * outputs[i] gives the values for sheet.rows[i], keyed by column name. Numbers stay numbers. Throws when there is not one
 * output per row.
 */
export async function writeResultSheet(
  data: Buffer,
  sheet: TaskSheet,
  columns: readonly string[],
  outputs: readonly Record<string, string | number>[],
): Promise<Buffer> {
  if (outputs.length !== sheet.rows.length) throw new Error('The results do not match the rows.');
  const workbook = await load(data);
  const worksheet = workbook.worksheets[0];
  const added = [...new Set(columns)];
  const newNames = added.filter(name => !sheet.headers.includes(name));
  const columnOf = (name: string): number => {
    const index = sheet.headers.indexOf(name);
    return index >= 0 ? index + 1 : sheet.headers.length + newNames.indexOf(name) + 1;
  };

  for (const name of newNames) worksheet.getCell(sheet.headerRow, columnOf(name)).value = name;
  sheet.rows.forEach((row, index) => {
    for (const name of added) worksheet.getCell(row.rowNumber, columnOf(name)).value = outputs[index][name] ?? null;
  });
  return save(workbook);
}

/**
 * Applies cell edits to the first worksheet of the original workbook and returns it. Nothing else changes. A formula is
 * written with its result, and a leading "=" is dropped.
 */
export async function writeCellEdits(data: Buffer, edits: readonly CellEdit[]): Promise<Buffer> {
  const workbook = await load(data);
  const worksheet = workbook.worksheets[0];
  for (const edit of edits) {
    const cell = worksheet.getCell(edit.address);
    cell.value =
      edit.formula === undefined
        ? edit.value ?? null
        : { formula: edit.formula.replace(/^=/, ''), result: edit.result };
  }
  return save(workbook);
}

async function load(data: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  // exceljs declares its own input type, which this Node typings version does not line up with. The bytes are the same.
  await workbook.xlsx.load(data as unknown as Parameters<ExcelJS.Xlsx['load']>[0]);
  return workbook;
}

async function save(workbook: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/**
 * The text a cell shows. A date becomes its calendar day as YYYY-MM-DD, and the time of day is dropped. ExcelJS builds a
 * date from local parts, so the day is read from local parts too; reading UTC would move some dates to the day before. A
 * formula gives its cached result. An error, or a value with no text, gives ''.
 */
function cellText(value: ExcelJS.CellValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : dayOf(value);
  if (typeof value !== 'object') return String(value).trim();
  if ('richText' in value) return value.richText.map(part => part.text).join('').trim();
  if ('formula' in value || 'sharedFormula' in value) return cellText(value.result);
  if ('hyperlink' in value) return cellText(value.text);
  return '';
}

function dayOf(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Makes each name distinct by adding " (2)", " (3)" and so on to a repeat, so two columns never share a key. */
function uniqueNames(names: string[]): string[] {
  const taken = new Set<string>();
  return names.map(name => {
    let unique = name;
    for (let n = 2; taken.has(unique); n++) unique = `${name} (${n})`;
    taken.add(unique);
    return unique;
  });
}
