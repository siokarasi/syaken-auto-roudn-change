const DEFAULT_MONITORING = {
  minMs: 1700,
  maxMs: 2400,
  maxFailCount: 8
};

const TAB_STEP_DELAY_MS = 450;

let timerId = null;
let tickInProgress = false;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const action = msg && msg.action;

  if (action === "scrapeRows") {
    const entries = parseListPageEntries().map((e) => ({
      id: e.id,
      date: e.date,
      vehicleType: e.vehicleType,
      currentRound: e.currentRound,
      reservationCount: e.reservationCount,
      reserveNo: e.reserveNo || "",
      inspectCd: e.inspectCd || ""
    }));
    sendResponse({ ok: true, entries, page: detectPageType() });
    return true;
  }

  if (action === "getStatus") {
    Promise.all([
      storageGet(["isRunning", "tasks", "automationState", "logs", "monitoring"]),
      Promise.resolve(detectPageType())
    ]).then(([data, page]) => {
      sendResponse({ ok: true, page, ...data });
    });
    return true;
  }

  if (action === "start") {
    handleStart(msg).then(() => sendResponse({ ok: true })).catch((err) => {
      sendResponse({ ok: false, error: String(err) });
    });
    return true;
  }

  if (action === "stop") {
    stopAutomation(msg.reason || "手動停止").then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});

window.addEventListener("load", () => {
  resumeIfRunning();
});

if (document.readyState === "complete") {
  resumeIfRunning();
}

async function handleStart(msg) {
  const allTasks = Array.isArray(msg.tasks) ? msg.tasks : [];
  const tasks = allTasks.length > 0 ? [allTasks[0]] : [];
  const monitoring = normalizeMonitoring(msg.monitoring || {});

  await storageSet({
    isRunning: true,
    tasks,
    monitoring,
    automationState: {
      phase: "idle",
      activeTaskId: null,
      targetRound: null,
      completedTaskIds: [],
      failCount: 0,
      lastError: ""
    },
    logs: []
  });

  await addLog(`監視開始: 対象 ${tasks.length} 件`);
  scheduleNextTick(120);
}

async function resumeIfRunning() {
  const data = await storageGet(["isRunning"]);
  if (data.isRunning) {
    scheduleNextTick(250);
  }
}

function scheduleNextTick(delayMs) {
  if (timerId) {
    clearTimeout(timerId);
  }
  timerId = setTimeout(runTick, Math.max(30, delayMs));
}

async function runTick() {
  if (tickInProgress) {
    scheduleNextTick(250);
    return;
  }
  tickInProgress = true;

  try {
    const data = await storageGet(["isRunning", "tasks", "monitoring", "automationState"]);
    const isRunning = Boolean(data.isRunning);

    if (!isRunning) {
      tickInProgress = false;
      return;
    }

    if (isLoginPage()) {
      await stopAutomation("ログイン画面を検知したため停止しました");
      tickInProgress = false;
      return;
    }

    const monitoring = normalizeMonitoring(data.monitoring || {});
    const state = normalizeState(data.automationState || {});
    const allTasks = Array.isArray(data.tasks) ? data.tasks : [];
    const tasks = allTasks.filter((t) => t && t.enabled !== false);

    if (tasks.length === 0) {
      await stopAutomation("有効なタスクがないため停止しました");
      tickInProgress = false;
      return;
    }

    const page = detectPageType();

    if (state.phase === "idle") {
      if (page === "list") {
        const acted = await processListPageIdle(tasks, state);
        if (!acted) {
          await tryRefreshList();
        }
      } else if (page === "change-form") {
        await addLog("idle状態で変更画面のため、戻る操作を試行");
        await backToListByTabRule();
      } else {
        await addLog(`idle待機: ページ判定 ${page}`);
      }
    } else if (state.phase === "change-form") {
      await processChangeForm(tasks, state);
    } else if (state.phase === "awaiting-confirm") {
      await processConfirmPage(state);
    } else if (state.phase === "verifying") {
      await processVerifying(tasks, state);
    } else {
      await incrementFail(state, monitoring, `想定外フェーズ: ${state.phase}`);
    }

    const nextDelay = randomInt(monitoring.minMs, monitoring.maxMs);
    scheduleNextTick(nextDelay);
  } catch (err) {
    await addLog(`エラー: ${String(err)}`);
    const data = await storageGet(["monitoring", "automationState"]);
    const monitoring = normalizeMonitoring(data.monitoring || {});
    const state = normalizeState(data.automationState || {});
    await incrementFail(state, monitoring, "例外発生");
    scheduleNextTick(1200);
  } finally {
    tickInProgress = false;
  }
}

