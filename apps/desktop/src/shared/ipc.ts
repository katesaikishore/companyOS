/** Channel names shared by the main process. The preload script repeats them, because sandboxed preloads cannot import modules. */
export const IPC = {
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
  resetDecline: 'twin:reset-decline',
  renameAutomation: 'twin:rename-automation',
  setLevel: 'twin:set-level',
  promote: 'twin:promote',
  dryRun: 'twin:dry-run',
  supervisedRun: 'twin:supervised-run',
  revertLast: 'twin:revert-last',
  answerPendingRun: 'twin:answer-pending-run',
  decideTask: 'twin:decide-task',
  exportData: 'twin:export-data',
  deleteAll: 'twin:delete-all',
  openMainWindow: 'twin:open-main-window',
  /** Main process to page: change route. */
  navigate: 'twin:navigate',
} as const;

/** The custom scheme the pages are served from. Module scripts need it: file:// blocks them in Chromium. */
export const APP_ORIGIN = 'app://twin';
