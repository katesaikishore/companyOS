import { z } from 'zod';
import type { Pseudonymizer } from './redact';
import type { Routine } from './mine';
import { WINDOW_CLASSES } from './types';

/**
 * The only shape that may leave the device. It is strict: any extra field, including a raw app
 * name, a URL or a title, fails validation before anything is sent.
 */
export const CloudTraceSchema = z
  .object({
    schemaVersion: z.literal(1),
    task: z.literal('name_automation'),
    steps: z
      .array(
        z
          .object({
            token: z.string().regex(/^app_[A-Za-z0-9_-]{12}$/),
            windowClass: z.enum(WINDOW_CLASSES),
            variable: z.boolean(),
          })
          .strict(),
      )
      .min(2)
      .max(8),
    support: z.number().int().nonnegative(),
    days: z.number().int().nonnegative(),
  })
  .strict();
export type CloudTrace = z.infer<typeof CloudTraceSchema>;

export const CLOUD_FIELDS_SENT = [
  'steps[].token (keyed pseudonym of app)',
  'steps[].windowClass',
  'steps[].variable',
  'support',
  'days',
] as const;

export function buildCloudTrace(routine: Routine, pseudonyms: Pseudonymizer): CloudTrace {
  return CloudTraceSchema.parse({
    schemaVersion: 1,
    task: 'name_automation',
    steps: routine.steps.map(step => ({
      token: pseudonyms.token('app', step.app),
      windowClass: step.windowClass,
      variable: step.options.length > 1,
    })),
    support: routine.support,
    days: routine.days,
  });
}

/** The subset of the Anthropic Messages API that this module uses. Tests inject a fake. */
export interface MessagesClient {
  messages: {
    create(body: Record<string, unknown>): Promise<{
      content: Array<{ type: string; text?: string }>;
      stop_reason: string | null;
    }>;
  };
}

export const CLOUD_MODEL = 'claude-opus-5-5';

const NAME_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
  },
  required: ['name', 'description'],
  additionalProperties: false,
};

const NameSchema = z.object({ name: z.string().min(3).max(60), description: z.string().min(10).max(200) }).strict();
export type NameSuggestion = z.infer<typeof NameSchema>;

export interface LedgerEntry {
  ts: number;
  purpose: 'name_automation';
  model: string;
  /** Fields handed to the client. Recorded for every attempt, even when the call later fails. */
  fieldsSent: readonly string[];
  outcome: 'ok' | 'refused' | 'error';
}

export interface NameResult {
  suggestion?: NameSuggestion;
  entry: LedgerEntry;
  /** A short, non-sensitive reason when there is no suggestion. */
  reason?: string;
}

/**
 * Asks the model for a name for an anonymised routine. The trace is validated again before sending.
 * Once the request is attempted, the ledger entry lists the fields whatever the outcome.
 */
export async function nameRoutine(trace: CloudTrace, client: MessagesClient, now: number): Promise<NameResult> {
  const checked = CloudTraceSchema.parse(trace);
  const entry = (outcome: LedgerEntry['outcome']): LedgerEntry => ({
    ts: now,
    purpose: 'name_automation',
    model: CLOUD_MODEL,
    fieldsSent: CLOUD_FIELDS_SENT,
    outcome,
  });

  let response: Awaited<ReturnType<MessagesClient['messages']['create']>>;
  try {
    response = await client.messages.create({
      model: CLOUD_MODEL,
      max_tokens: 1024,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: NAME_SCHEMA } },
      messages: [
        {
          role: 'user',
          content:
            'This is an anonymised trace of a repeated work routine. App names are pseudonyms; only window classes ' +
            'are meaningful. Give the routine a short plain name and a one-sentence description.\n\n' +
            JSON.stringify(checked),
        },
      ],
    });
  } catch {
    return { entry: entry('error'), reason: 'The request to Claude failed.' };
  }

  if (response.stop_reason === 'refusal') {
    return { entry: entry('refused'), reason: 'The model declined this request.' };
  }

  const text = response.content.find(block => block.type === 'text')?.text ?? '';
  try {
    return { suggestion: NameSchema.parse(JSON.parse(text)), entry: entry('ok') };
  } catch {
    return { entry: entry('error'), reason: 'The reply was not a usable name.' };
  }
}