async function processListPageIdle(tasks, state) {
  const entries = parseListPageEntries();
  const completed = new Set(state.completedTaskIds || []);
  const pending = tasks.filter((t) => !completed.has(t.id));

  if (pending.length === 0) {
    await stopAutomation("すべてのタスクが完了しました");
    return true;
  }

  for (const task of pending) {
    const matched = entries.find((e) => isEntryMatch(task, e));
    if (!matched) {
      continue;
    }

    await storageSet({
      automationState: {
        ...state,
        phase: "change-form",
        activeTaskId: task.id,
        targetRound: null,
        failCount: 0,
        lastError: ""
      }
    });
    const candidatesText = formatRoundCandidates(task);
    await addLog(`対象検知: ${task.vehicleType} ${task.date} ${task.fromRound}R -> ${candidatesText}`);
    focusByTabAndActivate(matched.linkElement);
    return true;
  }

  await addLog("一致行なし: 表示更新を試行");
  return false;
}

async function processChangeForm(tasks, state) {
  const task = tasks.find((t) => t.id === state.activeTaskId);
  if (!task) {
    await stopAutomation("アクティブタスクが見つからないため停止しました");
    return;
  }

  if (detectPageType() !== "change-form") {
    await addLog("変更画面待機中");
    return;
  }

  const select = document.querySelector("select");
  if (!select) {
    await addLog("ラウンド選択のセレクトが見つかりません");
    return;
  }

  const candidates = getTaskRoundCandidates(task);
  const selectedCandidate = chooseFirstAvailableCandidate(select, candidates);

  if (!selectedCandidate) {
    await addLog(`希望ラウンド ${formatRoundCandidates(task)} が未表示: 戻って再読込します`);
    await storageSet({
      automationState: {
        ...state,
        phase: "idle",
        activeTaskId: null,
        targetRound: null,
        failCount: 0,
        lastError: ""
      }
    });
    await backToListByTabRule();
    return;
  }

  const desiredText = `${selectedCandidate.round}ラウンド`;
  const selected = await chooseRoundByKeyboard(select, selectedCandidate.option.value, desiredText);
  if (!selected) {
    await addLog(`希望ラウンド ${desiredText} の選択に失敗しました`);
    return;
  }

  if (candidates.length > 1 && selectedCandidate.round !== candidates[0]) {
    await addLog(`第1候補が不可のため第2候補 ${selectedCandidate.round}R を採用`);
  }

  const changeBtn = findActionButton(["変更", "変更実行", "次へ"]);
  await storageSet({
    automationState: {
      ...state,
      phase: "awaiting-confirm",
      targetRound: selectedCandidate.round,
      failCount: 0,
      lastError: ""
    }
  });

  if (changeBtn) {
    if (select.options.length <= 1) {
      await addLog("候補1件: Tab2回で変更ボタンへ移動して実行");
      await performTabThenEnter(2, select, (el) => isChangeButton(el));
    } else {
      await addLog(`変更操作実行: ${desiredText}`);
      focusByTabAndActivate(changeBtn);
    }
    return;
  }

  await addLog("変更ボタン未検出: Tab2回+Enter を実行");
  await performTabThenEnter(2);
}

async function processConfirmPage(state) {
  const page = detectPageType();

  if (page === "list") {
    await storageSet({
      automationState: {
        ...state,
        phase: "verifying",
        failCount: 0,
        lastError: ""
      }
    });
    await addLog("一覧へ戻ったため検証フェーズへ");
    return;
  }

  const confirmBtn = findActionButton(["登録", "確定", "変更"]);
  if (confirmBtn) {
    await storageSet({
      automationState: {
        ...state,
        phase: "verifying",
        failCount: 0,
        lastError: ""
      }
    });

    await addLog("確認ボタンを実行");
    focusByTabAndActivate(confirmBtn);
    return;
  }

  await storageSet({
    automationState: {
      ...state,
      phase: "verifying",
      failCount: 0,
      lastError: ""
    }
  });
  await addLog("確認ボタン未検出: Tab2回+Enter を実行");
  await performTabThenEnter(2);
}

