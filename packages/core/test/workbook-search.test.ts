import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { readWorkbookRows } from '../src/workbook/sheet';
import { addEmbeddings, buildIndex, searchRows, termsOf, type Embedder } from '../src/workbook/search';

/** Builds an .xlsx in memory. Each sheet is a name and its rows of plain values. */
async function workbookOf(sheets: Record<string, (string | number | null)[][]>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const worksheet = workbook.addWorksheet(name);
    for (const row of rows) worksheet.addRow(row);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function indexOf(file: string, sheets: Record<string, (string | number | null)[][]>, firstRowIsHeader?: boolean) {
  return buildIndex(file, await readWorkbookRows(await workbookOf(sheets)), { firstRowIsHeader });
}

const SALES = {
  Q1: [
    ['Region', 'Sales', 'Expense'],
    ['North', 120, 'travel'],
    ['South', 900, 'hotel'],
    ['East', 45, 'meals'],
  ],
};

describe('readWorkbookRows', () => {
  it('reads every row of every sheet, with cell addresses', async () => {
    const rows = await readWorkbookRows(await workbookOf({
      Q1: [['Region', 'Sales'], ['North', 120]],
      Q2: [[null, null], ['West', 300]],
    }));
    expect(rows.map(row => [row.sheet, row.rowNumber])).toEqual([['Q1', 1], ['Q1', 2], ['Q2', 2]]);
    expect(rows[1].cells).toEqual([{ address: 'A2', text: 'North' }, { address: 'B2', text: '120' }]);
    expect(rows[2].cells).toEqual([{ address: 'A2', text: 'West' }, { address: 'B2', text: '300' }]);
  });
});

describe('buildIndex', () => {
  it('writes each cell with its column name and address, and gives each row its own id', async () => {
    const index = await indexOf('sales.xlsx', SALES);
    expect(index.documents).toHaveLength(4);
    expect(index.documents[1]).toEqual({
      id: 'sales.xlsx!Q1!2',
      file: 'sales.xlsx',
      sheet: 'Q1',
      rowNumber: 2,
      text: 'Sheet Q1, row 2. Region (A2): North; Sales (B2): 120; Expense (C2): travel',
    });
  });

  it('leaves out column names when the sheet has no header row', async () => {
    const index = await indexOf('sales.xlsx', SALES, false);
    expect(index.documents[1].text).toBe('Sheet Q1, row 2. A2: North; B2: 120; C2: travel');
  });
});

describe('searchRows', () => {
  it('finds the row by a column name and a value', async () => {
    const index = await indexOf('sales.xlsx', SALES);
    const hits = await searchRows(index, 'sales 900');
    expect(hits[0].document.rowNumber).toBe(3);
  });

  it('finds the row by a cell address', async () => {
    const index = await indexOf('sales.xlsx', SALES);
    expect((await searchRows(index, 'what is in B4'))[0].document.rowNumber).toBe(4);
  });

  it('ignores question words, so a question reads as its subject', async () => {
    const index = await indexOf('sales.xlsx', SALES);
    expect((await searchRows(index, 'which rows show the North expense?'))[0].document.rowNumber).toBe(2);
  });

  it('matches a plural in the question with the singular in the sheet', async () => {
    const index = await indexOf('sales.xlsx', { Q1: [['Expense'], ['travel']], Q2: [['Expense'], ['hotel']] });
    expect(termsOf('expenses')).toEqual(['expense']);
    const hits = await searchRows(index, 'show the expenses');
    expect([...new Set(hits.map(hit => hit.document.sheet))]).toEqual(['Q1', 'Q2']);
  });

  it('keeps each sheet apart, so the same row number in two sheets is two rows', async () => {
    const index = await indexOf('book.xlsx', { Q1: [['Region'], ['North']], Q2: [['Region'], ['North']] });
    const hits = await searchRows(index, 'north');
    expect(hits.map(hit => hit.document.id)).toEqual(['book.xlsx!Q1!2', 'book.xlsx!Q2!2']);
  });

  it('returns nothing when no row shares a word with the question', async () => {
    const index = await indexOf('sales.xlsx', SALES);
    expect(await searchRows(index, 'gross margin forecast')).toEqual([]);
  });

  it('returns nothing from an empty workbook index', async () => {
    const index = buildIndex('empty.xlsx', []);
    expect(await searchRows(index, 'anything')).toEqual([]);
  });

  it('caps the results at the limit', async () => {
    const index = await indexOf('book.xlsx', { Q1: [['Region'], ['North'], ['North'], ['North']] });
    expect(await searchRows(index, 'north', { limit: 2 })).toHaveLength(2);
  });
});

describe('headers and errors', () => {
  it('treats a first row of numbers as data, not as headers', async () => {
    const index = await indexOf('nums.xlsx', { Sheet1: [[1, 'one'], [2, 'two']] });
    expect(index.documents[0].text).toBe('Sheet Sheet1, row 1. A1: 1; B1: one');
  });

  it('reads an error cell as its text, so a question about #REF! finds it', async () => {
    const index = await indexOf('fix.xlsx', { Sheet1: [['Key', 'Value'], ['a', { error: '#REF!' }]] });
    expect(index.documents[1].text).toContain('Value (B2): #REF!');
    expect((await searchRows(index, 'where is the #REF! error?'))[0].document.rowNumber).toBe(2);
  });
});

describe('embeddings', () => {
  /** An embedder whose vectors are given by a lookup, so a test can say exactly what the meaning ranking sees. */
  function fakeEmbedder(vectorOf: (text: string) => number[]): Embedder {
    return {
      embed: async texts => texts.map(vectorOf),
    };
  }

  it('finds a row by meaning when no word in the question appears in it', async () => {
    const index = await indexOf('sales.xlsx', SALES);
    const embedder = fakeEmbedder(text => (text.includes('South') ? [1, 0] : [0, 1]));
    const withVectors = await addEmbeddings(index, embedder);
    expect(await searchRows(index, 'south', { embedder })).toHaveLength(1);
    const hits = await searchRows(withVectors, 'the lowest number', { embedder: fakeEmbedder(() => [1, 0]) });
    expect(hits[0].document.rowNumber).toBe(3);
    expect(await searchRows(withVectors, 'the lowest number')).toEqual([]);
  });

  it('refuses an embedder that does not return one vector per row', async () => {
    const index = await indexOf('sales.xlsx', SALES);
    const short: Embedder = { embed: async () => [[1, 0]] };
    await expect(addEmbeddings(index, short)).rejects.toThrow('The embedder did not return one vector per row.');
  });
});
