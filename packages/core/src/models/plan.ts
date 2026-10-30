import { CATALOG } from './catalog';
import type { Fit, HardwareProfile, ModelFit, ModelSpec, SetupPlan } from './types';

const GIB = 1024 ** 3;

/** Memory a model needs to run: its weights, plus about 25% and a gigabyte for the context and runtime. */
export function requiredMemoryBytes(spec: ModelSpec): number {
  return Math.ceil(spec.sizeBytes * 1.25 + GIB);
}

/**
 * Memory the models may use. Apple Silicon shares one pool, so more of it is usable. Elsewhere the plan keeps
 * half of system memory free, because a GPU's memory is not measured reliably.
 */
export function memoryBudgetBytes(hardware: HardwareProfile): number {
  return Math.floor(hardware.memoryBytes * (hardware.unifiedMemory ? 0.6 : 0.5));
}

export function classifyFit(requiredBytes: number, budgetBytes: number): Fit {
  if (requiredBytes <= budgetBytes * 0.75) return 'good';
  if (requiredBytes <= budgetBytes) return 'tight';
  return 'too_large';
}

export function formatBytes(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function fitFor(spec: ModelSpec, hardware: HardwareProfile, budget: number): ModelFit {
  const required = requiredMemoryBytes(spec);
  const diskLimit = hardware.freeDiskBytes * 0.4;
  let fit = classifyFit(required, budget);
  let reason: string;
  if (spec.sizeBytes > diskLimit) {
    fit = 'too_large';
    reason = 'Not enough free disk space for this model.';
  } else if (fit === 'too_large') {
    reason = `Needs about ${formatBytes(required)} of memory. This device has about ${formatBytes(budget)} to spare.`;
  } else if (fit === 'tight') {
    reason = 'Fits, but leaves little room for other apps.';
  } else {
    reason = 'Fits comfortably alongside other apps.';
  }
  const discreteGpu = hardware.gpu.vendor === 'nvidia' || hardware.gpu.vendor === 'amd' || hardware.gpu.vendor === 'apple';
  if (fit !== 'too_large' && spec.role === 'chat' && !discreteGpu && spec.sizeBytes > 2 * GIB) {
    reason += ' Without a GPU, responses will be slow.';
  }
  return { spec, fit, requiredMemoryBytes: required, reason };
}

/**
 * Chooses models for this device. The recommendation is the largest chat model that fits comfortably, falling back
 * to the largest that fits tightly. An embedding model is always included. Pure: the same hardware always gives the same plan.
 */
export function planSetup(hardware: HardwareProfile, catalog: readonly ModelSpec[] = CATALOG): SetupPlan {
  const embedding = catalog.find(model => model.role === 'embedding');
  if (!embedding) throw new Error('The catalog has no embedding model.');

  const budget = memoryBudgetBytes(hardware);
  const chats = catalog
    .filter(model => model.role === 'chat')
    .sort((a, b) => a.sizeBytes - b.sizeBytes)
    .map(spec => fitFor(spec, hardware, budget));

  const chat = chats.filter(entry => entry.fit === 'good').at(-1) ?? chats.filter(entry => entry.fit === 'tight').at(-1);

  const warnings: string[] = [...hardware.notes];
  if (hardware.cpuCores < 4) warnings.push('Few CPU cores: local models will respond slowly.');
  if (hardware.freeDiskBytes < 10 * GIB) warnings.push('Less than 10 GB of free disk. Keep room for models and your twin data.');
  if (!chat) {
    warnings.push('This device does not have enough memory for a local model. The twin will use simple rule-based labels.');
  }
  return { hardware, memoryBudgetBytes: budget, chat, alternatives: chats, embedding, warnings };
}