async function processVerifying(tasks, state) {
  if (detectPageType() !== "list") {
    await addLog("検証待機: 一覧ページ待ち");
    return;
  }

  const task = tasks.find((t) => t.id === state.activeTaskId);
  if (!task) {
    await stopAutomation("検証対象タスクが見つからないため停止しました");
    return;
  }

  const entries = parseListPageEntries();
  const expectedRound = Number(state.targetRound || task.toRound);
  const success = entries.some((e) => {
    if (task.reserveNo && e.reserveNo) {
      return String(task.reserveNo) === String(e.reserveNo) && e.currentRound === expectedRound;
    }
    return e.date === task.date && e.vehicleType === task.vehicleType && e.currentRound === expectedRound;
  });

  if (!success) {
    await addLog("変更検証未成立: 次周期で再確認");
    await tryRefreshList();
    return;
  }

  const completed = new Set(state.completedTaskIds || []);
  completed.add(task.id);

  const nextState = {
    ...state,
    phase: "idle",
    activeTaskId: null,
    targetRound: null,
    completedTaskIds: Array.from(completed),
    failCount: 0,
    lastError: ""
  };

  await storageSet({ automationState: nextState });
  await addLog(`完了: ${task.vehicleType} ${task.date} ${task.fromRound}R -> ${expectedRound}R`);

  const remaining = tasks.filter((t) => !completed.has(t.id));
  if (remaining.length === 0) {
    await stopAutomation("すべての変更が完了しました");
  }
}

async function incrementFail(state, monitoring, errorMsg) {
  const nextFail = (state.failCount || 0) + 1;
  const nextState = {
    ...state,
    failCount: nextFail,
    lastError: errorMsg
  };
  await storageSet({ automationState: nextState });
  await addLog(`失敗カウント ${nextFail}/${monitoring.maxFailCount}: ${errorMsg}`);

  if (nextFail >= monitoring.maxFailCount) {
    await stopAutomation("失敗回数上限に達したため停止しました");
  }
}

async function stopAutomation(reason) {
  if (timerId) {
    clearTimeout(timerId);
    timerId = null;
  }
  await storageSet({
    isRunning: false,
    automationState: {
      phase: "idle",
      activeTaskId: null,
      targetRound: null,
      completedTaskIds: [],
      failCount: 0,
      lastError: ""
    }
  });
  await addLog(`停止: ${reason}`);
}

function detectPageType() {
  const hasListRows = parseListPageEntries().length > 0;
  if (hasListRows) {
    return "list";
  }

  const hasRoundSelect = Boolean(document.querySelector("select"));
  const hasRoundLabel = normalizeText(document.body.innerText || "").includes("予約ラウンドの変更を行います");
  if (hasRoundSelect && hasRoundLabel) {
    return "change-form";
  }

  return "unknown";
}

function parseListPageEntries() {
  const result = [];
  const plates = Array.from(document.querySelectorAll(".common-table-plate"));

  for (const plate of plates) {
    const vehicleType = extractVehicleType(plate);
    const bookingTable = findBookingTable(plate);
    if (!bookingTable) {
      continue;
    }

    const rows = Array.from(bookingTable.querySelectorAll("tr"));
    for (const row of rows) {
      const cells = Array.from(row.cells || []);
      if (cells.length < 5) {
        continue;
      }

      const linkElement = cells[0].querySelector("a[href*='pca0401.php']");
      if (!linkElement) {
        continue;
      }

      const params = parseHrefParams(linkElement.getAttribute("href") || "");
      const dateFromHref = params.pINSPECTDATE || "";
      const dateFromText = (normalizeText(linkElement.innerText).match(/\d{4}\/\d{2}\/\d{2}/) || [""])[0];
      const date = dateFromHref || dateFromText;

      const round = Number(params.pROUNDCD) || extractRoundNumber(cells[1].innerText);
      if (!date || !round) {
        continue;
      }

      const reserveNo = params.pRESERVENO || "";
      const inspectCd = params.pINSPECTCD || "";

      result.push({
        id: `${date}|${vehicleType}|${round}|${reserveNo || result.length}`,
        date,
        vehicleType,
        currentRound: round,
        reservationCount: normalizeText(cells[3].innerText),
        reserveNo,
        inspectCd,
        linkElement
      });
    }
  }

  return result;
}

