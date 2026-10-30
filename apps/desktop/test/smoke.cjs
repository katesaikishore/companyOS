// End-to-end smoke test: launches the built app, checks that the page renders and that the
// preload bridge reaches the main process, then takes a screenshot.
//
// Needs a display (xvfb-run on headless Linux), the built app (npm run build), and Playwright.
//   NODE_PATH="$(npm root -g)" xvfb-run -a node test/smoke.cjs
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright');

(async () => {
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [path.join(__dirname, '..'), '--no-sandbox', '--password-store=basic'],
    // Headless Linux has no keyring. This test-only switch lets the app start with Electron's basic store.
    env: { ...process.env, COMPANYOS_TEST_BASIC_STORE: '1' },
    timeout: 60_000,
  });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));

    await page.waitForSelector('h1', { timeout: 30_000 });
    assert.equal(await page.textContent('h1'), 'companyOS Twin');

    const status = await page.evaluate(() => window.twin.status());
    assert.ok(status.config.excludedApps.includes('1password'), 'default exclusions are present');
    assert.equal(status.apiKeyConfigured, false, 'no API key by default');
    assert.equal(status.config.cloudEnabled, false, 'cloud escalation is off by default');
    assert.ok(Array.isArray(status.automations));

    await page.screenshot({ path: process.env.SMOKE_SCREENSHOT ?? path.join(__dirname, 'smoke.png'), fullPage: true });
    assert.deepEqual(errors, [], 'no page errors');
    console.log(`smoke ok: capture=${status.capture.state} (${status.capture.detail})`);
  } finally {
    await app.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
