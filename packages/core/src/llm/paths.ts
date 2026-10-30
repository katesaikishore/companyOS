import { realpath } from 'node:fs/promises';
import { isAbsolute, sep } from 'node:path';

/**
 * Resolves a model path to the real file it names. Only a .gguf file inside the models folder is accepted. Symbolic
 * links and '..' are followed before the check, so a link inside the folder that points outside it is refused. Any
 * refusal throws, and the message names no path.
 */
export async function resolveModelPath(modelsDir: string, modelPath: string): Promise<string> {
  if (!isAbsolute(modelsDir) || !isAbsolute(modelPath)) throw new Error('The model is outside the models folder.');
  if (!modelPath.endsWith('.gguf')) throw new Error('The model must be a .gguf file.');

  const folder = await realpath(modelsDir);
  const file = await realpath(modelPath);
  if (!file.endsWith('.gguf')) throw new Error('The model must be a .gguf file.');
  if (!file.startsWith(folder + sep)) throw new Error('The model is outside the models folder.');
  return file;
}
