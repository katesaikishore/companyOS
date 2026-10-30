// companyOS Twin browser bridge: a Manifest V3 service worker for Chrome and Edge.
//
// It reports one thing: which browser is in front, and the host and path shape of its active tab. The template
// logic is compiled from packages/core/src/url.ts into url.js, so the engine and the extension share one implementation.
//
// Privacy rules, enforced before anything leaves the extension:
// - Tabs and windows in incognito or private mode are never read or reported. The manifest also sets
//   "incognito": "not_allowed", so Chrome does not run this extension in them.
// - If a window cannot be checked, nothing is sent (fail closed).
// - Only http(s) pages are reported, and only as templates. Query strings, fragments and titles are not read.
// - Nothing is logged. Messages are sent only to the companyOS native host.

import { urlTemplate } from './url.js';

const NATIVE_HOST = 'com.companyos.twin';

/** The template last reported. A repeat is not sent again until the browser loses focus. */
let lastTemplate = '';

function browserName() {
  // Edge's user agent includes "Edg/". Everything else is reported as Chrome.
  return /\bEdg\//.test(navigator.userAgent) ? 'edge' : 'chrome';
}

/** Reports one tab, but only when it is the active tab of a focused, normal, non-private window. */
async function reportTab(tab) {
  if (!tab || !tab.active || tab.incognito) return;

  const win = await chrome.windows.get(tab.windowId).catch(() => undefined);
  if (!win || win.incognito || win.type !== 'normal' || !win.focused) return;

  const template = urlTemplate(tab.url ?? '');
  if (!template || template === lastTemplate) return;
  lastTemplate = template;

  chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: 'visit', browser: browserName(), template }, () => {
    // The app is closed, or browser capture is off. Nothing is retried, and the error is not logged.
    void chrome.runtime.lastError;
  });
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then(reportTab, () => undefined);
});

chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
  if (change.url) void reportTab(tab);
});

chrome.windows.onFocusChanged.addListener(windowId => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // Focus left the browser. The next visit is reported even if it repeats the last one.
    lastTemplate = '';
    return;
  }
  chrome.tabs.query({ windowId, active: true }).then(([tab]) => reportTab(tab), () => undefined);
});
