export type GpuVendor = 'apple' | 'nvidia' | 'amd' | 'intel' | 'other' | 'none' | 'unknown';

/** What this device can run. Measured by the desktop app, then interpreted by planSetup(). */
export interface HardwareProfile {
  platform: 'darwin' | 'win32' | 'linux' | 'other';
  arch: string;
  cpuModel: string;
  cpuCores: number;
  memoryBytes: number;
  /** Apple Silicon shares one memory pool between CPU and GPU. */
  unifiedMemory: boolean;
  gpu: { vendor: GpuVendor; name?: string };
  freeDiskBytes: number;
  /** Plain-language caveats, such as "GPU memory is not measured, so the plan assumes system memory." */
  notes: string[];
}

/** A model the app may install. Only open-weight models with an OSI-approved licence are listed. */
export interface ModelSpec {
  id: string;
  name: string;
  role: 'chat' | 'embedding';
  params: string;
  quantization: string;
  license: 'Apache-2.0' | 'MIT';
  /** Hugging Face repository. Downloads are only accepted from its own files. */
  repo: string;
  file: string;
  sizeBytes: number;
  sha256: string;
  summary: string;
}

export type Fit = 'good' | 'tight' | 'too_large';

export interface ModelFit {
  spec: ModelSpec;
  fit: Fit;
  requiredMemoryBytes: number;
  reason: string;
}

export interface SetupPlan {
  hardware: HardwareProfile;
  memoryBudgetBytes: number;
  /** The recommendation. Undefined when no chat model fits this device. */
  chat?: ModelFit;
  /** Every chat model, with its fit, so the person can choose another. */
  alternatives: ModelFit[];
  embedding: ModelSpec;
  warnings: string[];
}

export interface InstalledModel {
  id: string;
  sha256: string;
  bytes: number;
  installedAt: number;
}

export interface DownloadState {
  modelId: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  receivedBytes: number;
  totalBytes: number;
  message?: string;
}

/** A network call the twin made. Recorded so the person can see exactly what left the device. */
export interface NetworkEntry {
  ts: number;
  purpose: 'model_download';
  modelId: string;
  host: string;
  path: string;
  bytes: number;
  sha256Verified: boolean;
  outcome: 'ok' | 'failed' | 'cancelled';
}
