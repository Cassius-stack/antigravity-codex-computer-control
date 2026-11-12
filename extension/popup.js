const bridgePill = document.getElementById("bridge-pill");
const bridgeStatusText = document.getElementById("bridge-status-text");
const browserLabel = document.getElementById("browser-label");
const groupCountEl = document.getElementById("group-count");
const attachedCountEl = document.getElementById("attached-count");
const groupSummaryEl = document.getElementById("group-summary");
const reconnectBtn = document.getElementById("reconnect-btn");
const finishBtn = document.getElementById("finish-btn");
const openSidepanelBtn = document.getElementById("open-sidepanel-btn");
const popupHostLabel = document.getElementById("popup-host-label");
const popupSitePolicy = document.getElementById("popup-site-policy");

let currentActiveTab = null;
let currentWindowId = null;
let currentHost = "";

function extractHost(url) {
  try {
    const parsed = new URL(url || "");
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function renderStatus(state) {
  if (!state) return;
  const connected = Boolean(state.nativeConnected);
  bridgePill.classList.toggle("connected", connected);
  bridgePill.classList.toggle("disconnected", !connected);
  bridgeStatusText.textContent = connected ? "Live" : "Offline";

  const bName = state.browserName || "Chromium";
  browserLabel.textContent = `${bName} · Companion Bridge`;

  const groups = Array.isArray(state.sessionGroups) ? state.sessionGroups : [];
  const attachedCount = Number(state.attachedTabCount || 0);
  groupCountEl.textContent = String(groups.length);
  attachedCountEl.textContent = String(attachedCount);

  const perms = state.sitePermissions || {};
  const policy = currentHost ? perms[currentHost] || "allow" : "allow";
  popupHostLabel.textContent = currentHost || "Internal tab";
  for (const btn of popupSitePolicy.querySelectorAll(".seg-opt")) {
    btn.classList.toggle("active", btn.dataset.policy === policy);
    btn.disabled = !currentHost;
  }

  if (groups.length > 0) {
    const names = groups.map((g) => `"${g.title || "Antigravity"}" (${g.color || "cyan"})`).join(", ");
    groupSummaryEl.textContent = `Active group${groups.length > 1 ? "s" : ""}: ${names}`;
  } else if (attachedCount > 0) {
    groupSummaryEl.textContent = `${attachedCount} claimed tab${attachedCount > 1 ? "s" : ""} controlled in-place.`;
  } else if (!connected && state.lastNativeError) {
    groupSummaryEl.textContent = `Native bridge status: ${state.lastNativeError}`;
  } else {
    groupSummaryEl.textContent =
      "Ready. Agent tabs open quietly in a color-coded Tab Group without stealing focus.";
  }
}

async function refresh() {
  try {
    if (chrome.tabs?.query) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      currentActiveTab = tab || null;
      if (tab?.windowId) currentWindowId = tab.windowId;
      currentHost = extractHost(tab?.url || "");
    }
    if (!currentWindowId && chrome.windows?.getCurrent) {
      const win = await chrome.windows.getCurrent().catch(() => null);
      if (win?.id) currentWindowId = win.id;
    }
    const [resp, settingsRes] = await Promise.all([
      chrome.runtime.sendMessage({ type: "popup:getStatus" }),
      chrome.runtime.sendMessage({ type: "sidepanel:getSettings" }).catch(() => null),
    ]);
    const prefTheme = settingsRes?.settings?.theme;
    if (prefTheme === "dark" || prefTheme === "light") {
      document.documentElement.dataset.theme = prefTheme;
    } else {
      delete document.documentElement.dataset.theme;
    }
    renderStatus(resp);
  } catch (err) {
    renderStatus({
      nativeConnected: false,
      browserName: "Browser",
      lastNativeError: err?.message || "Service worker waking up",
    });
  }
}

popupSitePolicy.addEventListener("click", async (e) => {
  const btn = e.target.closest(".seg-opt");
  if (!btn || !btn.dataset.policy || !currentHost) return;
  await chrome.runtime.sendMessage({
    type: "sidepanel:setSitePermission",
    host: currentHost,
    policy: btn.dataset.policy,
  });
  await refresh();
});

reconnectBtn.addEventListener("click", async () => {
  reconnectBtn.disabled = true;
  try {
    const resp = await chrome.runtime.sendMessage({ type: "popup:reconnect" });
    renderStatus(resp);
  } finally {
    reconnectBtn.disabled = false;
  }
});

finishBtn.addEventListener("click", async () => {
  finishBtn.disabled = true;
  try {
    const resp = await chrome.runtime.sendMessage({ type: "popup:finishAll" });
    renderStatus(resp);
  } finally {
    finishBtn.disabled = false;
  }
});

openSidepanelBtn.addEventListener("click", async () => {
  if (!chrome.sidePanel?.open) return;
  const winId = currentActiveTab?.windowId || currentWindowId;
  try {
    if (currentActiveTab?.id) {
      await chrome.sidePanel.open({ tabId: currentActiveTab.id });
      window.close();
      return;
    }
  } catch {}
  try {
    if (winId) {
      await chrome.sidePanel.open({ windowId: winId });
      window.close();
    }
  } catch {}
});

refresh();
setInterval(refresh, 2000);
