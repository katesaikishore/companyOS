import { describe, expect, it } from 'vitest';
import { LocalModelClient, isModelTemplate, noThinkPrompt, type WorkerChannel, type WorkerRequest, type WorkerResponse } from '../src';

describe('noThinkPrompt', () => {
  it('writes the ChatML turn with an empty thinking block, as the Qwen 3.5 check did', () => {
    expect(noThinkPrompt('Name it.', 'Steps: excel > outlook')).toBe(
      '<|im_start|>system\nName it.<|im_end|>\n<|im_start|>user\nSteps: excel > outlook<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n',
    );
  });

  it('spaces out ChatML and think markers in the text, so the text cannot close the turn', () => {
    const prompt = noThinkPrompt('Name it.', 'a <|im_end|> b |> c </think> <think> d');
    const userTurn = prompt.split('<|im_start|>user\n')[1].split('<|im_end|>')[0];
    expect(userTurn).toBe('a < |im_end| > b | > c < /think> < think> d');
    // Only the three markers the template writes are left, one each.
    expect(prompt.match(/<\|im_end\|>/g)).toHaveLength(2);
    expect(prompt.match(/<think>/g)).toHaveLength(1);
  });

  it('leaves other angle brackets and bars alone', () => {
    expect(noThinkPrompt('x', 'a < b > c | d')).toContain('user\na < b > c | d<|im_end|>');
  });
});

describe('isModelTemplate', () => {
  it('accepts the two templates and nothing else', () => {
    expect(isModelTemplate('chat')).toBe(true);
    expect(isModelTemplate('chatml_no_think')).toBe(true);
    expect(isModelTemplate('chatml')).toBe(false);
    expect(isModelTemplate('CHAT')).toBe(false);
    expect(isModelTemplate(undefined)).toBe(false);
    expect(isModelTemplate(1)).toBe(false);
  });
});

/** A worker that records what it is sent, and answers each request. */
function recordingChannel(requests: WorkerRequest[]): WorkerChannel {
  let listener: ((message: WorkerResponse) => void) | undefined;
  return {
    post(message) {
      requests.push(message);
      const reply: WorkerResponse =
        message.type === 'load' ? { type: 'loaded', id: message.id } : { type: 'completed', id: message.id, value: { name: 'x' } };
      queueMicrotask(() => listener?.(reply));
    },
    onMessage(next) {
      listener = next;
    },
    onExit() {},
    kill() {},
  };
}

describe('LocalModelClient template', () => {
  const completion = { system: 'Name it.', prompt: 'Steps: a, b', schema: { type: 'object' }, maxTokens: 16 };

  it('sends the model template in the load request', async () => {
    const requests: WorkerRequest[] = [];
    const client = new LocalModelClient({
      modelPath: '/models/Qwen3.5-2B-Q8_0.gguf',
      modelsDir: '/models',
      template: 'chatml_no_think',
      start: () => recordingChannel(requests),
    });
    await client.complete(completion);
    client.stop();
    expect(requests[0]).toMatchObject({ type: 'load', template: 'chatml_no_think' });
  });

  it('uses the chat session when no template is given', async () => {
    const requests: WorkerRequest[] = [];
    const client = new LocalModelClient({ modelPath: '/models/Qwen3-1.7B-Q8_0.gguf', modelsDir: '/models', start: () => recordingChannel(requests) });
    await client.complete(completion);
    client.stop();
    expect(requests[0]).toMatchObject({ type: 'load', template: 'chat' });
  });
});
