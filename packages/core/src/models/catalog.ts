import type { ModelSpec } from './types';

/**
 * Open-weight models the app may install. Every entry is Apache-2.0 or MIT, not gated, and its
 * SHA-256 was taken from the Hugging Face file index and checked against a real download.
 * Adding a model means adding a row here. Nothing else can be installed.
 */
export const CATALOG: readonly ModelSpec[] = [
  {
    id: 'qwen3-0.6b',
    name: 'Qwen3 0.6B',
    role: 'chat',
    params: '0.6B',
    quantization: 'Q8_0',
    license: 'Apache-2.0',
    repo: 'Qwen/Qwen3-0.6B-GGUF',
    file: 'Qwen3-0.6B-Q8_0.gguf',
    sizeBytes: 639446688,
    sha256: '9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031',
    summary: 'Smallest option. Simple labels on low-memory machines.',
  },
  {
    id: 'qwen3-1.7b',
    name: 'Qwen3 1.7B',
    role: 'chat',
    params: '1.7B',
    quantization: 'Q8_0',
    license: 'Apache-2.0',
    repo: 'Qwen/Qwen3-1.7B-GGUF',
    file: 'Qwen3-1.7B-Q8_0.gguf',
    sizeBytes: 1834426016,
    sha256: '061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a',
    summary: 'Light and quick. Good for labelling routines on 8 GB machines.',
  },
  {
    id: 'qwen3-4b',
    name: 'Qwen3 4B',
    role: 'chat',
    params: '4B',
    quantization: 'Q4_K_M',
    license: 'Apache-2.0',
    repo: 'Qwen/Qwen3-4B-GGUF',
    file: 'Qwen3-4B-Q4_K_M.gguf',
    sizeBytes: 2497280256,
    sha256: '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5',
    summary: 'Balanced default for most laptops. Writes drafts and step names well.',
  },
  {
    id: 'qwen3-8b',
    name: 'Qwen3 8B',
    role: 'chat',
    params: '8B',
    quantization: 'Q4_K_M',
    license: 'Apache-2.0',
    repo: 'Qwen/Qwen3-8B-GGUF',
    file: 'Qwen3-8B-Q4_K_M.gguf',
    sizeBytes: 5027783488,
    sha256: 'd98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785',
    summary: 'Stronger reasoning for repairs. Needs about 8 GB of free memory.',
  },
  {
    id: 'qwen3-14b',
    name: 'Qwen3 14B',
    role: 'chat',
    params: '14B',
    quantization: 'Q4_K_M',
    license: 'Apache-2.0',
    repo: 'Qwen/Qwen3-14B-GGUF',
    file: 'Qwen3-14B-Q4_K_M.gguf',
    sizeBytes: 9001752960,
    sha256: '500a8806e85ee9c83f3ae08420295592451379b4f8cf2d0f41c15dffeb6b81f0',
    summary: 'Highest quality on workstation-class machines.',
  },
  {
    id: 'nomic-embed-text-v1.5',
    name: 'Nomic Embed Text v1.5',
    role: 'embedding',
    params: '137M',
    quantization: 'Q8_0',
    license: 'Apache-2.0',
    repo: 'nomic-ai/nomic-embed-text-v1.5-GGUF',
    file: 'nomic-embed-text-v1.5.Q8_0.gguf',
    sizeBytes: 146146432,
    sha256: '3e24342164b3d94991ba9692fdc0dd08e3fd7362e0aacc396a9a5c54a544c3b7',
    summary: 'Finds similar routines and past runs. Always installed with a chat model.',
  },
];

export function findModel(id: string): ModelSpec | undefined {
  return CATALOG.find(model => model.id === id);
}
