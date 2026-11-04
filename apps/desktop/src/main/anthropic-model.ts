import Anthropic from '@anthropic-ai/sdk';
import type { CompletionRequest, NetworkEntry, OperatorModel } from '@companyos/twin-core';

/**
 * The task operator's model on Anthropic: Claude Opus 5.5 through the Messages API. A request carries the task's goal, the
 * front app's control names and the steps so far; the text inside fields and memory notes go only when the person ticked
 * the box for that task. The reply is one JSON object held to the turn's schema by structured outputs. Every call is
 * written to the ledger with the host, the path, the bytes sent and whether it carried screen text, never the content.
 */
const ANTHROPIC_HOST = 'api.anthropic.com';
const ANTHROPIC_PATH = '/v1/messages';
const ANTHROPIC_MODEL = 'claude-opus-5-5';
const KEY_SHAPE = /^sk-ant-[A-Za-z0-9_-]{20,300}$/;
const CALL_TIMEOUT_MS = 120_000;
/**
 * Room for the model's thinking and the reply. Claude Opus 5.5 always thinks before it answers, so a small cap would cut a
 * reply off; tokens are billed as used, not as allowed.
 */
const REPLY_TOKENS = 16_000;

export function validAnthropicKey(key: string): boolean {
  return KEY_SHAPE.test(key);
}

interface AnthropicChatOptions {
  apiKey: string;
  model?: string;
  /** Whether this task sends text from the screen or memory notes. The ledger shows it on every call. */
  sharesScreenText: boolean;
  record: (entry: NetworkEntry) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * What a failed call means, in words the person can act on. Each is a fixed sentence with the status number, so no part of
 * the response body or the key reaches the page.
 */
export function anthropicFailure(error: unknown): string {
  if (error instanceof Anthropic.APIUserAbortError) return 'The task was stopped.';
  if (error instanceof Anthropic.APIConnectionTimeoutError) return 'Anthropic did not answer within 2 minutes. Try again.';
  if (error instanceof Anthropic.APIConnectionError) return 'Anthropic could not be reached. Check the internet connection.';
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return `Anthropic refused the key (${error.status}). Remove the key on the Tasks page and save one that works.`;
  }
  if (error instanceof Anthropic.RateLimitError) return 'Anthropic is limiting calls for this key (429). Wait a minute, then try again.';
  if (error instanceof Anthropic.NotFoundError) return 'Anthropic does not offer this model to this key (404).';
  if (error instanceof Anthropic.BadRequestError) return 'Anthropic could not take the request (400). The account may have no credit left; check console.anthropic.com.';
  if (error instanceof Anthropic.APIError && typeof error.status === 'number' && error.status >= 500) return `Anthropic had a problem on its side (${error.status}). Try again in a minute.`;
  if (error instanceof Anthropic.APIError) return `Anthropic returned ${error.status ?? 'an error'}.`;
  return 'The call to Anthropic failed.';
}

/** A copy of a JSON schema with additionalProperties false on every object, as structured outputs require. */
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) copy[key] = key === 'enum' || key === 'required' ? value : strictSchema(value);
  if (copy.type === 'object') copy.additionalProperties = false;
  return copy;
}

export function createAnthropicChat(options: AnthropicChatOptions): OperatorModel {
  if (!validAnthropicKey(options.apiKey)) throw new Error('The Anthropic key is not in the sk-ant- format.');
  // The address is fixed, so a base URL set in the environment cannot carry task steps to another host.
  const client = new Anthropic({
    apiKey: options.apiKey,
    baseURL: `https://${ANTHROPIC_HOST}`,
    timeout: CALL_TIMEOUT_MS,
    maxRetries: 1,
    ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
  });
  const model = options.model ?? ANTHROPIC_MODEL;
  const now = options.now ?? Date.now;
  return {
    async complete(request: CompletionRequest): Promise<unknown> {
      const ts = now();
      const schema = strictSchema(request.schema) as Record<string, unknown>;
      const bytes = Buffer.byteLength(JSON.stringify({ system: request.system, prompt: request.prompt, schema }));
      const log = (outcome: NetworkEntry['outcome'], status?: number): void =>
        options.record({
          ts,
          purpose: 'remote_model',
          host: ANTHROPIC_HOST,
          path: ANTHROPIC_PATH,
          bytes,
          outcome,
          sharedScreenText: options.sharesScreenText,
          ...(status === undefined ? {} : { status }),
        });

      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await client.beta.messages.create(
          {
            model,
            max_tokens: Math.max(request.maxTokens, REPLY_TOKENS),
            system: request.system,
            messages: [{ role: 'user', content: request.prompt }],
            // One step is one small decision, so the model thinks briefly. The reply must match the turn's schema.
            output_config: { effort: 'low', format: { type: 'json_schema', schema } },
            // When Claude declines a step on policy grounds, the API runs the same request on a fallback model it picks.
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
          },
          request.signal ? { signal: request.signal } : undefined,
        );
      } catch (error) {
        // A Stop is not a failure of Anthropic, so it is not reported as one.
        log(request.signal?.aborted ? 'cancelled' : 'failed', error instanceof Anthropic.APIError && typeof error.status === 'number' ? error.status : undefined);
        throw new Error(anthropicFailure(error));
      }
      if (message.stop_reason === 'refusal') {
        log('failed');
        throw new Error('Claude declined this step.');
      }
      const text = message.content.find((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')?.text;
      try {
        const parsed: unknown = JSON.parse(text ?? '');
        log('ok');
        return parsed;
      } catch {
        log('failed');
        throw new Error(message.stop_reason === 'max_tokens' ? 'Claude ran out of room before it answered.' : 'Claude gave an answer that is not JSON.');
      }
    },
  };
}
