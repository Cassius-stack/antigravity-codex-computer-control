// Antigravity in Chrome — Crafted Google Gemini Side Panel & Live ACP Client

const state = {
  currentSessionId: null,
  sessionTitle: "Antigravity",
  interactionMode: "chat", // "chat" | "agent"
  permissionMode: "auto", // "auto" | "default" | "plan"
  modelId: "gemini-4-carbon-medium",
  models: [{ modelId: "gemini-4-carbon-medium", name: "Gemini 4 Carbon" }],
  running: false,
  activeRequestId: null,
  includeActiveTab: true,
  activeTab: null,
  allTabs: [],
  mentionedTabIds: new Set(),
  screenshot: null, // { dataUrl, base64 }
  sessions: [],
  shortcuts: { builtin: [], custom: [] },
  agySkills: [],
  schedules: [],
  bridgeStatus: null,
  agentStatus: null,
  schedInterval: 60,
  schedMode: "chat",
  customScMode: "chat",
};

// SVG Snippets (Crisp Material Symbols & New 4-Color Rounded Gemini Spark)
const SVG = {
  sparkle: `<svg viewBox="0 0 32 32" width="21" height="21" aria-hidden="true"><use href="#gemini-spark-4c"/></svg>`,
  chevronDown: `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M5.5 7.75L10 12.25l4.5-4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  check: `<svg class="model-option-check" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4.2 10.5l3.8 3.8 7.8-8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  spinner: `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M10 3a7 7 0 1 1-4.95 2.05" stroke-linecap="round"/></svg>`,
  checkSmall: `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.1" aria-hidden="true"><path d="M4.5 10.5l3.6 3.6 7.4-7.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  alertSmall: `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M10 6.5v4M10 13.5h.01" stroke-linecap="round"/></svg>`,
  closeXs: `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke-linecap="round"/></svg>`,
  globeXs: `<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="10" cy="10" r="7.2"/><path d="M3 10h14M10 2.8c2 2 3.1 4.5 3.1 7.2S12 15.2 10 17.2c-2-2-3.1-4.5-3.1-7.2S8 4.8 10 2.8Z"/></svg>`,
  imageXs: `<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="2.8" y="4" width="14.4" height="12" rx="2.2"/><circle cx="7.4" cy="8.4" r="1.3"/><path d="M17.2 13l-3.6-3.6L7.8 15.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  copySm: `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><rect x="6.8" y="6.8" width="9.4" height="9.4" rx="2"/><path d="M4.2 12.8V5.2a1.8 1.8 0 0 1 1.8-1.8h7.6" stroke-linecap="round"/></svg>`,
  openExtSm: `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="M11.5 4.5h4v4M15.5 4.5L8.5 11.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 5.5H5.8A1.8 1.8 0 0 0 4 7.3v6.9A1.8 1.8 0 0 0 5.8 16h6.9a1.8 1.8 0 0 0 1.8-1.8V11" stroke-linecap="round"/></svg>`,
  slashSm: `<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12.5 4L7.5 16" stroke-linecap="round"/></svg>`,
};

// DOM References
const headerTitleEl = document.getElementById("header-title");
const modelMenuBtn = document.getElementById("model-menu-btn");
const modelCurrentLabelEl = document.getElementById("model-current-label");
const modelPopover = document.getElementById("model-popover");
const modelOptionsListEl = document.getElementById("model-options-list");
const permissionSegmentedEl = document.getElementById("permission-segmented");
const bridgeDotEl = document.getElementById("bridge-dot");
const bridgeReconnectRow = document.getElementById("bridge-reconnect-row");
const bridgeLabelEl = document.getElementById("bridge-label");
const bridgeStatusBtn = document.getElementById("bridge-status-btn");

const newChatBtn = document.getElementById("new-chat-btn");
const historyBtn = document.getElementById("history-btn");
const schedulesBtn = document.getElementById("schedules-btn");
const openDesktopBtn = document.getElementById("open-desktop-btn");

const desktopActivityBar = document.getElementById("desktop-activity-bar");
const desktopActivityText = document.getElementById("desktop-activity-text");
const detachAllBtn = document.getElementById("detach-all-btn");

const setupBanner = document.getElementById("setup-banner");
const setupBannerTitle = document.getElementById("setup-banner-title");
const setupBannerDesc = document.getElementById("setup-banner-desc");
const bannerReconnectBtn = document.getElementById("banner-reconnect-btn");

const historyDrawer = document.getElementById("history-drawer");
const closeHistoryBtn = document.getElementById("close-history-btn");
const drawerTabsGroup = document.getElementById("drawer-tabs-group");
const drawerPanelChats = document.getElementById("drawer-panel-chats");
const drawerPanelSchedules = document.getElementById("drawer-panel-schedules");
const historyListEl = document.getElementById("history-list");

const scheduleForm = document.getElementById("schedule-form");
const schedIntervalGroup = document.getElementById("sched-interval-group");
const schedModeGroup = document.getElementById("sched-mode-group");
const schedulesListEl = document.getElementById("schedules-list");

const chatViewport = document.getElementById("chat-viewport");
const welcomeStateEl = document.getElementById("welcome-state");
const greetingHeadlineEl = document.getElementById("greeting-headline");
const quickGridEl = document.getElementById("quick-grid");
const messagesListEl = document.getElementById("messages-list");

const addMenuBtn = document.getElementById("add-menu-btn");
const addMenuPopover = document.getElementById("add-menu-popover");
const menuShareTabsBtn = document.getElementById("menu-share-tabs-btn");
const screenshotBtn = document.getElementById("screenshot-btn");
const menuShortcutsBtn = document.getElementById("menu-shortcuts-btn");

const slashPopover = document.getElementById("slash-popover");
const slashListEl = document.getElementById("slash-list");
const openSaveShortcutBtn = document.getElementById("open-save-shortcut-btn");
const saveShortcutBox = document.getElementById("save-shortcut-box");
const customScModeGroup = document.getElementById("custom-sc-mode-group");
const saveCustomScBtn = document.getElementById("save-custom-sc-btn");

const tabsPopover = document.getElementById("tabs-popover");
const tabsPickerListEl = document.getElementById("tabs-picker-list");
const groupMentionedBtn = document.getElementById("group-mentioned-btn");

const activeTabChipEl = document.getElementById("active-tab-chip");
const activeTabFaviconEl = document.getElementById("active-tab-favicon");
const activeTabGlobeEl = document.getElementById("active-tab-globe");
const activeTabTitleEl = document.getElementById("active-tab-title");
const unshareActiveTabBtn = document.getElementById("unshare-active-tab-btn");
const reshareActiveTabBtn = document.getElementById("reshare-active-tab-btn");
const attachmentChipsEl = document.getElementById("attachment-chips");

const promptInput = document.getElementById("prompt-input");
const agentModeToggle = document.getElementById("agent-mode-toggle");
const sendBtn = document.getElementById("send-btn");
const sendIcon = document.getElementById("send-icon");
const stopIcon = document.getElementById("stop-icon");

let liveAssistantRefs = null;

activeTabFaviconEl.addEventListener("error", () => {
  activeTabFaviconEl.classList.add("hidden");
  activeTabGlobeEl.classList.remove("hidden");
});

