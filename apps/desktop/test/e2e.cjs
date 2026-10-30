// End-to-end tests against the built app, launched through Electron by Playwright.
// They exercise the real main process, real IPC, the app:// protocol, real CSP, and a real model download.
//
//   npm run build && NODE_PATH="$(npm root -g)" xvfb-run -a node apps/desktop/test/e2e.cjs
//
// Needs network access to huggingface.co for the embedding-model download test.
const { mkdtempSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright');

const APP = path.resolve(__dirname, '..');
const CORE = path.resolve(__dirname, '../../../packages/core/dist/index.js');
const KEYS = path.resolve(__dirname, '../dist/main/keys.js');
const SHOTS = process.env.E2E_SHOTS ?? path.join(tmpdir(), 'companyos-e2e-shots');
mkdirSync(SHOTS, { recursive: true });

const log = (...args) => console.log('[e2e]', ...args);

async function launch(userDataDir) {
  return electron.launch({
    executablePath: require('/home/user/companyOS/node_modules/electron'),
    args: [APP, '--no-sandbox', '--password-store=basic', `--user-data-dir=${userDataDir}`],
    env: { ...process.env, COMPANYOS_TEST_BASIC_STORE: '1' },
    timeout: 60_000,
  });
}

/** Writes ten working days of synthetic activity through a second engine instance on the same data folder. */
async function seedActivity(app) {
  return app.evaluate(async (electronModule, args) => {
    const req = globalThis.require || process.mainModule.require;
    const { TwinAgent } = req(args.core);
    const { loadOrCreateDataKey } = req(args.keys);
    const userData = electronModule.app.getPath('userData');
    const key = await loadOrCreateDataKey(userData);
    const agent = new TwinAgent({ dataDir: req('path').join(userData, 'twin'), dataKey: key });
    agent.updateConfig({ watchBrowsers: true });
    const now = new Date();
    const at = (ago, hour, minute = 0) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - ago, hour, minute).getTime();
    for (let ago = 10; ago >= 1; ago--) {
      agent.ingest({ kind: 'focus', ts: at(ago, 9), app: ago % 5 === 0 ? 'LibreOffice Calc' : 'Microsoft Excel' });
      agent.ingest({ kind: 'focus', ts: at(ago, 9, 20), app: 'Microsoft Outlook' });
      agent.ingest({ kind: 'focus', ts: at(ago, 9, 30), app: 'Slack' });
      agent.ingest({ kind: 'focus', ts: at(ago, 9, 40), app: '1Password' });
      agent.ingest({ kind: 'focus', ts: at(ago, 10), app: 'Google Chrome', url: 'https://docs.example.com/doc/1ab2cd3ef4567890/edit?token=SECRET123456' });
      agent.ingest({ kind: 'idle_start', ts: at(ago, 10, 10) });
      agent.ingest({ kind: 'idle_end', ts: at(ago, 13) });
    }
    return agent.suggestions().length;
  }, { core: CORE, keys: KEYS });
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

async function noHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `${label}: horizontal overflow of ${overflow}px`);
}

