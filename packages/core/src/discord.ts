/**
 * Reading the Discord app on this device through its accessibility tree. Discord draws each message as an "article" whose
 * name is "author , text , time", inside a list named "Messages in <conversation>", and inside it the full time, such as
 * "Tuesday, November 3, 2026 at 8:43 PM". The window title names the conversation
 * too: "@Kala - Discord" for a direct message, "#general | Server - Discord" for a channel. Nothing is clicked: the reader
 * takes what the window shows, the same way screen text is read.
 */

export interface AccessibilityNode {
  role?: string;
  name?: string;
  value?: unknown;
  children?: AccessibilityNode[];
}

export interface DiscordMessage {
  /** The direct message or channel, as Discord names it, such as "@Kala" or "#general · Server". */
  conversation: string;
  author: string;
  text: string;
  /** When the message was sent, from the time Discord shows. A message without a readable day takes the day before it. */
  ts: number;
}

const MESSAGES_LIST = /^Messages in (.+)$/;
const CLOCK = /(\d{1,2}):(\d{2})\s*([AP]M)?/i;
const DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/;
const MAX_TEXT = 4000;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** The full time Discord keeps inside each message, such as "Tuesday, November 3, 2026 at 8:43 PM". */
const FULL_TIME = /(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4}) at (\d{1,2}):(\d{2})\s*([AP]M)?/i;

/** The exact time from the full timestamp inside a message, or undefined when it has none. */
export function parseFullDiscordTime(text: string): number | undefined {
  const match = FULL_TIME.exec(clean(text));
  if (!match) return undefined;
  const [, month, dayOfMonth, year, hour, minute, half] = match;
  let hours = Number(hour);
  if (half) hours = (hours % 12) + (half.toUpperCase() === 'PM' ? 12 : 0);
  return new Date(Number(year), MONTHS.indexOf(month.toLowerCase()), Number(dayOfMonth), hours, Number(minute)).getTime();
}

function clean(text: string): string {
  return text.replace(/[‎‏  ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The conversation from the window title: "@Kala - Discord" or "#general | Server - Discord". */
export function conversationFromTitle(title: string): string | undefined {
  const base = clean(title).replace(/\s*-\s*Discord$/, '');
  if (!base || base === 'Discord' || base === 'Friends') return undefined;
  const [channel, server] = base.split(/\s+\|\s+/);
  return server ? `${channel} · ${server}` : channel;
}

/** Midnight of the day ts falls on, in local time. */
function dayStart(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * The time a message was sent, from what Discord shows: "Today at 2:11 PM", "Yesterday at 6:23 PM", "11/02/2026 3:00 PM",
 * or only "2:11 PM" for a follow-up, which is taken on the day of the message before it. Undefined when it cannot be read.
 */
export function parseDiscordTime(shown: string, now: number, previousDay?: number): { ts: number; day: number } | undefined {
  const text = clean(shown);
  let day: number | undefined;
  if (/^Today\b/i.test(text)) day = dayStart(now);
  else if (/^Yesterday\b/i.test(text)) day = dayStart(now) - 86_400_000;
  else {
    const date = DATE.exec(text);
    // Discord writes dates in the system's order. Month first is the common one; a first number over 12 must be the day.
    if (date) {
      const [a, b, year] = [Number(date[1]), Number(date[2]), Number(date[3])];
      const [month, dayOfMonth] = a > 12 ? [b, a] : [a, b];
      day = new Date(year, month - 1, dayOfMonth).getTime();
    }
  }
  const clock = CLOCK.exec(text);
  if (day === undefined) {
    if (!clock) return undefined;
    day = previousDay ?? dayStart(now);
  }
  if (!clock) return { ts: day, day };
  let hours = Number(clock[1]) % 12;
  if (clock[3]?.toUpperCase() === 'PM') hours += 12;
  if (!clock[3]) hours = Number(clock[1]);
  return { ts: day + hours * 3_600_000 + Number(clock[2]) * 60_000, day };
}

/**
 * The messages a Discord window shows, in the order shown. An article without a name (a link preview or an attachment) is
 * skipped. The text between the author and the time can itself hold " , ", so it is everything between them.
 */
export function parseDiscordWindow(tree: AccessibilityNode, windowTitle: string, now: number): DiscordMessage[] {
  let conversation = conversationFromTitle(windowTitle);
  const articles: Array<{ name: string; full?: number }> = [];
  /** The first full timestamp inside a message. */
  const fullTime = (node: AccessibilityNode): number | undefined => {
    for (const child of node.children ?? []) {
      const own = typeof child.name === 'string' ? parseFullDiscordTime(child.name) : undefined;
      const found = own ?? fullTime(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const walk = (node: AccessibilityNode, inMessages: boolean): void => {
    const listName = node.role === 'list' && typeof node.name === 'string' ? MESSAGES_LIST.exec(clean(node.name)) : null;
    if (listName && !conversation) conversation = listName[1];
    const inside = inMessages || listName !== null;
    if (inside && node.role === 'article' && typeof node.name === 'string' && node.name.trim()) articles.push({ name: node.name, full: fullTime(node) });
    for (const child of node.children ?? []) walk(child, inside);
  };
  walk(tree, false);
  if (!conversation) return [];
  const messages: DiscordMessage[] = [];
  let previousDay: number | undefined;
  for (const { name, full } of articles) {
    const parts = name.split(' , ');
    if (parts.length < 3) continue;
    const author = clean(parts[0]);
    const when = full !== undefined ? { ts: full, day: dayStart(full) } : parseDiscordTime(parts[parts.length - 1], now, previousDay);
    const text = clean(parts.slice(1, -1).join(' , ')).slice(0, MAX_TEXT);
    if (!author || !text || !when) continue;
    previousDay = when.day;
    messages.push({ conversation, author, text, ts: when.ts });
  }
  return messages;
}

/** One line per message, the form it is stored and searched in: "@Kala · Kala (2026-11-02 18:23): Hii anna". */
export function discordLine(message: DiscordMessage): string {
  const at = new Date(message.ts);
  const stamp = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return `${message.conversation} · ${message.author} (${stamp}): ${message.text}`;
}
