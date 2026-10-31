import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Runs electron-builder with the arguments it is given. Code signing stays off unless a certificate is configured
 * through CSC_LINK, CSC_NAME or WIN_CSC_LINK. Without this, electron-builder would sign with any identity already in
 * the keychain of this machine, and a local build should not be signed by accident.
 *
 * COMPANYOS_RELEASE=1 marks a release build. On macOS it needs a Developer ID Application certificate and an App Store
 * Connect key, and it stops before building without them. After the build it checks the app: the signature, the
 * hardened runtime, the notarisation ticket and Gatekeeper. It also notarises and staples each disk image. A failed check
 * fails the build, so macOS never gets a copy it would flag.
 */
const SIGNING_VARIABLES = ['CSC_LINK', 'CSC_NAME', 'WIN_CSC_LINK'];
const NOTARY_VARIABLES = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
const DESKTOP = fileURLToPath(new URL('..', import.meta.url));
const RELEASE_DIR = join(DESKTOP, 'release');

const env = { ...process.env };
const onMac = process.platform === 'darwin';
const release = env.COMPANYOS_RELEASE === '1';
const signingConfigured = SIGNING_VARIABLES.some(name => Boolean(env[name]));
if (!signingConfigured && env.CSC_IDENTITY_AUTO_DISCOVERY === undefined) env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';

if (release && onMac) {
  const missing = [];
  if (!env.CSC_LINK && !env.CSC_NAME) missing.push('CSC_LINK (a Developer ID Application certificate)');
  for (const name of NOTARY_VARIABLES) if (!env[name]) missing.push(name);
  if (missing.length > 0) fail(`a macOS release needs ${missing.join(', ')}. Nothing was built.`);
}

const cli = createRequire(import.meta.url).resolve('electron-builder/out/cli/cli.js');
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { env, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (onMac && (release || signingConfigured)) verifyMac();
process.exit(0);

function fail(message) {
  console.error(`[package] ${message}`);
  process.exit(1);
}

/** Runs one check and prints what it said. Returns true when the command exits with status 0. */
function check(description, command, args) {
  const outcome = spawnSync(command, args, { encoding: 'utf8' });
  const output = `${outcome.stdout ?? ''}${outcome.stderr ?? ''}`.trim();
  const passed = outcome.status === 0;
  console.log(`[package] ${description}: ${passed ? 'ok' : 'FAILED'}${output ? `\n${output}` : ''}`);
  return passed;
}

/** Every .app bundle under the release folder, at most two folders down (release/mac-arm64, for example). */
function appBundles(dir, depth = 2) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (!entry.isDirectory()) return [];
    const path = join(dir, entry.name);
    if (entry.name.endsWith('.app')) return [path];
    return depth > 1 ? appBundles(path, depth - 1) : [];
  });
}

/** Notarises a disk image with the App Store Connect key, staples the ticket to it, and checks Gatekeeper accepts it. */
function notariseImage(image) {
  const name = basename(image);
  const submitted = check(`notarising ${name}`, 'xcrun', [
    'notarytool', 'submit', image, '--key', env.APPLE_API_KEY, '--key-id', env.APPLE_API_KEY_ID, '--issuer', env.APPLE_API_ISSUER, '--wait',
  ]);
  return (
    submitted &&
    check(`stapling ${name}`, 'xcrun', ['stapler', 'staple', image]) &&
    check(`Gatekeeper on ${name}`, 'spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', image])
  );
}

function verifyMac() {
  const apps = appBundles(RELEASE_DIR);
  if (apps.length === 0) fail('no .app bundle was found in apps/desktop/release.');
  let passed = true;
  for (const app of apps) {
    const name = basename(app);
    const details = spawnSync('codesign', ['-dv', '--verbose=4', app], { encoding: 'utf8' });
    const text = `${details.stdout ?? ''}${details.stderr ?? ''}`;
    if (!release && /not signed at all/.test(text)) {
      console.log(`[package] ${name} is unsigned: no signing certificate is configured.`);
      continue;
    }
    passed = check(`code signature of ${name}`, 'codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]) && passed;
    if (!release) continue;
    const developerId = /Authority=Developer ID Application:/.test(text);
    const hardened = /flags=0x[0-9a-f]+\(runtime\)/.test(text);
    console.log(`[package] ${name}: Developer ID signature ${developerId ? 'yes' : 'NO'}, hardened runtime ${hardened ? 'yes' : 'NO'}.`);
    passed = developerId && hardened && passed;
    passed = check(`notarisation ticket of ${name}`, 'xcrun', ['stapler', 'validate', app]) && passed;
    passed = check(`Gatekeeper on ${name}`, 'spctl', ['--assess', '--type', 'execute', '--verbose=4', app]) && passed;
  }
  if (release) {
    for (const file of readdirSync(RELEASE_DIR).filter(entry => entry.endsWith('.dmg'))) {
      passed = notariseImage(join(RELEASE_DIR, file)) && passed;
    }
  }
  if (!passed) fail('the macOS build did not pass its checks.');
}
