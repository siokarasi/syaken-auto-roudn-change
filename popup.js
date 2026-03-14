const rowsBody = document.getElementById("rowsBody");
const statusText = document.getElementById("statusText");
const statusBadge = document.getElementById("statusBadge");
const logsBox = document.getElementById("logs");
const minMsInput = document.getElementById("minMs");
const maxMsInput = document.getElementById("maxMs");

const state = {
  pageRows: [],
  isRunning: false,
  storedTasks: []
};

document.addEventListener("DOMContentLoaded", async () => {
  bindButtons();
  await loadPersistedSettings();
  await reloadRowsFromPage();
  await refreshStatus();
});

function bindButtons() {
  document.getElementById("reloadBtn").addEventListener("click", reloadRowsFromPage);
  document.getElementById("selectAllBtn").addEventListener("click", () => setAllChecks(true));
  document.getElementById("clearAllBtn").addEventListener("click", () => setAllChecks(false));
  document.getElementById("startBtn").addEventListener("click", startAutomation);
  document.getElementById("stopBtn").addEventListener("click", stopAutomation);
  document.getElementById("refreshStatusBtn").addEventListener("click", refreshStatus);
}

async function loadPersistedSettings() {
  const saved = await storageGet(["monitoring", "tasks"]);
  if (saved.monitoring) {
    if (saved.monitoring.minMs) minMsInput.value = saved.monitoring.minMs;
    if (saved.monitoring.maxMs) maxMsInput.value = saved.monitoring.maxMs;
  }
  state.storedTasks = Array.isArray(saved.tasks) ? saved.tasks : [];
}

async function reloadRowsFromPage() {
  const tab = await getActiveTab();
  if (!tab) {
    renderStatus(false, "アクティブタブが取得できません");
    return;
  }

  const frameId = await resolveAutomationFrameId(tab.id);
  const res = await sendTabMessage(tab.id, { action: "scrapeRows" }, frameId);
  if (!res || !res.ok) {
    rowsBody.innerHTML = "<tr><td colspan='6'>対象ページで実行できません。拡張機能の再読込後に対象タブを再表示してください。</td></tr>";
    return;
  }

  state.pageRows = Array.isArray(res.entries) ? res.entries : [];
  renderRows();
}

