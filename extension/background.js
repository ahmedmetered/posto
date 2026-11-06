// Clicking the toolbar icon opens Posto as a side panel. Unlike a popup, a side panel stays open while you
// click around the page, switch tabs, or scroll through search results.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
