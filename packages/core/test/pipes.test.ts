import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  MAX_PIPES,
  PIPE_MATCH_LIMIT,
  TwinAgent,
  TwinConfigSchema,
  isPipeDue,
  mergeConfigPatch,
  parsePipes,
  pipeDecision,
  runPipe,
  type CaptureHitView,
  type CaptureSearchRequest,
  type Pipe,
  type PipeGate,
} from '../src';
import { tempFolders } from './temp-folders';

const temps = tempFolders();
const NOW = Date.UTC(2026, 10, 2, 9, 0);
const MINUTE = 60_000;

const base: Pipe = {
  id: 'pipe-0001',
  name: 'Standup',
  query: 'budget',
  intervalMinutes: 60,
  action: 'notify',
  enabled: true,
};

function pipeList(count: number): Pipe[] {
  return Array.from({ length: count }, (_, index) => ({ ...base, id: `pipe-${String(index).padStart(4, '0')}` }));
}

function hit(app: string | null, snippet: string, overrides: Partial<CaptureHitView> = {}): CaptureHitView {
  return { kind: 'screen', id: 'a'.repeat(32), ts: NOW - MINUTE, app, snippet, ...overrides };
}

/** The message a refused list throws. It must be the fixed sentence, with nothing from the input. */
function refusal(value: unknown): string {
  try {
    parsePipes(value);
  } catch (error) {
    return error instanceof Error ? error.message : '';
  }
  return 'accepted';
}

describe('parsePipes', () => {
  it('accepts a valid list, an empty search, and each optional field', () => {
    expect(parsePipes([base])).toEqual([base]);
    expect(parsePipes([{ ...base, query: '' }])).toHaveLength(1);
    expect(parsePipes([{ ...base, kind: 'audio', app: 'Slack', action: 'write', enabled: false }])).toHaveLength(1);
    expect(parsePipes([])).toEqual([]);
  });

  it('trims the name and the search before it checks their length', () => {
    expect(parsePipes([{ ...base, name: `  ${'n'.repeat(60)}  `, query: '  budget  ' }])[0]).toMatchObject({
      name: 'n'.repeat(60),
      query: 'budget',
    });
    expect(refusal([{ ...base, name: '   ' }])).toMatch(/^Invalid pipes/);
  });

  it('allows at most 20 pipes, and each id once', () => {
    expect(MAX_PIPES).toBe(20);
    expect(parsePipes(pipeList(20))).toHaveLength(20);
    expect(refusal(pipeList(21))).toMatch(/^Invalid pipes/);
    expect(refusal([base, { ...base, name: 'Other' }])).toMatch(/^Invalid pipes/);
  });

  it('refuses a name that is empty, over 60 characters, or has a control character', () => {
    expect(refusal([{ ...base, name: '' }])).toMatch(/^Invalid pipes/);
    expect(parsePipes([{ ...base, name: 'n'.repeat(60) }])).toHaveLength(1);
    expect(refusal([{ ...base, name: 'n'.repeat(61) }])).toMatch(/^Invalid pipes/);
    expect(refusal([{ ...base, name: 'two\nlines' }])).toMatch(/^Invalid pipes/);
  });

  it('refuses a search over 200 characters, or one with no letter or digit', () => {
    expect(parsePipes([{ ...base, query: 'q'.repeat(200) }])).toHaveLength(1);
    expect(refusal([{ ...base, query: 'q'.repeat(201) }])).toMatch(/^Invalid pipes/);
    expect(refusal([{ ...base, query: '!!!' }])).toMatch(/^Invalid pipes/);
    expect(parsePipes([{ ...base, query: '   ' }])[0].query).toBe('');
  });

  it('keeps the interval within 15 to 1440 whole minutes', () => {
    for (const intervalMinutes of [15, 1440]) expect(parsePipes([{ ...base, intervalMinutes }])).toHaveLength(1);
    for (const intervalMinutes of [14, 1441, 15.5, Number.NaN]) {
      expect(refusal([{ ...base, intervalMinutes }])).toMatch(/^Invalid pipes/);
    }
    expect(refusal([{ ...base, intervalMinutes: '60' }])).toMatch(/^Invalid pipes/);
  });

  it('accepts only the two kinds and the two actions', () => {
    expect(refusal([{ ...base, kind: 'video' }])).toMatch(/^Invalid pipes/);
    expect(refusal([{ ...base, action: 'send' }])).toMatch(/^Invalid pipes/);
    expect(refusal([{ ...base, action: 'run' }])).toMatch(/^Invalid pipes/);
  });

  it('refuses an extra field, so a pipe cannot carry a command or a destination', () => {
    expect(refusal([{ ...base, command: 'curl' }])).toMatch(/^Invalid pipes/);
    expect(refusal([{ ...base, url: 'https://example.com' }])).toMatch(/^Invalid pipes/);
  });

  it('refuses an id that is not safe as a file name', () => {
    expect(refusal([{ ...base, id: '../escape' }])).toMatch(/^Invalid pipes/);
    expect(refusal([{ ...base, id: 'short' }])).toMatch(/^Invalid pipes/);
    expect(refusal([{ ...base, id: 'a/b/c/d/e/f/g/h' }])).toMatch(/^Invalid pipes/);
  });

  it('refuses a value that is not a list, and throws a fixed sentence with nothing from the input', () => {
    expect(refusal({ ...base })).toMatch(/^Invalid pipes/);
    const secret = 'SECRETNAME'.repeat(7);
    const message = refusal([{ ...base, name: secret }]);
    expect(message).toMatch(/^Invalid pipes/);
    expect(message).not.toContain('SECRET');
  });
});