function updateGreetingByTime() {
  const hr = new Date().getHours();
  if (hr >= 5 && hr < 12) {
    greetingHeadlineEl.textContent = "Good morning";
  } else if (hr >= 12 && hr < 18) {
    greetingHeadlineEl.textContent = "Good afternoon";
  } else {
    greetingHeadlineEl.textContent = "Hi there";
  }
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatInlineMarkdown(escapedLine) {
  let out = escapedLine;
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[\s(])\*([^*]+)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
  return out;
}

function renderMarkdownSafe(rawMarkdown) {
  const src = String(rawMarkdown ?? "").replace(/\r\n/g, "\n");
  if (!src.trim()) return "";

  const codeBlocks = [];
  const withPlaceholders = src.replace(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang: lang || "code", code: code.replace(/\n$/, "") });
    return `\n@@AG_CODEBLOCK_${idx}@@\n`;
  });

  const lines = withPlaceholders.split("\n");
  const htmlParts = [];
  let inUl = false;
  let inOl = false;
  let tableRows = [];

  const flushLists = () => {
    if (inUl) {
      htmlParts.push("</ul>");
      inUl = false;
    }
    if (inOl) {
      htmlParts.push("</ol>");
      inOl = false;
    }
  };

  const flushTable = () => {
    if (tableRows.length === 0) return;
    if (tableRows.length >= 2 && /^\|?[\s:-]+\|/.test(tableRows[1])) {
      const parseRow = (r) =>
        r
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => formatInlineMarkdown(escapeHtml(c.trim())));
      const headers = parseRow(tableRows[0]);
      const bodyRows = tableRows.slice(2).map(parseRow);
      htmlParts.push(
        `<table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${bodyRows
          .map((cols) => `<tr>${cols.map((c) => `<td>${c}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
      );
    } else {
      for (const r of tableRows) {
        htmlParts.push(`<p>${formatInlineMarkdown(escapeHtml(r))}</p>`);
      }
    }
    tableRows = [];
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    const codeMatch = /^@@AG_CODEBLOCK_(\d+)@@$/.exec(trimmed);
    if (codeMatch) {
      flushLists();
      flushTable();
      const block = codeBlocks[Number(codeMatch[1])];
      if (block) {
        const escapedCode = escapeHtml(block.code);
        htmlParts.push(
          `<div class="code-block-wrap"><div class="code-block-bar"><span>${escapeHtml(
            block.lang,
          )}</span><button type="button" class="copy-code-btn" data-code="${encodeURIComponent(
            block.code,
          )}">Copy</button></div><pre><code>${escapedCode}</code></pre></div>`,
        );
      }
      continue;
    }

    if (trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 2) {
      flushLists();
      tableRows.push(trimmed);
      continue;
    } else {
      flushTable();
    }

    if (!trimmed) {
      flushLists();
      continue;
    }

    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      flushLists();
      const level = headingMatch[1].length;
      htmlParts.push(`<h${level}>${formatInlineMarkdown(escapeHtml(headingMatch[2]))}</h${level}>`);
      continue;
    }

    const ulMatch = /^[-*•]\s+(.+)$/.exec(trimmed);
    if (ulMatch) {
      if (inOl) {
        htmlParts.push("</ol>");
        inOl = false;
      }
      if (!inUl) {
        htmlParts.push("<ul>");
        inUl = true;
      }
      htmlParts.push(`<li>${formatInlineMarkdown(escapeHtml(ulMatch[1]))}</li>`);
      continue;
    }

    const olMatch = /^\d+\.\s+(.+)$/.exec(trimmed);
    if (olMatch) {
      if (inUl) {
        htmlParts.push("</ul>");
        inUl = false;
      }
      if (!inOl) {
        htmlParts.push("<ol>");
        inOl = true;
      }
      htmlParts.push(`<li>${formatInlineMarkdown(escapeHtml(olMatch[1]))}</li>`);
      continue;
    }

    flushLists();
    htmlParts.push(`<p>${formatInlineMarkdown(escapeHtml(trimmed))}</p>`);
  }

  flushLists();
  flushTable();
  return htmlParts.join("");
}

function isNearBottom() {
  return chatViewport.scrollHeight - chatViewport.scrollTop - chatViewport.clientHeight < 96;
}

function scrollToBottom(force = false) {
  if (force || isNearBottom()) {
    chatViewport.scrollTop = chatViewport.scrollHeight;
  }
}

function closeAllPopovers() {
  modelPopover.classList.add("hidden");
  modelMenuBtn.setAttribute("aria-expanded", "false");
  addMenuPopover.classList.add("hidden");
  addMenuBtn.classList.remove("active");
  slashPopover.classList.add("hidden");
  tabsPopover.classList.add("hidden");
}

function syncSendButtonState() {
  if (state.running) {
    sendBtn.disabled = false;
    sendBtn.classList.add("running");
    sendIcon.classList.add("hidden");
    stopIcon.classList.remove("hidden");
    sendBtn.title = "Stop response";
    sendBtn.setAttribute("aria-label", "Stop response");
  } else {
    const hasText = promptInput.value.trim().length > 0;
    sendBtn.disabled = !hasText;
    sendBtn.classList.remove("running");
    sendIcon.classList.remove("hidden");
    stopIcon.classList.add("hidden");
    sendBtn.title = "Send";
    sendBtn.setAttribute("aria-label", "Send");
  }
}

function updateModeUI() {
  const isAgent = state.interactionMode === "agent";
  agentModeToggle.classList.toggle("active", isAgent);
  agentModeToggle.setAttribute("aria-pressed", isAgent ? "true" : "false");
  promptInput.placeholder = isAgent ? "Ask Antigravity to act on this page" : "Ask Antigravity";
}

function updateRunningUI(running) {
  state.running = Boolean(running);
  syncSendButtonState();
}

function formatShortModelName(rawName) {
  const cleaned = String(rawName || "Pro")
    .replace(/\s*\(.*?\)\s*/g, "")
    .replace(/^Gemini\s+/i, "")
    .trim();
  return cleaned || "Pro";
}

function renderModelMenu() {
  const activeModel = state.models.find((m) => m.modelId === state.modelId) || state.models[0];
  modelCurrentLabelEl.textContent = formatShortModelName(activeModel?.name || state.modelId);

  modelOptionsListEl.innerHTML = "";
  for (const m of state.models) {
    const btn = document.createElement("button");
    btn.type = "button";
    const selected = m.modelId === state.modelId;
    btn.className = `model-option-btn${selected ? " selected" : ""}`;
    btn.innerHTML = `<span>${escapeHtml(m.name || m.modelId)}</span>${SVG.check}`;
    btn.addEventListener("click", () => {
      state.modelId = m.modelId;
      renderModelMenu();
      closeAllPopovers();
      if (state.currentSessionId) {
        chrome.runtime.sendMessage({
          type: "sidepanel:setConfig",
          payload: { sessionId: state.currentSessionId, modelId: state.modelId },
        });
      }
    });
    modelOptionsListEl.appendChild(btn);
  }

  for (const seg of permissionSegmentedEl.querySelectorAll(".tonal-seg-btn")) {
    seg.classList.toggle("active", seg.dataset.perm === state.permissionMode);
  }
}

