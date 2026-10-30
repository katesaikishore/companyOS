import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Runs the privacy leak suite (plan 9.2) against the engine and the desktop modules as they are written. The desktop
 * modules import '@companyos/twin-core', so the alias points them at the engine source and no build is needed first.
 */
export default defineConfig({
  root,
  resolve: {
    alias: { '@companyos/twin-core': resolve(root, 'packages/core/src/index.ts') },
  },
  test: {
    include: ['tests/privacy/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
