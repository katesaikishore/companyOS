import { execFile } from 'node:child_process';
import { statfsSync } from 'node:fs';
import os from 'node:os';
import { buildHardwareProfile, parseLspciGpuNames, parseWindowsGpuNames, type HardwareProfile } from '@companyos/twin-core';

function run(file: string, args: readonly string[]): Promise<string> {
  return new Promise(resolve => {
    execFile(file, [...args], { timeout: 4000, windowsHide: true, maxBuffer: 256 * 1024 }, (error, stdout) => {
      resolve(error ? '' : stdout.toString());
    });
  });
}

/** Display adapters, by platform. Failures return no names rather than an error: the plan then assumes no GPU. */
async function gpuNames(platform: string): Promise<string[]> {
  if (platform === 'win32') {
    const json = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_VideoController | Select-Object Name | ConvertTo-Json',
    ]);
    return parseWindowsGpuNames(json);
  }
  if (platform === 'linux') return parseLspciGpuNames(await run('lspci', []));
  return [];
}

/** Measures the device once: CPU, memory, GPU vendor, and free disk on the volume that holds the twin. */
export async function detectHardware(userDataDir: string): Promise<HardwareProfile> {
  const cpus = os.cpus();
  const disk = statfsSync(userDataDir);
  return buildHardwareProfile({
    platform: process.platform,
    arch: os.arch(),
    cpuModel: cpus[0]?.model?.trim() || 'Unknown CPU',
    cpuCores: cpus.length,
    memoryBytes: os.totalmem(),
    gpuNames: await gpuNames(process.platform),
    freeDiskBytes: Number(disk.bavail) * Number(disk.bsize),
  });
}