function renderBridgeStatus(status) {
  if (!status) return;
  state.bridgeStatus = status;
  const online = Boolean(status.nativeConnected);

  bridgeDotEl.classList.toggle("hidden", online);
  bridgeReconnectRow.classList.toggle("hidden", online);
  bridgeLabelEl.textContent = online ? "Connected" : "Native bridge offline";

  // Show live browser control pill ONLY when tabs or Tab Groups are actively being controlled
  const attachedCount = Number(status.attachedTabCount || 0);
  const groups = Array.isArray(status.sessionGroups) ? status.sessionGroups : [];

  if (attachedCount > 0 || groups.length > 0) {
    desktopActivityBar.classList.remove("hidden");
    const parts = [];
    if (groups.length > 0) {
      parts.push(groups.map((g) => g.title || "Antigravity").join(", "));
    }
    if (attachedCount > 0) {
      parts.push(`${attachedCount} tab${attachedCount > 1 ? "s" : ""} active`);
    }
    desktopActivityText.textContent = parts.join(" · ");
  } else {
    desktopActivityBar.classList.add("hidden");
  }

  if (!online && status.lastNativeError) {
    setupBanner.classList.remove("hidden");
    bannerReconnectBtn.classList.remove("hidden");
    setupBannerTitle.textContent = "Native bridge disconnected";
    setupBannerDesc.textContent = "Run ./install.sh once if not set up yet, then tap Reconnect.";
  } else if (state.agentStatus && state.agentStatus.ok && !state.agentStatus.agyFound) {
    setupBanner.classList.remove("hidden");
    bannerReconnectBtn.classList.add("hidden");
    setupBannerTitle.textContent = "Enable Antigravity CLI ('agy')";
    setupBannerDesc.textContent =
      "Install 'agy' from Antigravity Settings → CLI to chat directly inside this Side Panel.";
  } else {
    setupBanner.classList.add("hidden");
  }
}

function populateAgentCatalog(agentStatus) {
  if (!agentStatus || !agentStatus.ok) return;
  state.agentStatus = agentStatus;
  if (Array.isArray(agentStatus.availableCommands)) {
    state.agySkills = agentStatus.availableCommands;
  }
  if (Array.isArray(agentStatus.models) && agentStatus.models.length > 0) {
    state.models = agentStatus.models;
    if (!state.models.some((m) => m.modelId === state.modelId)) {
      state.modelId = agentStatus.currentModelId || state.models[0].modelId;
    }
  }
  renderModelMenu();
  renderBridgeStatus(state.bridgeStatus);
}

function syncSharedPageChipUI() {
  const active = state.activeTab;
  if (!active) {
    activeTabChipEl.classList.add("hidden");
    reshareActiveTabBtn.classList.add("hidden");
    return;
  }

  if (state.includeActiveTab) {
    activeTabChipEl.classList.remove("hidden");
    reshareActiveTabBtn.classList.add("hidden");

    let host = "";
    try {
      host = new URL(active.url).hostname.replace(/^www\./, "");
    } catch {}
    activeTabTitleEl.textContent = active.title || host || "Current page";

    if (active.favIconUrl && /^https?:|^data:/i.test(active.favIconUrl)) {
      activeTabFaviconEl.src = active.favIconUrl;
      activeTabFaviconEl.classList.remove("hidden");
      activeTabGlobeEl.classList.add("hidden");
    } else {
      activeTabFaviconEl.classList.add("hidden");
      activeTabGlobeEl.classList.remove("hidden");
    }
  } else {
    activeTabChipEl.classList.add("hidden");
    reshareActiveTabBtn.classList.remove("hidden");
  }
}