function chooseFirstAvailableCandidate(select, candidates) {
  const options = Array.from(select.options || []);
  for (const round of candidates) {
    const desiredText = `${round}ラウンド`;
    const option = options.find((o) => normalizeText(o.textContent).includes(desiredText));
    if (option) {
      return { round, option };
    }
  }
  return null;
}

function getTaskRoundCandidates(task) {
  const first = Number(task.toRound) || 0;
  const second = Number(task.toRoundSecondary) || 0;
  const result = [];
  if (first > 0) {
    result.push(first);
  }
  if (second > 0 && second !== first) {
    result.push(second);
  }
  return result;
}

function formatRoundCandidates(task) {
  const list = getTaskRoundCandidates(task);
  if (list.length === 0) {
    return "(候補なし)";
  }
  if (list.length === 1) {
    return `${list[0]}R`;
  }
  return `${list[0]}R/${list[1]}R`;
}

function isEntryMatch(task, entry) {
  if (task.reserveNo && entry.reserveNo) {
    return String(task.reserveNo) === String(entry.reserveNo);
  }

  return entry.date === task.date &&
    entry.vehicleType === task.vehicleType &&
    Number(entry.currentRound) === Number(task.fromRound);
}

function extractVehicleType(plate) {
  const rows = Array.from(plate.querySelectorAll("table.common-table tr"));
  for (const row of rows) {
    const th = row.querySelector("th");
    const td = row.querySelector("td");
    const head = normalizeText(th ? th.innerText : "");
    if (head === "検査場" && td) {
      return normalizeText(td.innerText) || "不明";
    }
  }
  return "不明";
}

function findBookingTable(plate) {
  const tables = Array.from(plate.querySelectorAll("table.common-table"));
  return tables.find((tbl) => Boolean(tbl.querySelector("a[href*='pca0401.php']"))) || null;
}

function parseHrefParams(href) {
  const query = String(href || "").split("?")[1] || "";
  const params = {};
  if (!query) {
    return params;
  }

  for (const pair of query.split("&")) {
    if (!pair) {
      continue;
    }
    const [rawKey, rawValue] = pair.split("=");
    const key = decodeURIComponent((rawKey || "").trim());
    const value = decodeURIComponent((rawValue || "").trim());
    if (key) {
      params[key] = value;
    }
  }
  return params;
}

function findActionButton(candidates) {
  const buttons = Array.from(document.querySelectorAll("button, input[type='button'], input[type='submit']"));
  for (const btn of buttons) {
    const text = normalizeText(btn.textContent || btn.value || "");
    if (candidates.some((c) => text.includes(c))) {
      return btn;
    }
  }
  return null;
}

function focusByTabAndActivate(target, shouldActivate = true) {
  if (!target) {
    return;
  }

  const focusable = Array.from(document.querySelectorAll("a, button, input, select, textarea, [tabindex]"))
    .filter((el) => !el.disabled && isVisible(el));

  const active = document.activeElement;
  const currentIndex = focusable.indexOf(active);
  const targetIndex = focusable.indexOf(target);

  if (targetIndex > currentIndex) {
    for (let i = 0; i < targetIndex - currentIndex; i += 1) {
      dispatchTab();
    }
  }

  target.focus();
  if (shouldActivate) {
    dispatchSpace(target);
    target.click();
  }
}

function dispatchTab() {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", keyCode: 9, bubbles: true }));
  document.dispatchEvent(new KeyboardEvent("keyup", { key: "Tab", code: "Tab", keyCode: 9, bubbles: true }));
}

function dispatchSpace(target) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", keyCode: 32, bubbles: true }));
  target.dispatchEvent(new KeyboardEvent("keyup", { key: " ", code: "Space", keyCode: 32, bubbles: true }));
}

