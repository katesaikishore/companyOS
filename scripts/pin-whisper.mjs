// Pins the Whisper speech bundle. Downloads each file once from one Hugging Face commit, hashes it in memory, and prints the
// manifest as JSON on stdout. Paste the output into WHISPER_BUNDLE in packages/core/src/models/whisper.ts. Nothing is
// written to disk, and every file must come from huggingface.co or a hf.co CDN host.
//
// Usage: node scripts/pin-whisper.mjs [commit]
//   commit: a full 40-hex commit to pin. Omit it to pin the repository's current main commit.
// Exit status 1 on any failure.

import { createHash } from 'node:crypto';

const REPO = 'onnx-community/whisper-tiny.en';
const LICENSE = 'Apache-2.0';
const FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];
const HOSTS = ['huggingface.co', '.hf.co'];
const COMMIT = /^[0-9a-f]{40}$/;

function hostAllowed(host) {
  return HOSTS.some(entry => (entry.startsWith('.') ? host.endsWith(entry) : host === entry));
}

async function resolveCommit(argument) {
  if (argument !== undefined) {
    if (!COMMIT.test(argument)) throw new Error('The commit must be a full 40-character hash.');
    return argument;
  }
  const response = await fetch(`https://huggingface.co/api/models/${REPO}`);
  if (!response.ok) throw new Error(`The repository lookup answered HTTP ${response.status}.`);
  const { sha } = await response.json();
  if (!COMMIT.test(sha ?? '')) throw new Error('The repository lookup did not return a commit.');
  return sha;
}

async function pinFile(commit, path) {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(`https://huggingface.co/${REPO}/resolve/${commit}/${encoded}`);
  if (!response.ok || !response.body) throw new Error(`${path} answered HTTP ${response.status}.`);
  if (!hostAllowed(new URL(response.url).hostname)) throw new Error(`${path} was served from a host that is not allowed.`);
  const declared = response.headers.get('content-length');
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  if (declared !== null && Number(declared) !== bytes) throw new Error(`${path} did not match its declared size.`);
  return { path, bytes, sha256: hash.digest('hex') };
}

const commit = await resolveCommit(process.argv[2]);
const files = [];
for (const path of FILES) {
  process.stderr.write(`pinning ${path}\n`);
  files.push(await pinFile(commit, path));
}
process.stdout.write(`${JSON.stringify({ id: 'whisper-tiny-en', repo: REPO, revision: commit, license: LICENSE, files }, null, 2)}\n`);
