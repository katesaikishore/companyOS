import type { ModelTemplate } from './template';

/**
 * The most characters the worker accepts in the system text or the prompt of one request. The worker refuses a longer
 * one, and a refusal looks like a model failure, so the prompt builder keeps inside this limit (see prompt.ts).
 */
export const MAX_WORKER_TEXT_CHARS = 4_000;

/**
 * Messages between the engine's worker client and the utility process that runs the model. Every reply carries the id
 * of the request it answers. Failures carry only a stage, never error text, because error text can name file paths.
 */
export type WorkerRequest =
  | {
      type: 'load';
      id: number;
      /** The directory the model must live in. The worker refuses a path outside it. */
      modelsDir: string;
      modelPath: string;
      contextSize: number;
      /** How the worker writes each prompt for this model. See template.ts. */
      template: ModelTemplate;
    }
  | {
      type: 'complete';
      id: number;
      system: string;
      prompt: string;
      schema: Readonly<Record<string, unknown>>;
      maxTokens: number;
    };

export type WorkerResponse =
  | { type: 'loaded'; id: number }
  | { type: 'completed'; id: number; value: unknown }
  | { type: 'failed'; id: number; stage: 'load' | 'complete' };
