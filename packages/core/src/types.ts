import { z } from 'zod';

/** Coarse, locally assigned class of an application. Titles and content are never stored. */
export const WINDOW_CLASSES = [
  'browser',
  'editor',
  'spreadsheet',
  'document',
  'mail',
  'chat',
  'terminal',
  'design',
  'other',
] as const;
export type WindowClass = (typeof WINDOW_CLASSES)[number];

/** What an automation step does to the outside world. */
export const EFFECT_CLASSES = [
  'read_only',
  'local_reversible',
  'external_effect',
  'money',
  'deletion',
  'permission',
  'install',
] as const;
export type EffectClass = (typeof EFFECT_CLASSES)[number];

/** Effects that always need a person, at every autonomy level. */
export const FLOOR_EFFECTS: readonly EffectClass[] = ['external_effect', 'money', 'deletion', 'permission', 'install'];

/** Every operation an automation step can perform. Focus and check are the original vocabulary; the rest open or press things. */
export type StepOp = 'focus_app' | 'check_focus' | 'open_url' | 'open_file' | 'press_shortcut';

/** 0 observe, 1 suggest, 2 draft, 3 one-click run, 4 unattended (local, reversible), 5 external (not in this version). */
export type AutonomyLevel = 0 | 1 | 2 | 3 | 4 | 5;
export const AutonomyLevelSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

export const SIGNAL_KINDS = ['focus', 'idle_start', 'idle_end', 'lock', 'unlock'] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

/**
 * A raw signal from a capture adapter. The schema is strict: a capture adapter that tries to
 * send a field it should not have (for example a window title) fails validation instead of leaking it.
 */
export const RawSignalSchema = z
  .object({
    kind: z.enum(SIGNAL_KINDS),
    ts: z.number().int().nonnegative(),
    app: z.string().min(1).max(200).optional(),
    isPrivateWindow: z.boolean().optional(),
    secureInput: z.boolean().optional(),
    url: z.string().max(2048).optional(),
  })
  .strict();
export type RawSignal = z.infer<typeof RawSignalSchema>;

/** A normalised, redacted event. This is the only shape that is ever stored. */
export interface TwinEvent {
  id: string;
  ts: number;
  kind: SignalKind;
  app?: string;
  windowClass?: WindowClass;
  /** Host and path shape only. Identifiers become :id. Query strings and fragments are dropped. */
  urlTemplate?: string;
}

/** The most consecutive declines a routine's count holds. Past seven days of cooldown the count adds nothing. */
export const MAX_DECLINE_STREAK = 32;
/** The longest dismissed-routine signature kept. A longer one is not stored, so its routine is hidden by id only. */
export const MAX_SIGNATURE_CHARS = 2048;

export const TwinConfigSchema = z
  .object({
    excludedApps: z.array(z.string().min(1).max(100)).max(200),
    maxAutonomyLevel: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    allowUnattended: z.boolean(),
    watchBrowsers: z.boolean(),
    idleGapMs: z.number().int().min(60_000).max(3_600_000),
    theme: z.enum(['system', 'light', 'dark']),
    setupCompleted: z.boolean(),
    /** The "stop all automations" switch. When false, no automation runs at any level. */
    automationsEnabled: z.boolean(),
    installedModels: z
      .array(z.object({ id: z.string().max(80), sha256: z.string().length(64), bytes: z.number().int().nonnegative(), installedAt: z.number() }).strict())
      .max(20),
    dismissedRoutineIds: z.array(z.string().max(40)).max(500),
    /** Optional agent-desktop program for the focus and key steps. Blank keeps the built-in adapters. The app does not bundle it. */
    agentDesktopPath: z.string().trim().max(512).default(''),
    /** The step keys of each dismissed routine, joined with '>'. A near copy of a dismissed routine is hidden too. */
    dismissedRoutineSignatures: z.array(z.string().min(1).max(MAX_SIGNATURE_CHARS)).max(500).default([]),
    /** When each routine was last declined or dismissed, and how many times in a row. Kept so a restart keeps the wait. */
    declinedRoutines: z
      .array(
        z
          .object({
            routineId: z.string().min(1).max(40),
            at: z.number().int().nonnegative(),
            count: z.number().int().min(1).max(MAX_DECLINE_STREAK),
          })
          .strict(),
      )
      .max(500)
      .default([]),
  })
  .strict();
export type TwinConfig = z.infer<typeof TwinConfigSchema>;

export const DEFAULT_CONFIG: TwinConfig = {
  excludedApps: [
    '1password',
    'bitwarden',
    'keepass',
    'keepassxc',
    'dashlane',
    'lastpass',
    'enpass',
    'keychain access',
    'seahorse',
    'kwalletmanager',
  ],
  maxAutonomyLevel: 3,
  allowUnattended: false,
  // Browser capture is off until private windows can be detected. Otherwise the twin would record them.
  watchBrowsers: false,
  // Time spent in one app is dwell, not idleness. The OS idle signal marks idleness. This gap is a fallback.
  idleGapMs: 60 * 60_000,
  theme: 'system',
  setupCompleted: false,
  automationsEnabled: true,
  installedModels: [],
  dismissedRoutineIds: [],
  agentDesktopPath: '',
  dismissedRoutineSignatures: [],
  declinedRoutines: [],
};
