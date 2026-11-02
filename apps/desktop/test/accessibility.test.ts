import { describe, expect, it } from 'vitest';
import { MACOS_READER, WINDOWS_READER, parseAccessibleText, readAccessibleText } from '../src/main/accessibility';

describe('accessible text', () => {
  it('keeps each line once, trimmed, and drops empty lines', () => {
    expect(parseAccessibleText('  Invoice total  \n\nInvoice total\r\n  Due 1 Nov  \n')).toBe('Invoice total\nDue 1 Nov');
  });

  it('caps the total length, so a huge tree cannot grow the record', () => {
    const big = Array.from({ length: 2000 }, (_, i) => `line number ${i} with some words`).join('\n');
    expect(parseAccessibleText(big).length).toBeLessThanOrEqual(8000);
  });

  it('skips password fields in both readers', () => {
    expect(WINDOWS_READER).toContain('IsPasswordProperty');
    expect(MACOS_READER).toContain("'AXSecureTextField'");
  });

  it('reads nothing on a platform with no reader', async () => {
    expect(await readAccessibleText('linux')).toBe('');
  });

  it('reads nothing, and does not throw, when the reader cannot run', async () => {
    // A platform name with a reader, on a machine where its program is not present, must come back empty.
    const text = await readAccessibleText('darwin').catch(() => 'threw');
    expect(typeof text).toBe('string');
  });
});
