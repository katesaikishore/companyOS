import type { CloudAccountView, DiscordStatusView, TwinStatus } from '@companyos/twin-core';
import { h } from '../dom.js';
import { button, pageHeader, panel, panelHead, toggleRow } from '../components/ui.js';
import { formatWhen, plural } from '../format.js';
import { LOCAL_CONNECTOR_KINDS, CONNECTORS_NOTE } from '../connectors-model.js';
import { act, bridge, pending, saveConfig, setNotice, state } from '../store.js';
import { connectorAddButtons, connectorRow } from './settings.js';

/** The cloud accounts the app can connect, in the order the page shows them. */
const CLOUD_PROVIDERS: readonly CloudAccountView['provider'][] = ['googleCalendar', 'github'];
const CLOUD_LABELS: Record<CloudAccountView['provider'], string> = {
  googleCalendar: 'Google Calendar',
  github: 'GitHub',
};

/**
 * The Connectors page: every source the twin reads from, in one place. Local sources are added, read and removed here, as
 * in Settings. Cloud accounts are connected read-only through the person's own sign-in in the browser.
 */
export function connectorsPageView(status: TwinStatus): HTMLElement {
  const now = Date.now();
  const sources = status.config.connectors.filter(source => (LOCAL_CONNECTOR_KINDS as readonly string[]).includes(source.kind));
  return h(
    'div',
    // The rows are the Settings rows, so the page takes the Settings styles.
    { class: 'ov-page settings-view', 'data-testid': 'view-connectors' },
    pageHeader('Connectors', 'Every source the twin reads from. Each one is read on this device, and nothing is sent elsewhere.'),
    panel(
      { testid: 'connectors-local' },
      panelHead('Local sources', CONNECTORS_NOTE),
      status.connectorItems === undefined
        ? null
        : h('p', { class: 'muted small', 'data-testid': 'connectors-total' }, `${plural(status.connectorItems, 'item')} stored from connected sources.`),
      sources.length === 0
        ? h('p', { class: 'muted small', 'data-testid': 'connectors-local-empty' }, 'No local sources connected.')
        : h('div', null, ...sources.map(source => connectorRow(source, status, now))),
      connectorAddButtons(status.config.connectors.length),
    ),
    filesPanel(status),
    discordPanel(status),
    panel(
      { testid: 'connectors-cloud' },
      panelHead('Cloud accounts', 'Read-only. You sign in through your browser, and the tokens are sealed on this device.'),
      h(
        'div',
        null,
        ...CLOUD_PROVIDERS.map(provider => cloudRow(provider, status.cloudAccounts?.find(account => account.provider === provider))),
        gmailRow(),
      ),
    ),
  );
}

/**
 * File and photo search: the index of Desktop, Documents, Downloads and Pictures that Ctrl+Space searches. It runs inside
 * the app, a minute after it starts and every six hours, and reads only files that changed.
 */
function filesPanel(status: TwinStatus): HTMLElement {
  const files = status.files;
  const enabled = status.config.fileSearchEnabled;
  return panel(
    { testid: 'connectors-files' },
    panelHead('Search my files', 'Press Ctrl+Space anywhere and ask in plain words, such as “my passport size photo”. The index stays encrypted on this Mac.'),
    toggleRow({
      testid: 'files-toggle',
      label: 'Index Desktop, Documents, Downloads and Pictures',
      note: 'Photos and scanned PDFs are read by Apple’s on-device Vision, and documents by their text. What each file is, who issued it, who and which account it is about, and the months it covers are kept as facts in a knowledge graph, and BGE, an embedding model on this Mac (110 MB, downloaded once from Hugging Face), gives each file its meaning. Files only in iCloud are found by their names until they are on this Mac.',
      checked: enabled,
      disabled: pending('files-toggle'),
      onChange: checked =>
        void saveConfig('files-toggle', { fileSearchEnabled: checked }).then(() => {
          if (checked) void bridge().indexFiles();
        }),
    }),
    enabled && files
      ? h(
          'div',
          { class: 'settings-row', 'data-testid': 'files-status' },
          h(
            'div',
            { class: 'settings-model-main' },
            h('span', { class: 'settings-row-title' }, files.running ? `Indexing: ${files.done} of ${files.total} new or changed files` : `${plural(files.files, 'file')} indexed`),
            h(
              'span',
              { class: 'settings-row-note' },
              `${plural(files.images, 'photo')}, ${plural(files.documents, 'document')}${files.indexedAt ? ` · last pass ${formatWhen(files.indexedAt)}` : ''}${files.noEmbeddings ? ' · the embedding model was not running, so search uses names only until the next pass' : ''}`,
            ),
          ),
          button('Index now', { testid: 'files-index-now', disabled: files.running, onClick: () => void act('files-index', () => bridge().indexFiles()) }),
        )
      : undefined,
  );
}

