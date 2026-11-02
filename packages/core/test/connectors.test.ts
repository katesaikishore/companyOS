import { describe, expect, it } from 'vitest';
import type { NetworkEntry } from '../src/models/types';
import { connectionState, type ConnectorSpec, type StoredTokens, type TokenVault } from '../src/connectors/connector';
import { OutboundGate, OutboundRefused, approve, draftDigest, type OutboundDraft } from '../src/connectors/outbound';
import { GMAIL_CONNECTOR } from '../src/connectors/specs';
import { GMAIL_SCOPE, GOOGLE_HOSTS } from '../src/mail/gmail';

const NOW = 1_000_000;
const SECRET = 'access-token-value-for-test';
const SPEC: ConnectorSpec = { id: 'mailbox', name: 'Mailbox', hosts: ['mail.example.com'], scopes: ['read', 'send'] };
const DRAFT: OutboundDraft = { connectorId: 'mailbox', action: 'send_mail', recipient: 'pat@example.com', body: 'Thanks, will do.' };
const ENDPOINT = new URL('https://mail.example.com/v1/send');

function memoryVault(initial?: StoredTokens, connectorId: string = SPEC.id): TokenVault {
  const store = new Map<string, StoredTokens>();
  if (initial) store.set(connectorId, initial);
  return {
    async load(id) {
      return store.get(id);
    },
    async save(id, tokens) {
      store.set(id, tokens);
    },
    async clear(id) {
      store.delete(id);
    },
  };
}

const GOOD: StoredTokens = { accessToken: SECRET, refreshToken: 'refresh-test', scopes: ['read', 'send'] };

describe('connectionState', () => {
  it('is not connected with no tokens', async () => {
    expect(await connectionState(SPEC, memoryVault(), NOW)).toEqual({ connectorId: 'mailbox', status: 'not_connected', scopes: [] });
  });

  it('is connected with every scope the connector asks for', async () => {
    expect((await connectionState(SPEC, memoryVault(GOOD), NOW)).status).toBe('connected');
  });

  it('needs sign-in when a scope is missing from the grant', async () => {
    const readOnly = { ...GOOD, scopes: ['read'] };
    expect((await connectionState(SPEC, memoryVault(readOnly), NOW)).status).toBe('needs_sign_in');
  });

  it('needs sign-in when the access token has ended and there is no refresh token', async () => {
    const ended = { accessToken: SECRET, expiresAt: NOW - 1, scopes: ['read', 'send'] };
    expect((await connectionState(SPEC, memoryVault(ended), NOW)).status).toBe('needs_sign_in');
  });

  it('never returns a token value', async () => {
    const state = await connectionState(SPEC, memoryVault(GOOD), NOW);
    expect(JSON.stringify(state)).not.toContain(SECRET);
  });
});