describe('pipes in the config', () => {
  it('defaults to no pipes, including for a config saved before pipes existed', () => {
    const { pipes: _unused, ...saved } = DEFAULT_CONFIG;
    expect(DEFAULT_CONFIG.pipes).toEqual([]);
    expect(TwinConfigSchema.parse(saved).pipes).toEqual([]);
  });

  it('takes a settings patch of pipes, and refuses one that is over the limit', () => {
    expect(mergeConfigPatch(DEFAULT_CONFIG, { pipes: [base] }).pipes).toEqual([base]);
    expect(() => mergeConfigPatch(DEFAULT_CONFIG, { pipes: pipeList(21) })).toThrow();
    expect(() => mergeConfigPatch(DEFAULT_CONFIG, { pipes: [{ ...base, name: '' }] })).toThrow();
  });
});

describe('isPipeDue', () => {
  it('is due once the interval has passed since the baseline, and not before', () => {
    expect(isPipeDue(base, 0, 60 * MINUTE - 1)).toBe(false);
    expect(isPipeDue(base, 0, 60 * MINUTE)).toBe(true);
    expect(isPipeDue(base, 5 * MINUTE, 65 * MINUTE)).toBe(true);
  });

  it('is never due while the pipe is off', () => {
    expect(isPipeDue({ ...base, enabled: false }, 0, 1_000 * MINUTE)).toBe(false);
  });

  it('uses the shortest interval the settings allow', () => {
    expect(isPipeDue({ ...base, intervalMinutes: 15 }, 0, 15 * MINUTE)).toBe(true);
    expect(isPipeDue({ ...base, intervalMinutes: 15 }, 0, 15 * MINUTE - 1)).toBe(false);
  });
});

describe('pipeDecision', () => {
  const clear: PipeGate = { automationsEnabled: true, paused: false, locked: false, idle: false, secureInput: false };

  it('lets pipes run when every gate is clear', () => {
    expect(pipeDecision(clear).run).toBe(true);
  });

  it('holds pipes while automations are stopped, capture is paused, the screen is locked or the person is away', () => {
    expect(pipeDecision({ ...clear, automationsEnabled: false })).toMatchObject({ run: false, reason: expect.stringMatching(/stopped/) });
    expect(pipeDecision({ ...clear, paused: true })).toMatchObject({ run: false, reason: expect.stringMatching(/paused/) });
    expect(pipeDecision({ ...clear, locked: true })).toMatchObject({ run: false, reason: expect.stringMatching(/locked/) });
    expect(pipeDecision({ ...clear, idle: true })).toMatchObject({ run: false, reason: expect.stringMatching(/away/) });
  });

  it('holds pipes while a password field may have focus, and while secure input cannot be checked', () => {
    expect(pipeDecision({ ...clear, secureInput: true })).toMatchObject({ run: false, reason: expect.stringMatching(/password/) });
    expect(pipeDecision({ ...clear, secureInput: 'unknown' })).toMatchObject({ run: false, reason: expect.stringMatching(/cannot be checked/) });
  });

  it('gives the first failing check as the reason, and every reason is a fixed sentence', () => {
    const everything: PipeGate = { automationsEnabled: false, paused: true, locked: true, idle: true, secureInput: true };
    expect(pipeDecision(everything).reason).toBe('Automations are stopped, so pipes wait.');
  });
});

