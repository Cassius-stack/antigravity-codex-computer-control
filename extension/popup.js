const bridgePill = document.getElementById("bridge-pill");
const bridgeStatusText = document.getElementById("bridge-status-text");
const browserLabel = document.getElementById("browser-label");
const groupCountEl = document.getElementById("group-count");
const attachedCountEl = document.getElementById("attached-count");
const groupSummaryEl = document.getElementById("group-summary");
const reconnectBtn = document.getElementById("reconnect-btn");
const finishBtn = document.getElementById("finish-btn");

function renderStatus(state) {
  if (!state) return;
  const connected = Boolean(state.nativeConnected);
  bridgePill.classList.toggle("connected", connected);
  bridgePill.classList.toggle("disconnected", !connected);
  bridgeStatusText.textContent = connected ? "Bridge Live" : "Disconnected";

  const bName = state.browserName || "Chromium";
  browserLabel.textContent = `${bName} · Native Messaging`;

  const groups = Array.isArray(state.sessionGroups) ? state.sessionGroups : [];
  const attachedCount = Number(state.attachedTabCount || 0);
  groupCountEl.textContent = String(groups.length);
  attachedCountEl.textContent = String(attachedCount);

  if (groups.length > 0) {
    const names = groups.map((g) => `"${g.title || "Antigravity"}" (${g.color || "cyan"})`).join(", ");
    groupSummaryEl.textContent = `Active group${groups.length > 1 ? "s" : ""}: ${names}`;
  } else if (attachedCount > 0) {
    groupSummaryEl.textContent = `${attachedCount} claimed tab${attachedCount > 1 ? "s" : ""} attached in-place.`;
  } else if (!connected && state.lastNativeError) {
    groupSummaryEl.textContent = `Native bridge status: ${state.lastNativeError}`;
  } else {
    groupSummaryEl.textContent =
      "Ready. Agent tabs open quietly in a color-coded Tab Group without stealing focus.";
  }
}

async function refresh() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "popup:getStatus" });
    renderStatus(resp);
  } catch (err) {
    renderStatus({
      nativeConnected: false,
      browserName: "Browser",
      lastNativeError: err?.message || "Service worker waking up",
    });
  }
}

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

refresh();
setInterval(refresh, 2000);
