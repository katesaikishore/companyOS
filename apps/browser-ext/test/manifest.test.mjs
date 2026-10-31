// Tests for the manifests the browser extension build generates, and for the browser name each build reports.
// Run with:
//   node --test apps/browser-ext/test/manifest.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  FIREFOX_DESCRIPTION_LIMIT,
  FIREFOX_GECKO_ID,
  FIREFOX_MIN_VERSION,
  chromeManifest,
  firefoxManifest,
} from '../scripts/manifests.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.join(here, '..');
const buildScript = path.join(extensionRoot, 'scripts', 'build.mjs');
const distDir = path.join(extensionRoot, 'dist');
const firefoxDir = path.join(distDir, 'firefox');
const source = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'src', 'manifest.json'), 'utf8'));

const clone = value => JSON.parse(JSON.stringify(value));

const UA = {
  firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
  chrome: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
};

test('the Chrome manifest is the source manifest, and it keeps the privacy and ID settings', () => {
  assert.deepEqual(chromeManifest(source), source);
  assert.equal(source.incognito, 'not_allowed');
  assert.equal(source.background.service_worker, 'background.js');
});

test('the Chrome manifest is refused when the key, the private-window rule or the service worker is missing', () => {
  const noKey = clone(source);
  delete noKey.key;
  assert.throws(() => chromeManifest(noKey), /key/);

  const openIncognito = { ...clone(source), incognito: 'spanning' };
  assert.throws(() => chromeManifest(openIncognito), /not_allowed/);

  const noWorker = { ...clone(source), background: { scripts: ['background.js'] } };
  assert.throws(() => chromeManifest(noWorker), /service worker/);
});

test('the Firefox manifest loads the background as a module script, not as a service worker', () => {
  const manifest = firefoxManifest(source);
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, undefined);
  assert.deepEqual(manifest.background, { scripts: ['background.js'], type: 'module' });
});

test('the Firefox manifest drops the Chrome-only keys and adds the gecko ID and minimum version', () => {
  const manifest = firefoxManifest(source);
  assert.equal(manifest.key, undefined, 'Firefox does not read "key"');
  assert.equal(manifest.incognito, undefined, 'Firefox does not read "incognito"');
  assert.deepEqual(manifest.browser_specific_settings, {
    gecko: { id: FIREFOX_GECKO_ID, strict_min_version: FIREFOX_MIN_VERSION },
  });
  assert.match(manifest.browser_specific_settings.gecko.id, /^\{[0-9a-f-]{36}\}$/);
});

test('the Firefox manifest keeps the name, version, description and permissions of the source', () => {
  const manifest = firefoxManifest(source);
  for (const field of ['name', 'version', 'description', 'permissions']) {
    assert.deepEqual(manifest[field], source[field], field);
  }
  assert.deepEqual(manifest.permissions, ['tabs', 'nativeMessaging']);
  assert.ok(manifest.description.length <= FIREFOX_DESCRIPTION_LIMIT);
});

test('generating the Firefox manifest does not change the source manifest', () => {
  const before = clone(source);
  firefoxManifest(source);
  assert.deepEqual(source, before);
});

test('the Firefox manifest refuses a bad gecko ID, a missing worker and an over-long description', () => {
  assert.throws(() => firefoxManifest(source, { geckoId: 'not an id' }), /not a valid Firefox add-on ID/);
  assert.doesNotThrow(() => firefoxManifest(source, { geckoId: 'twin-bridge@example.org' }));

  const noWorker = { ...clone(source), background: { scripts: ['background.js'] } };
  assert.throws(() => firefoxManifest(noWorker), /service worker/);

  const long = { ...clone(source), description: 'x'.repeat(FIREFOX_DESCRIPTION_LIMIT + 1) };
  assert.throws(() => firefoxManifest(long), /characters/);
});

