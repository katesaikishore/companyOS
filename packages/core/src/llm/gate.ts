/** Idle time after which model work may run on battery. A design value, not a sourced standard. */
export const MODEL_IDLE_SECONDS = 120;

export interface DeviceConditions {
  /** True when the device runs on its battery. */
  onBattery: boolean;
  /** Seconds since the last keyboard or mouse input. */
  idleSeconds: number;
}

/**
 * Model work runs only when the device is on AC power, or when the person has been idle for a while. On battery during
 * active use it waits, so a model does not drain the battery or heat the machine while someone is working (plan §5.5).
 */
export function modelWorkAllowed(conditions: DeviceConditions): boolean {
  return !conditions.onBattery || conditions.idleSeconds >= MODEL_IDLE_SECONDS;
}
