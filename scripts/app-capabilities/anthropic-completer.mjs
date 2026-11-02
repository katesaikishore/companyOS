// Sends a capability request to a Claude model through the Anthropic Messages API. This is a test harness for comparing
// models, like the Chutes one. The desktop app does not use it, and it sends the application's control names to Anthropic,
// so run it only on applications whose control names are not personal.
//
// The reply comes back as the input of one tool, reply, whose input schema is the app's schema, so the output has the same
// shape the Chutes completer returns. The key is sent only as the x-api-key header. It is never logged, returned or written to a file, and
// every error message here is a fixed sentence that does not include the key or the response body.
const DEFAULT_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const KEY_SHAPE = /^sk-ant-\S+$/;

/**
 * A LocalCompleter-shaped object for one Claude model. The token budget is the request's maxTokens, which is the app's
 * own budget, unless maxTokens is given here. onResult receives one record per call, with the parsed reply when there is one.
 */
export function createAnthropicCompleter({
  apiKey,
  model,
  maxTokens,
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl = fetch,
  timeoutMs = 180_000,
  onResult = () => {},
}) {
  if (typeof apiKey !== 'string' || !KEY_SHAPE.test(apiKey)) throw new Error('The Anthropic key is missing or not in the sk-ant- format.');
  return {
    async complete(request) {
      const { system, prompt, schema, signal } = request;
      const budget = maxTokens ?? request.maxTokens;
      const started = Date.now();
      const record = fields => onResult({ ms: Date.now() - started, budget, ...fields });

      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            max_tokens: budget,
            system: `${system}\nAnswer only by calling the reply tool.`,
            messages: [{ role: 'user', content: prompt }],
            tools: [{ name: 'reply', description: 'Give the answer in the required shape.', input_schema: schema }],
            // Forced tool choice is refused by some Claude models, so every model gets automatic choice and the prompt asks for the call.
            tool_choice: { type: 'auto' },
          }),
          signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]),
        });
      } catch (error) {
        const reason = error?.name === 'TimeoutError' ? 'timeout' : error?.name === 'AbortError' ? 'aborted' : 'network';
        record({ ok: false, reason });
        throw new Error(`The Anthropic call did not finish: ${reason}.`);
      }
      if (!response.ok) {
        record({ ok: false, reason: 'http', status: response.status });
        throw new Error(`Anthropic returned ${response.status}.`);
      }

      let body;
      try {
        body = await response.json();
      } catch {
        record({ ok: false, reason: 'bad_body' });
        throw new Error('Anthropic returned a body that is not JSON.');
      }
      const finish = body.stop_reason ?? null;
      const tokens = body.usage?.output_tokens ?? null;
      const answer = (body.content ?? []).find(part => part.type === 'tool_use' && part.name === 'reply');
      if (!answer) {
        record({ ok: false, reason: finish === 'max_tokens' ? 'truncated' : 'no_tool_reply', finish, tokens });
        throw new Error('The reply had no tool answer.');
      }
      record({ ok: true, finish, tokens, stripped: false, reply: answer.input });
      return answer.input;
    },
  };
}
