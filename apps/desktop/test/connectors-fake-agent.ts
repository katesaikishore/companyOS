import type { ConnectorItem, TwinConfig } from '@companyos/twin-core';
import type { ConnectorStore } from '../src/main/connectors-runner';

/**
 * A stand-in for the engine's connector methods, for the runner and scheduler tests. It keeps the items per source key,
 * the way the engine does: a re-import of the same sourceId replaces the item. Sources are kept as plain objects.
 */
export interface FakeSource {
  id: string;
  kind: string;
  label: string;
  path?: string;
  createdAt: number;
  lastImportedAt?: number;
}

export interface FakeAgent extends ConnectorStore {
  /** The stored items of one source key, in insertion order. */
  itemsOf(sourceKey: string): ConnectorItem[];
  /** How many ingest calls were made, across all sources. */
  readonly ingestCalls: number;
  /** Runs before each ingest call. A test uses it to change state in the middle of an import. */
  beforeIngest?: () => void;
  /** Makes the next ingest call throw. */
  failIngest: boolean;
  sources(): FakeSource[];
}

export function fakeAgent(initial: FakeSource[] = []): FakeAgent {
  let connectors: FakeSource[] = initial.map(source => ({ ...source }));
  const items = new Map<string, Map<string, ConnectorItem>>();
  let ingests = 0;
  const agent: FakeAgent = {
    failIngest: false,
    beforeIngest: undefined,
    get ingestCalls() {
      return ingests;
    },
    get configuration(): TwinConfig {
      return { connectors: connectors.map(source => ({ ...source })) } as unknown as TwinConfig;
    },
    sources: () => connectors.map(source => ({ ...source })),
    ingestConnectorItems(sourceKey, batch) {
      ingests += 1;
      agent.beforeIngest?.();
      if (agent.failIngest) throw new Error('The store is closed.');
      const bucket = items.get(sourceKey) ?? new Map<string, ConnectorItem>();
      items.set(sourceKey, bucket);
      for (const item of batch) bucket.set(item.sourceId, item);
      return batch.length;
    },
    removeConnectorItems(sourceKey) {
      const removed = items.get(sourceKey)?.size ?? 0;
      items.delete(sourceKey);
      return removed;
    },
    updateConfig(patch) {
      if (patch.connectors !== undefined) connectors = patch.connectors.map(source => ({ ...source })) as FakeSource[];
      return agent.configuration;
    },
    itemsOf(sourceKey) {
      return [...(items.get(sourceKey)?.values() ?? [])];
    },
  };
  return agent;
}
