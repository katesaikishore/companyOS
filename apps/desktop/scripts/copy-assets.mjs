import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'src', 'renderer');
const target = join(root, 'dist', 'renderer');

/** Copies the static parts of the renderer (pages, styles, fonts, licences). TypeScript output is written by tsc. */
const STATIC = new Set(['.html', '.css', '.woff2', '.woff', '.txt', '.svg', '.png']);

function walk(folder) {
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) {
      walk(path);
    } else if (STATIC.has(extname(name))) {
      const destination = join(target, relative(source, path));
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(path, destination);
    }
  }
}

mkdirSync(target, { recursive: true });
walk(source);

/** Plain CommonJS files in the main process that tsc does not compile (src/main/import-module.cjs). */
const mainSource = join(root, 'src', 'main');
const mainTarget = join(root, 'dist', 'main');
mkdirSync(mainTarget, { recursive: true });
for (const name of readdirSync(mainSource).filter(file => file.endsWith('.cjs'))) {
  copyFileSync(join(mainSource, name), join(mainTarget, name));
}
