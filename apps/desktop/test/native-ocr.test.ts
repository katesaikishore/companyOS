import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnNativeOcr } from '../src/main/native-ocr';

const FAKE = join(__dirname, 'fixtures', 'fake-ocr.cjs');
const engine = (timeoutMs?: number) => spawnNativeOcr(process.execPath, { args: [FAKE], timeoutMs });
const FAILED = 'The frame could not be read.';

describe('spawnNativeOcr', () => {
  it('reads frames one after another through one helper, in order', async () => {
    const ocr = engine();
    const results = await Promise.all(['one', 'two', 'three'].map(label => ocr.recognise(Buffer.from(label))));
    expect(results).toEqual(['read one', 'read two', 'read three']);
  });

  it('rejects with a fixed sentence when the helper reports a failure or answers with something that is not JSON', async () => {
    const ocr = engine();
    await expect(ocr.recognise(Buffer.from('fail'))).rejects.toThrow(FAILED);
    await expect(ocr.recognise(Buffer.from('garbled'))).rejects.toThrow(FAILED);
    await expect(ocr.recognise(Buffer.from('after'))).resolves.toBe('read after');
  });

  it('fails a frame whose helper exits, and starts a fresh helper for the next one', async () => {
    const ocr = engine();
    await expect(ocr.recognise(Buffer.from('exit'))).rejects.toThrow(FAILED);
    await expect(ocr.recognise(Buffer.from('again'))).resolves.toBe('read again');
  });

  it('ends a helper that does not answer in time', async () => {
    const ocr = engine(300);
    await expect(ocr.recognise(Buffer.from('hang'))).rejects.toThrow(FAILED);
    await expect(ocr.recognise(Buffer.from('later'))).resolves.toBe('read later');
  });

  it('rejects at once when the helper is not in the build', async () => {
    await expect(spawnNativeOcr('/nowhere/companyos-ocr').recognise(Buffer.from('x'))).rejects.toThrow(FAILED);
  });
});
