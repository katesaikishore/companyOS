import type { TwinBridge } from '@companyos/twin-core';

/** The bridge the preload script exposes. Pages use it only through this typed surface. */
declare global {
  interface Window {
    twin: TwinBridge;
  }
}

export {};
