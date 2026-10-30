/**
 * The seam between the engine and a local language model. The engine never imports a model runtime. The desktop app
 * supplies an implementation that runs in a utility process, and tests supply a fake. An implementation must never
 * make a network call, and it must only load a model file from the device.
 */
export interface CompletionRequest {
  /** Instructions for the model. Built from abstract routine data only (see prompt.ts). */
  system: string;
  prompt: string;
  /** A JSON Schema the output must match. The runtime enforces it while generating, and callers still validate it. */
  schema: Readonly<Record<string, unknown>>;
  maxTokens: number;
  /** Aborted when the caller gives up. The implementation should stop generating and free its work. */
  signal?: AbortSignal;
}

export interface LocalCompleter {
  /** Resolves with the parsed JSON the model produced. Rejects on any failure. */
  complete(request: CompletionRequest): Promise<unknown>;
}
