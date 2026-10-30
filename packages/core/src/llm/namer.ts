import type { Routine } from '../mine';
import { ROUTINE_NAME_JSON_SCHEMA, RoutineNameOutputSchema } from './output';
import { NAMING_SYSTEM_PROMPT, namingPrompt } from './prompt';
import type { LocalCompleter } from './types';

/** Longest wait for one name. Past this the rule-based name is kept and the model is stopped. */
export const NAMING_TIMEOUT_MS = 20_000;
const NAMING_MAX_TOKENS = 64;

export type FallbackReason = 'no_model' | 'timeout' | 'model_error' | 'invalid_output';

/** Either the model's name, or the reason the engine keeps its rule-based name. */
export type RoutineNaming = { source: 'model'; name: string } | { source: 'rule'; reason: FallbackReason };

export interface NameRoutineOptions {
  /** The local model. Without one, the rule-based name is kept. */
  completer?: LocalCompleter;
  timeoutMs?: number;
}

/**
 * Asks the local model for a routine's name. Output is constrained by JSON Schema while it is generated and checked
 * with Zod afterwards. Any failure, including no model, a timeout, an error or an invalid name, returns a rule
 * reason, and the caller keeps the rule-based name. This never throws.
 */
export async function nameRoutine(routine: Routine, options: NameRoutineOptions = {}): Promise<RoutineNaming> {
  const completer = options.completer;
  if (!completer) return { source: 'rule', reason: 'no_model' };

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<'expired'>(resolve => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('expired');
    }, options.timeoutMs ?? NAMING_TIMEOUT_MS);
  });
  try {
    const answer = await Promise.race([
      Promise.resolve().then(() =>
        completer.complete({
          system: NAMING_SYSTEM_PROMPT,
          prompt: namingPrompt(routine),
          schema: ROUTINE_NAME_JSON_SCHEMA,
          maxTokens: NAMING_MAX_TOKENS,
          signal: controller.signal,
        }),
      ),
      expired,
    ]);
    if (answer === 'expired') return { source: 'rule', reason: 'timeout' };
    const checked = RoutineNameOutputSchema.safeParse(answer);
    return checked.success ? { source: 'model', name: checked.data.name } : { source: 'rule', reason: 'invalid_output' };
  } catch {
    // The error text is dropped on purpose. It can name files or processes, and nothing downstream needs it.
    return { source: 'rule', reason: controller.signal.aborted ? 'timeout' : 'model_error' };
  } finally {
    clearTimeout(timer);
  }
}
