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
