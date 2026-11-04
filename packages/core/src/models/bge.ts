import { bundleDirectory, type BundleSpec } from './bundle-download';

/**
 * The text embedding model behind file search, search questions, Discord recall and tasks from the screen: BAAI's
 * bge-base-en-v1.5, the middle size of the BGE family, with 8-bit quantised ONNX weights run through
 * @huggingface/transformers on this Mac. The pin is written by scripts/pin-bge.mjs. Change it only by running that script
 * again. The model and its ONNX conversion are MIT licensed.
 */
export const BGE_MODEL_ID = 'bge-base-en';

export const BGE_BUNDLE: BundleSpec = {
  id: BGE_MODEL_ID,
  repo: 'Xenova/bge-base-en-v1.5',
  revision: '4d6cd88e18e51a5e020c2c305726d76ada9c03cf',
  license: 'MIT',
  files: [
    { path: 'config.json', bytes: 717, sha256: 'd83c21fa7366994560727112ef0a31d8a2ec1c280c2a3e66326fdb877f64c91e' },
    { path: 'tokenizer.json', bytes: 711396, sha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66' },
    { path: 'tokenizer_config.json', bytes: 366, sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3' },
    { path: 'special_tokens_map.json', bytes: 125, sha256: 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3' },
    { path: 'onnx/model_quantized.onnx', bytes: 110083337, sha256: 'c9729cc84cbd0e9fecc759505d2be65916c9fe05222d7ea26c65fcb3382af38d' },
  ],
};

/** The length of a BGE base vector. */
export const BGE_DIMENSIONS = 768;

/** BGE v1.5 finds passages best when a short search question carries this instruction. Documents are embedded as they are. */
export const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

/** The folder the BGE files are installed in, under the models folder. */
export function bgeDirectory(modelsDir: string): string {
  return bundleDirectory(modelsDir, BGE_BUNDLE);
}
