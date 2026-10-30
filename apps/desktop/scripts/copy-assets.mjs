import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'dist', 'renderer');
mkdirSync(target, { recursive: true });

for (const file of ['index.html', 'styles.css']) {
  copyFileSync(join(root, 'src', 'renderer', file), join(target, file));
}