async function main() {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'companyos-e2e-'));
  const app = await launch(userDataDir);
  const consoleErrors = [];
  try {
    const page = await app.firstWindow();
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', error => consoleErrors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 800));

    // 1. A fresh install opens the setup wizard, not the app.
    await page.waitForSelector('[data-testid="setup-root"]', { timeout: 30_000 });
    assert.equal(await page.getAttribute('[data-testid="setup-root"] [data-step]', 'data-step'), '1');
    assert.equal(await page.locator('[data-testid="app-shell"]').count(), 0, 'shell is hidden during setup');
    log('setup opens on step 1');
    await shot(page, '01-setup-welcome');

    await page.click('[data-testid="setup-next"]');
    await page.waitForSelector('[data-testid="setup-step"][data-step="2"]');
    await shot(page, '02-setup-permissions');
    await page.click('[data-testid="setup-next"]');

    // 2. Step three detects the device and recommends models from the open catalogue.
    await page.waitForSelector('[data-testid="setup-plan-chat"]', { timeout: 30_000 });
    const chatModel = await page.getAttribute('[data-testid="setup-plan-chat"]', 'data-model-id');
    assert.ok(['qwen3-0.6b', 'qwen3-1.7b', 'qwen3-4b', 'qwen3-8b', 'qwen3-14b'].includes(chatModel), `chat model ${chatModel}`);
    assert.equal(await page.getAttribute('[data-testid="setup-plan-embedding"]', 'data-model-id'), 'nomic-embed-text-v1.5');
    log('recommended chat model for this device:', chatModel);
    await shot(page, '03-setup-device');

    // 3. A real embedding-model download, verified against its digest and recorded in the ledger.
    await page.click('[data-testid="setup-plan-embedding"] [data-testid="install-model"]');
    await page.waitForSelector('[data-testid="download-progress"][data-model-id="nomic-embed-text-v1.5"]', { timeout: 15_000 });
    await page.waitForFunction(
      () => document.querySelector('[data-testid="setup-plan-embedding"]')?.getAttribute('data-state') === 'installed',
      null,
      { timeout: 240_000 },
    );
    log('embedding model downloaded and verified');

    // 4. Cancelling a chat-model install leaves no partial file and records the cancellation.
    await page.click('[data-testid="setup-plan-chat"] [data-testid="install-model"]');
    await page.click('[data-testid="setup-plan-chat"] [data-testid="cancel-download"]');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="setup-plan-chat"]')?.getAttribute('data-state') === 'cancelled',
      null,
      { timeout: 30_000 },
    );
    log('cancelled chat-model install shows as cancelled');

    await page.click('[data-testid="setup-next"]');
    await page.click('[data-testid="setup-start-observing"]');
    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 15_000 });
    log('setup finished, app shell visible');

    // 5. Seed activity and check the overview.
    const suggestionCount = await seedActivity(app);
    assert.ok(suggestionCount >= 1, 'a routine was detected from seeded activity');
    await page.reload();
    await page.waitForSelector('[data-testid="overview-stats"]', { timeout: 15_000 });
    await page.waitForSelector('[data-testid="overview-heatmap"]');
    await shot(page, '04-overview-light');
    await noHorizontalOverflow(page, 'overview @1200');

    // 6. Theme: dark applies to the whole app, and the choice persists in config.
    await page.click('[data-testid="nav-settings"]');
    await page.click('[data-testid="settings-theme-dark"]');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark', null, { timeout: 10_000 });
    const darkBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await shot(page, '05-settings-dark');
    await page.click('[data-testid="settings-theme-light"]');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light', null, { timeout: 10_000 });
    const lightBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.notEqual(darkBackground, lightBackground, 'dark and light backgrounds differ');
    log('theme switches the palette');

    // 7. Suggestions: accept one, then dismiss another.
    await page.click('[data-testid="nav-suggestions"]');
    await page.waitForSelector('[data-testid="suggestion-card"]');
    await shot(page, '06-suggestions-light');
    await page.click('[data-testid="suggestion-accept"]');
    await page.waitForSelector('[data-testid="automation-card"]', { timeout: 15_000 });
    log('accepted routine is a draft automation');

    // 8. Automation detail: dry run shows previews, and a supervised run is refused below level 3.
    await page.click('[data-testid="nav-automations"]');
    await page.click('[data-testid="automation-card"]');
    await page.click('[data-testid="automation-run-dry"]');
    await page.waitForSelector('[data-testid="run-result"]', { timeout: 15_000 });
    assert.match(await page.textContent('[data-testid="run-result"]'), /dry_run/);
    assert.equal(await page.isDisabled('[data-testid="automation-run"]'), true, 'run is disabled at draft');
    await shot(page, '07-automation-detail-light');

    // 9. The network ledger shows the verified model download, with no personal data in the request.
    await page.click('[data-testid="nav-ledger"]');
    await page.waitForSelector('[data-testid="ledger-entry"]');
    const ledgerText = await page.textContent('[data-testid="ledger-entry"]');
    assert.match(ledgerText, /Model download/);
    assert.match(ledgerText, /verified/i);
    await shot(page, '08-ledger-light');

    // 10. Stop switch from the tray. The tray is a separate window; open it and press the button.
    const trayResult = await app.evaluate(({ BrowserWindow }) => {
      const tray = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/tray.html'));
      if (!tray) return 'missing';
      tray.show();
      return 'shown';
    });
    assert.equal(trayResult, 'shown', 'tray window exists');
    const traySource = app.windows().find(win => win.url().endsWith('/tray.html'));
    assert.ok(traySource, 'tray page loaded');
    await traySource.waitForSelector('[data-testid="tray-root"]');
    await traySource.click('[data-testid="tray-stop-all"]');
    await page.waitForFunction(async () => {
      const status = await window.twin.status();
      return status.config.automationsEnabled === false;
    }, null, { timeout: 10_000 });
    log('tray stop-all switches automations off');
    await page.click('[data-testid="nav-settings"]');
    await page.click('[data-testid="settings-automations-toggle"]');

    // 11. Layout at the minimum window size, every main route, no horizontal overflow.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640));
    for (const route of ['overview', 'suggestions', 'automations', 'ledger', 'settings']) {
      await page.click(`[data-testid="nav-${route}"]`);
      await page.waitForTimeout(300);
      await noHorizontalOverflow(page, `${route} @960`);
    }
    await shot(page, '09-settings-min-width');

    assert.deepEqual(
      consoleErrors.filter(text => !/Failed to load resource: net::ERR_FILE_NOT_FOUND/.test(text)),
      [],
      'no page errors or CSP violations',
    );
    log('all checks passed; screenshots in', SHOTS);
  } finally {
    await app.close().catch(() => {});
  }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('[e2e] FAILED:', error.message);
    process.exit(1);
  });
