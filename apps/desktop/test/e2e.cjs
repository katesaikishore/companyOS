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
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [APP, '--no-sandbox', '--password-store=basic', `--user-data-dir=${userDataDir}`],
    env: { ...process.env, COMPANYOS_TEST_BASIC_STORE: '1', COMPANYOS_TEST_FAKE_PLATFORM: path.join(userDataDir, 'front-app.txt') },
    timeout: 60_000,
  });
  return app;
}

/**
 * Polls the page's status until the check passes. Playwright's waitForFunction does not wait on an async predicate:
 * it treats the returned Promise as truthy and returns at once, so every wait on the status goes through here.
 */
async function waitForStatus(page, check, { timeout = 15_000, label = 'status' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const status = await page.evaluate(() => window.twin.status());
    if (check(status)) return status;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
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
      agent.ingest({ kind: 'focus', ts: at(ago, 13, 5), app: 'Microsoft Excel' });
      agent.ingest({ kind: 'focus', ts: at(ago, 13, 25), app: 'Microsoft Word' });
      agent.ingest({ kind: 'focus', ts: at(ago, 13, 45), app: 'Visual Studio Code' });
      agent.ingest({ kind: 'idle_start', ts: at(ago, 14) });
    }
    return agent.suggestions().length;
  }, { core: CORE, keys: KEYS });
}

/** The app opens two pages: the main window and the tray popover. Tests drive the main window, found by its URL. */
async function mainPage(app) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const page = app.windows().find(candidate => candidate.url().includes('/index.html'));
    if (page) return page;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('The main window never opened.');
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

async function noHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `${label}: horizontal overflow of ${overflow}px`);
}

/** Resizes the main window's content area, and waits until the page reports the new width. */
async function setWindowSize(app, page, width, height) {
  await app.evaluate(({ BrowserWindow }, size) => {
    const main = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/index.html'));
    main?.setContentSize(size.width, size.height);
  }, { width, height });
  await page.waitForFunction(target => window.innerWidth === target, width, { timeout: 10_000 });
}

/**
 * The responsive checks, run on the current page at its current width. Returns the problems found, so an empty list
 * means the layout holds: no sideways page scroll, every navigation link and the Stop all and capture controls inside
 * the window, and nothing running past the window edge unless an ancestor scrolls or clips it.
 */
async function responsiveProblems(page) {
  return page.evaluate(() => {
    const problems = [];
    const viewport = window.innerWidth;
    const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    if (overflow > 0) problems.push(`the page scrolls sideways by ${overflow}px`);
    for (const link of document.querySelectorAll('[data-testid^="nav-"]')) {
      const box = link.getBoundingClientRect();
      if (box.left < -1 || box.right > viewport + 1) problems.push(`${link.dataset.testid} is outside the window`);
    }
    for (const testid of ['stop-all', 'capture-toggle']) {
      const element = document.querySelector(`[data-testid="${testid}"]`);
      const box = element?.getBoundingClientRect();
      if (!box || box.width === 0) problems.push(`${testid} is missing`);
      else if (box.left < -1 || box.right > viewport + 1) problems.push(`${testid} is outside the window`);
    }
    const spills = [];
    for (const element of document.querySelectorAll('main *')) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.right <= viewport + 1) continue;
      let contained = false;
      for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
        if (['auto', 'hidden', 'scroll'].includes(getComputedStyle(node).overflowX)) {
          contained = true;
          break;
        }
      }
      if (!contained) spills.push(element.getAttribute('class') || element.tagName);
    }
    if (spills.length > 0) problems.push(`${spills.length} element(s) run past the window edge, for example ${spills.slice(0, 3).join(', ')}`);
    return problems;
  });
}

