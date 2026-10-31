import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const desktop = new URL('../', import.meta.url);
const builderConfig = readFileSync(new URL('electron-builder.yml', desktop), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('package.json', desktop), 'utf8')) as { homepage?: string };

/** The characters GitHub keeps in a release asset name. Anything else, a space included, is rewritten on upload. */
const GITHUB_SAFE_NAME = /^[0-9A-Za-z._-]+$/;

describe('release packaging config', () => {
  it('names every installer and update file without spaces, so an update feed on GitHub Releases can find them', () => {
    const pattern = /^artifactName:\s*(\S+)\s*$/m.exec(builderConfig)?.[1];
    expect(pattern, 'a top-level artifactName in electron-builder.yml').toBeDefined();
    for (const [arch, ext] of [['arm64', 'dmg'], ['arm64', 'zip'], ['x64', 'exe'], ['amd64', 'deb'], ['x86_64', 'rpm']]) {
      const name = pattern!.replace('${version}', '0.1.0').replace('${arch}', arch).replace('${ext}', ext);
      expect(name, `the name for ${ext}`).toMatch(GITHUB_SAFE_NAME);
    }
    expect(pattern).toContain('${ext}');
    expect(pattern).toContain('${version}');
  });

  it('sets a project homepage, which electron-builder needs to build the .deb and .rpm', () => {
    expect(manifest.homepage).toMatch(/^https:\/\/\S+$/);
  });
});
