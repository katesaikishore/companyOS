/**
 * How the worker writes a prompt to a model. 'chat' lets the model's own chat session do it, which is how the Qwen3 models
 * run. 'chatml_no_think' writes the ChatML turn out by hand, with an empty thinking block. Qwen 3.5 turns thinking on by
 * default in its chat template, and a chat session cannot switch it off, so the naming model would think first and run
 * out of its output budget. See docs/research/model-comparison.md.
 */
export const MODEL_TEMPLATES = ['chat', 'chatml_no_think'] as const;
export type ModelTemplate = (typeof MODEL_TEMPLATES)[number];

export function isModelTemplate(value: unknown): value is ModelTemplate {
  return typeof value === 'string' && (MODEL_TEMPLATES as readonly string[]).includes(value);
}

/**
 * A ChatML turn with thinking off. The person's text is kept as it is, except for anything that reads as a ChatML or
 * think marker. Those are spaced out, so the text cannot close the turn early or open a new one.
 */
export function noThinkPrompt(system: string, prompt: string): string {
  return `<|im_start|>system\n${neutral(system)}<|im_end|>\n<|im_start|>user\n${neutral(prompt)}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;
}

function neutral(text: string): string {
  return text.replace(/<\|/g, '< |').replace(/\|>/g, '| >').replace(/<(\/?)think>/g, '< $1think>');
}
