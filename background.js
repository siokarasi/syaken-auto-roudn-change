chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    isRunning: false,
    automationState: {
      phase: "idle",
      activeTaskId: null,
      completedTaskIds: [],
      failCount: 0,
      lastError: ""
    }
  }, () => updateBadge(false));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.isRunning) {
    updateBadge(Boolean(changes.isRunning.newValue));
  }
});

function updateBadge(isRunning) {
  chrome.action.setBadgeText({ text: isRunning ? "ON" : "OFF" });
  chrome.action.setBadgeBackgroundColor({ color: isRunning ? "#2e7d32" : "#c62828" });
}
