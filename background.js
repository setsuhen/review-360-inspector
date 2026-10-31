function enableSidePanel() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
  // Clears the "ALT" badge earlier builds put on the toolbar icon; the icon itself now differs.
  if (chrome.action && chrome.action.setBadgeText) chrome.action.setBadgeText({ text: "" });
}

enableSidePanel();
chrome.runtime.onInstalled.addListener(enableSidePanel);