function updateActiveTabBar(tabs) {
  state.allTabs = Array.isArray(tabs) ? tabs : [];
  const active =
    state.allTabs.find((t) => t.active && !/^(chrome-extension):\/\//i.test(t.url || "")) ||
    state.allTabs.find((t) => t.active) ||
    null;
  state.activeTab = active;
  syncSharedPageChipUI();

  const validIds = new Set(state.allTabs.map((t) => t.tabId));
  for (const id of Array.from(state.mentionedTabIds)) {
    if (!validIds.has(id)) state.mentionedTabIds.delete(id);
  }
  renderAttachmentChips();
}

function renderAttachmentChips() {
  attachmentChipsEl.innerHTML = "";

  for (const tid of state.mentionedTabIds) {
    const tab = state.allTabs.find((t) => t.tabId === tid);
    if (!tab) continue;
    const chip = document.createElement("div");
    chip.className = "removable-chip";

    if (tab.favIconUrl && /^https?:|^data:/i.test(tab.favIconUrl)) {
      const fav = document.createElement("img");
      fav.className = "tab-favicon";
      fav.src = tab.favIconUrl;
      fav.alt = "";
      fav.addEventListener("error", () => fav.remove());
      chip.appendChild(fav);
    }

    const lbl = document.createElement("span");
    lbl.textContent = tab.title || tab.url || `Tab ${tid}`;
    chip.appendChild(lbl);

    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "chip-dismiss-btn";
    rm.innerHTML = SVG.closeXs;
    rm.addEventListener("click", () => {
      state.mentionedTabIds.delete(tid);
      renderAttachmentChips();
    });
    chip.appendChild(rm);
    attachmentChipsEl.appendChild(chip);
  }

  if (state.screenshot) {
    const chip = document.createElement("div");
    chip.className = "removable-chip";
    if (state.screenshot.dataUrl) {
      const thumb = document.createElement("img");
      thumb.className = "shot-thumb";
      thumb.src = state.screenshot.dataUrl;
      thumb.alt = "";
      chip.appendChild(thumb);
    }
    const lbl = document.createElement("span");
    lbl.textContent = "Page view";
    chip.appendChild(lbl);

    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "chip-dismiss-btn";
    rm.innerHTML = SVG.closeXs;
    rm.addEventListener("click", () => {
      state.screenshot = null;
      renderAttachmentChips();
    });
    chip.appendChild(rm);
    attachmentChipsEl.appendChild(chip);
  }
}

function appendUserMessageDOM(text, attachments = []) {
  welcomeStateEl.classList.add("hidden");
  const turnWrap = document.createElement("div");
  turnWrap.className = "user-turn-wrap";

  if (Array.isArray(attachments) && attachments.length > 0) {
    const attRow = document.createElement("div");
    attRow.className = "msg-attachments";
    for (const att of attachments) {
      const b = document.createElement("span");
      b.className = "att-badge";
      if (att.kind === "screenshot") {
        b.innerHTML = `${SVG.imageXs}<span>Page view</span>`;
      } else {
        b.innerHTML = `${SVG.globeXs}<span>${escapeHtml(att.title || "Shared page")}</span>`;
      }
      attRow.appendChild(b);
    }
    turnWrap.appendChild(attRow);
  }

  const bubble = document.createElement("div");
  bubble.className = "msg-user";
  const txtEl = document.createElement("div");
  txtEl.className = "msg-user-text";
  txtEl.textContent = text;
  bubble.appendChild(txtEl);

  turnWrap.appendChild(bubble);
  messagesListEl.appendChild(turnWrap);
  scrollToBottom(true);
}

function createAssistantTurnDOM({ thoughts = "", toolCalls = [], text = "", streaming = false } = {}) {
  welcomeStateEl.classList.add("hidden");
  const container = document.createElement("div");
  container.className = "msg-assistant";

  const metaRow = document.createElement("div");
  metaRow.className = "assistant-meta-row";

  const sparkleEl = document.createElement("span");
  sparkleEl.className = `assistant-sparkle${streaming ? " streaming" : ""}`;
  sparkleEl.innerHTML = SVG.sparkle;

  const thoughtToggleBtn = document.createElement("button");
  thoughtToggleBtn.type = "button";
  thoughtToggleBtn.className = `thought-toggle-btn${thoughts ? "" : " hidden"}`;
  const startOpen = Boolean(streaming && thoughts && !text);
  thoughtToggleBtn.setAttribute("aria-expanded", startOpen ? "true" : "false");

  const thoughtLabel = document.createElement("span");
  thoughtLabel.textContent = streaming && !text ? "Thinking" : "Show thinking";
  thoughtToggleBtn.innerHTML = "";
  thoughtToggleBtn.append(thoughtLabel);
  thoughtToggleBtn.insertAdjacentHTML("beforeend", SVG.chevronDown);

  const thoughtBody = document.createElement("div");
  thoughtBody.className = `thought-body${startOpen ? "" : " hidden"}`;
  thoughtBody.textContent = thoughts || "";

  thoughtToggleBtn.addEventListener("click", () => {
    const expanded = thoughtToggleBtn.getAttribute("aria-expanded") === "true";
    const next = !expanded;
    thoughtToggleBtn.setAttribute("aria-expanded", next ? "true" : "false");
    thoughtBody.classList.toggle("hidden", !next);
    if (!container.dataset.streaming) {
      thoughtLabel.textContent = next ? "Hide thinking" : "Show thinking";
    }
  });

  metaRow.append(sparkleEl, thoughtToggleBtn);

  const toolsStack = document.createElement("div");
  toolsStack.className = "tool-calls-stack";
  const toolNodesById = new Map();

  const upsertToolCard = (tc) => {
    if (!tc) return;
    const id = tc.toolCallId || `tc-${Math.random()}`;
    let card = toolNodesById.get(id);
    if (!card) {
      card = document.createElement("div");
      card.className = "tool-card";
      card.innerHTML = `<span class="tool-indicator">${SVG.spinner}</span><span class="tool-card-title"></span>`;
      toolNodesById.set(id, card);
      toolsStack.appendChild(card);
    }
    const isDone = tc.status === "completed";
    const isFailed = tc.status === "failed";
    card.classList.toggle("completed", isDone);
    card.classList.toggle("failed", isFailed);
    card.querySelector(".tool-indicator").innerHTML = isDone
      ? SVG.checkSmall
      : isFailed
        ? SVG.alertSmall
        : SVG.spinner;
    card.querySelector(".tool-card-title").textContent = tc.title || tc.name || "Browser action";
  };

  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) upsertToolCard(tc);
  }

  const permissionsStack = document.createElement("div");
  permissionsStack.className = "tool-calls-stack";

  const mdBody = document.createElement("div");
  mdBody.className = "md-body";
  if (text) {
    mdBody.innerHTML = renderMarkdownSafe(text);
  } else if (streaming) {
    container.dataset.streaming = "1";
    mdBody.innerHTML = `<span class="streaming-placeholder">Just a moment…</span>`;
  }

  const footer = document.createElement("div");
  footer.className = `turn-footer${streaming ? " hidden" : ""}`;

  const copyTurnBtn = document.createElement("button");
  copyTurnBtn.type = "button";
  copyTurnBtn.className = "turn-action-btn";
  copyTurnBtn.innerHTML = `${SVG.copySm}<span>Copy</span>`;

  const openAppBtn = document.createElement("button");
  openAppBtn.type = "button";
  openAppBtn.className = "turn-action-btn";
  openAppBtn.innerHTML = `${SVG.openExtSm}<span>Continue in app</span>`;
  openAppBtn.addEventListener("click", () => openInDesktopApp());

  footer.append(copyTurnBtn, openAppBtn);
  container.append(metaRow, thoughtBody, toolsStack, permissionsStack, mdBody, footer);
  messagesListEl.appendChild(container);
  scrollToBottom(true);

  const refs = {
    container,
    sparkleEl,
    thoughtToggleBtn,
    thoughtLabel,
    thoughtBody,
    toolsStack,
    permissionsStack,
    upsertToolCard,
    mdBody,
    footer,
    rawText: text || "",
    rawThoughts: thoughts || "",
  };

  copyTurnBtn.addEventListener("click", () => {
    const content = refs.rawText || mdBody.innerText || "";
    if (!content) return;
    navigator.clipboard?.writeText(content).then(() => {
      const span = copyTurnBtn.querySelector("span");
      if (span) {
        span.textContent = "Copied";
        setTimeout(() => {
          span.textContent = "Copy";
        }, 1400);
      }
    });
  });

  return refs;
}

function finalizeAssistantTurnDOM(refs) {
  if (!refs) return;
  delete refs.container.dataset.streaming;
  refs.sparkleEl.classList.remove("streaming");
  if (refs.rawThoughts) {
    const isExpanded = refs.thoughtToggleBtn.getAttribute("aria-expanded") === "true";
    refs.thoughtLabel.textContent = isExpanded ? "Hide thinking" : "Show thinking";
  }
  refs.footer.classList.remove("hidden");
}

function renderPermissionRequestCard(refs, payload) {
  if (!refs) return;
  const { permRequestId, toolCall, options } = payload;
  const card = document.createElement("div");
  card.className = "permission-card";
  const toolTitle = toolCall?.title || toolCall?.name || "Action";
  const detailText =
    toolCall?.args?.CommandLine ||
    (toolCall?.args ? JSON.stringify(toolCall.args) : "") ||
    toolTitle;

  card.innerHTML = `
    <div class="perm-header">Allow ${escapeHtml(toolCall?.name || "action")}?</div>
    <div class="perm-detail">${escapeHtml(detailText)}</div>
    <div class="perm-actions"></div>
  `;
  const actionsRow = card.querySelector(".perm-actions");
  const opts =
    Array.isArray(options) && options.length > 0
      ? options
      : [
          { optionId: "deny", name: "Decline", kind: "reject_once" },
          { optionId: "allow", name: "Allow", kind: "allow_once" },
        ];

  for (const opt of opts) {
    const btn = document.createElement("button");
    btn.type = "button";
    const isAllow = /allow/i.test(opt.kind || opt.optionId || "");
    btn.className = isAllow ? "filled-pill-btn" : "tonal-pill-btn";
    if (isAllow) btn.style.marginLeft = "0";
    btn.textContent = opt.name || opt.optionId;
    btn.addEventListener("click", async () => {
      card.remove();
      await chrome.runtime.sendMessage({
        type: "sidepanel:respondPermission",
        permRequestId,
        optionId: opt.optionId,
      });
    });
    actionsRow.appendChild(btn);
  }

  refs.permissionsStack.appendChild(card);
  scrollToBottom(true);
}

