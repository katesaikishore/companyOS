import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  powerMonitor,
  Tray,
  type MessageBoxOptions,
  type SaveDialogOptions,
} from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AutonomyLevelSchema, TwinConfigSchema, type Automation, type Decision, type Step } from '@companyos/twin-core';
import { IPC } from '../shared/ipc';
import { solidPng } from './icon';
import { SecureStorageUnavailableError } from './keys';
import { TwinRuntime } from './runtime';

let runtime: TwinRuntime | undefined;
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let paused = false;
let quitting = false;

const userData = app.getPath('userData');

function requireRuntime(): TwinRuntime {
  if (!runtime) throw new Error('The twin is still starting.');
  return runtime;
}

/** The renderer is less trusted than the main process, so every value crossing IPC is checked. */
function automationId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 80) throw new Error('Invalid automation id.');
  return value;
}

function routineId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 80) throw new Error('Invalid routine id.');
  return value;
}

function handle(channel: string, fn: (...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (_event, ...args) => fn(...args));
}

function registerIpc(): void {
  handle(IPC.status, () => requireRuntime().status());

  handle(IPC.setPaused, value => {
    if (typeof value !== 'boolean') throw new Error('Invalid value.');
    paused = value;
    requireRuntime().setPaused(value);
    rebuildTrayMenu();
  });

  handle(IPC.updateConfig, patch => requireRuntime().updateConfig(TwinConfigSchema.partial().parse(patch)));

  handle(IPC.acceptRoutine, (id, name) =>
    requireRuntime().acceptRoutine(routineId(id), typeof name === 'string' ? name.slice(0, 80) : undefined),
  );

  handle(IPC.setLevel, (id, level) => requireRuntime().setLevel(automationId(id), AutonomyLevelSchema.parse(level)));

  handle(IPC.promote, id => requireRuntime().promote(automationId(id)));

  handle(IPC.dryRun, id => requireRuntime().dryRun(automationId(id)));

  handle(IPC.supervisedRun, id => requireRuntime().supervisedRun(automationId(id)));

  handle(IPC.revertLast, id => requireRuntime().revertLast(automationId(id)));

  handle(IPC.requestName, id => requireRuntime().requestName(routineId(id)));

  handle(IPC.setApiKey, key => {
    if (typeof key !== 'string' || key.length > 200) throw new Error('Invalid key.');
    return requireRuntime().setApiKey(key);
  });

  handle(IPC.exportData, async () => {
    // Shown before the save dialog: the save dialog's own message is macOS-only, so it cannot carry this warning everywhere.
    const warning: MessageBoxOptions = {
      type: 'warning',
      buttons: ['Export anyway', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'The export is not encrypted',
      detail: 'It lists every app switch the twin recorded, with timestamps, and any URL shapes. Keep it somewhere private, and do not put it in a synced folder.',
    };
    const parent = parentWindow();
    const warned = parent ? await dialog.showMessageBox(parent, warning) : await dialog.showMessageBox(warning);
    if (warned.response !== 0) return '';

    const data = requireRuntime().exportData();
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
      detail: 'This removes all events, automations, the cloud ledger and the stored Claude API key on this device. It cannot be undone.',
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

/** Dialogs attach to the main window when it exists, so they appear over it. */
function parentWindow(): BrowserWindow | undefined {
  return window && !window.isDestroyed() ? window : undefined;
}

/** Asks the person before each step the policy marks as needing confirmation. */
async function approveStep(automation: Automation, step: Step, decision: Decision): Promise<boolean> {
  const message = step.op === 'focus_app' ? `Bring "${step.app}" to the front?` : `Check that "${step.app}" is in front?`;
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

function createWindow(): void {
  window = new BrowserWindow({
    width: 1120,
    height: 800,
    title: 'companyOS Twin',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => {
    if (!quitting) {
      event.preventDefault();
      window?.hide();
    }
  });
  void window.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
}

function showWindow(): void {
  if (!window || window.isDestroyed()) createWindow();
  window?.show();
  window?.focus();
}

function rebuildTrayMenu(): void {
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open companyOS Twin', click: showWindow },
      {
        label: paused ? 'Resume capture' : 'Pause capture',
        click: () => {
          paused = !paused;
          requireRuntime().setPaused(paused);
          rebuildTrayMenu();
        },
      },
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
  tray = new Tray(nativeImage.createFromBuffer(solidPng(16, [46, 125, 50])));
  tray.setToolTip('companyOS Twin');
  tray.on('click', showWindow);
  rebuildTrayMenu();
}

async function boot(): Promise<void> {
  try {
    runtime = await TwinRuntime.create({
      userData,
      approve: approveStep,
      idleSeconds: () => powerMonitor.getSystemIdleTime(),
    });
  } catch (error) {
    // Any failure at startup, including a damaged key file, ends visibly. A silent process with no window is worse.
    const detail = error instanceof SecureStorageUnavailableError ? error.message : 'The stored key could not be opened. Check the twin folder or reset it from another start.';
    dialog.showErrorBox('companyOS Twin cannot start', detail);
    app.quit();
    return;
  }

  runtime.start();
  powerMonitor.on('lock-screen', () => runtime?.setLocked(true));
  powerMonitor.on('unlock-screen', () => runtime?.setLocked(false));

  registerIpc();
  createWindow();
  createTray();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('before-quit', () => {
    quitting = true;
    runtime?.stop();
  });
  void app.whenReady().then(boot).catch(error => {
    dialog.showErrorBox('companyOS Twin cannot start', error instanceof Error ? error.message : 'Unknown error.');
    app.quit();
  });
}
