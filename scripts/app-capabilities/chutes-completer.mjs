// Sends a capability request to a Chutes model over its OpenAI-compatible API. This is a test harness for comparing models.
// The desktop app does not use it: the app's rule is that nothing it sends leaves the device except model and update
// requests, and this sends the application's control names to Chutes. Run it only on applications whose control names are
// not personal.
//
// The key is passed in by the caller and sent only as a Bearer header. It is never logged, returned or written to a file,
// and every error message here is a fixed sentence that does not include the key or the response body.
const DEFAULT_ENDPOINT = 'https://llm.chutes.ai/v1/chat/completions';
const KEY_SHAPE = /^cpk_\S+$/;

/**
 * A LocalCompleter-shaped object for one Chutes model. The token budget is the request's maxTokens, which is the app's
 * own budget, unless maxTokens is given here. onResult receives one record per call: how it ended, how long it took, the
 * finish reason, and the parsed reply when there is one.
 */
export function createChutesCompleter({
  apiKey,
  model,
  maxTokens,
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl = fetch,
  timeoutMs = 180_000,
  noThink = false,
  onResult = () => {},
}) {
  if (typeof apiKey !== 'string' || !KEY_SHAPE.test(apiKey)) throw new Error('The Chutes key is missing or not in the cpk_ format.');
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
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: prompt },
            ],
            max_tokens: budget,
            temperature: 0,
            // Qwen-style switch for hidden reasoning. Without it, big reasoning models spend the whole budget thinking.
            ...(noThink ? { chat_template_kwargs: { enable_thinking: false } } : {}),
            response_format: { type: 'json_schema', json_schema: { name: 'reply', schema } },
          }),
          signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]),
        });
      } catch (error) {
        const reason = error?.name === 'TimeoutError' ? 'timeout' : error?.name === 'AbortError' ? 'aborted' : 'network';
        record({ ok: false, reason });
        throw new Error(`The Chutes call did not finish: ${reason}.`);
      }
      if (!response.ok) {
        record({ ok: false, reason: 'http', status: response.status });
        throw new Error(`Chutes returned ${response.status}.`);
      }

      let body;
      try {
        body = await response.json();
      } catch {
        record({ ok: false, reason: 'bad_body' });
        throw new Error('Chutes returned a body that is not JSON.');
      }
      const choice = body.choices?.[0];
      const finish = choice?.finish_reason ?? null;
      const tokens = body.usage?.completion_tokens ?? null;
      const { text, stripped } = unwrap(choice?.message?.content ?? '');
      try {
        const reply = JSON.parse(text);
        record({ ok: true, finish, tokens, stripped, reply });
        return reply;
      } catch {
        record({ ok: false, reason: finish === 'length' ? 'truncated' : 'not_json', finish, tokens, stripped });
        throw new Error('The reply was not JSON.');
      }
    },
  };
}

/** Removes a reasoning block and a code fence when a model adds them, and reports that it did. */
export function unwrap(content) {
  const trimmed = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const text = fenced ? fenced[1] : trimmed;
  return { text, stripped: text !== content.trim() };
}