function dispatchEnter(target) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
  target.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
}

function dispatchArrowDown(target) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", keyCode: 40, bubbles: true }));
  target.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowDown", code: "ArrowDown", keyCode: 40, bubbles: true }));
}

function dispatchArrowUp(target) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", code: "ArrowUp", keyCode: 38, bubbles: true }));
  target.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowUp", code: "ArrowUp", keyCode: 38, bubbles: true }));
}

async function performTabThenEnter(tabCount, preferredStart, stopWhenFocused, shouldActivate = true) {
  const focusStart = preferredStart || (document.activeElement && document.activeElement !== document.body
    ? document.activeElement
    : firstFocusable() || document.body);

  if (focusStart && typeof focusStart.focus === "function") {
    focusStart.focus();
    await sleep(TAB_STEP_DELAY_MS);
  }

  if (typeof stopWhenFocused === "function" && stopWhenFocused(document.activeElement)) {
    const current = document.activeElement || document.body;
    if (shouldActivate) {
      await addLog(`Enter実行(開始時到達): ${describeElement(current)}`);
      dispatchEnter(current);
      if (current && typeof current.click === "function") {
        current.click();
      }
    } else {
      await addLog(`フォーカス到達(開始時): ${describeElement(current)}`);
    }
    return;
  }

  for (let i = 0; i < tabCount; i += 1) {
    dispatchTab();
    moveFocusByTab();
    await addLog(`Tab ${i + 1}/${tabCount}: ${describeElement(document.activeElement)}`);
    await sleep(TAB_STEP_DELAY_MS);
    if (typeof stopWhenFocused === "function" && stopWhenFocused(document.activeElement)) {
      break;
    }
  }

  const target = document.activeElement || document.body;
  if (shouldActivate) {
    await addLog(`Enter実行: ${describeElement(target)}`);
    dispatchEnter(target);
    if (target && typeof target.click === "function") {
      target.click();
    }
  } else {
    await addLog(`フォーカス到達: ${describeElement(target)}`);
  }
}

function moveFocusByTab() {
  const list = getFocusableList();
  if (list.length === 0) {
    return;
  }

  const active = document.activeElement;
  const index = list.indexOf(active);
  const nextIndex = index >= 0 ? Math.min(index + 1, list.length - 1) : 0;
  const next = list[nextIndex];
  if (next && typeof next.focus === "function") {
    next.focus();
  }
}

function getFocusableList() {
  return Array.from(document.querySelectorAll("a, button, input, select, textarea, [tabindex]"))
    .filter((el) => !el.disabled && isVisible(el));
}

function firstFocusable() {
  const list = getFocusableList();
  return list[0] || null;
}

async function tryRefreshList() {
  const refreshBtn = findActionButton(["表示更新", "更新", "検索"]);
  if (refreshBtn) {
    focusByTabAndActivate(refreshBtn);
    return;
  }

  window.dispatchEvent(new CustomEvent("SYAKEN_AUTO_CALL", { detail: { command: "submitform" } }));
}

async function backToListByTabRule(startElement) {
  const hasVacancy = detectAnyVacancyOnChangeForm();
  const tabCount = hasVacancy ? 3 : 2;
  await addLog(`戻る操作: 空き${hasVacancy ? "あり" : "なし"} -> Tab${tabCount}+Enter`);
  const start = startElement || firstFocusable() || document.body;
  await performTabThenEnter(tabCount, start, (el) => isBackButton(el));
}

function detectAnyVacancyOnChangeForm() {
  const statusRow = document.querySelector("tr.img-c");
  if (!statusRow) {
    return false;
  }

  const cells = Array.from(statusRow.querySelectorAll("td"));
  if (cells.length === 0) {
    return false;
  }

  return cells.some((td) => {
    const cls = td.className || "";
    const text = normalizeText(td.innerText);
    if (/(maru|zan)/i.test(cls)) {
      return true;
    }
    return /^\d+$/.test(text) && Number(text) > 0;
  });
}

