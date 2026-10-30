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
