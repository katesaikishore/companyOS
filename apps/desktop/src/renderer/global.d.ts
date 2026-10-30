import type { AutomationView, RunResult, TwinBridge, TwinStatus } from '@companyos/twin-core';

/**
 * Renderer types, declared globally. app.ts has no imports so that it compiles to a classic script:
 * Chromium refuses module scripts loaded from file://.
 */
declare global {
  type AutomationView = import('@companyos/twin-core').AutomationView;
  type RunResult = import('@companyos/twin-core').RunResult;
  type TwinStatus = import('@companyos/twin-core').TwinStatus;

  interface Window {
    twin: TwinBridge;
  }
}

export type { AutomationView, RunResult, TwinBridge, TwinStatus };
