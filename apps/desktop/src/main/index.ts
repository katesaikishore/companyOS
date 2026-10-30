import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  net,
  powerMonitor,
  protocol,
  screen,
  Notification,
  Tray,
  type MessageBoxOptions,
  type SaveDialogOptions,
} from 'electron';
import { writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AutonomyLevelSchema,
  TwinConfigSchema,
  describeStep,
  type Automation,
  type Decision,
  type PendingRunView,
  type Step,
} from '@companyos/twin-core';
import { APP_ORIGIN, IPC } from '../shared/ipc';
import { SecureStorageUnavailableError } from './keys';
import { buildOpenMausBotPrompt } from './openmausbot';
import { TwinRuntime } from './runtime';
import { startAutoUpdates } from './updater';

/** Pages are served from a private scheme. Module scripts need it, because Chromium blocks them on file://. */
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const RENDERER_DIR = join(__dirname, '..', 'renderer');
const BRAND_DIR = join(RENDERER_DIR, 'brand');
const STOP_ALL_SHORTCUT = 'Control+Alt+.';

let runtime: TwinRuntime | undefined;
let mainWindow: BrowserWindow | undefined;
let trayWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let paused = false;
let quitting = false;

// COMPANYOS_USER_DATA moves the twin's data folder. The performance harness uses it, so a measured run never touches a real install.
if (process.env.COMPANYOS_USER_DATA) app.setPath('userData', resolve(process.env.COMPANYOS_USER_DATA));
const userData = app.getPath('userData');

function requireRuntime(): TwinRuntime {
  if (!runtime) throw new Error('The twin is still starting.');
  return runtime;
}

/** The renderer is less trusted than the main process, so every value crossing IPC is checked. */
function text(value: unknown, pattern: RegExp, message: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(message);
  return value;
}

const automationId = (value: unknown) => text(value, /^auto_[a-f0-9]{12}$/, 'Invalid automation id.');
const routineId = (value: unknown) => text(value, /^[a-f0-9]{12}$/, 'Invalid routine id.');
const modelId = (value: unknown) => text(value, /^[a-z0-9.-]{1,80}$/, 'Invalid model id.');

function handle(channel: string, fn: (...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (_event, ...args) => fn(...args));
}

function parentWindow(): BrowserWindow | undefined {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
}

function showMainWindow(route?: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  mainWindow?.show();
  mainWindow?.focus();
  if (route) mainWindow?.webContents.send(IPC.navigate, route);
}

function stopAllAutomations(): void {
  requireRuntime().stopAllAutomations();
}

