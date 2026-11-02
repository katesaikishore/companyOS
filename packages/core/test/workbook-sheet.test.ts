import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { readSheet, readTaskSheet, taskColumnOf, writeCellEdits, writeResultSheet } from '../src/workbook/sheet';

/** Builds an .xlsx in memory from rows of plain values, the first row being the headers. */
async function workbookOf(rows: (string | number | Date | ExcelJS.CellValue | null)[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Sheet1');
  for (const row of rows) worksheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function readBack(buffer: Buffer): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook.worksheets[0];
}

describe('readSheet', () => {
  it('reads a sheet with no task column, which a real workbook usually has', async () => {
    const sheet = await readSheet(await workbookOf([
      ['Region', 'Sales'],
      ['North', 120],
    ]));
    expect(sheet.headers).toEqual(['Region', 'Sales']);
    expect(sheet.headerRow).toBe(1);
    expect(sheet.rows[0].cells).toEqual({ Region: 'North', Sales: '120' });
  });

  it('reports the row the headers are on', async () => {
    const sheet = await readSheet(await workbookOf([[null], ['Title', 'Status'], ['Pay the invoice', 'open']]));
    expect(sheet.headerRow).toBe(2);
  });

  it('reads a formula as its result', async () => {
    const sheet = await readSheet(await workbookOf([
      ['A', 'B'],
      [2, { formula: 'A2*2', result: 4 }],
    ]));
    expect(sheet.rows[0].cells.B).toBe('4');
  });

  it('refuses a sheet with no data rows', async () => {
    await expect(readSheet(await workbookOf([['Task', 'Owner']]))).rejects.toThrow('The sheet has no rows.');
  });
});

describe('readTaskSheet', () => {
  it('reads the headers and the rows of the first worksheet', async () => {
    const sheet = await readTaskSheet(await workbookOf([
      ['Task', 'Owner'],
      ['Send the weekly report', 'Ana'],
      ['Book the room', 'Ben'],
    ]));
    expect(sheet.headers).toEqual(['Task', 'Owner']);
    expect(sheet.rows).toEqual([
      { rowNumber: 2, cells: { Task: 'Send the weekly report', Owner: 'Ana' } },
      { rowNumber: 3, cells: { Task: 'Book the room', Owner: 'Ben' } },
    ]);
  });

  it('starts at the first non-empty row, and skips blank rows', async () => {
    const sheet = await readTaskSheet(await workbookOf([
      [null, null],
      ['Title', 'Status'],
      [null, null],
      ['Pay the invoice', 'open'],
    ]));
    expect(sheet.headers).toEqual(['Title', 'Status']);
    expect(sheet.rows.map(row => row.rowNumber)).toEqual([4]);
  });

  it('names a header-less column "Column N" and keeps repeated names apart', async () => {
    const sheet = await readTaskSheet(await workbookOf([
      ['Task', null, 'Task'],
      ['One', 'x', 'Two'],
    ]));
    expect(sheet.headers).toEqual(['Task', 'Column 2', 'Task (2)']);
    expect(sheet.rows[0].cells).toEqual({ Task: 'One', 'Column 2': 'x', 'Task (2)': 'Two' });
  });

  it('turns numbers into text and trims the text', async () => {
    const sheet = await readTaskSheet(await workbookOf([
      ['Task', 'Hours'],
      ['  Review the plan  ', 4],
    ]));
    expect(sheet.rows[0].cells).toEqual({ Task: 'Review the plan', Hours: '4' });
  });

  it('reads a date as its calendar day', async () => {
    const sheet = await readTaskSheet(await workbookOf([
      ['Task', 'Due'],
      ['File the return', new Date(2026, 10, 2, 17, 30)],
    ]));
    expect(sheet.rows[0].cells.Due).toBe('2026-11-02');
  });

  it('accepts each of the task column names, in any case and with spaces around it', async () => {
    for (const name of [' task ', 'TASK NAME', 'Description', 'title']) {
      const sheet = await readTaskSheet(await workbookOf([[name, 'Owner'], ['Do it', 'Ana']]));
      expect(taskColumnOf(sheet.headers)).toBe(name.trim());
    }
  });

  it('refuses a sheet with no task column, without echoing its cells', async () => {
    const buffer = await workbookOf([['Name', 'Owner'], ['secret client name', 'Ana']]);
    const error = await readTaskSheet(buffer).then(
      () => undefined,
      (caught: Error) => caught,
    );
    expect(error?.message).toBe('The sheet has no task column.');
  });

  it('refuses a sheet with no data rows', async () => {
    await expect(readTaskSheet(await workbookOf([['Task', 'Owner']]))).rejects.toThrow('The sheet has no rows.');
    await expect(readTaskSheet(await workbookOf([]))).rejects.toThrow('The sheet has no rows.');
  });
});

describe('taskColumnOf', () => {
  it('picks the first matching column from the left', () => {
    expect(taskColumnOf(['Owner', 'Description', 'Title'])).toBe('Description');
  });

  it('returns undefined when no column matches', () => {
    expect(taskColumnOf(['Owner', 'Due'])).toBeUndefined();
  });
});

describe('writeResultSheet', () => {
  it('keeps the original cells and appends the result columns', async () => {
    const original = await workbookOf([
      ['Task', 'Owner'],
      ['Send the report', 'Ana'],
      ['Decide the budget', null],
    ]);
    const sheet = await readTaskSheet(original);
    const buffer = await writeResultSheet(original, sheet, ['Routine', 'Confidence'], [
      { Routine: 'weekly-report', Confidence: 0.82 },
      { Routine: 'you', Confidence: 0 },
    ]);
    const worksheet = await readBack(buffer);
    expect(worksheet.getRow(1).values).toEqual([undefined, 'Task', 'Owner', 'Routine', 'Confidence']);
    // Cells are 1-based: Task, Owner, Routine, Confidence.
    expect(worksheet.getRow(2).getCell(1).value).toBe('Send the report');
    expect(worksheet.getRow(2).getCell(3).value).toBe('weekly-report');
    expect(worksheet.getRow(2).getCell(4).value).toBe(0.82);
    expect(worksheet.getRow(3).getCell(2).value).toBeNull();
    expect(worksheet.getRow(3).getCell(3).value).toBe('you');
  });

  it('replaces a result column that already exists, rather than duplicating it', async () => {
    const original = await workbookOf([
      ['Task', 'Routine'],
      ['Send the report', 'old'],
    ]);
    const sheet = await readTaskSheet(original);
    const buffer = await writeResultSheet(original, sheet, ['Routine'], [{ Routine: 'weekly-report' }]);
    const worksheet = await readBack(buffer);
    expect(worksheet.getRow(1).values).toEqual([undefined, 'Task', 'Routine']);
    expect(worksheet.getRow(2).getCell(2).value).toBe('weekly-report');
  });

  it('keeps formulas in the rest of the workbook', async () => {
    const original = await workbookOf([
      ['Task', 'Total'],
      ['Add the numbers', { formula: '1+1', result: 2 }],
    ]);
    const sheet = await readTaskSheet(original);
    const buffer = await writeResultSheet(original, sheet, ['Routine'], [{ Routine: 'you' }]);
    const cell = (await readBack(buffer)).getRow(2).getCell(2).value;
    expect(cell).toEqual({ formula: '1+1', result: 2 });
  });

  it('refuses one output per row', async () => {
    const original = await workbookOf([['Task'], ['One'], ['Two']]);
    const sheet = await readTaskSheet(original);
    await expect(writeResultSheet(original, sheet, ['Routine'], [{ Routine: 'you' }])).rejects.toThrow(
      'The results do not match the rows.',
    );
  });
});

describe('writeCellEdits', () => {
  it('writes a formula with its result and leaves the other cells alone', async () => {
    const original = await workbookOf([
      ['one', 'two'],
      ['bad', null],
    ]);
    const buffer = await writeCellEdits(original, [
      { address: 'B2', formula: 'VLOOKUP(A2,$A$1:$B$1,2,FALSE)', result: 'two' },
    ]);
    const worksheet = await readBack(buffer);
    expect(worksheet.getCell('B2').value).toEqual({ formula: 'VLOOKUP(A2,$A$1:$B$1,2,FALSE)', result: 'two' });
    expect(worksheet.getCell('A1').value).toBe('one');
    expect(worksheet.getCell('B1').value).toBe('two');
  });

  it('drops a leading "=" from a formula', async () => {
    const buffer = await writeCellEdits(await workbookOf([['x']]), [{ address: 'A2', formula: '=1+1', result: 2 }]);
    expect((await readBack(buffer)).getCell('A2').value).toEqual({ formula: '1+1', result: 2 });
  });

  it('writes a plain value', async () => {
    const buffer = await writeCellEdits(await workbookOf([['x']]), [{ address: 'A3', value: 'done' }]);
    expect((await readBack(buffer)).getCell('A3').value).toBe('done');
  });
});
