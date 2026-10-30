import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveModelPath } from '../src';

/** A models folder with one model inside it, one model outside it, and one file that is not a model. */
function layout() {
  const base = mkdtempSync(join(tmpdir(), 'twin-models-'));
  const modelsDir = join(base, 'models');
  mkdirSync(modelsDir);
  const inside = join(modelsDir, 'Qwen3-4B-Q4_K_M.gguf');
  const outside = join(base, 'elsewhere.gguf');
  writeFileSync(inside, 'model');
  writeFileSync(outside, 'model');
  return { modelsDir, inside, outside };
}

describe('resolveModelPath', () => {
  it('accepts a .gguf file inside the models folder and returns its real path', async () => {
    const { modelsDir, inside } = layout();
    await expect(resolveModelPath(modelsDir, inside)).resolves.toBe(realpathSync(inside));
  });

  it('refuses a .gguf file outside the models folder', async () => {
    const { modelsDir, outside } = layout();
    await expect(resolveModelPath(modelsDir, outside)).rejects.toThrow('The model is outside the models folder.');
  });

  it('refuses a file that is not a .gguf model, even inside the folder', async () => {
    const { modelsDir } = layout();
    const notes = join(modelsDir, 'notes.txt');
    writeFileSync(notes, 'not a model');
    await expect(resolveModelPath(modelsDir, notes)).rejects.toThrow('The model must be a .gguf file.');
  });

  it('refuses a symbolic link inside the folder that points outside it', async () => {
    const { modelsDir, outside } = layout();
    const link = join(modelsDir, 'link.gguf');
    symlinkSync(outside, link);
    await expect(resolveModelPath(modelsDir, link)).rejects.toThrow('The model is outside the models folder.');
  });

  it('refuses a path that climbs out of the folder with ".."', async () => {
    const { modelsDir } = layout();
    await expect(resolveModelPath(modelsDir, join(modelsDir, '..', 'elsewhere.gguf'))).rejects.toThrow(
      'The model is outside the models folder.',
    );
  });

  it('refuses a relative model path', async () => {
    const { modelsDir } = layout();
    await expect(resolveModelPath(modelsDir, 'Qwen3-4B-Q4_K_M.gguf')).rejects.toThrow(
      'The model is outside the models folder.',
    );
  });
});