const DISCORD_QUESTION_KEY = 'discord:question';
const DISCORD_PROBLEMS: Record<NonNullable<DiscordStatusView['problem']>, string> = {
  not_set: 'Set the agent-desktop program path in Settings, so the twin can read Discord.',
  not_running: 'Discord is not open. Messages are read while it is.',
  unreadable: 'Discord’s window could not be read. Try again after Discord has finished loading.',
};

/**
 * Discord, read from the app on this Mac. The twin reads what the Discord window shows, about once a minute, and never clicks
 * or types in it. A self-check, run on its own as messages arrive, measures how well it answers questions about them.
 */
function discordPanel(status: TwinStatus): HTMLElement {
  const discord = status.discord;
  const screenOn = status.config.screenCaptureEnabled;
  const enabled = status.config.discordReadingEnabled;
  return panel(
    { testid: 'connectors-discord' },
    panelHead('Apps on this Mac', 'Read from the app’s window while it is open. Nothing is clicked or sent, and the messages stay encrypted here.'),
    toggleRow({
      testid: 'discord-toggle',
      label: 'Read Discord',
      note: screenOn ? 'Reads the messages Discord shows in the conversations you open.' : 'Turn on screen text in Settings first.',
      checked: enabled,
      disabled: (!screenOn && !enabled) || pending('discord-toggle'),
      onChange: checked => void saveConfig('discord-toggle', { discordReadingEnabled: checked }),
    }),
    enabled && discord ? discordBody(discord) : undefined,
  );
}