function handleIncomingAgentEvent(payload = {}) {
  const { event, requestId, sessionId, update } = payload;
  if (requestId && state.activeRequestId && requestId !== state.activeRequestId) {
    return;
  }

  if (event === "session_created" && sessionId) {
    state.currentSessionId = sessionId;
    return;
  }

  if (event === "permission_request") {
    renderPermissionRequestCard(liveAssistantRefs, payload);
    return;
  }

  if (event === "session_update" && update) {
    if (update.sessionUpdate === "session_info_update" && update.title) {
      state.sessionTitle = update.title;
      headerTitleEl.textContent = update.title;
      return;
    }

    if (!liveAssistantRefs) return;
    const stickBottom = isNearBottom();

    if (update.sessionUpdate === "agent_thought_chunk" && update.content?.text) {
      liveAssistantRefs.rawThoughts += update.content.text;
      liveAssistantRefs.thoughtToggleBtn.classList.remove("hidden");
      if (!liveAssistantRefs.rawText) {
        liveAssistantRefs.thoughtLabel.textContent = "Thinking";
        liveAssistantRefs.thoughtToggleBtn.setAttribute("aria-expanded", "true");
        liveAssistantRefs.thoughtBody.classList.remove("hidden");
      }
      liveAssistantRefs.thoughtBody.textContent = liveAssistantRefs.rawThoughts;
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      liveAssistantRefs.upsertToolCard(update);
    } else if (update.sessionUpdate === "agent_message_chunk" && update.content?.text) {
      liveAssistantRefs.rawText += update.content.text;
      liveAssistantRefs.thoughtToggleBtn.setAttribute("aria-expanded", "false");
      liveAssistantRefs.thoughtBody.classList.add("hidden");
      liveAssistantRefs.thoughtLabel.textContent = "Show thinking";
      liveAssistantRefs.mdBody.innerHTML = renderMarkdownSafe(liveAssistantRefs.rawText);
    }

    if (stickBottom) scrollToBottom(true);
  }
}

async function sendPromptNow(overridePromptText = null) {
  if (state.running) {
    if (state.currentSessionId) {
      await chrome.runtime.sendMessage({
        type: "sidepanel:cancelPrompt",
        sessionId: state.currentSessionId,
      });
    }
    return;
  }

  let rawInput = overridePromptText !== null ? String(overridePromptText) : promptInput.value.trim();
  if (!rawInput) return;

  if (rawInput.startsWith("/")) {
    const token = rawInput.slice(1).split(/\s+/)[0].toLowerCase();
    const rest = rawInput.slice(1 + token.length).trim();
    const allShortcuts = [...(state.shortcuts.custom || []), ...(state.shortcuts.builtin || [])];
    const matched = allShortcuts.find((s) => s.command === token);
    if (matched) {
      if (matched.interactionMode) {
        state.interactionMode = matched.interactionMode;
        updateModeUI();
      }
      rawInput = rest ? `${matched.prompt}\n\nAdditional context: ${rest}` : matched.prompt;
    }
  }

  promptInput.value = "";
  promptInput.style.height = "auto";
  closeAllPopovers();
  syncSendButtonState();

  const attachmentsPreview = [];
  if (state.includeActiveTab && state.activeTab) {
    attachmentsPreview.push({
      kind: "active-tab",
      tabId: state.activeTab.tabId,
      title: state.activeTab.title || state.activeTab.url,
    });
  }
  for (const tid of state.mentionedTabIds) {
    const t = state.allTabs.find((x) => x.tabId === tid);
    if (t) attachmentsPreview.push({ kind: "mentioned-tab", tabId: tid, title: t.title || t.url });
  }
  const screenshotBase64 = state.screenshot?.base64 || null;
  if (screenshotBase64) {
    attachmentsPreview.push({ kind: "screenshot" });
  }
  state.screenshot = null;
  renderAttachmentChips();

  appendUserMessageDOM(rawInput, attachmentsPreview);
  liveAssistantRefs = createAssistantTurnDOM({ streaming: true });

  const requestId = `ui-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  state.activeRequestId = requestId;
  updateRunningUI(true);

  try {
    const res = await chrome.runtime.sendMessage({
      type: "sidepanel:sendPrompt",
      payload: {
        requestId,
        sessionId: state.currentSessionId,
        userText: rawInput,
        interactionMode: state.interactionMode,
        permissionMode: state.permissionMode || "auto",
        autoApprovePermissions: false,
        modelId: state.modelId || null,
        includeActiveTab: Boolean(state.includeActiveTab),
        activeTabId: state.activeTab?.tabId || null,
        mentionedTabIds: Array.from(state.mentionedTabIds),
        screenshotBase64,
      },
    });

    if (!res?.ok) {
      const errDiv = document.createElement("div");
      errDiv.className = "error-bubble";
      errDiv.textContent = res?.error || "Request failed.";
      liveAssistantRefs.mdBody.innerHTML = "";
      liveAssistantRefs.mdBody.appendChild(errDiv);
      liveAssistantRefs.sparkleEl.classList.remove("streaming");
    } else {
      state.currentSessionId = res.sessionId || state.currentSessionId;
      if (res.title) {
        state.sessionTitle = res.title;
        headerTitleEl.textContent = res.title;
      }
      if (!liveAssistantRefs.rawText) {
        liveAssistantRefs.mdBody.innerHTML = `<p><em>Done.</em></p>`;
      }
      finalizeAssistantTurnDOM(liveAssistantRefs);
    }
  } catch (err) {
    if (liveAssistantRefs) {
      liveAssistantRefs.sparkleEl.classList.remove("streaming");
      liveAssistantRefs.mdBody.innerHTML = `<div class="error-bubble">${escapeHtml(
        err?.message || String(err),
      )}</div>`;
    }
  } finally {
    updateRunningUI(false);
    state.activeRequestId = null;
    liveAssistantRefs = null;
    scrollToBottom(false);
  }
}

function startNewChat() {
  if (state.running) return;
  state.currentSessionId = null;
  state.sessionTitle = "Antigravity";
  headerTitleEl.textContent = "Antigravity";
  messagesListEl.innerHTML = "";
  updateGreetingByTime();
  welcomeStateEl.classList.remove("hidden");
  historyDrawer.classList.add("hidden");
  closeAllPopovers();
  promptInput.focus();
}

async function loadChromeSessionIntoView(sessionId) {
  historyDrawer.classList.add("hidden");
  closeAllPopovers();

  const res = await chrome.runtime.sendMessage({
    type: "sidepanel:loadSession",
    sessionId,
  });
  if (!res?.ok || !res.session) {
    messagesListEl.innerHTML = `<div class="error-bubble">${escapeHtml(
      res?.error || "Unable to load chat.",
    )}</div>`;
    welcomeStateEl.classList.add("hidden");
    return;
  }

  const sess = res.session;
  state.currentSessionId = sess.sessionId;
  state.sessionTitle = sess.title || "Chat";
  headerTitleEl.textContent = state.sessionTitle;
  if (sess.interactionMode) {
    state.interactionMode = sess.interactionMode;
    updateModeUI();
  }

  messagesListEl.innerHTML = "";
  const msgs = Array.isArray(sess.messages) ? sess.messages : [];
  if (msgs.length === 0) {
    welcomeStateEl.classList.remove("hidden");
    return;
  }
  welcomeStateEl.classList.add("hidden");
  for (const m of msgs) {
    if (m.role === "user") {
      appendUserMessageDOM(m.text || "", m.attachments || []);
    } else {
      createAssistantTurnDOM({
        thoughts: m.thoughts || "",
        toolCalls: m.toolCalls || [],
        text: m.text || "",
        streaming: false,
      });
    }
  }
  scrollToBottom(true);
}

function renderHistoryDrawer() {
  historyListEl.innerHTML = "";
  if (!Array.isArray(state.sessions) || state.sessions.length === 0) {
    historyListEl.innerHTML = `<p class="sheet-empty">No recent chats in Chrome yet.</p>`;
    return;
  }

  for (const s of state.sessions) {
    const card = document.createElement("div");
    card.className = "tonal-list-card";
    const when = s.updatedAt
      ? new Date(s.updatedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : "";
    card.innerHTML = `
      <div class="tonal-card-top">
        <div class="tonal-card-title">${escapeHtml(s.title || "Chat")}</div>
        <div class="tonal-card-actions">
          <button type="button" class="text-pill-btn open-app-btn" title="Open in Antigravity app">Open in app</button>
          <button type="button" class="mini-icon-btn del-sess-btn" title="Remove" aria-label="Remove">${SVG.closeXs}</button>
        </div>
      </div>
      <div class="tonal-card-meta">
        <span>${escapeHtml(s.interactionMode === "agent" ? "Agent" : "Chat")} · ${s.messageCount || 0} messages</span>
        <span>${escapeHtml(when)}</span>
      </div>
    `;
    card.querySelector(".tonal-card-title").addEventListener("click", () => {
      loadChromeSessionIntoView(s.sessionId);
    });
    card.querySelector(".open-app-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      openInDesktopApp(s.sessionId);
    });
    card.querySelector(".del-sess-btn").addEventListener("click", async (e) => {
      e.stopPropagation();
      const resp = await chrome.runtime.sendMessage({
        type: "sidepanel:deleteSession",
        sessionId: s.sessionId,
      });
      if (resp?.sessions) {
        state.sessions = resp.sessions;
        if (state.currentSessionId === s.sessionId) startNewChat();
        renderHistoryDrawer();
      }
    });
    historyListEl.appendChild(card);
  }
}

function renderSchedulesDrawer() {
  schedulesListEl.innerHTML = "";
  if (!Array.isArray(state.schedules) || state.schedules.length === 0) {
    schedulesListEl.innerHTML = `<p class="sheet-empty">No scheduled tasks yet.</p>`;
    return;
  }

  for (const task of state.schedules) {
    const card = document.createElement("div");
    card.className = "tonal-list-card";
    const lastInfo = task.lastRunAt
      ? `Last run ${new Date(task.lastRunAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : "Waiting for next run";
    card.innerHTML = `
      <div class="tonal-card-top">
        <div class="tonal-card-title">${escapeHtml(task.name)}</div>
        <div class="tonal-card-actions">
          <button type="button" class="tonal-pill-btn run-now-btn">Run now</button>
          ${task.lastSessionId ? '<button type="button" class="text-pill-btn view-run-btn">View</button>' : ""}
          <button type="button" class="mini-icon-btn del-sched-btn" aria-label="Delete">${SVG.closeXs}</button>
        </div>
      </div>
      <div class="tonal-card-meta">
        <span>Every ${task.intervalMinutes}m · ${task.interactionMode === "agent" ? "Agent" : "Read"}</span>
        <span>${escapeHtml(lastInfo)}</span>
      </div>
    `;
    card.querySelector(".run-now-btn").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = "Running…";
      try {
        const res = await chrome.runtime.sendMessage({ type: "sidepanel:runScheduleNow", id: task.id });
        if (res?.sessionId) {
          await loadChromeSessionIntoView(res.sessionId);
        }
      } finally {
        btn.disabled = false;
        btn.textContent = "Run now";
      }
    });
    const viewBtn = card.querySelector(".view-run-btn");
    if (viewBtn && task.lastSessionId) {
      viewBtn.addEventListener("click", () => loadChromeSessionIntoView(task.lastSessionId));
    }
    card.querySelector(".del-sched-btn").addEventListener("click", async () => {
      const res = await chrome.runtime.sendMessage({
        type: "sidepanel:deleteSchedule",
        payload: { id: task.id },
      });
      if (res?.tasks) {
        state.schedules = res.tasks;
        renderSchedulesDrawer();
      }
    });
    schedulesListEl.appendChild(card);
  }
}

