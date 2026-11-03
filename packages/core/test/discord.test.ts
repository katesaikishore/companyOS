import { describe, expect, it } from 'vitest';
import { conversationFromTitle, discordLine, parseDiscordTime, parseDiscordWindow, parseFullDiscordTime, type AccessibilityNode } from '../src/discord';

const NOW = new Date(2026, 10, 3, 21, 0).getTime();
const NBSP = ' ';

function article(name: string, full?: string): AccessibilityNode {
  return { role: 'article', name, children: full ? [{ role: 'group', children: [{ role: 'statictext', name: full }] }] : [] };
}

describe('Discord window parsing', () => {
  it('names the conversation from the window title, for a direct message and for a server channel', () => {
    expect(conversationFromTitle('@Kala - Discord')).toBe('@Kala');
    expect(conversationFromTitle('#general | Qbrin - Discord')).toBe('#general · Qbrin');
    expect(conversationFromTitle('Friends - Discord')).toBeUndefined();
  });

  it('reads the full time inside a message, and the short forms when that is missing', () => {
    expect(parseFullDiscordTime(`Tuesday, November 3, 2026 at 8:43${NBSP}PM`)).toBe(new Date(2026, 10, 3, 20, 43).getTime());
    expect(parseDiscordTime(`Yesterday at 6:23${NBSP}PM`, NOW)?.ts).toBe(new Date(2026, 10, 2, 18, 23).getTime());
    const previous = new Date(2026, 10, 2).getTime();
    expect(parseDiscordTime(`6:54${NBSP}PM`, NOW, previous)?.ts).toBe(new Date(2026, 10, 2, 18, 54).getTime());
    expect(parseDiscordTime('not a time', NOW)).toBeUndefined();
  });

  it('takes the messages in the conversation list, keeps " , " inside the text, and skips link previews', () => {
    const tree: AccessibilityNode = {
      role: 'window',
      children: [
        { role: 'list', name: 'Direct Messages', children: [article('Someone , not a message , 1:00 PM')] },
        {
          role: 'list',
          name: 'Messages in Kala',
          children: [
            article(`Kala , Hii anna , Yesterday at 6:23${NBSP}PM`, `Monday, November 2, 2026 at 6:23${NBSP}PM`),
            article(''),
            article(`kishore - qbrin.com , ok , see you at 3 , 8:44${NBSP}PM`, `Tuesday, November 3, 2026 at 8:44${NBSP}PM`),
          ],
        },
      ],
    };
    const messages = parseDiscordWindow(tree, '@Kala - Discord', NOW);
    expect(messages.map(m => [m.conversation, m.author, m.text])).toEqual([
      ['@Kala', 'Kala', 'Hii anna'],
      ['@Kala', 'kishore - qbrin.com', 'ok , see you at 3'],
    ]);
    expect(discordLine(messages[1])).toBe('@Kala · kishore - qbrin.com (2026-11-03 20:44): ok , see you at 3');
  });

  it('returns nothing for a window with no conversation, such as the friends list', () => {
    expect(parseDiscordWindow({ role: 'window', children: [article('A , b , 1:00 PM')] }, 'Friends - Discord', NOW)).toEqual([]);
  });
});