function registerIpc(): void {
  handle(IPC.status, () => requireRuntime().status());
  handle(IPC.hardware, () => requireRuntime().hardware());
  handle(IPC.setupPlan, () => requireRuntime().setupPlan());
  handle(IPC.installModel, id => requireRuntime().installModel(modelId(id)));
  handle(IPC.cancelDownload, id => requireRuntime().cancelDownload(modelId(id)));
  handle(IPC.removeModel, id => requireRuntime().removeModel(modelId(id)));
  handle(IPC.completeSetup, () => requireRuntime().completeSetup());

  handle(IPC.setPaused, value => {
    if (typeof value !== 'boolean') throw new Error('Invalid value.');
    paused = value;
    requireRuntime().setPaused(value);
    rebuildTrayMenu();
  });

  handle(IPC.updateConfig, patch => requireRuntime().updateConfig(TwinConfigSchema.partial().parse(patch)));
  handle(IPC.stopAllAutomations, () => stopAllAutomations());

  handle(IPC.acceptRoutine, (id, name) =>
    requireRuntime().acceptRoutine(routineId(id), typeof name === 'string' ? name.slice(0, 80) : undefined),
  );
  handle(IPC.dismissRoutine, id => requireRuntime().dismissRoutine(routineId(id)));
  handle(IPC.setLevel, (id, level) => requireRuntime().setLevel(automationId(id), AutonomyLevelSchema.parse(level)));
  handle(IPC.promote, id => requireRuntime().promote(automationId(id)));
  handle(IPC.dryRun, id => requireRuntime().dryRun(automationId(id)));
  handle(IPC.supervisedRun, id => requireRuntime().supervisedRun(automationId(id)));
  handle(IPC.revertLast, id => requireRuntime().revertLast(automationId(id)));
  handle(IPC.answerPendingRun, async (id, run) => {
    const offer = text(id, /^[0-9a-f-]{36}$/, 'Invalid request id.');
    if (typeof run !== 'boolean') throw new Error('Invalid answer.');
    await requireRuntime().answerPendingRun(offer, run);
    if (!requireRuntime().hasPendingOffers()) hideTray();
  });
  handle(IPC.delegateRoutine, async (id, brief) => {
    const automation = automationId(id);
    if (typeof brief !== 'string' || brief.length > 500 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(brief)) {
      throw new Error('Describe the task in 1–500 characters.');
    }
    const taskBrief = brief.trim();
    if (!taskBrief) throw new Error('Describe the task in 1–500 characters.');

    const status = requireRuntime().status();
    const selected = status.automations.find(view => view.automation.id === automation)?.automation;
    if (!selected) throw new Error('Unknown automation.');
    const target = status.config.openMausBotTarget.trim();
    if (!target || !/^[\p{L}\p{N}][\p{L}\p{N}_.@ -]*$/u.test(target)) {
      throw new Error('Set a valid OpenMausBot lead bot or room in Settings first.');
    }
    const prompt = buildOpenMausBotPrompt(selected, taskBrief);
    const confirmation: MessageBoxOptions = {
      type: 'warning',
      buttons: ['Send task', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Send this task to OpenMausBot (${target})?`,
      detail: `${prompt}\n\nOpenMausBot uses its own configured models, connected apps and account credentials. companyOS autonomy settings do not control its agents. The prompt does not include activity history, screenshots, window contents or companyOS credentials.`,
    };
    const parent = parentWindow();
    const confirmed = parent ? await dialog.showMessageBox(parent, confirmation) : await dialog.showMessageBox(confirmation);
    if (confirmed.response !== 0) return { state: 'cancelled', summary: 'The handoff was cancelled.' };
    return requireRuntime().delegateRoutine(automation, taskBrief);
  });

  handle(IPC.openMainWindow, route => {
    if (route !== undefined && (typeof route !== 'string' || !/^#\/[a-z0-9/-]{0,80}$/.test(route))) {
      throw new Error('Invalid route.');
    }
    hideTray();
    showMainWindow(route);
  });

  handle(IPC.exportData, async () => {
    const data = requireRuntime().exportData();
    const warning: MessageBoxOptions = {
      type: 'warning',
      buttons: ['Export anyway', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'The export is not encrypted',
      detail: 'It includes every recorded app switch with timestamps, URL shapes, your settings, and any configured OpenMausBot executable and target. Keep it somewhere private, and do not put it in a synced folder.',
    };
    const parent = parentWindow();
    const warned = parent ? await dialog.showMessageBox(parent, warning) : await dialog.showMessageBox(warning);
    if (warned.response !== 0) return '';

    const options: SaveDialogOptions = {
      title: 'Export your twin data',
      defaultPath: 'companyos-twin-export.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    };
    const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return '';
    writeFileSync(result.filePath, data, { mode: 0o600 });
    return result.filePath;
  });

  handle(IPC.deleteAll, async () => {
    const options: MessageBoxOptions = {
      type: 'warning',
      buttons: ['Delete everything', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Delete everything the twin knows about you?',
      detail: 'This removes all events, automations, the network ledger and the installed models on this device. It cannot be undone.',
    };
    const parent = parentWindow();
    const choice = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    if (choice.response !== 0) return;
    requireRuntime().deleteAll();
    quitting = true;
    app.relaunch();
    app.exit(0);
  });
}

/** Asks the person before each step the policy marks as needing confirmation. */
async function approveStep(automation: Automation, step: Step, decision: Decision): Promise<boolean> {
  const message = describeStep(step);
  const options: MessageBoxOptions = {
    type: 'question',
    buttons: ['Allow this step', 'Stop the run'],
    defaultId: 1,
    cancelId: 1,
    title: automation.name,
    message,
    detail: decision.reason,
  };
  const parent = parentWindow();
  const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return result.response === 0;
}

/** Serves files from the renderer folder only. Anything outside it, or any other host, is a 404. */
async function serveRenderer(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname !== 'twin') return new Response('Not found', { status: 404 });
  const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = resolve(RENDERER_DIR, relative);
  if (!file.startsWith(RENDERER_DIR + sep)) return new Response('Not found', { status: 404 });
  return net.fetch(pathToFileURL(file).toString());
}

const WEB_PREFERENCES = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
  preload: join(__dirname, 'preload.js'),
};

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: 'companyOS Twin',
    icon: join(BRAND_DIR, 'app-icon.png'),
    backgroundColor: '#F3F4F1',
    show: false,
    webPreferences: WEB_PREFERENCES,
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.on('close', event => {
    if (!quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  void mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
}

function createTrayWindow(): void {
  trayWindow = new BrowserWindow({
    width: 400,
    height: 600,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#101214',
    webPreferences: WEB_PREFERENCES,
  });
  trayWindow.on('blur', () => {
    // An open offer stays on screen until it is answered or expires.
    if (!runtime?.hasPendingOffers()) hideTray();
  });
  void trayWindow.loadURL(`${APP_ORIGIN}/tray.html`);
}

function hideTray(): void {
  if (trayWindow && !trayWindow.isDestroyed() && trayWindow.isVisible()) trayWindow.hide();
}

/** Places the tray popover under the menu bar icon, clamped to the screen it appears on. */
function positionTray(): void {
  const primary = screen.getPrimaryDisplay().workArea;
  const bounds = tray?.getBounds();
  const anchor =
    bounds && bounds.width > 0
      ? bounds
      : { x: primary.x + primary.width - 40, y: primary.y, width: 20, height: 20 };
  const size = trayWindow?.getBounds() ?? { width: 400, height: 600 };
  const area = screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y }).workArea;
  const x = Math.min(
    Math.max(anchor.x + Math.round(anchor.width / 2) - Math.round(size.width / 2), area.x + 8),
    area.x + area.width - size.width - 8,
  );
  const belowAnchor = anchor.y < area.y + area.height / 2;
  const y = belowAnchor ? anchor.y + anchor.height + 6 : anchor.y - size.height - 6;
  trayWindow?.setPosition(x, Math.max(area.y + 8, y));
}

/** Opens the tray popover when the menu bar icon is clicked. */
function toggleTray(): void {
  if (!trayWindow || trayWindow.isDestroyed()) createTrayWindow();
  if (trayWindow?.isVisible()) {
    trayWindow.hide();
    return;
  }
  positionTray();
  trayWindow?.show();
  trayWindow?.focus();
}

/**
 * Offers a routine. The popover appears without taking focus from whatever the person is doing, and a
 * notification says what was offered. Nothing runs until the person answers.
 */
function showOffer(offer: PendingRunView): void {
  if (!trayWindow || trayWindow.isDestroyed()) createTrayWindow();
  positionTray();
  trayWindow?.showInactive();
  if (Notification.isSupported()) {
    const notification = new Notification({
      title: 'companyOS Twin',
      body: `You opened ${offer.app}. Run "${offer.automationName}"? You approve every run.`,
    });
    notification.on('click', () => {
      positionTray();
      trayWindow?.show();
      trayWindow?.focus();
    });
    notification.show();
  }
}

function rebuildTrayMenu(): void {
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open companyOS Twin', click: () => showMainWindow() },
      {
        label: paused ? 'Resume capture' : 'Pause capture',
        click: () => {
          paused = !paused;
          requireRuntime().setPaused(paused);
          rebuildTrayMenu();
        },
      },
      { label: 'Stop all automations', click: () => stopAllAutomations() },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function createTray(): void {
  // A template image: macOS draws it in the colour that suits the menu bar, light or dark.
  const image = nativeImage.createFromPath(join(BRAND_DIR, 'tray.png'));
  image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip('companyOS Twin');
  tray.on('click', toggleTray);
  tray.on('right-click', () => tray?.popUpContextMenu());
  rebuildTrayMenu();
}

async function boot(): Promise<void> {
  if (process.platform === 'darwin') app.dock?.setIcon(join(BRAND_DIR, 'app-icon.png'));
  try {
    runtime = await TwinRuntime.create({
      userData,
      approve: approveStep,
      // The test platform has no real input device, so idle time is pinned to zero for it.
      idleSeconds: () => (process.env.COMPANYOS_TEST_FAKE_PLATFORM ? 0 : powerMonitor.getSystemIdleTime()),
      onChange: () => undefined,
      onOffer: showOffer,
      onUnattendedRun: result => {
        if (!Notification.isSupported()) return;
        const body =
          result.status === 'completed'
            ? 'A level 4 routine finished. See its run history in Automations.'
            : result.status === 'failed'
              ? 'A level 4 routine failed and was demoted. Check it in Automations.'
              : 'A level 4 routine stopped before completion.';
        new Notification({
          title: 'companyOS Twin',
          body,
        }).show();
      },
    });
  } catch (error) {
    // Any failure at startup, including a damaged key file, ends visibly. A silent process with no window is worse.
    const detail =
      error instanceof SecureStorageUnavailableError
        ? error.message
        : 'The stored key could not be opened. Check the twin folder, or reset it from another start.';
    dialog.showErrorBox('companyOS Twin cannot start', detail);
    app.quit();
    return;
  }

  await runtime.start();
  // Test-only, for the performance harness. It needs an unpackaged run in its own data folder, so a real install never seeds.
  const seedDays = Number(process.env.COMPANYOS_MEASURE_SEED_DAYS);
  if (!app.isPackaged && process.env.COMPANYOS_USER_DATA && Number.isInteger(seedDays) && seedDays > 0) {
    runtime.seedMeasurementActivity(Math.min(seedDays, 30));
  }
  powerMonitor.on('lock-screen', () => runtime?.setLocked(true));
  powerMonitor.on('unlock-screen', () => runtime?.setLocked(false));

  protocol.handle('app', serveRenderer);
  registerIpc();
  createMainWindow();
  createTrayWindow();
  createTray();
  // Does nothing unless the app is packaged and a feed URL is set (src/main/updater.ts).
  startAutoUpdates(app.isPackaged, entry => requireRuntime().recordNetworkCall(entry));

  try {
    globalShortcut.register(STOP_ALL_SHORTCUT, () => stopAllAutomations());
  } catch {
    // Another app may own the shortcut. The tray menu still stops everything.
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
  app.on('before-quit', () => {
    quitting = true;
    runtime?.stop();
    globalShortcut.unregisterAll();
  });
  void app.whenReady().then(boot).catch(error => {
    dialog.showErrorBox('companyOS Twin cannot start', error instanceof Error ? error.message : 'Unknown error.');
    app.quit();
  });
}