function renderSlashPopover(filterText = "") {
  const needle = filterText.replace(/^\/+/, "").trim().toLowerCase();
  slashListEl.innerHTML = "";

  const combined = [
    ...(state.shortcuts.custom || []).map((s) => ({ ...s, kindLabel: "Saved" })),
    ...(state.shortcuts.builtin || []).map((s) => ({ ...s, kindLabel: s.interactionMode === "agent" ? "Agent" : "Page" })),
    ...(state.agySkills || []).slice(0, 25).map((sk) => ({
      command: sk.name,
      title: sk.name,
      description: sk.description || "",
      isSkill: true,
      kindLabel: "Skill",
    })),
  ].filter(
    (item) =>
      !needle ||
      item.command.toLowerCase().includes(needle) ||
      (item.title || "").toLowerCase().includes(needle) ||
      (item.description || "").toLowerCase().includes(needle),
  );

  if (combined.length === 0) {
    slashListEl.innerHTML = `<div class="popover-item-sub" style="padding:8px 12px;">No matching shortcuts.</div>`;
    return;
  }

  for (const item of combined) {
    const row = document.createElement("div");
    row.className = "popover-item";
    row.innerHTML = `
      <span class="popover-item-icon">${SVG.slashSm}</span>
      <div class="popover-item-main">
        <div class="popover-item-title">${escapeHtml(item.command)} <span style="font-weight:400;color:var(--gem-text-muted)">· ${escapeHtml(
      item.kindLabel,
    )}</span></div>
        <div class="popover-item-sub">${escapeHtml(item.description || item.title || "")}</div>
      </div>
      ${!item.builtin && !item.isSkill ? `<button type="button" class="mini-icon-btn del-sc-btn" title="Delete">${SVG.closeXs}</button>` : ""}
    `;
    row.addEventListener("click", (e) => {
      if (e.target.closest(".del-sc-btn")) return;
      closeAllPopovers();
      if (item.isSkill) {
        promptInput.value = `/${item.command} `;
        syncSendButtonState();
        promptInput.focus();
      } else {
        if (item.interactionMode) {
          state.interactionMode = item.interactionMode;
          updateModeUI();
        }
        sendPromptNow(item.prompt);
      }
    });
    const delBtn = row.querySelector(".del-sc-btn");
    if (delBtn) {
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const res = await chrome.runtime.sendMessage({
          type: "sidepanel:deleteShortcut",
          payload: { id: item.id },
        });
        if (res?.custom) {
          state.shortcuts.custom = res.custom;
          renderSlashPopover(filterText);
        }
      });
    }
    slashListEl.appendChild(row);
  }
}

