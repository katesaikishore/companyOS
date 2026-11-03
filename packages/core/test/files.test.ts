import { describe, expect, it } from 'vitest';
import { FileSearchIndex, buildGraph, compress, expand, extractEntities, graphScores, parseQuery, shapeFit, type FileRecord } from '../src/files';

function record(path: string, extra: Partial<FileRecord> = {}): FileRecord {
  const name = path.split('/').pop() ?? path;
  return { path, name, folder: 'Downloads', kind: 'other', size: 1, mtime: Date.UTC(2026, 9, 1), text: '', entities: [], ...extra };
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
  it('finds names, organisations, emails and project folders', () => {
    const entities = extractEntities({ name: 'Acme_invoice_march.pdf', folder: 'Documents/Vendor Deals', text: 'Invoice for ACME from Priya Shah, priya@acme.com. Total 4,200.' });
    expect(entities).toEqual(expect.arrayContaining(['priya shah', 'priya@acme.com', 'acme', 'vendor deals']));
    expect(entities).not.toContain('invoice');
  });

  it('ties files to the names a question gives, and gives neighbours a smaller tie', () => {
    const records = [
      record('/a.pdf', { entities: ['priya shah', 'acme'] }),
      record('/b.pdf', { entities: ['acme', 'renewal'] }),
      record('/c.pdf', { entities: ['renewal'] }),
      record('/d.pdf', { entities: ['other'] }),
    ];
    const scores = graphScores(buildGraph(records), ['priya']);
    expect(scores.get('/a.pdf')).toBe(1);
    expect(scores.get('/b.pdf')).toBe(0.4);
    expect(scores.has('/d.pdf')).toBe(false);
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
    expect(parseQuery('find me the passport size photo of mine', NOW)).toEqual({ kind: 'image', about: 'passport', names: ['passport'], shape: 'passport' });
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
      record('/a.pdf', { kind: 'document', ...far, entities: ['priya shah'] }),
      record('/b.pdf', { kind: 'document', ...near }),
    ];
    const index = new FileSearchIndex(records);
    expect(index.search({ kind: 'document', about: 'x', names: ['zzz'], shape: 'any' }, [1, 0, 0])[0].record.path).toBe('/b.pdf');
    const byName = index.search({ kind: 'document', about: 'priya', names: ['priya'], shape: 'any' }, [0, 0, 1]);
    expect(byName[0].record.path).toBe('/a.pdf');
    expect(byName[0].why).toContain('names what you asked for');
  });

  it('ranks 8,000 files in milliseconds', () => {
    const records = Array.from({ length: 8000 }, (_, i) =>
      record(`/f${i}.jpg`, { kind: i % 3 ? 'document' : 'image', width: 413, height: 531, faces: [[0.2, 0.3, 0.55, 0.45]], text: 'lorem ipsum '.repeat(100), entities: ['acme', 'priya shah'], ...compress(Array.from({ length: 384 }, (_, j) => Math.sin(i + j))) }),
    );
    const index = new FileSearchIndex(records);
    const query = Array.from({ length: 384 }, (_, j) => Math.cos(j));
    index.search(parseQuery('passport photo'), query);
    const started = performance.now();
    for (let i = 0; i < 5; i++) {
      index.search(parseQuery('find me the passport size photo of mine'), query);
      index.search(parseQuery('acme invoices from priya'), query);
    }
    expect((performance.now() - started) / 10).toBeLessThan(50);
  });
});
