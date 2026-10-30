/** Channel names. Used by the main process and the preload script only. */
export const IPC = {
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

export type { TwinBridge, TwinStatus } from '@companyos/twin-core';
