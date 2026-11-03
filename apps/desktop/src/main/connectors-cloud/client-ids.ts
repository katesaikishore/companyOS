/**
 * The OAuth client ids for the cloud connectors. A client id is public, but it belongs to the owner's provider account, so
 * none is committed here: both values are empty, and a provider with an empty id is "not configured". Connecting then
 * refuses before any browser opens.
 *
 * The environment overrides (COMPANYOS_GOOGLE_CLIENT_ID and COMPANYOS_GITHUB_CLIENT_ID) are for development only. A packaged
 * build ignores them, so a release carries exactly the ids the owner put here. Setup steps are in docs-site/development.mdx.
 */
import { CLOUD_PROVIDER_IDS, type ClientIds, type CloudProviderId } from './providers';

/** The ids this build ships with. Empty until the owner registers the OAuth apps and fills them in. */
const BUILT_IN_CLIENT_IDS: Readonly<Record<CloudProviderId, string>> = {
  googleCalendar: '',
  github: '',
};

/** The variable a developer sets to try a provider before its id is built in. */
const CLIENT_ID_ENVIRONMENT: Readonly<Record<CloudProviderId, string>> = {
  googleCalendar: 'COMPANYOS_GOOGLE_CLIENT_ID',
  github: 'COMPANYOS_GITHUB_CLIENT_ID',
};

interface ClientIdOptions {
  /** True in a packaged build. The environment is then not read. */
  packaged: boolean;
  env: Readonly<Record<string, string | undefined>>;
  /** Defaults to BUILT_IN_CLIENT_IDS. The tests pass their own. */
  built?: Readonly<Record<CloudProviderId, string>>;
}

/** The client id of each provider for this run. A blank value counts as missing. */
export function clientIdsFor(options: ClientIdOptions): ClientIds {
  const built = options.built ?? BUILT_IN_CLIENT_IDS;
  const ids: ClientIds = {};
  for (const id of CLOUD_PROVIDER_IDS) {
    const override = options.packaged ? '' : (options.env[CLIENT_ID_ENVIRONMENT[id]] ?? '').trim();
    ids[id] = override !== '' ? override : built[id];
  }
  return ids;
}
