import type { HardwareProfile, RunResult, SetupPlan, TwinBridge, TwinConfig, TwinStatus } from '@companyos/twin-core';

export type Route =
  | { name: 'overview' }
  | { name: 'suggestions' }
  | { name: 'automations' }
  | { name: 'automation'; id: string }
  | { name: 'ledger' }
  /** The app readiness list, or one app's detail when the route names an app. */
  | { name: 'readiness'; app?: string }
  | { name: 'settings' };

export interface Notice {
  text: string;
  tone: 'info' | 'error';
}

export interface SetupData {
  loading: boolean;
  hardware?: HardwareProfile;
  plan?: SetupPlan;
  error?: string;
}

/** A run result and when it arrived. The time is part of the stored value, so a repeat with the same steps still redraws. */
export type StoredRun = RunResult & { at: number };

/** Page state shared by the views. It lives in memory only; the twin's data stays in the main process. */
export const state = {
  status: undefined as TwinStatus | undefined,
  loadError: undefined as string | undefined,
  notice: undefined as Notice | undefined,
  /** Keys of actions in flight. Their buttons are disabled. */
  pending: new Set<string>(),
  /** Form keys with unsaved input. While any is set, the view is not rebuilt, so typing is never lost. */
  dirty: new Set<string>(),
  route: { name: 'overview' } as Route,
  wizardForced: false,
  wizardStep: 1,
  altOpen: false,
  setup: { loading: false } as SetupData,
  selectedSuggestion: undefined as string | undefined,
  selectedLedger: undefined as string | undefined,
  /** The tab the automation detail shows. It is here, with the other selections, so a tab click redraws the page. */
  automationTab: 'workflow' as 'workflow' | 'autonomy',
  runResults: new Map<string, StoredRun>(),
};

let renderer: (() => void) | undefined;
let kicker: (() => void) | undefined;

export function setRenderer(fn: () => void): void {
  renderer = fn;
}

/** Asks the poller to read status soon, so a button that starts a download shows its progress without waiting out the interval. */
export function setKicker(fn: () => void): void {
  kicker = fn;
}

export function requestRender(): void {
  renderer?.();
}

export function bridge(): TwinBridge {
  return window.twin;
}

export function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : '';
  const cleaned = raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '').trim();
  return cleaned || 'Something went wrong.';
}

export function setNotice(text: string, tone: Notice['tone'] = 'error'): void {
  state.notice = { text, tone };
}

export async function refresh(): Promise<void> {
  try {
    state.status = await bridge().status();
    state.loadError = undefined;
  } catch (error) {
    const text = errorText(error);
    if (state.status) setNotice(text);
    else state.loadError = text;
  }
  requestRender();
}

/** Runs one bridge action with its button disabled, shows any error, then redraws from fresh status. */
export async function act(key: string, task: () => Promise<void>): Promise<void> {
  if (state.pending.has(key)) return;
  state.pending.add(key);
  state.notice = undefined;
  requestRender();
  kicker?.();
  try {
    await task();
  } catch (error) {
    setNotice(errorText(error));
  } finally {
    state.pending.delete(key);
    await refresh();
  }
}

export function call(key: string, task: (twin: TwinBridge) => Promise<unknown>): Promise<void> {
  return act(key, async () => {
    await task(bridge());
  });
}

export function saveConfig(key: string, patch: Partial<TwinConfig>): Promise<void> {
  return call(key, twin => twin.updateConfig(patch));
}

export function confirmDeleteAll(): void {
  if (!window.confirm('Delete everything the twin knows about you? This removes all events, automations, any handoff records saved by an earlier version, and installed models on this device, including the optional decision model. It cannot be undone.')) {
    return;
  }
  void call('delete', twin => twin.deleteAll());
}

export function pending(key: string): boolean {
  return state.pending.has(key);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function routeFromHash(hash: string): Route {
  const [path = ''] = hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(part => part.length > 0);
  switch (parts[0]) {
    case 'suggestions':
      return { name: 'suggestions' };
    case 'automations':
      return parts[1] ? { name: 'automation', id: safeDecode(parts[1]) } : { name: 'automations' };
    case 'ledger':
      return { name: 'ledger' };
    case 'readiness':
      return parts[1] ? { name: 'readiness', app: safeDecode(parts[1]) } : { name: 'readiness' };
    case 'settings':
      return { name: 'settings' };
    default:
      return { name: 'overview' };
  }
}

export function routeKey(route: Route): string {
  if (route.name === 'automation') return `#/automations/${encodeURIComponent(route.id)}`;
  if (route.name === 'readiness' && route.app !== undefined) return `#/readiness/${encodeURIComponent(route.app)}`;
  return `#/${route.name}`;
}

/** Navigates by hash. Accepts '#/ledger' or 'ledger'. */
export function go(route: string): void {
  location.hash = route.startsWith('#') ? route : `#${route}`;
}

