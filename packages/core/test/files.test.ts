import { describe, expect, it } from 'vitest';
import { extractFacts, identityOf } from '../src/file-knowledge';
import { FileSearchIndex, buildGraph, clipText, compress, embeddingText, expand, graphScores, parseQuery, shapeFit, type FileRecord } from '../src/files';

function record(path: string, extra: Partial<FileRecord> = {}): FileRecord {
  const name = path.split('/').pop() ?? path;
  return { path, name, folder: 'Downloads', kind: 'other', size: 1, mtime: Date.UTC(2026, 9, 1), text: '', facts: [], ...extra };
}

describe('compressed vectors', () => {
  it('keep the direction of a vector in a quarter of the space', () => {
    const vector = Array.from({ length: 384 }, (_, i) => Math.sin(i) / 3);
    const packed = compress(vector);
    expect(Buffer.from(packed.vector, 'base64')).toHaveLength(384);
    const back = expand(packed.vector, packed.scale);
    const dot = vector.reduce((sum, value, i) => sum + value * back[i], 0);
    const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0) * back.reduce((s, v) => s + v * v, 0));
    expect(dot / norm).toBeGreaterThan(0.999);
  });
});

describe('the knowledge graph', () => {
  const statement = record('/Desktop/OpTransactionHistory26-10-2026.pdf', {
    kind: 'document',
    facts: ['type:bank statement', 'org:icici bank', 'account:4321', 'period:2026-10'],
  });
  const receipts = Array.from({ length: 6 }, (_, i) =>
    record(`/Downloads/INDIAN BANK - PRINT RECEIPT ${i}.pdf`, { kind: 'document', facts: ['type:receipt', 'org:indian bank'] }),
  );
  const other = record('/Downloads/hdfc.pdf', { kind: 'document', facts: ['type:bank statement', 'org:hdfc bank'] });

  it('adds the ties of every word, weighing rare words most, so the file that covers the question wins', () => {
    const graph = buildGraph([statement, other, ...receipts]);
    const scores = graphScores(graph, [['icici'], ['bank'], ['statement']]);
    expect(scores.get(statement.path)?.score).toBeCloseTo(1);
    expect(scores.get(statement.path)?.facts).toEqual(['org:icici bank', 'type:bank statement']);
    // Another bank's statement covers "bank statement", and a receipt only "bank", which is in every file and weighs little.
    expect(scores.get(other.path)!.score).toBeLessThan(0.6);
    expect(scores.get(receipts[0].path)!.score).toBeLessThan(0.2);
  });

  it('ties a statement from a bank above one that only mentions it', () => {
    const hdfc = record('/hdfc.pdf', { facts: ['type:bank statement', 'org:hdfc bank'] });
    const icici = record('/icici.pdf', { facts: ['type:bank statement', 'org:icici bank', 'mention:hdfc bank'] });
    const scores = graphScores(buildGraph([hdfc, icici, ...receipts]), [['hdfc'], ['statement']]);
    expect(scores.get('/hdfc.pdf')!.score).toBeGreaterThan(scores.get('/icici.pdf')!.score);
  });

  it('reaches a fact by its other names, and a name in every file is nobody’s neighbour', () => {
    const own = 'person:kate sai kishore';
    const records = [
      record('/a.pdf', { facts: ['person:priya shah', 'org:acme', own] }),
      record('/b.pdf', { facts: ['person:priya shah', 'org:acme', own] }),
      record('/c.pdf', { facts: ['org:acme', own] }),
      record('/d.pdf', { facts: ['type:salary slip', own] }),
      ...Array.from({ length: 40 }, (_, i) => record(`/e${i}.pdf`, { facts: [own] })),
    ];
    const graph = buildGraph(records);
    expect(graphScores(graph, [['payslip']]).get('/d.pdf')?.score).toBe(1);
    expect(graph.near.get('person:priya shah')).toEqual(['org:acme']);
    expect(graph.near.get('org:acme')).toEqual(['person:priya shah']);
    expect(graph.near.has(own)).toBe(false);
    // A file that only names Acme is tied to "priya" through its neighbour, by less.
    expect(graphScores(graph, [['priya']]).get('/c.pdf')?.score).toBeCloseTo(0.4);
  });

  it('leads the embedding text with the card of the facts', () => {
    expect(embeddingText({ ...statement, text: '01/10/2026 UPI 450.00' })).toBe(
      'OpTransactionHistory26-10-2026.pdf | Downloads | bank statement, icici bank, account ending 4321, october 2026 | 01/10/2026 UPI 450.00',
    );
  });
});

