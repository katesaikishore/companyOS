import { describe, expect, it } from 'vitest';
import { redactTypedText } from '../src/redact';

describe('redactTypedText: card-like numbers', () => {
  it.each([
    ['4111 1111 1111 1111', '[card number]'],
    ['4111-1111-1111-1111', '[card number]'],
    ['4111111111111111', '[card number]'],
    ['378282246310005', '[card number]'],
  ])('replaces the card-like number %s', (card, placeholder) => {
    expect(redactTypedText(card)).toBe(placeholder);
  });

  it('replaces a card number inside a sentence and keeps the words around it', () => {
    expect(redactTypedText('my card is 4111 1111 1111 1111 thanks')).toBe('my card is [card number] thanks');
  });

  it('leaves numbers that are too short to be a card number', () => {
    expect(redactTypedText('call 020 7946 0958 or order 20261102')).toBe('call 020 7946 0958 or order 20261102');
  });
});

describe('redactTypedText: key-like tokens', () => {
  it.each([
    ['AKIAIOSFODNN7EXAMPLE', 'AWS access key'],
    ['ghp_1234567890abcdefghijklmnopqrstuvwxyz', 'GitHub token'],
    ['github_pat_11ABCDEFG0123456789_abcdefghijklmnop', 'GitHub fine-grained token'],
    ['sk-ant-api03-abcdefghijklmnopqrstuvwx', 'vendor secret key'],
    ['xoxb-1234567890-abcdefghijk', 'Slack token'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk', 'JSON web token'],
    ['-----BEGIN RSA PRIVATE KEY-----', 'private key header'],
    ['Xk3vQ9pL2mR7tY4wZ8nB', 'random run of letters and digits'],
  ])('replaces a %s', (token) => {
    expect(redactTypedText(token)).toBe('[key]');
  });

  it('replaces a key inside a sentence and keeps the words around it', () => {
    expect(redactTypedText('use key Xk3vQ9pL2mR7tY4wZ8nB today')).toBe('use key [key] today');
  });

  it('keeps a long run of letters only, and a short mixed token', () => {
    expect(redactTypedText('correcthorsebatterystaple')).toBe('correcthorsebatterystaple');
    expect(redactTypedText('ab12cd34')).toBe('ab12cd34');
  });

  it('does not change ordinary typed text', () => {
    const plain = 'Meeting moved to 10:30, see the invoice in the shared folder.';
    expect(redactTypedText(plain)).toBe(plain);
  });

  it('replaces a key and a card in one piece of text', () => {
    expect(redactTypedText('card 4111 1111 1111 1111 key sk-abcdefghijklmnopqrstuvwx')).toBe('card [card number] key [key]');
  });
});
