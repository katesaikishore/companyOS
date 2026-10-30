import { z } from 'zod';

/** Every state a handoff can be in: "sending" while its CLI runs, then the state OpenMausBot reported. */
export const HANDOFF_STATES = [
  'sending',
  'completed',
  'idle',
  'needs-input',
  'failed',
  'stalled',
  'timed-out',
  'cancelled',
] as const;

/** The most handoffs one read returns. The newest come first. */
export const HANDOFF_READ_LIMIT = 100;

/** Written in place of a reply when the app closed before OpenMausBot answered. The job may still be running there. */
export const INTERRUPTED_HANDOFF_SUMMARY =
  'companyOS closed before OpenMausBot replied. The job may still be running in OpenMausBot.';

/**
 * A handoff as the twin keeps it. The lengths are bounded here, so a stored record cannot grow past what the handoff
 * sent or what OpenMausBot returned. Only the task brief, routine name, app names, cadence and the reply are kept.
 */
export const HandoffSchema = z
  .object({
    id: z.string().min(1).max(80),
    automationId: z.string().min(1).max(80),
    routineName: z.string().min(1).max(200),
    target: z.string().max(120),
    brief: z.string().min(1).max(500),
    /** Each entry is one app name, or the options of a step that varies, joined with " or ". */
    apps: z.array(z.string().min(1).max(1_100)).max(12),
    cadencePerWeek: z.number().nonnegative().optional(),
    sentAt: z.number().int().nonnegative(),
    state: z.enum(HANDOFF_STATES),
    summary: z.string().max(8_000),
    threadId: z.string().max(100).optional(),
    /** The harness job tree as sanitised JSON text. */
    taskTree: z.string().max(24_000).optional(),
    /** True when companyOS itself failed (for example the CLI was not found), so the summary is its message, not a reply. */
    localFailure: z.boolean(),
  })
  .strict();