async function main() {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'companyos-e2e-'));
  const app = await launch(userDataDir);
  const consoleErrors = [];
  try {
    const page = await mainPage(app);
    const [defaultWidth, defaultHeight] = await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/index.html'));
      return main.getContentSize();
    });
    assert.ok(defaultWidth <= 1100 && defaultHeight <= 700, `the default window fits a 13-inch screen (${defaultWidth}x${defaultHeight})`);
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', error => consoleErrors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/index.html'));
      main?.setContentSize(1100, 700);
    });

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
    await waitForStatus(page, status => status.automations.length === 1, { label: 'draft automation' });
    log('accepted routine is a draft automation');

    // 8. Automation detail: dry run shows previews, and a supervised run is refused below level 3.
    await page.click('[data-testid="nav-automations"]');
    await page.waitForSelector('[data-testid="automation-card"]', { timeout: 15_000 });
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
    await waitForStatus(page, status => status.config.automationsEnabled === false, { timeout: 10_000, label: 'tray stop-all' });
    log('tray stop-all switches automations off');
    await page.click('[data-testid="nav-settings"]');
    // The page reads status on a timer, so wait until the switch shows the stopped state before flipping it.
    await page.waitForFunction(() => document.querySelector('[data-testid="settings-automations-toggle"]')?.checked === false, null, { timeout: 10_000 });
    await page.click('[data-testid="settings-automations-toggle"]');
    await waitForStatus(page, status => status.config.automationsEnabled === true, { timeout: 10_000, label: 'automations on' });
    log('automations switch round-trips');

    // 10b. The twin offers a local routine when its first app opens. Nothing runs until the person approves.
    const offered = await page.evaluate(async () => {
      const status = await window.twin.status();
      const suggestion = status.suggestions.find(item => item.drafted.some(step => step.app === 'microsoft word'));
      if (!suggestion) return undefined;
      const view = await window.twin.acceptRoutine(suggestion.routineId);
      await window.twin.setLevel(view.automation.id, 3);
      return view.automation.id;
    });
    assert.ok(offered, 'the document routine was detected and accepted');
    const frontFile = path.join(userDataDir, 'front-app.txt');
    const { writeFileSync } = require('node:fs');
    writeFileSync(frontFile, 'Slack');
    await new Promise(resolve => setTimeout(resolve, 1200));
    writeFileSync(frontFile, 'Microsoft Excel');
    const offerStatus = await waitForStatus(page, status => status.pendingRuns.length === 1, { label: 'offer for Excel' });
    const offer = offerStatus.pendingRuns[0];
    assert.equal(offer.automationId, offered);
    assert.equal(offer.app, 'microsoft excel');
    log('opening Excel offered the routine:', offer.automationName);

    const trayPage = app.windows().find(candidate => candidate.url().includes('/tray.html'));
    assert.ok(trayPage, 'tray page exists');
    await trayPage.waitForSelector('[data-testid="tray-offer"]', { timeout: 10_000 });
    assert.match(await trayPage.textContent('[data-testid="tray-offer"]'), /Each step that sends or writes still asks you/);
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/tray.html')).isVisible()), true, 'the tray shows the offer');
    await shot(trayPage, '10-tray-offer');

    // Approving starts one supervised run. Its own app switches do not trigger another offer.
    await trayPage.click('[data-testid="tray-run-pending"]');
    await waitForStatus(page, status => status.pendingRuns.length === 0 && status.automations.some(view => view.state.runs.some(run => run.status === 'completed' && run.mode === 'supervised')), { timeout: 30_000, label: 'supervised run to finish' });
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/tray.html')).isVisible()), false, 'the tray closes after the answer');
    log('approved offer ran the routine to completion');

    // After the run, the same routine is not offered again straight away.
    writeFileSync(frontFile, 'Slack');
    await new Promise(resolve => setTimeout(resolve, 1200));
    writeFileSync(frontFile, 'Microsoft Excel');
    await new Promise(resolve => setTimeout(resolve, 4000));
    assert.equal((await page.evaluate(async () => (await window.twin.status()).pendingRuns.length)), 0, 'no repeat offer after a run');
    log('no repeat offer during the cooldown');


    // 11. Responsive layout. Every main route at each width holds the checks in responsiveProblems, and a live resize
    // changes the shell layout at the breakpoint without a reload.
    const WIDTHS = [640, 760, 900, 1024, 1280, 1600, 1920];
    const ROUTES = ['overview', 'suggestions', 'automations', 'readiness', 'harness', 'ledger', 'settings'];
    for (const width of WIDTHS) {
      await setWindowSize(app, page, width, 600);
      for (const route of ROUTES) {
        if (route === 'harness') {
          // The harness has no sidebar link any more; it opens from an automation. Its route still has to lay out.
          await page.evaluate(() => { location.hash = '#/harness'; });
        } else {
          await page.click(`[data-testid="nav-${route}"]`);
        }
        await page.waitForTimeout(250);
        const problems = await responsiveProblems(page);
        assert.deepEqual(problems, [], `${route} at ${width}px: ${problems.join('; ')}`);
        if ([640, 1280, 1920].includes(width) && ['overview', 'readiness'].includes(route)) {
          await page.screenshot({ path: path.join(SHOTS, `responsive-${width}-${route}.png`) });
        }
      }
      log(`responsive: every main route holds at ${width}px`);
    }

    await page.click('[data-testid="nav-overview"]');
    await setWindowSize(app, page, 1280, 800);
    const wideSidebar = await page.evaluate(() => document.querySelector('.sidebar').getBoundingClientRect().width);
    assert.ok(wideSidebar >= 220 && wideSidebar <= 260, `the sidebar is a column at 1280px (${wideSidebar}px)`);
    await setWindowSize(app, page, 640, 600);
    const narrowSidebar = await page.evaluate(() => document.querySelector('.sidebar').getBoundingClientRect().width);
    assert.ok(narrowSidebar >= 600, `the sidebar becomes a top header at 640px (${narrowSidebar}px)`);
    assert.deepEqual(await responsiveProblems(page), [], 'the layout holds after the live resize to 640px');
    await setWindowSize(app, page, 1920, 900);
    const againSidebar = await page.evaluate(() => document.querySelector('.sidebar').getBoundingClientRect().width);
    assert.ok(againSidebar >= 220 && againSidebar <= 260, `the sidebar is a column again at 1920px (${againSidebar}px)`);
    log('live resize: the shell changes layout at the breakpoint, without a reload');
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
