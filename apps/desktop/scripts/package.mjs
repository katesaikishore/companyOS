import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * Runs electron-builder with the arguments it is given. Code signing stays off unless a certificate is configured
 * through CSC_LINK, CSC_NAME or WIN_CSC_LINK. Without this, electron-builder would sign with any identity already in
 * the keychain of this machine, and a local build should not be signed by accident.
 */
const SIGNING_VARIABLES = ['CSC_LINK', 'CSC_NAME', 'WIN_CSC_LINK'];

const env = { ...process.env };
const signingConfigured = SIGNING_VARIABLES.some(name => Boolean(env[name]));
if (!signingConfigured && env.CSC_IDENTITY_AUTO_DISCOVERY === undefined) env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';

const cli = createRequire(import.meta.url).resolve('electron-builder/out/cli/cli.js');
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