describe('runPipe', () => {
  /** A fake search that filters by kind, as the engine does. */
  function run(pipe: Pipe, hits: CaptureHitView[], since = NOW - 10 * MINUTE) {
    const calls: CaptureSearchRequest[] = [];
    const result = runPipe(pipe, since, {
      now: () => NOW,
      search: request => {
        calls.push(request);
        return hits.filter(hit => request.kind === undefined || hit.kind === request.kind);
      },
    });
    return { result, calls };
  }

  it('searches the window from the baseline to now, with the pipe search, source and app', () => {
    const { calls } = run({ ...base, kind: 'screen', app: 'Slack' }, []);
    expect(calls).toEqual([{ text: 'budget', from: NOW - 10 * MINUTE, to: NOW, kind: 'screen', app: 'Slack' }]);
  });

  it('asks for the screen and the microphone one at a time when the pipe sets no kind, and for no app', () => {
    const { calls } = run({ ...base, query: '' }, []);
    expect(calls).toEqual([
      { text: '', kind: 'screen', from: NOW - 10 * MINUTE, to: NOW },
      { text: '', kind: 'audio', from: NOW - 10 * MINUTE, to: NOW },
    ]);
  });

  it('never returns typed text, even when the search gives it back', () => {
    const typed: CaptureHitView = { kind: 'keystroke' as CaptureHitView['kind'], id: 'c'.repeat(32), ts: NOW - MINUTE, app: 'Notes', snippet: 'TYPEDCANARY 5521' };
    const calls: CaptureSearchRequest[] = [];
    const result = runPipe(base, NOW - 10 * MINUTE, {
      now: () => NOW,
      search: request => {
        calls.push(request);
        return [typed, hit('Chrome', 'budget note')];
      },
    });
    expect(calls.every(request => request.kind === 'screen' || request.kind === 'audio')).toBe(true);
    expect(result.count).toBe(2);
    expect(result.apps).toEqual(['Chrome']);
    expect(result.notice).not.toContain('TYPEDCANARY');
    expect(result.markdown).not.toContain('TYPEDCANARY');
  });

  it('keeps the newest matches across the two kinds when the pipe sets no kind', () => {
    const older = Array.from({ length: PIPE_MATCH_LIMIT }, (_, index) => hit('Chrome', `old ${index}`, { ts: NOW - (index + 100) * 1000 }));
    const newest = hit('Slack', 'newest audio', { kind: 'audio', ts: NOW - 1 });
    const { result } = run(base, [...older, newest]);
    expect(result.count).toBe(PIPE_MATCH_LIMIT);
    expect(result.markdown).toContain('newest audio');
    expect(result.markdown).not.toContain('old 199');
  });

  it('starts the window no later than now, so a baseline in the future reads nothing older', () => {
    const { calls } = run(base, [], NOW + 5 * MINUTE);
    expect(calls[0]).toMatchObject({ from: NOW, to: NOW });
  });

  it('counts the matches, lists each app once in order, and names the rest after three', () => {
    const hits = [hit('Slack', 'one'), hit('Chrome', 'two'), hit('Slack', 'three'), hit(null, 'four', { kind: 'audio' })];
    const { result } = run(base, hits);
    expect(result).toMatchObject({ count: 4, truncated: false, apps: ['Slack', 'Chrome'] });
    expect(result.notice).toBe('Standup: 4 new matches in Slack, Chrome.');

    const many = ['A', 'B', 'C', 'D', 'E'].map(app => hit(app, 'text'));
    expect(run(base, many).result.notice).toBe('Standup: 5 new matches in A, B, C and 2 more.');
  });

  it('uses the singular for one match, and says so when the search was full', () => {
    expect(run(base, [hit('Slack', 'one')]).result.notice).toBe('Standup: 1 new match in Slack.');
    const full = Array.from({ length: PIPE_MATCH_LIMIT }, () => hit('Slack', 'text'));
    const { result } = run(base, full);
    expect(result.truncated).toBe(true);
    expect(result.notice).toBe(`Standup: ${PIPE_MATCH_LIMIT} or more new matches in Slack.`);
  });

  it('gives no notice when nothing matched, and says so in the file', () => {
    const { result } = run(base, []);
    expect(result).toMatchObject({ count: 0, notice: '' });
    expect(result.markdown).toContain('No matches in this run.');
  });

  it('never puts the text of an item in the notice', () => {
    const hits = [hit('Chrome', 'PIPECANARY 4417 secret budget words'), hit(null, 'MICCANARY 9981', { kind: 'audio' })];
    const { result } = run({ ...base, name: 'Standup' }, hits);
    for (const secret of ['PIPECANARY', '4417', 'secret', 'budget words', 'MICCANARY', '9981']) {
      expect(result.notice).not.toContain(secret);
    }
  });

  it('writes the stored text to the file, marked as not encrypted and replaced on each run', () => {
    const { result } = run({ ...base, action: 'write' }, [hit('Chrome', 'PIPECANARY 4417')]);
    expect(result.markdown.startsWith('# Standup\n')).toBe(true);
    expect(result.markdown).toContain('PIPECANARY 4417');
    expect(result.markdown).toContain('- 2026-11-02T08:59:00.000Z · Chrome · PIPECANARY 4417');
    expect(result.markdown).toContain('It is not encrypted, and each run replaces it.');
  });

  it('keeps the file to one line for each match, even when the text has line breaks', () => {
    const { result } = run({ ...base, action: 'write' }, [hit('Chrome', 'first line\n\nsecond line')]);
    const bullets = result.markdown.split('\n').filter(line => line.startsWith('- '));
    expect(bullets).toHaveLength(1);
    expect(bullets[0]).toContain('first line second line');
  });
});