describe('photo shapes', () => {
  const photo = (width: number, height: number, faces: number[][]) => record('/p.jpg', { kind: 'image', width, height, faces });
  it('takes one large face in a portrait or square frame as a passport photo', () => {
    expect(shapeFit(photo(413, 531, [[0.2, 0.3, 0.55, 0.45]]), 'passport')).toBe('one face, passport shape');
    expect(shapeFit(photo(600, 600, [[0.2, 0.3, 0.5, 0.5]]), 'passport')).toBe('one face, square');
  });
  it('refuses a group, a small face, a landscape frame and a document', () => {
    expect(shapeFit(photo(413, 531, [[0.2, 0.3, 0.5, 0.4], [0.6, 0.3, 0.3, 0.3]]), 'passport')).toBeUndefined();
    expect(shapeFit(photo(3024, 4032, [[0.4, 0.5, 0.1, 0.08]]), 'passport')).toBeUndefined();
    expect(shapeFit(photo(1600, 900, [[0.3, 0.3, 0.4, 0.5]]), 'passport')).toBeUndefined();
    expect(shapeFit(record('/x.pdf', { kind: 'document' }), 'passport')).toBeUndefined();
  });
});

describe('reading a query', () => {
  const NOW = new Date(2026, 10, 3, 22, 0).getTime();

  it('reads a passport photo request as a photo of passport shape', () => {
    expect(parseQuery('find me the passport size photo of mine', NOW)).toEqual({ kind: 'image', about: 'passport', names: ['passport'], shape: 'passport', mine: true });
    expect(parseQuery('my headshot', NOW)).toMatchObject({ kind: 'image', shape: 'passport' });
  });

  it('keeps passport and visa documents as documents', () => {
    expect(parseQuery('visa letter', NOW)).toMatchObject({ kind: 'document', shape: 'any', names: ['visa', 'letter'] });
    expect(parseQuery('passport scan pdf', NOW)).toMatchObject({ kind: 'document', shape: 'any', names: ['passport', 'scan'] });
  });

  it('reads documents, screenshots and any file, with no photo shape on a document', () => {
    expect(parseQuery('my resume', NOW)).toMatchObject({ kind: 'document', shape: 'any', about: 'resume' });
    expect(parseQuery('screenshot of the error', NOW)).toMatchObject({ kind: 'image', shape: 'screenshot', names: ['error'] });
    expect(parseQuery('acme renewal', NOW)).toMatchObject({ kind: 'any', shape: 'any', names: ['acme', 'renewal'] });
  });

  it('filters by a relative time, and only prefers a named month or year, which stays a word', () => {
    expect(parseQuery('invoices from last month', NOW)).toMatchObject({ kind: 'document', after: new Date(2026, 9, 1).getTime(), before: new Date(2026, 10, 1).getTime() - 1, names: ['invoices'] });
    expect(parseQuery('documents today', NOW)).toMatchObject({ kind: 'document', after: new Date(2026, 10, 3).getTime(), names: [] });
    const year = parseQuery('form 16 2023', NOW);
    expect(year).toMatchObject({ names: ['form', '16', '2023'], prefer: { after: new Date(2023, 0, 1).getTime() } });
    expect(year.after).toBeUndefined();
    expect(parseQuery('photos from march', NOW)).toMatchObject({ prefer: { after: new Date(2026, 2, 1).getTime() } });
    expect(parseQuery('photos from december', NOW)).toMatchObject({ prefer: { after: new Date(2025, 11, 1).getTime() } });
  });

  it('does not read "may" or a name such as June as a month outside a time phrase', () => {
    const may = parseQuery('documents that may mention acme', NOW);
    expect(may.prefer).toBeUndefined();
    expect(may.names).toEqual(['may', 'mention', 'acme']);
    const june = parseQuery('photos of june', NOW);
    expect(june.prefer).toBeUndefined();
    expect(june.names).toEqual(['june']);
  });
});