function isBackButton(el) {
  if (!el) {
    return false;
  }
  const name = String(el.getAttribute && el.getAttribute("name") || "");
  const text = normalizeText(el.textContent || el.value || "");
  return name === "cmdback" || text.includes("戻る");
}

function isChangeButton(el) {
  if (!el) {
    return false;
  }
  const text = normalizeText(el.textContent || el.value || "");
  return text.includes("変更") || text.includes("次へ");
}

async function chooseRoundByKeyboard(select, desiredValue, desiredText) {
  if (!select) {
    return false;
  }

  if (typeof select.focus === "function") {
    select.focus();
    await sleep(TAB_STEP_DELAY_MS);
  }

  await addLog(`プルダウン操作開始: ${desiredText}`);
  dispatchEnter(select);
  await sleep(TAB_STEP_DELAY_MS);

  const options = Array.from(select.options || []);
  const currentIndex = Math.max(0, select.selectedIndex);
  const targetIndex = options.findIndex((o) => String(o.value) === String(desiredValue));
  if (targetIndex < 0) {
    return false;
  }

  const step = targetIndex >= currentIndex ? 1 : -1;
  const steps = Math.abs(targetIndex - currentIndex);

  for (let i = 0; i < steps; i += 1) {
    if (step > 0) {
      dispatchArrowDown(select);
    } else {
      dispatchArrowUp(select);
    }

    const nextIndex = currentIndex + step * (i + 1);
    select.selectedIndex = nextIndex;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await addLog(`プルダウン移動 ${i + 1}/${steps}: ${normalizeText(options[nextIndex].textContent)}`);
    await sleep(TAB_STEP_DELAY_MS);
  }

  select.value = String(desiredValue);
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await addLog(`プルダウン確定: ${desiredText}`);
  dispatchEnter(select);
  await sleep(TAB_STEP_DELAY_MS);
  return true;
}

function describeElement(el) {
  if (!el) {
    return "(none)";
  }

  const tag = String(el.tagName || "").toLowerCase();
  const name = String(el.getAttribute && el.getAttribute("name") || "");
  const id = String(el.id || "");
  const text = normalizeText(el.textContent || el.value || "").slice(0, 20);
  return `${tag}${id ? `#${id}` : ""}${name ? `[name=${name}]` : ""}${text ? `:${text}` : ""}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLoginPage() {
  const href = String(location.href || "").toLowerCase();
  if (href.includes("login")) {
    return true;
  }
  return Boolean(document.querySelector("input[type='password']"));
}

function normalizeMonitoring(raw) {
  const minMs = Number(raw.minMs) || DEFAULT_MONITORING.minMs;
  const maxMs = Number(raw.maxMs) || DEFAULT_MONITORING.maxMs;
  const sortedMin = Math.min(minMs, maxMs);
  const sortedMax = Math.max(minMs, maxMs);

  return {
    minMs: Math.max(600, sortedMin),
    maxMs: Math.max(900, sortedMax),
    maxFailCount: Math.max(3, Number(raw.maxFailCount) || DEFAULT_MONITORING.maxFailCount)
  };
}

function normalizeState(raw) {
  return {
    phase: raw.phase || "idle",
    activeTaskId: raw.activeTaskId || null,
    targetRound: Number(raw.targetRound) || null,
    completedTaskIds: Array.isArray(raw.completedTaskIds) ? raw.completedTaskIds : [],
    failCount: Number(raw.failCount) || 0,
    lastError: raw.lastError || ""
  };
}

function extractRoundNumber(text) {
  const m = normalizeText(text).match(/(\d)\s*ラウンド/);
  return m ? Number(m[1]) : null;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isVisible(el) {
  if (!el) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result || {}));
  });
}

function storageSet(data) {
  return new Promise((resolve) => {
    chrome.storage.local.set(data, () => resolve());
  });
}

async function addLog(message) {
  const now = new Date();
  const stamp = now.toLocaleTimeString("ja-JP", { hour12: false });
  const line = `[${stamp}] ${message}`;
  console.log(`[syaken-auto] ${line}`);

  const data = await storageGet(["logs"]);
  const logs = Array.isArray(data.logs) ? data.logs : [];
  logs.unshift(line);
  await storageSet({ logs: logs.slice(0, 60) });
}
