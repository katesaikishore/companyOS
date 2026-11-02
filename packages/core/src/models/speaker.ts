import { join } from 'node:path';
import { bundleDirectory, type BundleSpec } from './bundle-download';

/**
 * The speaker model that turns a stretch of speech into a voice embedding, so segments can be told apart. It is the
 * Wespeaker ResNet34 trained on VoxCeleb, exported to ONNX, under the Apache-2.0 licence the Hugging Face API reports for
 * the repository. The pin is one commit, and the SHA-256 and size of its one file were checked against the repository's LFS
 * record and against a download. Change it only by repeating that check.
 *
 * A voice embedding is biometric data. It is computed on this device, kept only in the encrypted store once the person
 * names a speaker, and never leaves the device. See packages/core/src/speaker/match.ts.
 */
export const SPEAKER_MODEL_ID = 'speaker-wespeaker-resnet34';

/** The file inside the bundle folder that onnxruntime loads. */
export const SPEAKER_MODEL_FILE = 'voxceleb_resnet34.onnx';

/** Length of one voice embedding, as the model outputs it. */
export const SPEAKER_EMBEDDING_DIM = 256;

export const SPEAKER_BUNDLE: BundleSpec = {
  id: SPEAKER_MODEL_ID,
  repo: 'Wespeaker/wespeaker-voxceleb-resnet34',
  revision: 'ff1ac5bca8ef11e90662b879aa923979e0bd277b',
  license: 'Apache-2.0',
  files: [
    { path: SPEAKER_MODEL_FILE, bytes: 26534127, sha256: '9fea6516d7ad6bf0a76c7689f5a49b65d330fad6dde96c91bb4435ffbfe056a1' },
  ],
};

/** The folder the speaker model is installed in, under the models folder. */
export function speakerDirectory(modelsDir: string): string {
  return bundleDirectory(modelsDir, SPEAKER_BUNDLE);
}

/** The ONNX file inside the speaker bundle folder. */
export function speakerModelPath(modelsDir: string): string {
  return join(speakerDirectory(modelsDir), SPEAKER_MODEL_FILE);
}
