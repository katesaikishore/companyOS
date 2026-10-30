import { CATALOG } from '../models/catalog';
import type { InstalledModel, ModelSpec } from '../models/types';

/**
 * The chat model the engine should run: the recommended one when it is installed, otherwise the smallest installed one.
 * Undefined when no chat model is installed, so the rule-based names stay in place.
 */
export function chooseChatModel(
  installed: readonly InstalledModel[],
  preferredId?: string,
  catalog: readonly ModelSpec[] = CATALOG,
): ModelSpec | undefined {
  const chats = catalog.filter(spec => spec.role === 'chat' && installed.some(model => model.id === spec.id));
  if (chats.length === 0) return undefined;
  return chats.find(spec => spec.id === preferredId) ?? [...chats].sort((a, b) => a.sizeBytes - b.sizeBytes)[0];
}
