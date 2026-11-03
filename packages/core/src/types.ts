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

/** Every operation an automation step can perform. Focus and check are the original vocabulary; the rest open, press or choose things. */
export type StepOp =
  | 'focus_app'
  | 'check_focus'
  | 'open_url'
  | 'open_file'
  | 'press_shortcut'
  | 'choose_menu'
  | 'click'
  | 'paste_text'
  | 'press_key'
  | 'fill_field'
  | 'set_field'
  | 'check_text'
  | 'wait';

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

/**
 * The kinds of captured item: text read from the screen, text from the microphone, text the person typed, and text from an
 * imported source. A connector item is one the person chose to import, so it has its own deletion rules. See connectors/types.ts.
 */
export const CAPTURE_KINDS = ['screen', 'audio', 'keystroke', 'connector'] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

/** Most pipes one config holds. */
export const MAX_PIPES = 20;
export const PIPE_NAME_MAX = 60;
export const PIPE_QUERY_MAX = 200;
export const PIPE_INTERVAL_MIN_MINUTES = 15;
export const PIPE_INTERVAL_MAX_MINUTES = 1440;
/** What a pipe does with its matches. 'notify' shows a count and app names. 'write' keeps the newest run's matches, encrypted in the store. */
export const PIPE_ACTIONS = ['notify', 'write'] as const;
export type PipeAction = (typeof PIPE_ACTIONS)[number];
/** The text a pipe may search. Typed text is not one of them, so a pipe never reads what the person typed. */
export const PIPE_KINDS = ['screen', 'audio'] as const;
export type PipeKind = (typeof PIPE_KINDS)[number];
/** No control characters, so a name or search cannot break a line of a log or a list. */
const NO_CONTROL_CHARACTERS = /^[^\p{Cc}]*$/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * A pipe: a saved search that runs on a schedule and does one local thing with the result. The strict schema refuses any
 * other field, so a pipe cannot carry code, a command or a destination. The id is limited to letters, digits and dashes.
 */
export const PipeSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9-]{8,40}$/),
    name: z.string().trim().min(1).max(PIPE_NAME_MAX).regex(NO_CONTROL_CHARACTERS),
    /** Empty lists everything in the range. Otherwise it must hold a letter or a digit, or every item would match. */
    query: z
      .string()
      .trim()
      .max(PIPE_QUERY_MAX)
      .regex(NO_CONTROL_CHARACTERS)
      .refine(query => query === '' || LETTER_OR_DIGIT.test(query)),
    kind: z.enum(PIPE_KINDS).optional(),
    app: z.string().trim().min(1).max(200).regex(NO_CONTROL_CHARACTERS).optional(),
    intervalMinutes: z.number().int().min(PIPE_INTERVAL_MIN_MINUTES).max(PIPE_INTERVAL_MAX_MINUTES),
    action: z.enum(PIPE_ACTIONS),
    enabled: z.boolean(),
  })
  .strict();
export type Pipe = z.infer<typeof PipeSchema>;

/** The saved pipes, checked as one list: at most MAX_PIPES, and each id once. */
export const PipesSchema = z
  .array(PipeSchema)
  .max(MAX_PIPES)
  .superRefine((pipes, context) => {
    const ids = new Set<string>();
    for (const pipe of pipes) {
      if (ids.has(pipe.id)) context.addIssue({ code: 'custom', message: 'Each pipe needs its own id.' });
      ids.add(pipe.id);
    }
  });

/** The kinds of imported source. The first four read a file or folder on this device. The last two read a cloud account, read-only. */
export const CONNECTOR_SOURCE_KINDS = ['folder', 'git', 'calendar', 'mail', 'google-calendar', 'github'] as const;
export type ConnectorSourceKind = (typeof CONNECTOR_SOURCE_KINDS)[number];
const LOCAL_CONNECTOR_SOURCE_KINDS: readonly ConnectorSourceKind[] = ['folder', 'git', 'calendar', 'mail'];
/** Most imported sources one config holds. */
export const MAX_CONNECTORS = 20;
export const CONNECTOR_LABEL_MAX = 60;
/** A local file or folder path. Only a local source has one. */
export const CONNECTOR_PATH_MAX = 1000;

/**
 * An imported source the person added. Its id is random, so the items it imported are found and removed by that id. The strict
 * schema refuses any other field, so a source cannot carry a token, a command or a destination.
 */
