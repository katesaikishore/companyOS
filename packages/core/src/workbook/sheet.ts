import ExcelJS from 'exceljs';

/** One row of the task sheet. Its cells are keyed by column name and hold text only. */
export interface TaskRow {
  /** The 1-based row of the original sheet, so a person can find the row again. */
  rowNumber: number;
  cells: Record<string, string>;
}

/** The first worksheet of a task workbook: its column names, and the rows that hold any text. */
export interface TaskSheet {
  headers: string[];
  rows: TaskRow[];
}

/** The column names that hold the task text, in lower case. A sheet can name its task column any of these ways. */
const TASK_COLUMN_NAMES = new Set(['task', 'task name', 'description', 'title']);

/**
 * Reads the first worksheet of an .xlsx file. Headers are the first non-empty row. Values are strings, trimmed. Blank rows
 * are dropped. A column with no header is named "Column N", and a repeated name gets " (2)" and so on, so no column's text
 * is lost when the cells are keyed by name. Throws when the sheet has no data rows or no task column. The errors never
 * include cell text, since the sheets hold private text.
 */
export async function readTaskSheet(data: Buffer): Promise<TaskSheet> {
  const workbook = new ExcelJS.Workbook();
  // exceljs declares its own input type, which this Node typings version does not line up with. The bytes are the same.
  await workbook.xlsx.load(data as unknown as Parameters<ExcelJS.Xlsx['load']>[0]);
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
  if (taskColumnOf(headers) === undefined) throw new Error('The sheet has no task column.');

  const rows = body.map(line => ({
    rowNumber: line.rowNumber,
    cells: Object.fromEntries(headers.map((name, index) => [name, line.texts[index] ?? ''])),
  }));
  return { headers, rows };
}

/**
 * Finds the column that holds the task text. Matches case-insensitively after trimming: 'task', 'task name', 'description'
 * or 'title'. When more than one column matches, the first from the left wins. Returns undefined when none match.
 */
export function taskColumnOf(headers: readonly string[]): string | undefined {
  return headers.find(header => TASK_COLUMN_NAMES.has(header.trim().toLowerCase()));
}

/**
 * Writes a new .xlsx that keeps the original headers and cells, then adds `columns` in order. A column already in the sheet
 * takes the new values in its own place, so running the tool twice does not duplicate it. outputs[i] gives the values for
 * sheet.rows[i], keyed by column name. Numbers stay numbers. Original cells are written back as the text that was read, so
 * their text is unchanged. Throws when there is not one output per row.
 */
export async function writeResultSheet(
  sheet: TaskSheet,
  columns: readonly string[],
  outputs: readonly Record<string, string | number>[],
): Promise<Buffer> {
  if (outputs.length !== sheet.rows.length) throw new Error('The results do not match the rows.');
  const added = [...new Set(columns)];
  const headers = [...sheet.headers, ...added.filter(name => !sheet.headers.includes(name))];

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Tasks');
  worksheet.addRow(headers);
  sheet.rows.forEach((row, index) => {
    // An empty original cell is written as an empty cell, not as an empty string, so the sheet looks as it did.
    worksheet.addRow(headers.map(name => (added.includes(name) ? outputs[index][name] ?? null : row.cells[name] || null)));
  });
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
