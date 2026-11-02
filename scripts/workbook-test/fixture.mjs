// A synthetic company brain and 50 synthetic tasks, for the workbook run in run.mjs.
//
// The routines are hand-written in the shape mineRoutines() returns. The labels in `expected` were written by hand too.
// So the agreement this run reports measures the matcher against these labels. It does not measure how well the twin
// knows a real person. Use a real task sheet for that.

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 2);
const WORKDAYS = [1, 1, 1, 1, 1, 0, 0];

function step(windowClass, app, extra = {}) {
  return { windowClass, app, options: [app], ...extra };
}

function routine(id, steps, score) {
  return {
    id,
    steps,
    support: 12,
    days: 9,
    score,
    segmentIds: [],
    durationMs: 25 * 60 * 1000,
    occurrencesPerWeek: 2,
    lastSeenAt: NOW - DAY,
    when: { weekdays: WORKDAYS, fromHour: 9, toHour: 11 },
  };
}

export const ROUTINES = [
  routine('weekly-report', [
    step('spreadsheet', 'Microsoft Excel'),
    step('document', 'Microsoft Word'),
    step('mail', 'Microsoft Outlook'),
  ], 0.82),
  routine('triage-chat', [
    step('chat', 'Slack'),
    step('browser', 'Google Chrome', { site: 'jira.atlassian.net', urlTemplate: 'jira.atlassian.net' }),
  ], 0.77),
  routine('invoice-run', [
    step('spreadsheet', 'Microsoft Excel'),
    step('browser', 'Google Chrome', { site: 'netbank.example', urlTemplate: 'netbank.example' }),
  ], 0.7),
  routine('standup-notes', [
    step('other', 'Notes'),
    step('other', 'Calendar'),
  ], 0.61),
  routine('design-review', [
    step('design', 'Figma'),
    step('chat', 'Slack'),
  ], 0.66),
  routine('code-ship', [
    step('terminal', 'Terminal'),
    step('editor', 'Visual Studio Code'),
    step('browser', 'Google Chrome', { site: 'github.com', urlTemplate: 'github.com' }),
  ], 0.8),
  routine('expense-claims', [
    step('browser', 'Google Chrome', { site: 'expenses.example', urlTemplate: 'expenses.example' }),
    step('spreadsheet', 'Microsoft Excel'),
  ], 0.58),
  routine('meeting-prep', [
    step('other', 'Calendar'),
    step('document', 'Microsoft Word'),
  ], 0.55),
];

// Each task has the text the person wrote and the routine (or 'you') it should go to.
// The last group has near misses on purpose: some are paraphrases with no shared word, and some are person-only work
// that shares a word with a routine.
export const TASKS = [
  ['Update the weekly sales sheet in Excel', 'weekly-report'],
  ['Send the weekly status email to the team in Outlook', 'weekly-report'],
  ['Write the weekly progress doc in Word', 'weekly-report'],
  ['Refresh the sales workbook for the weekly numbers', 'weekly-report'],
  ['Email the weekly summary to the leads', 'weekly-report'],
  ['Fill in the weekly timesheet spreadsheet', 'weekly-report'],
  ['Draft the weekly report document', 'weekly-report'],
  ['Mail the report table to the finance group', 'weekly-report'],
  ['Triage the open Jira tickets for the sprint', 'triage-chat'],
  ['Reply to the Slack questions about the release', 'triage-chat'],
  ['Close the stale Jira issues from last quarter', 'triage-chat'],
  ['Answer the team chat about the failing deploy', 'triage-chat'],
  ['Check the Jira board for blocked work', 'triage-chat'],
  ['Post the sprint update in Slack', 'triage-chat'],
  ['Reconcile the monthly invoices in Excel', 'invoice-run'],
  ['Check the bank statement at netbank for payments', 'invoice-run'],
  ['Pull the numbers for the monthly close into the workbook', 'invoice-run'],
  ['Match the invoices against the netbank transfers', 'invoice-run'],
  ['Log the supplier invoices in the spreadsheet', 'invoice-run'],
  ['Write up the standup notes from this morning', 'standup-notes'],
  ['Book the calendar slots for the review', 'standup-notes'],
  ['Capture the notes from the planning call', 'standup-notes'],
  ['Put next sprint dates in the calendar', 'standup-notes'],
  ['Review the Figma mockups for the onboarding flow', 'design-review'],
  ['Post the design feedback to Slack', 'design-review'],
  ['Check the Figma prototype against the brief', 'design-review'],
  ['Share the design review notes in the Slack channel', 'design-review'],
  ['Merge the feature branch and tag the release on GitHub', 'code-ship'],
  ['Run the build from the terminal and check the output', 'code-ship'],
  ['Open the pull request in VS Code and describe the change', 'code-ship'],
  ['Push the hotfix branch and publish it on github', 'code-ship'],
  ['Run the test suite in the terminal before release', 'code-ship'],
  ['Process the expense claims from the portal', 'expense-claims'],
  ['Enter the travel expenses into the sheet', 'expense-claims'],
  ['Approve the expenses submitted this week', 'expense-claims'],
  ['Export the claims from expenses for accounting', 'expense-claims'],
  ['Prepare the calendar for next week meetings', 'meeting-prep'],
  ['Write the agenda document for the Thursday meeting', 'meeting-prep'],
  ['Decide the Q3 hiring plan for engineering', 'you'],
  ['Coach Priya on her promotion case', 'you'],
  ['Write the apology letter to the client', 'you'],
  ['Choose the location for the new office', 'you'],
  ['Give feedback on the reorganisation proposal', 'you'],
  ['Negotiate the renewal of the vendor contract', 'you'],
  ['Pick the theme for the offsite', 'you'],
  ['Talk to the board about the runway', 'you'],
  ['Review the candidate for the finance director role', 'you'],
  ['Plan the team retreat agenda with the leads', 'you'],
  ['Ping the eng channel about the outage and own the call', 'triage-chat'],
  ['Get the numbers ready for the investor update', 'you'],
];

if (TASKS.length !== 50) throw new Error(`The fixture has ${TASKS.length} tasks, not 50.`);