describe('OutboundGate', () => {
  function setup(tokens: StoredTokens | undefined) {
    const entries: NetworkEntry[] = [];
    const gate = new OutboundGate({ vault: memoryVault(tokens), record: entry => entries.push(entry), now: () => NOW });
    const sent: string[] = [];
    const transport = async () => {
      sent.push(DRAFT.body);
    };
    return { gate, entries, sent, transport };
  }

  it('sends an approved draft once, and records where it went without the text', async () => {
    const { gate, entries, sent, transport } = setup(GOOD);
    await gate.send({ spec: SPEC, draft: DRAFT, approval: approve(DRAFT, NOW), endpoint: ENDPOINT, transport });
    expect(sent).toEqual([DRAFT.body]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ purpose: 'connector_send', host: 'mail.example.com', path: '/v1/send', outcome: 'ok' });
    expect(JSON.stringify(entries[0])).not.toContain(DRAFT.body);
  });

  it('refuses a second send with the same approval', async () => {
    const { gate, transport } = setup(GOOD);
    const approval = approve(DRAFT, NOW);
    await gate.send({ spec: SPEC, draft: DRAFT, approval, endpoint: ENDPOINT, transport });
    await expect(gate.send({ spec: SPEC, draft: DRAFT, approval, endpoint: ENDPOINT, transport })).rejects.toMatchObject({ reason: 'approval_used' });
  });

  it('refuses a draft that changed after it was approved', async () => {
    const { gate, transport } = setup(GOOD);
    const approval = approve(DRAFT, NOW);
    const changed = { ...DRAFT, body: 'Send the money instead.' };
    await expect(gate.send({ spec: SPEC, draft: changed, approval, endpoint: ENDPOINT, transport })).rejects.toMatchObject({ reason: 'approval_mismatch' });
  });

  it('refuses to send for an account that is not connected', async () => {
    const { gate, sent, transport } = setup(undefined);
    await expect(gate.send({ spec: SPEC, draft: DRAFT, approval: approve(DRAFT, NOW), endpoint: ENDPOINT, transport })).rejects.toBeInstanceOf(OutboundRefused);
    expect(sent).toHaveLength(0);
  });

  it('refuses an address that is not on the connector list, and plain http', async () => {
    const { gate, sent, transport } = setup(GOOD);
    const approval = approve(DRAFT, NOW);
    await expect(gate.send({ spec: SPEC, draft: DRAFT, approval, endpoint: new URL('https://evil.example.org/send'), transport })).rejects.toMatchObject({ reason: 'host_not_allowed' });
    await expect(gate.send({ spec: SPEC, draft: DRAFT, approval, endpoint: new URL('http://mail.example.com/send'), transport })).rejects.toMatchObject({ reason: 'not_https' });
    expect(sent).toHaveLength(0);
  });

  it('refuses a draft for another connector', async () => {
    const { gate, transport } = setup(GOOD);
    const other = { ...DRAFT, connectorId: 'elsewhere' };
    await expect(gate.send({ spec: SPEC, draft: other, approval: approve(other, NOW), endpoint: ENDPOINT, transport })).rejects.toMatchObject({ reason: 'wrong_connector' });
  });

  it('spends the approval on a failed send, so a retry needs a new approval', async () => {
    const { gate, entries, transport } = setup(GOOD);
    const approval = approve(DRAFT, NOW);
    const failing = async () => {
      throw new Error('network down');
    };
    await expect(gate.send({ spec: SPEC, draft: DRAFT, approval, endpoint: ENDPOINT, transport: failing })).rejects.toMatchObject({ reason: 'send_failed' });
    expect(entries[0]).toMatchObject({ outcome: 'failed' });
    await expect(gate.send({ spec: SPEC, draft: DRAFT, approval, endpoint: ENDPOINT, transport })).rejects.toMatchObject({ reason: 'approval_used' });
  });

  it('gives the transport the stored tokens and nothing else', async () => {
    const { gate } = setup(GOOD);
    let seen: StoredTokens | undefined;
    await gate.send({
      spec: SPEC,
      draft: DRAFT,
      approval: approve(DRAFT, NOW),
      endpoint: ENDPOINT,
      transport: async tokens => {
        seen = tokens;
      },
    });
    expect(seen?.accessToken).toBe(SECRET);
  });
});

describe('draftDigest', () => {
  it('changes with any field of the draft', () => {
    const base = draftDigest(DRAFT);
    expect(draftDigest({ ...DRAFT, recipient: 'other@example.com' })).not.toBe(base);
    expect(draftDigest({ ...DRAFT, action: 'post_message' })).not.toBe(base);
    expect(draftDigest({ ...DRAFT })).toBe(base);
  });
});

describe('the Gmail connector', () => {
  it('asks only for reading, on Google hosts', async () => {
    expect(GMAIL_CONNECTOR.scopes).toEqual([GMAIL_SCOPE]);
    expect(GMAIL_CONNECTOR.hosts).toEqual(GOOGLE_HOSTS);
    const readOnly: StoredTokens = { accessToken: SECRET, scopes: [GMAIL_SCOPE] };
    expect((await connectionState(GMAIL_CONNECTOR, memoryVault(readOnly, GMAIL_CONNECTOR.id), NOW)).status).toBe('connected');
  });
});
