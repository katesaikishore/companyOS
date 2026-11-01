import { contextBridge, ipcRenderer } from 'electron';
import type { TwinBridge } from '@companyos/twin-core';

/**
 * Sandboxed preload scripts may only require 'electron', so the channel names are repeated here.
 * They must match IPC in shared/ipc.ts. The end-to-end tests exercise these channels.
 */
const CHANNEL = {
  status: 'twin:status',
  hardware: 'twin:hardware',
  setupPlan: 'twin:setup-plan',
  installModel: 'twin:install-model',
  cancelDownload: 'twin:cancel-download',
  removeModel: 'twin:remove-model',
  installLaya: 'twin:install-laya',
  cancelLaya: 'twin:cancel-laya',
  removeLaya: 'twin:remove-laya',
  completeSetup: 'twin:complete-setup',
  setPaused: 'twin:set-paused',
  updateConfig: 'twin:update-config',
  stopAllAutomations: 'twin:stop-all-automations',
  acceptRoutine: 'twin:accept-routine',
  dismissRoutine: 'twin:dismiss-routine',
  renameAutomation: 'twin:rename-automation',
  setLevel: 'twin:set-level',
  promote: 'twin:promote',
  dryRun: 'twin:dry-run',
  supervisedRun: 'twin:supervised-run',
  revertLast: 'twin:revert-last',
  answerPendingRun: 'twin:answer-pending-run',
  exportData: 'twin:export-data',
  deleteAll: 'twin:delete-all',
  openMainWindow: 'twin:open-main-window',
  navigate: 'twin:navigate',
} as const;

/** The only surface a page can reach. Each method forwards to a validated handler in the main process. */
const bridge: TwinBridge = {
  status: () => ipcRenderer.invoke(CHANNEL.status),
  hardware: () => ipcRenderer.invoke(CHANNEL.hardware),
  setupPlan: () => ipcRenderer.invoke(CHANNEL.setupPlan),
  installModel: modelId => ipcRenderer.invoke(CHANNEL.installModel, modelId),
  cancelDownload: modelId => ipcRenderer.invoke(CHANNEL.cancelDownload, modelId),
  removeModel: modelId => ipcRenderer.invoke(CHANNEL.removeModel, modelId),
  installLaya: () => ipcRenderer.invoke(CHANNEL.installLaya),
  cancelLaya: () => ipcRenderer.invoke(CHANNEL.cancelLaya),
  removeLaya: () => ipcRenderer.invoke(CHANNEL.removeLaya),
  completeSetup: () => ipcRenderer.invoke(CHANNEL.completeSetup),
  setPaused: paused => ipcRenderer.invoke(CHANNEL.setPaused, paused),
  updateConfig: patch => ipcRenderer.invoke(CHANNEL.updateConfig, patch),
  stopAllAutomations: () => ipcRenderer.invoke(CHANNEL.stopAllAutomations),
  acceptRoutine: (routineId, name) => ipcRenderer.invoke(CHANNEL.acceptRoutine, routineId, name),
  dismissRoutine: routineId => ipcRenderer.invoke(CHANNEL.dismissRoutine, routineId),
  renameAutomation: (automationId, name) => ipcRenderer.invoke(CHANNEL.renameAutomation, automationId, name),
  setLevel: (automationId, level) => ipcRenderer.invoke(CHANNEL.setLevel, automationId, level),
  promote: automationId => ipcRenderer.invoke(CHANNEL.promote, automationId),
  dryRun: automationId => ipcRenderer.invoke(CHANNEL.dryRun, automationId),
  supervisedRun: automationId => ipcRenderer.invoke(CHANNEL.supervisedRun, automationId),
  revertLast: automationId => ipcRenderer.invoke(CHANNEL.revertLast, automationId),
  answerPendingRun: (id, run) => ipcRenderer.invoke(CHANNEL.answerPendingRun, id, run),
  exportData: () => ipcRenderer.invoke(CHANNEL.exportData),
  deleteAll: () => ipcRenderer.invoke(CHANNEL.deleteAll),
  openMainWindow: route => ipcRenderer.invoke(CHANNEL.openMainWindow, route),
  onNavigate: listener => {
    const handler = (_event: unknown, route: unknown) => {
      if (typeof route === 'string' && route.length <= 200) listener(route);
    };
    ipcRenderer.on(CHANNEL.navigate, handler);
    return () => ipcRenderer.removeListener(CHANNEL.navigate, handler);
  },
};

contextBridge.exposeInMainWorld('twin', bridge);
