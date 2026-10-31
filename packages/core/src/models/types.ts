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
  purpose: 'model_download' | 'update_check';
  /** Model downloads only. */
  modelId?: string;
  host: string;
  path: string;
  /** The file name within a multi-file download, such as `laya.onnx.data`. Single-file model downloads leave it out. */
  file?: string;
  /**
   * Bytes received by this call. An update check records zero, since electron-updater does not report the channel file's
   * size. A resumed download records only the bytes it fetched, not the part already on disk.
   */
  bytes: number;
  /** Model downloads only. An update check has no checksum to verify. */
  sha256Verified?: boolean;
  outcome: 'ok' | 'failed' | 'cancelled';
}

export type LayaBundleStatus = 'not_installed' | 'downloading' | 'verifying' | 'installed' | 'failed' | 'cancelled';

/**
 * The optional decision-model bundle (Laya), as the page sees it. It is several files, so it is not one catalog model.
 * `receivedBytes` counts every file of the bundle, including a partial file kept from an earlier attempt.
 */
export interface LayaBundleView {
  status: LayaBundleStatus;
  /** The file being downloaded or verified. */
  file?: string;
  receivedBytes: number;
  totalBytes: number;
  /** Free space needed before a download may start, in bytes. */
  requiredFreeBytes: number;
  /** The pinned Hugging Face repository and commit. */
  repo: string;
  revision: string;
  /** Why the last attempt failed, in words that are safe to show. A partial file is kept after most failures, so Resume continues it. */
  message?: string;
  /** True when a partial file from an earlier attempt is on disk. */
  hasPartial: boolean;
  /** False where onnxruntime-node has no prebuilt binding, such as Intel Macs. The bundle is not offered there. */
  supported: boolean;
}