function renderRows() {
  if (state.pageRows.length === 0) {
    rowsBody.innerHTML = "<tr><td colspan='6'>候補が見つかりませんでした</td></tr>";
    return;
  }

  const taskMap = new Map();
  for (const t of state.storedTasks) {
    taskMap.set(taskKeyFromTask(t), t);
  }

  rowsBody.innerHTML = "";
  for (const row of state.pageRows) {
    const key = taskKeyFromRow(row);
    const existing = taskMap.get(key);

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="checkbox" class="task-check" data-key="${escapeHtml(key)}" ${existing ? "checked" : ""}></td>
      <td>${escapeHtml(row.date)}</td>
      <td>${escapeHtml(row.vehicleType)}</td>
      <td>${row.currentRound}R</td>
      <td>
        <select class="to-round-primary" data-key="${escapeHtml(key)}">
          ${renderRoundOptions(row.currentRound, existing ? Number(existing.toRound) : null, false)}
        </select>
      </td>
      <td>
        <select class="to-round-secondary" data-key="${escapeHtml(key)}">
          ${renderRoundOptions(row.currentRound, existing ? Number(existing.toRoundSecondary) : null, true)}
        </select>
      </td>
    `;
    rowsBody.appendChild(tr);
  }
}

function renderRoundOptions(fromRound, selectedRound, includeEmpty) {
  let html = "";
  if (includeEmpty) {
    const emptySelected = selectedRound ? "" : "selected";
    html += `<option value="" ${emptySelected}>-</option>`;
  }
  for (let r = 1; r <= 4; r += 1) {
    if (r === Number(fromRound)) {
      continue;
    }
    const selected = Number(selectedRound) === r ? "selected" : "";
    html += `<option value="${r}" ${selected}>${r}R</option>`;
  }
  return html;
}

async function startAutomation() {
  const tab = await getActiveTab();
  if (!tab) {
    return;
  }
  const frameId = await resolveAutomationFrameId(tab.id);

  const tasks = collectTasksFromUi();

  if (tasks.length === 0) {
    alert("対象が未選択です。チェックを入れてください。");
    return;
  }

  let effectiveTasks = tasks;
  if (tasks.length > 1) {
    effectiveTasks = [tasks[0]];
    alert("現在は1件ずつの実行モードです。先頭の1件のみで開始します。");
  }

  const monitoring = {
    minMs: Number(minMsInput.value) || 1700,
    maxMs: Number(maxMsInput.value) || 2400,
    maxFailCount: 8
  };

  await storageSet({ tasks: effectiveTasks, monitoring });
  state.storedTasks = effectiveTasks;

  const res = await sendTabMessage(tab.id, { action: "start", tasks: effectiveTasks, monitoring }, frameId);
  if (!res || !res.ok) {
    alert("開始メッセージ送信に失敗しました。対象ページを開いて再試行してください。");
    return;
  }

  await refreshStatus();
}

async function stopAutomation() {
  const tab = await getActiveTab();
  if (tab) {
    const frameId = await resolveAutomationFrameId(tab.id);
    await sendTabMessage(tab.id, { action: "stop", reason: "Popupから手動停止" }, frameId);
  }
  await storageSet({ isRunning: false });
  await refreshStatus();
}

async function refreshStatus() {
  const tab = await getActiveTab();
  const local = await storageGet(["isRunning", "automationState", "logs", "tasks"]);
  state.storedTasks = Array.isArray(local.tasks) ? local.tasks : [];

  let page = "unknown";
  if (tab) {
    const frameId = await resolveAutomationFrameId(tab.id);
    const res = await sendTabMessage(tab.id, { action: "getStatus" }, frameId);
    if (res && res.ok) {
      page = res.page;
    }
  }

  const isRunning = Boolean(local.isRunning);
  const phase = local.automationState && local.automationState.phase ? local.automationState.phase : "idle";
  const failCount = local.automationState && local.automationState.failCount ? local.automationState.failCount : 0;

  renderStatus(isRunning, `ページ:${page} / フェーズ:${phase} / 失敗:${failCount}`);

  const logs = Array.isArray(local.logs) ? local.logs : [];
  logsBox.textContent = logs.length ? logs.join("\n") : "ログなし";
}

function renderStatus(isRunning, detail) {
  state.isRunning = isRunning;
  statusText.textContent = detail || "";
  statusBadge.textContent = isRunning ? "監視中" : "停止中";
  statusBadge.className = `badge ${isRunning ? "running" : "stopped"}`;
}

function setAllChecks(checked) {
  const checks = Array.from(document.querySelectorAll(".task-check"));
  checks.forEach((c) => {
    c.checked = checked;
  });
}

function collectTasksFromUi() {
  const checks = Array.from(document.querySelectorAll(".task-check"));
  const rowsByKey = new Map(state.pageRows.map((r) => [taskKeyFromRow(r), r]));
  const result = [];

  for (const c of checks) {
    if (!c.checked) {
      continue;
    }
    const key = c.dataset.key;
    const row = rowsByKey.get(key);
    if (!row) {
      continue;
    }

    const primarySelect = document.querySelector(`.to-round-primary[data-key="${cssEscape(key)}"]`);
    const secondarySelect = document.querySelector(`.to-round-secondary[data-key="${cssEscape(key)}"]`);
    const toRound = Number(primarySelect ? primarySelect.value : 0);
    if (!toRound) {
      continue;
    }

    let toRoundSecondary = Number(secondarySelect ? secondarySelect.value : 0);
    if (!toRoundSecondary || toRoundSecondary === toRound) {
      toRoundSecondary = 0;
    }

    result.push({
      id: `${key}->${toRound}${toRoundSecondary ? `-${toRoundSecondary}` : ""}`,
      enabled: true,
      date: row.date,
      vehicleType: row.vehicleType,
      reserveNo: row.reserveNo || "",
      inspectCd: row.inspectCd || "",
      fromRound: Number(row.currentRound),
      toRound,
      toRoundSecondary
    });
  }

  return result;
}

function taskKeyFromRow(row) {
  return `${row.date}|${row.vehicleType}|${row.currentRound}|${row.reserveNo || ""}|${row.inspectCd || ""}`;
}

function taskKeyFromTask(task) {
  return `${task.date}|${task.vehicleType}|${task.fromRound}|${task.reserveNo || ""}|${task.inspectCd || ""}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cssEscape(value) {
  return String(value).replace(/([\\"'])/g, "\\$1");
}

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs && tabs[0] ? tabs[0] : null);
    });
  });
}

function sendTabMessage(tabId, payload, frameId) {
  return new Promise((resolve) => {
    const options = Number.isInteger(frameId) ? { frameId } : undefined;
    chrome.tabs.sendMessage(tabId, payload, options, (res) => {
      if (chrome.runtime.lastError) {
        console.warn("sendMessage failed:", chrome.runtime.lastError.message);
        resolve(null);
        return;
      }
      resolve(res || null);
    });
  });
}

function resolveAutomationFrameId(tabId) {
  return new Promise((resolve) => {
    if (!chrome.webNavigation || !chrome.webNavigation.getAllFrames) {
      resolve(undefined);
      return;
    }

    chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
      if (chrome.runtime.lastError || !Array.isArray(frames)) {
        resolve(undefined);
        return;
      }

      const candidates = frames.filter((f) => /\/pca\/pca0(400|401|402|101)\.php/i.test(String(f.url || "")));
      if (candidates.length === 0) {
        resolve(undefined);
        return;
      }

      const best = candidates.find((f) => /\/pca\/pca04\d\d\.php/i.test(String(f.url || ""))) || candidates[0];
      resolve(best.frameId);
    });
  });
}

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (data) => resolve(data || {}));
  });
}

function storageSet(values) {
  return new Promise((resolve) => {
    chrome.storage.local.set(values, () => resolve());
  });
}
