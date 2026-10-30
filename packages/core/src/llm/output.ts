import { z } from 'zod';

/** Limits shared by the JSON Schema the model is constrained with and the Zod check that follows it. */
export const ROUTINE_NAME_LIMITS = { minLength: 3, maxLength: 60, maxWords: 8 } as const;

/** Letters, digits, spaces and light punctuation. No newlines, quotes, markup or other control characters. */
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ,.&'()/+-]*$/u;

/** The JSON Schema given to the model, so it can only produce an object with one string field. */
export const ROUTINE_NAME_JSON_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: ROUTINE_NAME_LIMITS.minLength, maxLength: ROUTINE_NAME_LIMITS.maxLength },
  },
  required: ['name'],
  additionalProperties: false,
} as const;

const RoutineName = z
  .string()
  .trim()
  .min(ROUTINE_NAME_LIMITS.minLength)
  .max(ROUTINE_NAME_LIMITS.maxLength)
  .regex(NAME_PATTERN, 'Use plain words and digits.')
  .refine(name => name.split(/\s+/).length <= ROUTINE_NAME_LIMITS.maxWords, 'Use at most eight words.')
  .transform(name => name.replace(/\s+/g, ' '));

/** Checks what the model produced. Anything else is treated as invalid output and the rule-based name is kept. */
export const RoutineNameOutputSchema = z.object({ name: RoutineName }).strict();
export type RoutineNameOutput = z.infer<typeof RoutineNameOutputSchema>;
