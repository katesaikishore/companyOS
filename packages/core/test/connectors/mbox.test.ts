import { describe, expect, it } from 'vitest';
import { parseMbox, parseMboxWithStats } from '../../src/connectors/mbox';

const ALL = { maxMessages: 1000 };

/** Joins lines of an mbox file with LF, the way the desktop app reads it. */
function mbox(...lines: string[]): string {
  return lines.join('\n');
}

describe('parseMbox: messages', () => {
  it('reads two messages: the subject is the title, the Date header is the ts, and the body is the text', () => {
    const text = mbox(
      'From alice@example.com Mon Mar  2 09:00:00 2026',
      'From: Alice Example <alice@example.com>',
      'To: Bob <bob@example.com>',
      'Subject: Quarterly plan',
      'Date: Mon, 02 Mar 2026 09:00:00 +0000',
      'Message-ID: <plan-1@example.com>',
      'Content-Type: text/plain; charset="utf-8"',
      '',
      'The plan is ready.',
      'Review it by Friday.',
      '',
      'From carol@example.com Tue Mar  3 10:00:00 2026',
      'From: Carol <carol@example.com>',
      'Subject: Lunch?',
      'Date: Tue, 03 Mar 2026 10:00:00 +0000',
      'Message-ID: <lunch-2@example.com>',
      '',
      'Are you free at noon?',
    );
    const items = parseMbox(text, ALL);
    expect(items.map((item) => [item.title, item.ts, item.text])).toEqual([
      ['Quarterly plan', Date.UTC(2026, 2, 2, 9), 'The plan is ready.\nReview it by Friday.'],
      ['Lunch?', Date.UTC(2026, 2, 3, 10), 'Are you free at noon?'],
    ]);
    expect(items.every((item) => item.source === 'mail')).toBe(true);
    for (const item of items) expect(item.sourceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('never stores the sender: no address and no display name appear in any item', () => {
    const text = mbox(
      'From alice@example.com Mon Mar  2 09:00:00 2026',
      'From: Alice Example <alice@example.com>',
      'Subject: Hello',
      'Date: Mon, 02 Mar 2026 09:00:00 +0000',
      '',
      'Body only.',
    );
    const serialised = JSON.stringify(parseMbox(text, ALL));
    expect(serialised).not.toContain('alice@example.com');
    expect(serialised).not.toContain('Alice Example');
  });

  it('decodes a quoted-printable body, including a UTF-8 character and a soft line break', () => {
    const text = mbox(
      'From dana@example.com Wed Mar  4 12:00:00 2026',
      'Subject: =?UTF-8?Q?Caf=C3=A9_menu?=',
      'Date: Wed, 04 Mar 2026 12:00:00 +0000',
      'Message-ID: <menu-3@example.com>',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Caf=C3=A9 =E2=9C=93 check.=',
      'Done=3D yes.',
    );
    const [item] = parseMbox(text, ALL);
    expect(item?.title).toBe('Café menu');
    expect(item?.text).toBe('Café ✓ check.Done= yes.');
  });

  it('decodes a base64 body that is wrapped over several lines', () => {
    const plain = 'Plain body text for the base64 test.';
    const encoded = Buffer.from(plain, 'utf8').toString('base64');
    const wrapped = encoded.match(/.{1,20}/g) ?? [];
    const text = mbox(
      'From eve@example.com Thu Mar  5 08:00:00 2026',
      'Subject: Base64 body',
      'Date: Thu, 05 Mar 2026 08:00:00 +0000',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      ...wrapped,
    );
    expect(parseMbox(text, ALL)[0]?.text).toBe(plain);
  });

  it('takes the first text/plain part of a multipart message, and skips attachments', () => {
    const attachment = Buffer.from('%PDF-1.4 secret attachment bytes', 'utf8').toString('base64');
    const text = mbox(
      'From erin@example.com Thu Mar  5 08:00:00 2026',
      'Subject: Report attached',
      'Date: Thu, 05 Mar 2026 08:00:00 +0000',
      'Message-ID: <report-4@example.com>',
      'Content-Type: multipart/mixed; boundary="XYZ-123"',
      '',
      'This preamble is not read.',
      '--XYZ-123',
      'Content-Type: text/plain; name="notes.txt"',
      'Content-Disposition: attachment; filename="notes.txt"',
      '',
      'ATTACHMENT-ONLY-TEXT',
      '--XYZ-123',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Please find the report attached.',
      '--XYZ-123',
      'Content-Type: application/pdf; name="report.pdf"',
      'Content-Disposition: attachment; filename="report.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      attachment,
      '--XYZ-123--',
      'Epilogue is not read.',
    );
    const [item] = parseMbox(text, ALL);
    expect(item?.text).toBe('Please find the report attached.');
    expect(item?.text).not.toContain('ATTACHMENT-ONLY-TEXT');
    expect(item?.text).not.toContain(attachment);
  });

  it('prefers the text/plain part of a multipart/alternative message', () => {
    const text = mbox(
      'From fay@example.com Thu Mar  5 09:00:00 2026',
      'Subject: Both kinds',
      'Date: Thu, 05 Mar 2026 09:00:00 +0000',
      'Content-Type: multipart/alternative; boundary=ALT',
      '',
      '--ALT',
      'Content-Type: text/html',
      '',
      '<p>HTML version</p>',
      '--ALT',
      'Content-Type: text/plain',
      '',
      'Plain version',
      '--ALT--',
    );
    expect(parseMbox(text, ALL)[0]?.text).toBe('Plain version');
  });

  it('reads an inline text part that has a file name, and skips the attachment and name-only parts before it', () => {
    const text = mbox(
      'From ivan@example.com Mon Mar  9 09:00:00 2026',
      'Subject: Inline notes',
      'Date: Mon, 09 Mar 2026 09:00:00 +0000',
      'Message-ID: <inline-6@example.com>',
      'Content-Type: multipart/mixed; boundary="MIX-9"',
      '',
      '--MIX-9',
      'Content-Type: text/plain; name="old.txt"',
      '',
      'NAME-ONLY-TEXT',
      '--MIX-9',
      'Content-Type: text/plain; name="data.txt"',
      'Content-Disposition: attachment; filename="data.txt"',
      '',
      'ATTACHMENT-ONLY-TEXT',
      '--MIX-9',
      'Content-Type: text/plain; charset=utf-8; name="notes.txt"',
      'Content-Disposition: inline; filename="notes.txt"',
      '',
      'INLINE-NOTE-TEXT',
      '--MIX-9--',
    );
    const [item] = parseMbox(text, ALL);
    expect(item?.text).toBe('INLINE-NOTE-TEXT');
  });

  it('skips a message whose only text is HTML, and counts it', () => {
    const text = mbox(
      'From frank@example.com Fri Mar  6 09:00:00 2026',
      'Subject: Newsletter',
      'Date: Fri, 06 Mar 2026 09:00:00 +0000',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<html><body><p>Hello</p></body></html>',
    );
    const result = parseMboxWithStats(text, ALL);
    expect(result.items).toEqual([]);
    expect(result.skippedHtmlOnly).toBe(1);
    expect(result.messages).toBe(1);
  });

  it('restores ">From " lines in the body, and does not split the message on them', () => {
    const text = mbox(
      'From gina@example.com Sat Mar  7 09:00:00 2026',
      'Subject: Quote',
      'Date: Sat, 07 Mar 2026 09:00:00 +0000',
      'Message-ID: <quote-5@example.com>',
      '',
      'Here is a line:',
      '>From the start of the year, things changed.',
      '>>From a nested quote.',
      'End.',
    );
    const result = parseMboxWithStats(text, ALL);
    expect(result.messages).toBe(1);
    expect(result.items[0]?.text).toBe(
      'Here is a line:\nFrom the start of the year, things changed.\n>From a nested quote.\nEnd.',
    );
  });

  it('decodes a base64 encoded word in the subject', () => {
    const subject = `=?UTF-8?B?${Buffer.from('Résumé review', 'utf8').toString('base64')}?=`;
    const text = mbox(
      'From hal@example.com Sun Mar  8 09:00:00 2026',
      `Subject: ${subject}`,
      'Date: Sun, 08 Mar 2026 09:00:00 +0000',
      '',
      'Body.',
    );
    expect(parseMbox(text, ALL)[0]?.title).toBe('Résumé review');
  });
});

describe('parseMbox: identifiers, limits and skipped messages', () => {
  it('gives a message without a Message-ID a hash of its subject, date and position, and keeps repeats apart', () => {
    const block = [
      'Subject: Same subject',
      'Date: Sun, 08 Mar 2026 09:00:00 +0000',
      '',
      'Body.',
    ];
    const text = mbox('From a@example.com Sun Mar  8 2026', ...block, 'From b@example.com Sun Mar  8 2026', ...block);
    const first = parseMbox(text, ALL);
    expect(first).toHaveLength(2);
    expect(first[0]?.sourceId).toMatch(/^[0-9a-f]{32}$/);
    expect(first[0]?.sourceId).not.toBe(first[1]?.sourceId);
    expect(parseMbox(text, ALL).map((item) => item.sourceId)).toEqual(first.map((item) => item.sourceId));
  });

  it('gives messages with the same Message-ID one item, so a repeated message is not imported twice', () => {
    const block = ['Subject: Copy', 'Date: Sun, 08 Mar 2026 09:00:00 +0000', 'Message-ID: <dup@example.com>', '', 'Body.'];
    const text = mbox('From a@example.com Sun Mar  8 2026', ...block, 'From a@example.com Sun Mar  8 2026', ...block);
    expect(parseMbox(text, ALL)).toHaveLength(1);
  });

  it('reads at most maxMessages messages, from the start of the file', () => {
    const text = mbox(
      'From a@example.com Mon Mar  2 2026',
      'Subject: One',
      'Date: Mon, 02 Mar 2026 09:00:00 +0000',
      '',
      'One.',
      'From b@example.com Tue Mar  3 2026',
      'Subject: Two',
      'Date: Tue, 03 Mar 2026 09:00:00 +0000',
      '',
      'Two.',
      'From c@example.com Wed Mar  4 2026',
      'Subject: Three',
      'Date: Wed, 04 Mar 2026 09:00:00 +0000',
      '',
      'Three.',
    );
    const result = parseMboxWithStats(text, { maxMessages: 2 });
    expect(result.messages).toBe(2);
    expect(result.items.map((item) => item.title)).toEqual(['One', 'Two']);
    expect(parseMbox(text, { maxMessages: 0 })).toEqual([]);
  });

  it('skips a message with no readable Date header, and counts it', () => {
    const text = mbox(
      'From a@example.com Mon Mar  2 2026',
      'Subject: Undated',
      'Date: not a date',
      '',
      'Body.',
    );
    const result = parseMboxWithStats(text, ALL);
    expect(result.items).toEqual([]);
    expect(result.skippedNoDate).toBe(1);
  });

  it('reads a text with no "From " line as one message', () => {
    const text = mbox('Subject: Bare message', 'Date: Mon, 02 Mar 2026 09:00:00 +0000', '', 'Just the body.');
    const items = parseMbox(text, ALL);
    expect(items.map((item) => [item.title, item.text])).toEqual([['Bare message', 'Just the body.']]);
  });
});
