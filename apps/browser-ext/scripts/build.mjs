// Builds the unpacked browser extension into apps/browser-ext/dist.
//
// The URL template logic is compiled from packages/core/src/url.ts, so the extension and the engine run the same
// code. The build also checks that the extension ID that Chrome derives from the manifest key matches the ID the
// desktop app writes into native messaging manifests. A mismatch would break the connection silently.

import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const extensionRoot = join(here, '..');
const repoRoot = join(extensionRoot, '..', '..');
const sourceDir = join(extensionRoot, 'src');
const outDir = join(extensionRoot, 'dist');

/** Chrome's extension ID: the first 16 bytes of the SHA-256 of the public key, written with the letters a to p. */
function extensionIdFromKey(key) {
  const digest = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...digest].map(digit => String.fromCharCode('a'.charCodeAt(0) + parseInt(digit, 16))).join('');
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const urlSource = readFileSync(join(repoRoot, 'packages', 'core', 'src', 'url.ts'), 'utf8');
const compiled = ts.transpileModule(urlSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  fileName: 'url.ts',
  reportDiagnostics: true,
});
if (compiled.diagnostics && compiled.diagnostics.length > 0) {
  throw new Error('packages/core/src/url.ts does not compile for the extension.');
}
writeFileSync(join(outDir, 'url.js'), compiled.outputText);
copyFileSync(join(sourceDir, 'background.js'), join(outDir, 'background.js'));
copyFileSync(join(sourceDir, 'manifest.json'), join(outDir, 'manifest.json'));

const manifest = JSON.parse(readFileSync(join(sourceDir, 'manifest.json'), 'utf8'));
const id = extensionIdFromKey(manifest.key);
const desktopSource = readFileSync(
  join(repoRoot, 'apps', 'desktop', 'src', 'main', 'native-host-install.ts'),
  'utf8',
);
const declared = /EXTENSION_ID = '([a-p]{32})'/.exec(desktopSource)?.[1];
if (declared !== id) {
  throw new Error(`EXTENSION_ID in native-host-install.ts is ${declared}, but the manifest key gives ${id}.`);
}

console.log(`Built the browser extension ${id} into ${outDir}`);
