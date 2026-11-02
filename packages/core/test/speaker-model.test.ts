import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOG } from '../src/models/catalog';
import { assertBundleSpec, bundleDirectory, bundleTotalBytes } from '../src/models/bundle-download';
import { SPEAKER_BUNDLE, SPEAKER_EMBEDDING_DIM, SPEAKER_MODEL_FILE, SPEAKER_MODEL_ID, speakerDirectory, speakerModelPath } from '../src/models/speaker';
import { WHISPER_MODEL_ID } from '../src/models/whisper';

/**
 * The speaker model's pins. The values were read from the Hugging Face API for Wespeaker/wespeaker-voxceleb-resnet34 at
 * commit ff1ac5bca8ef11e90662b879aa923979e0bd277b: the licence tag is license:apache-2.0, and the LFS record of
 * voxceleb_resnet34.onnx gives the SHA-256 and size below. The same digest was obtained from a download of that commit.
 * A change to the pin must change these expectations too, so a silent swap cannot pass.
 */
const PINNED = {
  id: 'speaker-wespeaker-resnet34',
  repo: 'Wespeaker/wespeaker-voxceleb-resnet34',
  revision: 'ff1ac5bca8ef11e90662b879aa923979e0bd277b',
  file: 'voxceleb_resnet34.onnx',
  bytes: 26534127,
  sha256: '9fea6516d7ad6bf0a76c7689f5a49b65d330fad6dde96c91bb4435ffbfe056a1',
};

describe('speaker model catalogue entry', () => {
  it('is pinned to the expected repository, commit, licence, file, size and digest', () => {
    expect(SPEAKER_MODEL_ID).toBe(PINNED.id);
    expect(SPEAKER_BUNDLE).toMatchObject({ id: PINNED.id, repo: PINNED.repo, revision: PINNED.revision, license: 'Apache-2.0' });
    expect(SPEAKER_BUNDLE.files).toEqual([{ path: PINNED.file, bytes: PINNED.bytes, sha256: PINNED.sha256 }]);
    expect(SPEAKER_MODEL_FILE).toBe(PINNED.file);
  });

  it('passes the bundle checks the downloader applies before any transfer', () => {
    expect(() => assertBundleSpec(SPEAKER_BUNDLE)).not.toThrow();
    expect(bundleTotalBytes(SPEAKER_BUNDLE)).toBe(PINNED.bytes);
  });

  it('has a revision that is a full commit, never a branch', () => {
    expect(SPEAKER_BUNDLE.revision).toMatch(/^[0-9a-f]{40}$/);
  });

  it('is installed in its own folder, apart from the speech model', () => {
    const models = '/models';
    expect(speakerDirectory(models)).toBe(bundleDirectory(models, SPEAKER_BUNDLE));
    // Built with join, as the code is, so the separator is the platform's (a backslash on Windows).
    expect(speakerModelPath(models)).toBe(join(speakerDirectory(models), PINNED.file));
    expect(SPEAKER_MODEL_ID).not.toBe(WHISPER_MODEL_ID);
    expect(CATALOG.some(model => model.id === SPEAKER_MODEL_ID)).toBe(false);
  });

  it('outputs embeddings of 256 values', () => {
    expect(SPEAKER_EMBEDDING_DIM).toBe(256);
  });
});
