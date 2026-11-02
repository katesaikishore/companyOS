/**
 * The cloud providers a person can connect, read-only. Endpoints and scopes live here. Client ids do not: the integrator
 * passes them in through `ClientIds`, so no identifier is committed to the repository.
 */

export type CloudProviderId = 'googleCalendar' | 'github';

export const CLOUD_PROVIDER_IDS: readonly CloudProviderId[] = ['googleCalendar', 'github'];

export interface CloudProvider {
  readonly id: CloudProviderId;
  readonly displayName: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  /** The narrowest scopes the connector can work with. */
  readonly scopes: readonly string[];
  /** Base of the read API. Tokens are sent only to this origin. */
  readonly apiBase: string;
  /** Extra authorization parameters the provider needs. */
  readonly authorizationParams: Readonly<Record<string, string>>;
}

export const CLOUD_PROVIDERS: Readonly<Record<CloudProviderId, CloudProvider>> = {
  googleCalendar: {
    id: 'googleCalendar',
    displayName: 'Google Calendar',
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    apiBase: 'https://www.googleapis.com/calendar/v3',
    // `offline` asks for a refresh token. `consent` makes Google issue one on every connect.
    authorizationParams: { access_type: 'offline', prompt: 'consent' },
  },
  github: {
    id: 'github',
    displayName: 'GitHub',
    authorizationUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    // OAuth apps have no read-only issue scope. `read:user` is the narrowest one offered. Issues in private repositories
    // need `repo`, which also grants write, so that choice is left to the owner (see the report).
    scopes: ['read:user'],
    apiBase: 'https://api.github.com',
    authorizationParams: {},
  },
};

/** Client ids from the build's configuration. A missing or blank id means the provider is not configured. */
export type ClientIds = Partial<Record<CloudProviderId, string>>;

export interface ConfiguredProvider extends CloudProvider {
  /** Undefined when this build has no client id for the provider. Connecting then refuses with a fixed sentence. */
  readonly clientId: string | undefined;
}

/** Joins a provider's endpoints with the client id configured for it. */
export function configureProvider(id: CloudProviderId, clientIds: ClientIds): ConfiguredProvider {
  const clientId = clientIds[id]?.trim();
  return { ...CLOUD_PROVIDERS[id], clientId: clientId ? clientId : undefined };
}

export function isCloudProviderId(value: unknown): value is CloudProviderId {
  return typeof value === 'string' && (CLOUD_PROVIDER_IDS as readonly string[]).includes(value);
}