function renderTabsPicker(filterText = "") {
  const needle = filterText.trim().toLowerCase();
  tabsPickerListEl.innerHTML = "";
  const candidates = state.allTabs.filter(
    (t) =>
      !/^chrome-extension:\/\//i.test(t.url || "") &&
      (!needle || (t.title || "").toLowerCase().includes(needle) || (t.url || "").toLowerCase().includes(needle)),
  );

  if (candidates.length === 0) {
    tabsPickerListEl.innerHTML = `<div class="popover-item-sub" style="padding:8px 12px;">No open tabs found.</div>`;
    return;
  }

  for (const t of candidates) {
    const isActive = state.activeTab?.tabId === t.tabId;
    const isSelected = state.mentionedTabIds.has(t.tabId);
    const row = document.createElement("div");
    row.className = `popover-item${isSelected ? " selected" : ""}`;

    const iconSlot = document.createElement("span");
    iconSlot.className = "popover-item-icon";
    if (isSelected) {
      iconSlot.innerHTML = SVG.checkSmall;
    } else if (t.favIconUrl && /^https?:|^data:/i.test(t.favIconUrl)) {
      const img = document.createElement("img");
      img.className = "tab-favicon";
      img.src = t.favIconUrl;
      img.alt = "";
      img.addEventListener("error", () => {
        iconSlot.innerHTML = SVG.globeXs;
      });
      iconSlot.appendChild(img);
    } else {
      iconSlot.innerHTML = SVG.globeXs;
    }

    const mainDiv = document.createElement("div");
    mainDiv.className = "popover-item-main";
    mainDiv.innerHTML = `
      <div class="popover-item-title">${escapeHtml(t.title || t.url || `Tab ${t.tabId}`)}${isActive ? " · Current" : ""}</div>
      <div class="popover-item-sub">${escapeHtml(t.url || "")}</div>
    `;

    row.append(iconSlot, mainDiv);
    row.addEventListener("click", () => {
      if (state.mentionedTabIds.has(t.tabId)) {
        state.mentionedTabIds.delete(t.tabId);
      } else {
        state.mentionedTabIds.add(t.tabId);
      }
      promptInput.value = promptInput.value.replace(/(^|\s)@[^\s]*$/, "$1");
      syncSendButtonState();
      renderAttachmentChips();
      renderTabsPicker(filterText);
    });
    tabsPickerListEl.appendChild(row);
  }
}

async function openInDesktopApp(sessionId = state.currentSessionId) {
  await chrome.runtime.sendMessage({
    type: "sidepanel:openInDesktopApp",
    sessionId,
  });
}

async function refreshTabsList() {
  const res = await chrome.runtime.sendMessage({ type: "sidepanel:listTabs" });
  if (res?.ok && Array.isArray(res.tabs)) {
    updateActiveTabBar(res.tabs);
  }
}

async function reconnectNativeBridge() {
  const status = await chrome.runtime.sendMessage({ type: "sidepanel:reconnect" });
  renderBridgeStatus(status);
}

// Event Listeners
document.addEventListener("click", (e) => {
  if (
    !e.target.closest(".floating-menu") &&
    !e.target.closest("#model-menu-btn") &&
    !e.target.closest("#add-menu-btn")
  ) {
    closeAllPopovers();
  }
});

modelMenuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const willOpen = modelPopover.classList.contains("hidden");
  closeAllPopovers();
  if (willOpen) {
    renderModelMenu();
    modelPopover.classList.remove("hidden");
    modelMenuBtn.setAttribute("aria-expanded", "true");
  }
});

permissionSegmentedEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".tonal-seg-btn");
  if (!btn || !btn.dataset.perm) return;
  state.permissionMode = btn.dataset.perm;
  renderModelMenu();
  if (state.currentSessionId) {
    chrome.runtime.sendMessage({
      type: "sidepanel:setConfig",
      payload: { sessionId: state.currentSessionId, modeId: state.permissionMode },
    });
  }
});

bridgeStatusBtn.addEventListener("click", reconnectNativeBridge);
bannerReconnectBtn.addEventListener("click", reconnectNativeBridge);

newChatBtn.addEventListener("click", startNewChat);
openDesktopBtn.addEventListener("click", () => openInDesktopApp());

detachAllBtn.addEventListener("click", async () => {
  const status = await chrome.runtime.sendMessage({ type: "sidepanel:finishAll" });
  renderBridgeStatus(status);
});

function openDrawerTab(tabName = "chats") {
  closeAllPopovers();
  historyDrawer.classList.remove("hidden");
  const isSchedules = tabName === "schedules";
  drawerPanelChats.classList.toggle("hidden", isSchedules);
  drawerPanelSchedules.classList.toggle("hidden", !isSchedules);
  for (const btn of drawerTabsGroup.querySelectorAll(".tonal-seg-btn")) {
    btn.classList.toggle("active", btn.dataset.drawerTab === tabName);
  }
  if (isSchedules) {
    renderSchedulesDrawer();
  } else {
    renderHistoryDrawer();
  }
}

historyBtn.addEventListener("click", () => {
  if (!historyDrawer.classList.contains("hidden")) {
    historyDrawer.classList.add("hidden");
  } else {
    openDrawerTab("chats");
  }
});

closeHistoryBtn.addEventListener("click", () => historyDrawer.classList.add("hidden"));

drawerTabsGroup.addEventListener("click", (e) => {
  const btn = e.target.closest(".tonal-seg-btn");
  if (!btn || !btn.dataset.drawerTab) return;
  openDrawerTab(btn.dataset.drawerTab);
});

schedulesBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  openDrawerTab("schedules");
});

schedIntervalGroup.addEventListener("click", (e) => {
  const btn = e.target.closest(".tonal-seg-btn");
  if (!btn) return;
  state.schedInterval = Number(btn.dataset.interval) || 60;
  for (const el of schedIntervalGroup.querySelectorAll(".tonal-seg-btn")) {
    el.classList.toggle("active", el === btn);
  }
});

schedModeGroup.addEventListener("click", (e) => {
  const btn = e.target.closest(".tonal-seg-btn");
  if (!btn) return;
  state.schedMode = btn.dataset.schedMode || "chat";
  for (const el of schedModeGroup.querySelectorAll(".tonal-seg-btn")) {
    el.classList.toggle("active", el === btn);
  }
});

scheduleForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("sched-name").value.trim();
  const targetUrl = document.getElementById("sched-url").value.trim();
  const prompt = document.getElementById("sched-prompt").value.trim();
  if (!name || !prompt) return;

  const res = await chrome.runtime.sendMessage({
    type: "sidepanel:saveSchedule",
    payload: {
      name,
      targetUrl,
      prompt,
      intervalMinutes: state.schedInterval,
      interactionMode: state.schedMode,
      enabled: true,
    },
  });
  if (res?.tasks) {
    state.schedules = res.tasks;
    scheduleForm.reset();
    renderSchedulesDrawer();
  }
});

