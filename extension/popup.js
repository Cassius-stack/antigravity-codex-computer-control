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

function normalizeSiteHost(rawHostOrUrl) {
  const raw = String(rawHostOrUrl || "").trim();
  if (!raw) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
      return parsed.hostname.toLowerCase().replace(/^www\./, "").replace(/\.+$/, "");
    } catch {
      return "";
    }
  }
  const stripped = raw
    .toLowerCase()
    .replace(/\/.*$/, "")
    .replace(/\.+$/, "");
  if (!stripped) return "";
  if (stripped.startsWith("[")) {
    const endBracket = stripped.indexOf("]");
    return endBracket > 0 ? stripped.slice(0, endBracket + 1) : stripped;
  }
  const hostOnly = stripped.includes(":") && stripped.indexOf(":") === stripped.lastIndexOf(":")
    ? stripped.replace(/:\d+$/, "")
    : stripped;
  return hostOnly.replace(/^www\./, "").replace(/\.+$/, "");
}

function getHostCandidateChain(rawHost) {
  const host = normalizeSiteHost(rawHost);
  if (!host) return [];
  if (host.startsWith("[") || host.includes(":") || /^\d+(?:\.\d+){3}$/.test(host)) {
    return [host];
  }
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 1) return parts;
  const chain = [];
  for (let i = 0; i <= parts.length - 2; i += 1) {
    chain.push(parts.slice(i).join("."));
  }
  return chain;
}

function getPolicyForHost(rawHost, permissions) {
  const perms = permissions && typeof permissions === "object" ? permissions : {};
  for (const candidate of getHostCandidateChain(rawHost)) {
    const rule = perms[candidate];
    if (rule === "allow" || rule === "ask" || rule === "block") {
      return rule;
    }
  }
  return "allow";
}

function extractHost(url) {
  try {
    const parsed = new URL(url || "");
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return normalizeSiteHost(parsed.hostname);
  } catch {
    return "";
  }
}

function hasRuntimeMessenger() {
  return typeof globalThis.chrome?.runtime?.sendMessage === "function";
}

function formatBridgeStatusNotice(rawError) {
  const msg = String(rawError || "").trim();
  if (!msg) return "";
  if (
    /cannot read propert|undefined is not an object|not a function|extension context invalidated|receiving end does not exist|message port closed/i.test(
      msg,
    )
  ) {
    return "Extension service worker is waking up. Click Reconnect if offline.";
  }
  return `Native bridge status: ${msg}`;
}

async function sendPopupMessage(payload) {
  if (!hasRuntimeMessenger()) return null;
  return await globalThis.chrome.runtime.sendMessage(payload);
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
  const policy = currentHost ? getPolicyForHost(currentHost, perms) : "allow";
  popupHostLabel.textContent = currentHost || "Internal tab";
  for (const btn of popupSitePolicy.querySelectorAll(".seg-opt")) {
    btn.classList.toggle("active", btn.dataset.policy === policy);
    btn.disabled = !currentHost || !hasRuntimeMessenger();
  }

  if (groups.length > 0) {
    const names = groups.map((g) => `"${g.title || "Antigravity"}" (${g.color || "cyan"})`).join(", ");
    groupSummaryEl.textContent = `Active group${groups.length > 1 ? "s" : ""}: ${names}`;
  } else if (attachedCount > 0) {
    groupSummaryEl.textContent = `${attachedCount} claimed tab${attachedCount > 1 ? "s" : ""} controlled in-place.`;
  } else if (state.standaloneNotice) {
    groupSummaryEl.textContent = state.standaloneNotice;
  } else if (!connected && state.lastNativeError) {
    groupSummaryEl.textContent = formatBridgeStatusNotice(state.lastNativeError);
  } else {
    groupSummaryEl.textContent =
      "Ready. Agent tabs open quietly in a color-coded Tab Group without stealing focus.";
  }
}

async function refresh() {
  const extApi = globalThis.chrome;
  if (!hasRuntimeMessenger()) {
    renderStatus({
      nativeConnected: false,
      browserName: "Browser",
      standaloneNotice:
        "Open Antigravity from the browser toolbar icon to connect to the live companion bridge.",
    });
    return;
  }

  try {
    if (typeof extApi?.tabs?.query === "function") {
      const [tab] = await extApi.tabs.query({ active: true, currentWindow: true });
      currentActiveTab = tab || null;
      if (tab?.windowId) currentWindowId = tab.windowId;
      currentHost = extractHost(tab?.url || "");
    }
    if (!currentWindowId && typeof extApi?.windows?.getCurrent === "function") {
      const win = await extApi.windows.getCurrent().catch(() => null);
      if (win?.id) currentWindowId = win.id;
    }
    const [resp, settingsRes] = await Promise.all([
      sendPopupMessage({ type: "popup:getStatus" }),
      sendPopupMessage({ type: "sidepanel:getSettings" }).catch(() => null),
    ]);
    const prefTheme = settingsRes?.settings?.theme;
    if (prefTheme === "dark" || prefTheme === "light") {
      document.documentElement.dataset.theme = prefTheme;
    } else {
      delete document.documentElement.dataset.theme;
    }
    if (resp) {
      renderStatus(resp);
    } else {
      renderStatus({
        nativeConnected: false,
        browserName: "Browser",
        standaloneNotice: "Extension service worker is waking up. Click Reconnect if offline.",
      });
    }
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
  if (!btn || !btn.dataset.policy || !currentHost || !hasRuntimeMessenger()) return;
  try {
    await sendPopupMessage({
      type: "sidepanel:setSitePermission",
      host: currentHost,
      policy: btn.dataset.policy,
    });
    await refresh();
  } catch {}
});

reconnectBtn.addEventListener("click", async () => {
  if (!hasRuntimeMessenger()) {
    await refresh();
    return;
  }
  reconnectBtn.disabled = true;
  try {
    const resp = await sendPopupMessage({ type: "popup:reconnect" });
    if (resp) renderStatus(resp);
  } catch (err) {
    renderStatus({
      nativeConnected: false,
      browserName: "Browser",
      lastNativeError: err?.message || "Reconnect failed",
    });
  } finally {
    reconnectBtn.disabled = false;
  }
});

finishBtn.addEventListener("click", async () => {
  if (!hasRuntimeMessenger()) return;
  finishBtn.disabled = true;
  try {
    const resp = await sendPopupMessage({ type: "popup:finishAll" });
    if (resp) renderStatus(resp);
  } catch {} finally {
    finishBtn.disabled = false;
  }
});

openSidepanelBtn.addEventListener("click", async () => {
  const sidePanelApi = globalThis.chrome?.sidePanel;
  if (typeof sidePanelApi?.open !== "function") return;
  const winId = currentActiveTab?.windowId || currentWindowId;
  try {
    if (currentActiveTab?.id) {
      await sidePanelApi.open({ tabId: currentActiveTab.id });
      window.close();
      return;
    }
  } catch {}
  try {
    if (winId) {
      await sidePanelApi.open({ windowId: winId });
      window.close();
    }
  } catch {}
});

refresh();
setInterval(refresh, 2000);