describe('a pipe over the real engine', () => {
  const dataDir = () => temps.folder('twin-pipes-');
  function openAgent(now: number = NOW): TwinAgent {
    return temps.track(new TwinAgent({ dataDir: dataDir(), dataKey: randomBytes(32), now: () => now }));
  }

  it('leaves an excluded app out of the notice and the file, before and after it is excluded', () => {
    const agent = openAgent();
    agent.updateConfig({ screenCaptureEnabled: true });
    agent.ingestScreen({ ts: NOW - MINUTE, app: 'Pages', windowClass: 'document', text: 'budget review notes', mediaId: null });
    agent.ingestScreen({ ts: NOW - MINUTE, app: 'Slack', windowClass: 'chat', text: 'budget chat message', mediaId: null });
    agent.updateConfig({ excludedApps: [...DEFAULT_CONFIG.excludedApps, 'slack'] });
    expect(agent.ingestScreen({ ts: NOW - MINUTE, app: 'Slack', windowClass: 'chat', text: 'budget later message', mediaId: null })).toBe(false);

    const result = runPipe({ ...base, action: 'write' }, NOW - 10 * MINUTE, {
      now: () => NOW,
      search: request => agent.searchCapture(request),
    });
    expect(result.count).toBe(1);
    expect(result.apps).toEqual(['pages']);
    expect(result.markdown).toContain('budget review notes');
    expect(result.markdown).not.toContain('budget chat message');
    expect(result.markdown).not.toContain('budget later message');
    expect(result.notice).toBe('Standup: 1 new match in pages.');
  });

  it('exports a pipe with its name and search replaced, as automation names are', () => {
    const agent = openAgent();
    agent.updateConfig({ pipes: [base] });
    const exported = JSON.stringify(agent.exportAll());
    expect(exported).not.toContain('Standup');
    expect(exported).not.toContain('budget');
    expect(exported).toContain('"intervalMinutes":60');
  });
});