export const ConnectorSourceSchema = z
  .object({
    id: z.string().min(16).max(64),
    kind: z.enum(CONNECTOR_SOURCE_KINDS),
    label: z.string().trim().min(1).max(CONNECTOR_LABEL_MAX).regex(NO_CONTROL_CHARACTERS),
    path: z.string().min(1).max(CONNECTOR_PATH_MAX).regex(NO_CONTROL_CHARACTERS).optional(),
    createdAt: z.number().int().nonnegative(),
    lastImportedAt: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(source => source.path === undefined || LOCAL_CONNECTOR_SOURCE_KINDS.includes(source.kind), {
    message: 'Only a local source has a path.',
  });
export type ConnectorSource = z.infer<typeof ConnectorSourceSchema>;

/** The imported sources, checked as one list: at most MAX_CONNECTORS, and each id once. */
export const ConnectorSourcesSchema = z
  .array(ConnectorSourceSchema)
  .max(MAX_CONNECTORS)
  .superRefine((sources, context) => {
    const ids = new Set<string>();
    for (const source of sources) {
      if (ids.has(source.id)) context.addIssue({ code: 'custom', message: 'Each source needs its own id.' });
      ids.add(source.id);
    }
  });

export const TwinConfigSchema = z
  .object({
    excludedApps: z.array(z.string().min(1).max(100)).max(200),
    /** Kinds of window (by class, never by title) that are not read, whatever app they belong to. Empty by default. */
    excludedWindowClasses: z.array(z.enum(WINDOW_CLASSES)).max(WINDOW_CLASSES.length).default([]),
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
    /** Screen text from the primary display. Off until the person turns it on, in settings or during setup. */
    screenCaptureEnabled: z.boolean().default(false),
    /** Microphone text. Off until the person turns it on, in settings or during setup. */
    audioCaptureEnabled: z.boolean().default(false),
    /** Whether the sound the computer plays is transcribed. Off until the person turns it on. */
    systemAudioCaptureEnabled: z.boolean().default(false),
    /** Whether voices in microphone and system audio are compared, so segments get a name. Off until the person turns it on. See speaker/match.ts. */
    speakerIdentificationEnabled: z.boolean().default(false),
    /** Text the person types into apps, kept as finished pieces. Off until the person turns it on. See keystroke-text.ts. */
    keystrokeCaptureEnabled: z.boolean().default(false),
    /** The read-only API on 127.0.0.1 for other programs on this device. Off until the person turns it on. */
    localApiEnabled: z.boolean().default(false),
    /** How many days captured screen images are kept. Their text is kept for the same 90 days as the rest of the history. */
    frameRetentionDays: z.union([z.literal(1), z.literal(3), z.literal(7), z.literal(14)]).default(7),
    /** Whether the person paused screen and microphone capture. Kept here, so a relaunch keeps the pause. Set by the pause control. */
    capturePaused: z.boolean().default(false),
    /** Saved pipes. Empty until the person adds one. Each runs on its own schedule. See pipes.ts. */
    pipes: PipesSchema.default([]),
    /** Imported sources the person added. Empty until they add one. The desktop app owns the list. Items are in the store. See connectors/types.ts. */
    connectors: ConnectorSourcesSchema.default([]),
  })
  .strict();
export type TwinConfig = z.infer<typeof TwinConfigSchema>;

/**
 * The config after a settings patch, checked as a whole. The merged object is parsed, never the patch on its own: a patch
 * parsed alone gets every defaulted field filled in with its default, and that would overwrite each saved value the patch
 * does not name. A key whose value is undefined is not a change. Throws on anything that is not an object, and on an
 * unknown key or a value the schema refuses.
 */
export function mergeConfigPatch(current: TwinConfig, patch: unknown): TwinConfig {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new Error('Invalid settings.');
  const changes = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  return TwinConfigSchema.parse({ ...current, ...changes });
}

export const DEFAULT_CONFIG: TwinConfig = {
  excludedWindowClasses: [],
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
  // Screen and microphone capture, and the local API, stay off until the person turns them on.
  screenCaptureEnabled: false,
  audioCaptureEnabled: false,
  systemAudioCaptureEnabled: false,
  speakerIdentificationEnabled: false,
  keystrokeCaptureEnabled: false,
  localApiEnabled: false,
  frameRetentionDays: 7,
  capturePaused: false,
  pipes: [],
  // Imported sources stay off until the person adds one.
  connectors: [],
};