test('the build writes the Chrome manifest and the generated Firefox manifest into their folders', () => {
  execFileSync(process.execPath, [buildScript], { stdio: 'pipe' });

  const chromeOut = JSON.parse(fs.readFileSync(path.join(distDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(chromeOut, source);

  const firefoxOut = JSON.parse(fs.readFileSync(path.join(firefoxDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(firefoxOut, firefoxManifest(source));
});

test('the Firefox folder has the same background script and URL template as the Chrome folder', () => {
  execFileSync(process.execPath, [buildScript], { stdio: 'pipe' });

  for (const file of ['background.js', 'url.js']) {
    const chromeBytes = fs.readFileSync(path.join(distDir, file));
    const firefoxBytes = fs.readFileSync(path.join(firefoxDir, file));
    assert.ok(chromeBytes.length > 0, `${file} is not empty`);
    assert.ok(chromeBytes.equals(firefoxBytes), `${file} matches in both folders`);
  }
  assert.deepEqual(fs.readdirSync(firefoxDir).sort(), ['background.js', 'manifest.json', 'url.js']);
});

/**
 * Stubs the parts of the chrome.* API that background.js uses, with callbacks only (no promises), and records the
 * native messages it sends. The window the stub reports is the one given, so a test can make it private or unfocused.
 */
function stubChrome(windowInfo = { incognito: false, type: 'normal', focused: true }) {
  const listeners = { activated: [], updated: [], focus: [] };
  const sent = [];
  const chromeStub = {
    tabs: {
      onActivated: { addListener: fn => listeners.activated.push(fn) },
      onUpdated: { addListener: fn => listeners.updated.push(fn) },
      get: (_tabId, callback) => callback({}),
      query: (_info, callback) => callback([]),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: { addListener: fn => listeners.focus.push(fn) },
      get: (_windowId, callback) => callback(windowInfo),
    },
    runtime: {
      lastError: undefined,
      sendNativeMessage: (host, message, callback) => {
        sent.push({ host, message });
        if (callback) callback();
      },
    },
  };
  return { chromeStub, listeners, sent };
}

/**
 * Loads a copy of the built background script with the given user agent, reports one active tab, and returns the
 * native messages it sent. The copy sits in its own folder with "type": "module", so each load starts fresh.
 */
async function reportedBy(folder, userAgent, windowInfo) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-bg-'));
  const savedChrome = globalThis.chrome;
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    fs.cpSync(folder, scratch, { recursive: true });
    fs.writeFileSync(path.join(scratch, 'package.json'), '{"type":"module"}\n');

    const { chromeStub, listeners, sent } = stubChrome(windowInfo);
    globalThis.chrome = chromeStub;
    Object.defineProperty(globalThis, 'navigator', { value: { userAgent }, configurable: true, writable: true });
    await import(pathToFileURL(path.join(scratch, 'background.js')).href);

    // The stub answers through callbacks, so the visit is sent before the update listener returns.
    const tab = { id: 1, windowId: 1, active: true, incognito: false, url: 'https://docs.example.com/doc/42?x=1' };
    listeners.updated[0](1, { url: tab.url }, tab);
    return sent;
  } finally {
    globalThis.chrome = savedChrome;
    if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
    else delete globalThis.navigator;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

test('the Firefox build reports visits as firefox, and never as chrome', async () => {
  execFileSync(process.execPath, [buildScript], { stdio: 'pipe' });

  const sent = await reportedBy(firefoxDir, UA.firefox);
  assert.deepEqual(sent, [
    {
      host: 'com.companyos.twin',
      message: { type: 'visit', browser: 'firefox', template: 'docs.example.com/doc/:id' },
    },
  ]);
});

test('the Chrome and Edge build still reports chrome and edge, and sends only the three fields', async () => {
  execFileSync(process.execPath, [buildScript], { stdio: 'pipe' });

  const chromeSent = await reportedBy(distDir, UA.chrome);
  assert.equal(chromeSent.length, 1);
  assert.equal(chromeSent[0].message.browser, 'chrome');
  assert.deepEqual(Object.keys(chromeSent[0].message).sort(), ['browser', 'template', 'type']);

  const edgeSent = await reportedBy(distDir, UA.edge);
  assert.equal(edgeSent[0].message.browser, 'edge');
});

test('the Firefox build sends nothing from a private window or a window that is not focused', async () => {
  execFileSync(process.execPath, [buildScript], { stdio: 'pipe' });

  assert.deepEqual(await reportedBy(firefoxDir, UA.firefox, { incognito: true, type: 'normal', focused: true }), []);
  assert.deepEqual(await reportedBy(firefoxDir, UA.firefox, { incognito: false, type: 'normal', focused: false }), []);
  assert.deepEqual(await reportedBy(firefoxDir, UA.firefox, { incognito: false, type: 'popup', focused: true }), []);
});
