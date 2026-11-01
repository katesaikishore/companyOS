import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveModelPath } from '../src';
import { tempFolders } from './temp-folders';

const temps = tempFolders();

/** A models folder with one model inside it, one model outside it, and one file that is not a model. */
function layout() {
  const base = temps.folder('twin-models-');
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
    // The check uses fs/promises realpath. On Windows the synchronous one can return a short 8.3 name for the same file.
    await expect(resolveModelPath(modelsDir, inside)).resolves.toBe(await realpath(inside));
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
    // A raw string on purpose. path.join would resolve '..' before the function ever sees it.
    const climbing = `${modelsDir}${sep}..${sep}elsewhere.gguf`;
    expect(climbing).toContain(`${sep}..${sep}`);
    await expect(resolveModelPath(modelsDir, climbing)).rejects.toThrow('The model is outside the models folder.');
  });

  it('names no path when the model file cannot be read', async () => {
    const { modelsDir } = layout();
    const missing = join(modelsDir, 'Missing-model.gguf');
    const error = await resolveModelPath(modelsDir, missing).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('The model could not be read.');
  });

  it('refuses a relative model path', async () => {
    const { modelsDir } = layout();
    await expect(resolveModelPath(modelsDir, 'Qwen3-4B-Q4_K_M.gguf')).rejects.toThrow(
      'The model is outside the models folder.',
    );
  });
});
