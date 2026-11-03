import { describe, expect, it } from 'vitest';
import { buildGraph, compress, expand, extractEntities, graphScores, planQuery, rankFiles, shapeFit, type FileRecord } from '../src/files';
import type { CompletionRequest } from '../src/llm/types';

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
    const scores = graphScores(buildGraph(records), ['Priya']);
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

describe('ranking and planning', () => {
  it('keeps only what the plan allows, and puts the best tie first', () => {
    const records = [
      record('/Downloads/passport_photo.jpg', { kind: 'image', width: 413, height: 531, faces: [[0.2, 0.3, 0.55, 0.45]] }),
      record('/Downloads/beach.jpg', { kind: 'image', width: 1600, height: 900, faces: [] }),
      record('/Downloads/passport_scan.pdf', { kind: 'document' }),
    ];
    const hits = rankFiles({ kind: 'image', about: 'passport photo', names: [], shape: 'passport' }, records, undefined, buildGraph(records));
    expect(hits.map(hit => hit.record.name)).toEqual(['passport_photo.jpg']);
    expect(hits[0].why).toEqual(['one face, passport shape', 'name matches']);
  });

  it('reads a plan from the model, and falls back to the words themselves when the model fails', async () => {
    const model = { complete: async (_r: CompletionRequest) => ({ kind: 'image', about: 'passport photo', names: [], shape: 'passport', after: '', before: '' }) };
    expect(await planQuery('find me the passport size photo of mine', model)).toMatchObject({ kind: 'image', shape: 'passport' });
    // A shape on a document search, and a date the words never asked for, are dropped.
    const wrong = { complete: async (_r: CompletionRequest) => ({ kind: 'document', about: 'a resume', names: [], shape: 'portrait', after: '2026-11-03', before: '' }) };
    expect(await planQuery('my resume', wrong)).toEqual({ kind: 'document', about: 'a resume', names: [], shape: 'any', after: undefined, before: undefined });
    const timed = { complete: async (_r: CompletionRequest) => ({ kind: 'document', about: 'invoices', names: [], shape: 'landscape', after: '2026-10-01', before: '2026-10-31' }) };
    expect(await planQuery('invoices from last month', timed)).toMatchObject({ shape: 'any', after: new Date('2026-10-01T00:00:00').getTime() });
    const broken = { complete: async () => { throw new Error('down'); } };
    expect(await planQuery('my passport photo', broken)).toEqual({ kind: 'any', about: 'my passport photo', names: [], shape: 'passport' });
  });
});