function discordBody(discord: DiscordStatusView): HTMLElement {
  const check = discord.check;
  const question = h('input', {
    class: 'input',
    type: 'text',
    maxlength: 500,
    placeholder: 'For example: what did Kala send me yesterday?',
    'aria-label': 'Ask about your Discord',
    'data-testid': 'discord-question',
    oninput: () => {
      state.discord.question = question.value;
      state.dirty.add(DISCORD_QUESTION_KEY);
    },
    onblur: () => state.dirty.delete(DISCORD_QUESTION_KEY),
  });
  question.value = state.discord.question;
  const answer = state.discord.answer;
  return h(
    'div',
    { class: 'stack', 'data-testid': 'discord-body' },
    h(
      'p',
      { class: 'muted small', 'data-testid': 'discord-counts' },
      `${plural(discord.messages, 'message')} from ${plural(discord.conversations, 'conversation')}${discord.lastReadAt ? ` · last read ${formatWhen(discord.lastReadAt)}` : ''}`,
    ),
    discord.problem ? h('p', { class: 'muted small', 'data-testid': 'discord-problem' }, DISCORD_PROBLEMS[discord.problem]) : undefined,
    h(
      'div',
      { class: 'settings-row', 'data-testid': 'discord-check' },
      h(
        'div',
        { class: 'settings-model-main' },
        h('span', { class: 'settings-row-title' }, 'How well it knows your Discord'),
        h(
          'span',
          { class: 'settings-row-note', 'data-testid': 'discord-score' },
          discord.checking
            ? 'Checking now: writing questions from your messages and answering them…'
            : check && check.asked > 0
              ? `Answered ${check.correct} of ${check.asked} self-check questions right (${Math.round((check.correct / check.asked) * 100)}%). Found the right message for ${check.found} of ${check.asked}. Its own stated confidence: ${check.meanConfidence}%. Checked ${formatWhen(check.at)}.`
              : discord.messages < 20
                ? 'The self-check runs on its own once 20 messages have been read.'
                : 'Not checked yet.',
        ),
      ),
      button('Check now', {
        testid: 'discord-check-now',
        disabled: discord.checking || discord.messages === 0,
        onClick: () => void act('discord-check', () => bridge().checkDiscord()),
      }),
    ),
    check && check.results.length > 0
      ? h(
          'details',
          { 'data-testid': 'discord-check-results' },
          h('summary', { class: 'muted small' }, 'See the self-check questions'),
          h(
            'ul',
            { class: 'ov-wait-list' },
            ...check.results.map(result =>
              h(
                'li',
                { class: 'ov-wait-row' },
                h(
                  'span',
                  { class: 'ov-wait-copy' },
                  h('span', { class: 'ov-wait-name' }, `${result.correct ? '✓' : '✗'} ${result.question}`),
                  h('span', { class: 'ov-wait-meta' }, `Expected: ${result.expected}`),
                  h('span', { class: 'ov-wait-meta' }, `Answered: ${result.answer} (${result.confidence}% sure)`),
                ),
              ),
            ),
          ),
        )
      : undefined,
    h(
      'div',
      { class: 'actions' },
      question,
      button('Ask', {
        variant: 'primary',
        testid: 'discord-ask',
        disabled: pending('discord-ask') || discord.messages === 0,
        onClick: () =>
          void act('discord-ask', async () => {
            state.discord.answer = await bridge().askDiscord(state.discord.question);
            state.dirty.delete(DISCORD_QUESTION_KEY);
          }),
      }),
    ),
    pending('discord-ask') ? h('p', { class: 'muted small' }, 'Looking through your messages…') : undefined,
    answer
      ? h(
          'div',
          { class: 'stack', 'data-testid': 'discord-answer' },
          h('p', null, answer.answer),
          h('p', { class: 'muted small mono' }, `${answer.confidence}% sure · from ${plural(answer.sources.length, 'message')}`),
          ...answer.sources.map(source => h('p', { class: 'muted small' }, source.text)),
        )
      : undefined,
  );
}

function cloudRow(provider: CloudAccountView['provider'], account: CloudAccountView | undefined): HTMLElement {
  const key = `cloud:${provider}`;
  const configured = account?.configured ?? false;
  const connected = account?.connected ?? false;
  const detail = !configured
    ? 'Not set up in this build'
    : connected
      ? [account?.lastImportedAt ? `last read ${formatWhen(account.lastImportedAt)}` : undefined, account?.count !== undefined ? plural(account.count, 'item') : undefined]
          .filter(Boolean)
          .join(' · ') || 'Connected'
      : 'Not connected';
  return h(
    'div',
    { class: 'settings-row', 'data-testid': `connector-cloud-${provider}` },
    rowText(CLOUD_LABELS[provider], detail),
    !configured
      ? null
      : connected
        ? button('Disconnect', {
            testid: `connector-cloud-disconnect-${provider}`,
            disabled: pending(key),
            onClick: () => void act(key, () => bridge().disconnectCloud(provider)),
          })
        : button('Connect', {
            variant: 'primary',
            testid: `connector-cloud-connect-${provider}`,
            disabled: pending(key),
            onClick: () =>
              void act(key, async () => {
                const count = await bridge().connectCloud(provider);
                setNotice(`Connected. Read ${plural(count, 'item')}.`, 'info');
              }),
          }),
  );
}

/** Gmail has a read-only connector in the core, but this build has no sign-in path for it yet, so the row says so. */
function gmailRow(): HTMLElement {
  return h(
    'div',
    { class: 'settings-row', 'data-testid': 'connector-cloud-gmail' },
    rowText('Gmail', 'Not available in this build yet'),
  );
}

/** A row's name and its state, laid out as the Settings rows are. */
function rowText(title: string, note: string): HTMLElement {
  return h('div', { class: 'settings-model-main' }, h('span', { class: 'settings-row-title' }, title), h('span', { class: 'settings-row-note' }, note));
}
