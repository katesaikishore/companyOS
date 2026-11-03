import { createHash } from 'node:crypto';
import { hostAllowed } from '../models/download';
import type { NetworkEntry } from '../models/types';
import { connectionState, type ConnectorSpec, type StoredTokens, type TokenVault } from './connector';

/**
 * A message the assistant drafted for the person to send. Only the person sends it, and only the exact text they approved.
 * Nothing in this module sends anything on its own: a send needs an approval that matches the draft, and each approval
 * works once.
 */
export interface OutboundDraft {
  connectorId: string;
  /** One named action, such as "send_mail" or "post_message". Never a bundle of actions. */
  action: string;
  /** Where it goes: an address, a channel, or a thread. The person sees it before approving. */
  recipient: string;
  /** The text that goes out. */
  body: string;
}

/**
 * The person's approval of one exact draft. Only the interface the person uses may create one, and only after they have
 * read the draft. An approval that does not match the draft, or that was already used, is refused.
 */
export interface Approval {
  digest: string;
  approvedAt: number;
}

const REFUSALS = {
  not_connected: 'This account is not connected.',
  needs_sign_in: 'This account needs to sign in again.',
  wrong_connector: 'This draft is for another account.',
  host_not_allowed: 'That address is not one this account may use.',
  not_https: 'The address must use https.',
  approval_mismatch: 'The draft changed after it was approved.',
  approval_used: 'This approval has already been used.',
  send_failed: 'The send did not finish. Approve it again to retry.',
} as const;

export type OutboundRefusal = keyof typeof REFUSALS;

export class OutboundRefused extends Error {
  constructor(readonly reason: OutboundRefusal) {
    super(REFUSALS[reason]);
    this.name = 'OutboundRefused';
  }
}

/** The approval a person gives for one draft. Nothing else in the app creates one. */
export function approve(draft: OutboundDraft, now: number): Approval {
  return { digest: draftDigest(draft), approvedAt: now };
}

/** A digest of exactly what would be sent. Any change to the draft changes it. */
export function draftDigest(draft: OutboundDraft): string {
  return createHash('sha256')
    .update(JSON.stringify([draft.connectorId, draft.action, draft.recipient, draft.body]))
    .digest('hex');
}

export interface OutboundDeps {
  vault: TokenVault;
  /** Every send attempt is written to the ledger, with where it went and how many bytes, and never the text. */
  record: (entry: NetworkEntry) => void;
  now?: () => number;
}

export interface SendRequest {
  spec: ConnectorSpec;
  draft: OutboundDraft;
  approval: Approval;
  /** Where the send goes. It must be https and on the connector's host list. */
  endpoint: URL;
  /** Makes the call with the stored tokens. Only this function sees the access token. */
  transport: (tokens: StoredTokens) => Promise<void>;
}

/**
 * Sends an approved draft, once. The approval is spent before the call, so a failed send needs a fresh approval and cannot
 * go out twice.
 */
export class OutboundGate {
  private readonly spent = new Set<string>();

  constructor(private readonly deps: OutboundDeps) {}

  async send(request: SendRequest): Promise<void> {
    const { spec, draft, approval, endpoint, transport } = request;
    const started = this.deps.now?.() ?? Date.now();

    if (draft.connectorId !== spec.id) throw new OutboundRefused('wrong_connector');
    const state = await connectionState(spec, this.deps.vault, started);
    if (state.status === 'not_connected') throw new OutboundRefused('not_connected');
    if (state.status === 'needs_sign_in') throw new OutboundRefused('needs_sign_in');
    if (endpoint.protocol !== 'https:') throw new OutboundRefused('not_https');
    if (!hostAllowed(endpoint.hostname, spec.hosts)) throw new OutboundRefused('host_not_allowed');
    if (approval.digest !== draftDigest(draft)) throw new OutboundRefused('approval_mismatch');
    if (this.spent.has(approval.digest)) throw new OutboundRefused('approval_used');
    this.spent.add(approval.digest);

    const tokens = await this.deps.vault.load(spec.id);
    if (!tokens) throw new OutboundRefused('not_connected');
    try {
      await transport(tokens);
    } catch {
      this.log(endpoint, draft, started, 'failed');
      throw new OutboundRefused('send_failed');
    }
    this.log(endpoint, draft, started, 'ok');
  }

  private log(endpoint: URL, draft: OutboundDraft, ts: number, outcome: 'ok' | 'failed'): void {
    this.deps.record({
      ts,
      purpose: 'connector_send',
      host: endpoint.hostname,
      // The path only. A query can hold identifiers, so it is left out of the ledger.
      path: endpoint.pathname,
      bytes: Buffer.byteLength(draft.body),
      outcome,
    });
  }
}
