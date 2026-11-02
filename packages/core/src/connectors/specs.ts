import { GMAIL_SCOPE, GOOGLE_HOSTS } from '../mail/gmail';
import type { ConnectorSpec } from './connector';

/**
 * Gmail as the connector layer sees it. The grant asks only for reading mail. Sending mail needs a separate send scope,
 * which is not requested until the person chooses it, so a send is refused for an account that was connected to read only.
 */
export const GMAIL_CONNECTOR: ConnectorSpec = {
  id: 'gmail',
  name: 'Gmail',
  hosts: GOOGLE_HOSTS,
  scopes: [GMAIL_SCOPE],
};
