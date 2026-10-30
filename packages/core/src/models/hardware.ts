import type { GpuVendor, HardwareProfile } from './types';

/** Maps a GPU's marketing name to its vendor. Anything unrecognised is 'other'. */
export function vendorFromName(name: string): GpuVendor {
  if (/nvidia|geforce|quadro|rtx|gtx/i.test(name)) return 'nvidia';
  if (/\bamd\b|radeon/i.test(name)) return 'amd';
  if (/intel|\buhd\b|iris|\barc\b/i.test(name)) return 'intel';
  if (/\bapple\b|\bm[1-9]\b/i.test(name)) return 'apple';
  return 'other';
}

/**
 * Parses the JSON from `Get-CimInstance Win32_VideoController | Select-Object Name | ConvertTo-Json`.
 * PowerShell emits one object for one adapter and an array for several, so both shapes are accepted.
 */
export function parseWindowsGpuNames(json: string): string[] {
  const trimmed = json.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  return entries
    .map(entry => (entry && typeof entry === 'object' && 'Name' in entry ? String((entry as { Name: unknown }).Name) : ''))
    .filter(name => name.length > 0);
}

/** Parses `lspci` output and keeps the display controllers. */
export function parseLspciGpuNames(text: string): string[] {
  return text
    .split('\n')
    .filter(line => /VGA compatible controller|3D controller|Display controller/i.test(line))
    .map(line => line.split(': ').slice(1).join(': ').trim())
    .filter(name => name.length > 0);
}

/** Prefers a discrete GPU, then integrated, so the plan reflects the most capable device. */
export function pickGpu(names: readonly string[]): { vendor: GpuVendor; name?: string } {
  if (names.length === 0) return { vendor: 'none' };
  const ranked = names
    .map(name => ({ name, vendor: vendorFromName(name) }))
    .sort((a, b) => rank(a.vendor) - rank(b.vendor));
  return { vendor: ranked[0].vendor, name: ranked[0].name };
}

function rank(vendor: GpuVendor): number {
  switch (vendor) {
    case 'apple':
    case 'nvidia':
    case 'amd':
      return 0;
    case 'intel':
      return 1;
    case 'other':
    case 'unknown':
      return 2;
    default:
      return 3;
  }
}

export interface RawHardware {
  platform: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  memoryBytes: number;
  gpuNames: readonly string[];
  freeDiskBytes: number;
}

/** Turns what the OS reported into a profile. Apple Silicon is unified memory; everything else is not. */
export function buildHardwareProfile(raw: RawHardware): HardwareProfile {
  const platform = raw.platform === 'darwin' || raw.platform === 'win32' || raw.platform === 'linux' ? raw.platform : 'other';
  const unifiedMemory = platform === 'darwin' && raw.arch === 'arm64';
  const gpu = unifiedMemory ? { vendor: 'apple' as const, name: raw.cpuModel } : pickGpu(raw.gpuNames);
  const notes: string[] = [];
  if (!unifiedMemory && (gpu.vendor === 'nvidia' || gpu.vendor === 'amd')) {
    notes.push("GPU memory is not measured, so the plan assumes system memory.");
  }
  return {
    platform,
    arch: raw.arch,
    cpuModel: raw.cpuModel,
    cpuCores: raw.cpuCores,
    memoryBytes: raw.memoryBytes,
    unifiedMemory,
    gpu,
    freeDiskBytes: raw.freeDiskBytes,
    notes,
  };
}
