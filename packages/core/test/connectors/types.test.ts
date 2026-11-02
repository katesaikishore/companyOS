import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_LOCATION_MAX,
  CONNECTOR_TEXT_MAX,
  CONNECTOR_TITLE_MAX,
  CONNECTOR_TRUNCATION_MARK,
  buildItem,
  connectorSourceId,
  parseParameters,
  splitOutsideQuotes,
  truncateText,
} from '../../src/connectors/types';

describe('buildItem: limits', () => {
  it('cuts a title to 200 characters and ends it with the truncation mark', () => {
    const item = buildItem({ source: 'mail', sourceId: 'x', ts: 1, title: 'x'.repeat(300), text: '' });
    expect(item?.title.length).toBe(CONNECTOR_TITLE_MAX);
    expect(item?.title.endsWith(CONNECTOR_TRUNCATION_MARK)).toBe(true);
  });

  it('cuts a text to 20000 characters and ends it with the truncation mark', () => {
    const item = buildItem({ source: 'folder', sourceId: 'x', ts: 1, title: 't', text: 'word '.repeat(5000) });
    expect(item?.text.length).toBe(CONNECTOR_TEXT_MAX);
    expect(item?.text.endsWith(CONNECTOR_TRUNCATION_MARK)).toBe(true);
  });

  it('cuts a location to 500 characters', () => {
    const item = buildItem({ source: 'folder', sourceId: 'x', ts: 1, title: 't', text: '', location: 'p/'.repeat(400) });
    expect(item?.location?.length).toBe(CONNECTOR_LOCATION_MAX);
  });

  it('never leaves half of a surrogate pair at the end of a cut value', () => {
    const cut = truncateText('a'.repeat(187) + '\u{1F600}'.repeat(10), 200);
    expect(/[\uD800-\uDBFF]$/.test(cut)).toBe(false);
    expect(cut).toBe('a'.repeat(187) + CONNECTOR_TRUNCATION_MARK);
  });

  it('leaves a value that fits exactly as it is', () => {
    expect(truncateText('abc', 3)).toBe('abc');
  });
});

describe('buildItem: cleaning and absent values', () => {
  it('turns a title into one line, and gives "(untitled)" to an empty one', () => {
    expect(buildItem({ source: 'calendar', sourceId: 'x', ts: 1, title: '  Two\nlines\tand  spaces ', text: '' })?.title).toBe(
      'Two lines and spaces',
    );
    expect(buildItem({ source: 'calendar', sourceId: 'x', ts: 1, title: '   ', text: '' })?.title).toBe('(untitled)');
  });

  it('removes control characters from the text and makes line endings LF', () => {
    const item = buildItem({ source: 'folder', sourceId: 'x', ts: 1, title: 't', text: 'a\u0001b\r\nc\rd\u007f' });
    expect(item?.text).toBe('ab\nc\nd');
  });

  it('leaves out the location when it is empty', () => {
    const item = buildItem({ source: 'git', sourceId: 'x', ts: 1, title: 't', text: '', location: '  ' });
    expect(item && 'location' in item).toBe(false);
  });

  it('returns null when the time is not a finite number, so the caller skips the item', () => {
    expect(buildItem({ source: 'mail', sourceId: 'x', ts: Number.NaN, title: 't', text: '' })).toBeNull();
    expect(buildItem({ source: 'mail', sourceId: 'x', ts: Number.POSITIVE_INFINITY, title: 't', text: '' })).toBeNull();
  });
});

describe('connectorSourceId', () => {
  it('is 32 hex characters, the same for the same parts, and different when the split between parts moves', () => {
    expect(connectorSourceId('ics', 'uid', '1')).toMatch(/^[0-9a-f]{32}$/);
    expect(connectorSourceId('ics', 'uid', '1')).toBe(connectorSourceId('ics', 'uid', '1'));
    expect(connectorSourceId('ab', 'c')).not.toBe(connectorSourceId('a', 'bc'));
  });
});

describe('parameter helpers', () => {
  it('splits on a separator only outside quotes', () => {
    expect(splitOutsideQuotes('a;"b;c";d', ';')).toEqual(['a', '"b;c"', 'd']);
  });

  it('reads the head and the lower-case parameters, with quotes removed', () => {
    const parsed = parseParameters('DTSTART;TZID="Europe/London";VALUE=DATE');
    expect(parsed.head).toBe('DTSTART');
    expect(parsed.params.get('tzid')).toBe('Europe/London');
    expect(parsed.params.get('value')).toBe('DATE');
  });

  it('keeps a parameter named like an Object property as a plain entry', () => {
    const parsed = parseParameters('x;__proto__=y');
    expect(parsed.params.get('__proto__')).toBe('y');
    expect(Object.getPrototypeOf(parsed.params)).toBe(Map.prototype);
  });
});