describe('the review’s regressions', () => {
  const NOW = new Date(2026, 10, 3, 22, 0).getTime();
  const today = new Date(2026, 10, 3, 9, 0).getTime();

  it('lists files for a query that is only a kind and a time, with no embedding at all', () => {
    const records = [record('/tax.pdf', { kind: 'document', mtime: today }), record('/old.pdf', { kind: 'document', mtime: Date.UTC(2025, 0, 1) })];
    expect(new FileSearchIndex(records).search(parseQuery('documents today', NOW), undefined).map(hit => hit.record.path)).toEqual(['/tax.pdf']);
  });

  it('finds a singular file name from a plural word, and a file named for a year saved later', () => {
    const records = [record('/Invoice_2024.pdf', { kind: 'document' }), record('/Form16_2023.pdf', { kind: 'document', mtime: Date.UTC(2024, 5, 1) })];
    const index = new FileSearchIndex(records);
    expect(index.search(parseQuery('invoices', NOW), undefined).map(hit => hit.record.name)).toEqual(['Invoice_2024.pdf']);
    expect(index.search(parseQuery('form16 2023', NOW), undefined)[0].record.name).toBe('Form16_2023.pdf');
  });
});

describe('the search index', () => {
  it('keeps only what the plan allows, and puts the best tie first', () => {
    const records = [
      record('/Downloads/passport_photo.jpg', { kind: 'image', width: 413, height: 531, faces: [[0.2, 0.3, 0.55, 0.45]] }),
      record('/Downloads/beach.jpg', { kind: 'image', width: 1600, height: 900, faces: [] }),
      record('/Downloads/passport_scan.pdf', { kind: 'document' }),
    ];
    const hits = new FileSearchIndex(records).search(parseQuery('my passport photo'), undefined);
    expect(hits.map(hit => hit.record.name)).toEqual(['passport_photo.jpg']);
    expect(hits[0].why).toEqual(['one face, passport shape', 'name matches']);
  });

  it('ranks by meaning with the query vector, and by the graph for a name', () => {
    const near = compress([1, 0, 0]);
    const far = compress([0, 1, 0]);
    const records = [
      record('/a.pdf', { kind: 'document', ...far, facts: ['person:priya shah'] }),
      record('/b.pdf', { kind: 'document', ...near }),
    ];
    const index = new FileSearchIndex(records);
    expect(index.search({ kind: 'document', about: 'x', names: ['zzz'], shape: 'any' }, [1, 0, 0])[0].record.path).toBe('/b.pdf');
    const byName = index.search({ kind: 'document', about: 'priya', names: ['priya'], shape: 'any' }, [0, 0, 1]);
    expect(byName[0].record.path).toBe('/a.pdf');
    expect(byName[0].why).toContain('priya shah');
  });

  it('finds a bank statement by what its text says, not its name, and says why', () => {
    const text = 'ICICI Bank Limited  Statement of Transactions in Savings Account Number: 000401234321 for the period 01/10/2026 - 26/10/2026  Opening Balance 12,000.00  Withdrawals Deposits';
    const statement = record('/Desktop/OpTransactionHistory26-10-2026.pdf', { kind: 'document', text, mtime: Date.UTC(2026, 9, 26) });
    statement.facts = extractFacts(statement);
    const records = [
      statement,
      record('/Downloads/account statement.pdf', { kind: 'document', facts: ['type:bank statement', 'org:hdfc bank'] }),
      ...Array.from({ length: 3 }, (_, i) => record(`/Downloads/INDIAN BANK - PRINT RECEIPT ${i}.pdf`, { kind: 'document', facts: ['type:receipt', 'org:indian bank'] })),
    ];
    const hits = new FileSearchIndex(records).search(parseQuery('find my icici bank statement'), undefined);
    expect(hits[0].record.name).toBe('OpTransactionHistory26-10-2026.pdf');
    expect(hits[0].why[0]).toBe('icici bank, bank statement');
    expect(hits[1].record.name).toBe('account statement.pdf');
  });

  it('prefers a statement whose text covers a named month, though it was saved the month after', () => {
    const march = record('/Downloads/stmt_a.pdf', { kind: 'document', facts: ['type:bank statement', 'period:2026-03'], mtime: new Date(2026, 3, 2).getTime() });
    const june = record('/Downloads/stmt_b.pdf', { kind: 'document', facts: ['type:bank statement', 'period:2026-06'], mtime: new Date(2026, 6, 1).getTime() });
    // Only the preference tells them apart: no word of the plan reaches a month.
    const prefer = { after: new Date(2026, 2, 1).getTime(), before: new Date(2026, 3, 1).getTime() - 1 };
    const hits = new FileSearchIndex([june, march]).search({ kind: 'document', about: 'bank statement', names: ['bank', 'statement'], shape: 'any', prefer }, undefined);
    expect(hits.map(hit => hit.record.name)).toEqual(['stmt_a.pdf', 'stmt_b.pdf']);
    expect(hits[0].why).toContain('from then');
  });

  it('keeps only the last four digits of long numbers in the text it stores', () => {
    expect(clipText('Aadhaar 1234 5678 9012, A/c 000401234321, card 4375-1234-5678-9012, phone 9876543210, total 12,000.00')).toBe(
      'Aadhaar XXXX9012, A/c XXXX4321, card XXXX9012, phone XXXX3210, total 12,000.00',
    );
  });

  it('puts the person’s own files first when the question says "my", and says so', () => {
    const kate = { fullName: 'Kate Saikishore', username: 'katesaikishore' };
    const records = [
      record('/Downloads/Resume_Aditya.pdf', { kind: 'document', facts: ['type:resume', 'person:aditya rao'], mtime: Date.UTC(2026, 7, 18) }),
      record('/Downloads/Kate_Sai_Kishore_Resume.pdf', { kind: 'document', facts: ['type:resume', 'person:kate sai kishore'], mtime: Date.UTC(2026, 6, 1) }),
    ];
    const index = new FileSearchIndex(records, identityOf(kate));
    expect(index.me).toBe('Kate Saikishore');
    expect(index.search(parseQuery('resume'), undefined)[0].record.name).toBe('Resume_Aditya.pdf');
    const mine = index.search(parseQuery('my resume'), undefined);
    expect(mine[0].record.name).toBe('Kate_Sai_Kishore_Resume.pdf');
    expect(mine[0].why[0]).toBe('yours');
  });

  it('ranks 8,000 files in milliseconds', () => {
    const records = Array.from({ length: 8000 }, (_, i) =>
      record(`/f${i}.jpg`, { kind: i % 3 ? 'document' : 'image', width: 413, height: 531, faces: [[0.2, 0.3, 0.55, 0.45]], text: 'lorem ipsum '.repeat(100), facts: ['org:acme', 'person:priya shah', 'type:invoice'], ...compress(Array.from({ length: 384 }, (_, j) => Math.sin(i + j))) }),
    );
    const index = new FileSearchIndex(records);
    const query = Array.from({ length: 384 }, (_, j) => Math.cos(j));
    index.search(parseQuery('passport photo'), query);
    // The median of ten searches, so one slowed by other work on the machine does not decide it.
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      for (const question of ['find me the passport size photo of mine', 'acme invoices from priya']) {
        const started = performance.now();
        index.search(parseQuery(question), query);
        times.push(performance.now() - started);
      }
    }
    expect(times.sort((a, b) => a - b)[5]).toBeLessThan(50);
  });
});
