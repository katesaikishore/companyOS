/**
 * A service the person connects their own account to. Its tokens live in a vault the desktop app supplies, which keeps them
 * encrypted with the OS keychain. Nothing in this module reads or returns a token value. It only says whether a connector
 * is connected, and what it may reach.
 */
export interface ConnectorSpec {
  id: string;
  name: string;
  /** The only hosts this connector may call. Any other host is refused. */
  hosts: readonly string[];
  /** The scopes this connector asks for. It never asks for more than this list. */
  scopes: readonly string[];
}

export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  /** Milliseconds since the epoch. Left out when the service does not say when the access token ends. */
  expiresAt?: number;
  scopes: readonly string[];
}

/** Supplied by the desktop app. Tests supply an in-memory one. */
export interface TokenVault {
  load(connectorId: string): Promise<StoredTokens | undefined>;
  save(connectorId: string, tokens: StoredTokens): Promise<void>;
  clear(connectorId: string): Promise<void>;
}

/** What the app may show about a connector. It holds no token and no secret. */
export interface ConnectionState {
  connectorId: string;
  status: 'not_connected' | 'connected' | 'needs_sign_in';
  scopes: readonly string[];
  expiresAt?: number;
}

/**
 * Whether the connector is usable now. A connector needs sign-in again when it has no tokens, when the access token has
 * ended and there is no refresh token, or when a scope the connector asks for is missing from the stored grant.
 */
export async function connectionState(spec: ConnectorSpec, vault: TokenVault, now: number): Promise<ConnectionState> {
  const tokens = await vault.load(spec.id);
  if (!tokens) return { connectorId: spec.id, status: 'not_connected', scopes: [] };
  const base = { connectorId: spec.id, scopes: [...tokens.scopes], expiresAt: tokens.expiresAt };
  const ended = tokens.expiresAt !== undefined && tokens.expiresAt <= now && !tokens.refreshToken;
  const missing = spec.scopes.some(scope => !tokens.scopes.includes(scope));
  return { ...base, status: ended || missing ? 'needs_sign_in' : 'connected' };
}
