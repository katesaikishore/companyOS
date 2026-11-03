// Builds companyos-ocr, the screen-text helper that calls Apple's Vision framework (native/macos-ocr/main.swift), as one
// universal binary for Apple silicon and Intel Macs, into native-bin/. electron-builder copies it into the app's resources.
// Screen text is read on macOS only, so other systems skip this. A Mac without Swift (the Xcode command line tools) builds
// the app without screen text, unless COMPANYOS_RELEASE=1, where the helper is required.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'native', 'macos-ocr', 'main.swift');
const outDir = path.join(root, 'native-bin');
const output = path.join(outDir, 'companyos-ocr');

if (process.platform !== 'darwin') process.exit(0);
if (existsSync(output) && statSync(output).mtimeMs >= statSync(source).mtimeMs) process.exit(0);

try {
  execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'ignore' });
} catch {
  const message = 'build-ocr: Swift is not installed, so this build has no screen text. Install the Xcode command line tools.';
  if (process.env.COMPANYOS_RELEASE === '1') {
    console.error(message);
    process.exit(1);
  }
  console.warn(message);
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
const slices = [];
for (const arch of ['arm64', 'x86_64']) {
  const slice = path.join(outDir, `companyos-ocr-${arch}`);
  // xcrun sets up the macOS SDK, which swiftc called by its path does not find.
  execFileSync('xcrun', ['swiftc', '-O', '-target', `${arch}-apple-macos12`, source, '-o', slice], { stdio: 'inherit' });
  slices.push(slice);
}
execFileSync('lipo', ['-create', ...slices, '-output', output], { stdio: 'inherit' });
for (const slice of slices) rmSync(slice);
console.log(`build-ocr: ${path.relative(root, output)}`);
