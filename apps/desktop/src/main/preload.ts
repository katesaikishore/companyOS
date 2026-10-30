import { contextBridge, ipcRenderer } from 'electron';
import type { TwinBridge } from '@companyos/twin-core';

/**
 * Sandboxed preload scripts may only require 'electron', so the channel names are repeated here.
 * They must match IPC in shared/ipc.ts. The smoke test calls every channel path that matters.
 */
const CHANNEL = {
  status: 'twin:status',
  setPaused: 'twin:set-paused',
  updateConfig: 'twin:update-config',
  acceptRoutine: 'twin:accept-routine',
  setLevel: 'twin:set-level',
  promote: 'twin:promote',
  dryRun: 'twin:dry-run',
  supervisedRun: 'twin:supervised-run',
  revertLast: 'twin:revert-last',
  requestName: 'twin:request-name',
  setApiKey: 'twin:set-api-key',
  exportData: 'twin:export-data',
  deleteAll: 'twin:delete-all',
} as const;

/** The only surface the page can reach. Each method forwards to a validated handler in the main process. */
const bridge: TwinBridge = {
  status: () => ipcRenderer.invoke(CHANNEL.status),
  setPaused: paused => ipcRenderer.invoke(CHANNEL.setPaused, paused),
  updateConfig: patch => ipcRenderer.invoke(CHANNEL.updateConfig, patch),
  acceptRoutine: (routineId, name) => ipcRenderer.invoke(CHANNEL.acceptRoutine, routineId, name),
  setLevel: (automationId, level) => ipcRenderer.invoke(CHANNEL.setLevel, automationId, level),
  promote: automationId => ipcRenderer.invoke(CHANNEL.promote, automationId),
  dryRun: automationId => ipcRenderer.invoke(CHANNEL.dryRun, automationId),
  supervisedRun: automationId => ipcRenderer.invoke(CHANNEL.supervisedRun, automationId),
  revertLast: automationId => ipcRenderer.invoke(CHANNEL.revertLast, automationId),
  requestName: routineId => ipcRenderer.invoke(CHANNEL.requestName, routineId),
  setApiKey: key => ipcRenderer.invoke(CHANNEL.setApiKey, key),
  exportData: () => ipcRenderer.invoke(CHANNEL.exportData),
  deleteAll: () => ipcRenderer.invoke(CHANNEL.deleteAll),
};

contextBridge.exposeInMainWorld('twin', bridge);
