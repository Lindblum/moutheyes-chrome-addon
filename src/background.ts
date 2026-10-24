import type { HostTokenMessage } from './shared/protocol';

// Chrome only adds content scripts to pages as they load. When the extension is installed,
// updated or reloaded, this puts a fresh one into every tab that's already open, so Moutheyes
// works there without a refresh (the old one, now cut off from the extension, steps aside).
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*', 'file:///*'] });
  for (const tab of tabs) {
    if (tab.id == null || tab.discarded) continue;
    chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] }).catch(() => {});
  }
});

// The tracker host page is web-accessible (the content script frames it into pages), so a page
// could frame it too and use it to fetch pictures with the extension's access. It only takes a
// connection that brings a one-time token a content script registered here first: pages can't
// see extension messages, so they can't learn one. Kept in session storage, which outlives this
// worker going idle but not the browser.
const tokenKey = (token: string) => `hostToken:${token}`;

chrome.runtime.onMessage.addListener((msg: HostTokenMessage, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (msg?.type === 'host-token' && sender.tab) {
    chrome.storage.session.set({ [tokenKey(msg.token)]: true }).then(() => reply(true));
    return true;
  }
  if (msg?.type === 'host-token-check' && sender.url?.startsWith(chrome.runtime.getURL('tracker/host.html'))) {
    const key = tokenKey(msg.token);
    chrome.storage.session.get(key).then(async (r) => {
      await chrome.storage.session.remove(key);
      reply(r[key] === true);
    });
    return true;
  }
});
