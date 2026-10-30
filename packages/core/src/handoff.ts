import { z } from 'zod';

/**
 * Every state a handoff can be in: "sending" while its CLI runs, then the state OpenMausBot reported. "unknown" is set by
 * companyOS, never reported by the CLI: the handoff closed without a reply, so the job may already exist.
 */
export const HANDOFF_STATES = [
  'sending',
  'completed',
  'idle',
  'needs-input',
  'failed',
  'stalled',
  'timed-out',
  'cancelled',
  'unknown',
] as const;

/** The most handoffs one read returns. The newest come first. */
export const HANDOFF_READ_LIMIT = 100;

/**
 * Written in place of a reply when a handoff closed without one: the app closed mid-send, the local wait ran out, or the
 * CLI's output was too large, unreadable, or ended in a non-zero exit with no valid state. The job may already exist in
 * OpenMausBot.
 */
export const UNKNOWN_HANDOFF_SUMMARY = 'Outcome unknown. Check OpenMausBot before sending again.';

/**
 * A handoff as the twin keeps it. The lengths are bounded here, so a stored record cannot grow past what the handoff
 * sent or what OpenMausBot returned. It keeps the brief, the routine name and id, the target, the app names, the
 * cadence, the state, the reply or companyOS's message, the thread id and the sanitised job tree.
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
    /**
     * True when companyOS wrote the summary, not OpenMausBot: the CLI could not be run or gave no reply, the local wait
     * ran out, or the handoff closed without a reply.
     */
    localFailure: z.boolean(),
  })
  .strict();