quickGridEl.addEventListener("click", (e) => {
  const pill = e.target.closest(".suggestion-pill");
  if (!pill) return;
  const scName = pill.dataset.shortcut;
  const all = [...(state.shortcuts.custom || []), ...(state.shortcuts.builtin || [])];
  const found = all.find((s) => s.command === scName);
  if (found) {
    if (found.interactionMode) {
      state.interactionMode = found.interactionMode;
      updateModeUI();
    }
    sendPromptNow(found.prompt);
  }
});

messagesListEl.addEventListener("click", (e) => {
  const copyBtn = e.target.closest(".copy-code-btn");
  if (!copyBtn) return;
  const decoded = decodeURIComponent(copyBtn.dataset.code || "");
  navigator.clipboard?.writeText(decoded).then(() => {
    copyBtn.textContent = "Copied";
    setTimeout(() => {
      copyBtn.textContent = "Copy";
    }, 1400);
  });
});

agentModeToggle.addEventListener("click", () => {
  state.interactionMode = state.interactionMode === "agent" ? "chat" : "agent";
  updateModeUI();
  promptInput.focus();
});

unshareActiveTabBtn.addEventListener("click", () => {
  state.includeActiveTab = false;
  syncSharedPageChipUI();
});

reshareActiveTabBtn.addEventListener("click", () => {
  state.includeActiveTab = true;
  syncSharedPageChipUI();
});

addMenuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const willOpen = addMenuPopover.classList.contains("hidden");
  closeAllPopovers();
  if (willOpen) {
    addMenuPopover.classList.remove("hidden");
    addMenuBtn.classList.add("active");
  }
});

menuShareTabsBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  closeAllPopovers();
  await refreshTabsList();
  renderTabsPicker("");
  tabsPopover.classList.remove("hidden");
});

screenshotBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  closeAllPopovers();
  screenshotBtn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({
      type: "sidepanel:captureScreenshot",
      windowId: state.activeTab?.windowId ?? null,
    });
    if (res?.ok && res.base64) {
      state.screenshot = { dataUrl: res.dataUrl, base64: res.base64 };
      renderAttachmentChips();
    }
  } finally {
    screenshotBtn.disabled = false;
  }
});

menuShortcutsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  closeAllPopovers();
  renderSlashPopover("");
  slashPopover.classList.remove("hidden");
});

groupMentionedBtn.addEventListener("click", async () => {
  const ids = Array.from(state.mentionedTabIds);
  if (state.activeTab?.tabId && !ids.includes(state.activeTab.tabId)) {
    ids.unshift(state.activeTab.tabId);
  }
  if (ids.length === 0) return;
  await chrome.runtime.sendMessage({
    type: "sidepanel:groupTabsNow",
    payload: {
      tabIds: ids,
      title: state.sessionTitle === "Antigravity" ? "Antigravity" : state.sessionTitle.slice(0, 22),
      color: "blue",
    },
  });
  closeAllPopovers();
});

openSaveShortcutBtn.addEventListener("click", () => {
  const hidden = saveShortcutBox.classList.contains("hidden");
  saveShortcutBox.classList.toggle("hidden", !hidden);
  if (hidden && promptInput.value.trim()) {
    document.getElementById("custom-sc-prompt").value = promptInput.value.trim();
  }
});

customScModeGroup.addEventListener("click", (e) => {
  const btn = e.target.closest(".tonal-seg-btn");
  if (!btn) return;
  state.customScMode = btn.dataset.scMode || "chat";
  for (const el of customScModeGroup.querySelectorAll(".tonal-seg-btn")) {
    el.classList.toggle("active", el === btn);
  }
});

saveCustomScBtn.addEventListener("click", async () => {
  const command = document.getElementById("custom-sc-cmd").value.trim();
  const title = document.getElementById("custom-sc-title").value.trim();
  const prompt = document.getElementById("custom-sc-prompt").value.trim();
  if (!command || !prompt) return;
  const res = await chrome.runtime.sendMessage({
    type: "sidepanel:saveShortcut",
    payload: { command, title, prompt, interactionMode: state.customScMode },
  });
  if (res?.custom) {
    state.shortcuts.custom = res.custom;
    saveShortcutBox.classList.add("hidden");
    document.getElementById("custom-sc-cmd").value = "";
    document.getElementById("custom-sc-title").value = "";
    document.getElementById("custom-sc-prompt").value = "";
    renderSlashPopover("");
  }
});

promptInput.addEventListener("input", () => {
  promptInput.style.height = "auto";
  promptInput.style.height = `${Math.min(136, promptInput.scrollHeight)}px`;
  syncSendButtonState();

  const val = promptInput.value;
  if (/^\/[a-zA-Z0-9_-]*$/.test(val)) {
    addMenuPopover.classList.add("hidden");
    tabsPopover.classList.add("hidden");
    slashPopover.classList.remove("hidden");
    renderSlashPopover(val);
    return;
  }
  slashPopover.classList.add("hidden");

  const atMatch = /(?:^|\s)@([^\s]*)$/.exec(val);
  if (atMatch) {
    addMenuPopover.classList.add("hidden");
    tabsPopover.classList.remove("hidden");
    renderTabsPicker(atMatch[1] || "");
  } else {
    tabsPopover.classList.add("hidden");
  }
});

promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeAllPopovers();
    return;
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendPromptNow();
  }
});

sendBtn.addEventListener("click", () => sendPromptNow());

// Live Runtime Port & Initial Bootstrap
const livePort = chrome.runtime.connect({ name: "ag-sidepanel" });
livePort.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "sidepanel:bridgeStatus") {
    renderBridgeStatus(msg.status);
  } else if (msg.type === "sidepanel:tabsChanged") {
    refreshTabsList();
  } else if (msg.type === "sidepanel:agentEvent") {
    handleIncomingAgentEvent(msg.payload);
  } else if (msg.type === "sidepanel:sessionsUpdated") {
    state.sessions = msg.sessions || [];
    if (!historyDrawer.classList.contains("hidden")) renderHistoryDrawer();
  } else if (msg.type === "sidepanel:schedulesUpdated") {
    state.schedules = msg.tasks || [];
    if (!historyDrawer.classList.contains("hidden") && !drawerPanelSchedules.classList.contains("hidden")) {
      renderSchedulesDrawer();
    }
  }
});

(async function bootstrap() {
  updateGreetingByTime();
  updateModeUI();
  renderModelMenu();
  syncSendButtonState();
  try {
    const init = await chrome.runtime.sendMessage({ type: "sidepanel:init" });
    if (init?.ok) {
      state.sessions = init.sessions || [];
      state.shortcuts = init.shortcuts || { builtin: [], custom: [] };
      state.schedules = init.schedules || [];
      updateActiveTabBar(init.tabs || []);
      populateAgentCatalog(init.agentStatus);
      renderBridgeStatus(init.bridgeStatus);
    }
  } catch (err) {
    renderBridgeStatus({
      nativeConnected: false,
      browserName: "Browser",
      lastNativeError: err?.message || "Initializing extension…",
    });
  }
})();
