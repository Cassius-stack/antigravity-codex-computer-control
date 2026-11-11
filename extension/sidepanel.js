// Antigravity in Chrome — Docked Side Panel UI & Live ACP Streaming Client

const state = {
  currentSessionId: null,
  sessionTitle: "Antigravity",
  interactionMode: "chat", // "chat" | "agent"
  permissionMode: "auto", // "auto" | "default" | "plan"
  modelId: "gemini-4-carbon-medium",
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
};

// DOM Elements
const headerTitleEl = document.getElementById("header-title");
const bridgeStatusBtn = document.getElementById("bridge-status-btn");
const bridgeDotEl = document.getElementById("bridge-dot");
const bridgeLabelEl = document.getElementById("bridge-label");
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

const historyDrawer = document.getElementById("history-drawer");
const closeHistoryBtn = document.getElementById("close-history-btn");
const historyListEl = document.getElementById("history-list");

const schedulesDrawer = document.getElementById("schedules-drawer");
const closeSchedulesBtn = document.getElementById("close-schedules-btn");
const scheduleForm = document.getElementById("schedule-form");
const schedulesListEl = document.getElementById("schedules-list");

const chatViewport = document.getElementById("chat-viewport");
const welcomeStateEl = document.getElementById("welcome-state");
const quickGridEl = document.getElementById("quick-grid");
const messagesListEl = document.getElementById("messages-list");

const slashPopover = document.getElementById("slash-popover");
const slashListEl = document.getElementById("slash-list");
const openSaveShortcutBtn = document.getElementById("open-save-shortcut-btn");
const saveShortcutBox = document.getElementById("save-shortcut-box");
const saveCustomScBtn = document.getElementById("save-custom-sc-btn");

const tabsPopover = document.getElementById("tabs-popover");
const tabsPickerListEl = document.getElementById("tabs-picker-list");
const groupMentionedBtn = document.getElementById("group-mentioned-btn");

const includeActiveTabCb = document.getElementById("include-active-tab");
const activeTabTitleEl = document.getElementById("active-tab-title");
const mentionTabsBtn = document.getElementById("mention-tabs-btn");
const screenshotBtn = document.getElementById("screenshot-btn");
const slashBtn = document.getElementById("slash-btn");
const attachmentChipsEl = document.getElementById("attachment-chips");

const inputFrameEl = document.querySelector(".input-frame");
const promptInput = document.getElementById("prompt-input");
const modeChatBtn = document.getElementById("mode-chat-btn");
const modeAgentBtn = document.getElementById("mode-agent-btn");
const permissionSelect = document.getElementById("permission-select");
const modelSelect = document.getElementById("model-select");
const sendBtn = document.getElementById("send-btn");
const sendIcon = document.getElementById("send-icon");
const stopIcon = document.getElementById("stop-icon");

// Active streaming assistant DOM references for the current turn
let liveAssistantRefs = null;

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
  // Inline code
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  // Safe external links [label](https://...)
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  // Bold & italic
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[\s(])\*([^*]+)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
  return out;
}

/**
 * Safe, zero-XSS Markdown-to-HTML renderer for assistant responses.
 */
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
  return chatViewport.scrollHeight - chatViewport.scrollTop - chatViewport.clientHeight < 90;
}

function scrollToBottom(force = false) {
  if (force || isNearBottom()) {
    chatViewport.scrollTop = chatViewport.scrollHeight;
  }
}

function updateModeUI() {
  const isAgent = state.interactionMode === "agent";
  modeChatBtn.classList.toggle("active", !isAgent);
  modeAgentBtn.classList.toggle("active", isAgent);
  inputFrameEl.classList.toggle("agent-mode", isAgent);
  promptInput.placeholder = isAgent
    ? "Tell Antigravity what to click, fill, upload, or group in your browser…"
    : "Ask about this page, type / for shortcuts, @ for tabs…";
}

function updateRunningUI(running) {
  state.running = Boolean(running);
  sendBtn.classList.toggle("running", state.running);
  sendIcon.classList.toggle("hidden", state.running);
  stopIcon.classList.toggle("hidden", !state.running);
  sendBtn.title = state.running ? "Stop active turn" : "Send (Enter)";
}

function renderBridgeStatus(status) {
  if (!status) return;
  state.bridgeStatus = status;
  const online = Boolean(status.nativeConnected);
  bridgeDotEl.classList.toggle("online", online);
  bridgeDotEl.classList.toggle("offline", !online);
  const bName = status.browserName || "Browser";
  bridgeLabelEl.textContent = online ? bName : "Offline";

  const attachedCount = Number(status.attachedTabCount || 0);
  const groups = Array.isArray(status.sessionGroups) ? status.sessionGroups : [];
  const desktopClients = Number(status.desktopBridgeInfo?.desktopMcpClients || 0);

  if (attachedCount > 0 || groups.length > 0 || desktopClients > 0) {
    desktopActivityBar.classList.remove("hidden");
    const parts = [];
    if (desktopClients > 0) {
      parts.push(`Desktop MCP connected`);
    }
    if (groups.length > 0) {
      parts.push(`Group: ${groups.map((g) => g.title || "Antigravity").join(", ")}`);
    }
    if (attachedCount > 0) {
      parts.push(`${attachedCount} tab${attachedCount > 1 ? "s" : ""} attached`);
    }
    desktopActivityText.textContent = parts.join(" · ");
    detachAllBtn.classList.toggle("hidden", attachedCount === 0 && groups.length === 0);
  } else {
    desktopActivityBar.classList.add("hidden");
  }

  if (!online && status.lastNativeError) {
    setupBanner.classList.remove("hidden");
    setupBannerTitle.textContent = "Native Bridge Offline";
    setupBannerDesc.textContent =
      "Run ./install.sh in antigravity-codex-computer-control, then click the Offline badge above to reconnect.";
  } else if (state.agentStatus && state.agentStatus.ok && !state.agentStatus.agyFound) {
    setupBanner.classList.remove("hidden");
    setupBannerTitle.textContent = "Antigravity CLI ('agy') Needed for Side Panel Chat";
    setupBannerDesc.textContent =
      "Desktop App → Browser tab control is active! Install the 'agy' CLI from Antigravity Settings → CLI to chat directly inside this Side Panel.";
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
    const prevVal = modelSelect.value;
    modelSelect.innerHTML = "";
    for (const m of agentStatus.models) {
      const opt = document.createElement("option");
      opt.value = m.modelId;
      opt.textContent = m.name || m.modelId;
      modelSelect.appendChild(opt);
    }
    if ([...modelSelect.options].some((o) => o.value === prevVal)) {
      modelSelect.value = prevVal;
    } else if (agentStatus.currentModelId) {
      modelSelect.value = agentStatus.currentModelId;
    }
    state.modelId = modelSelect.value;
  }
  renderBridgeStatus(state.bridgeStatus);
}

function updateActiveTabBar(tabs) {
  state.allTabs = Array.isArray(tabs) ? tabs : [];
  const active =
    state.allTabs.find((t) => t.active && !/^(chrome-extension):\/\//i.test(t.url || "")) ||
    state.allTabs.find((t) => t.active) ||
    null;
  state.activeTab = active;

  if (active) {
    let host = "";
    try {
      host = new URL(active.url).hostname.replace(/^www\./, "");
    } catch {}
    const label = active.title || host || "Current Tab";
    activeTabTitleEl.textContent = host && !label.includes(host) ? `${label} (${host})` : label;
  } else {
    activeTabTitleEl.textContent = "No active webpage";
  }

  // Prune closed tabs from mentionedTabIds
  const validIds = new Set(state.allTabs.map((t) => t.tabId));
  for (const id of Array.from(state.mentionedTabIds)) {
    if (!validIds.has(id)) state.mentionedTabIds.delete(id);
  }
  renderAttachmentChips();
}

function renderAttachmentChips() {
  attachmentChipsEl.innerHTML = "";
  let count = 0;

  for (const tid of state.mentionedTabIds) {
    const tab = state.allTabs.find((t) => t.tabId === tid);
    if (!tab) continue;
    count++;
    const chip = document.createElement("div");
    chip.className = "removable-chip";
    chip.innerHTML = `<span>@${escapeHtml(tab.title || tab.url || `Tab #${tid}`)}</span>`;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "chip-remove-btn";
    rm.textContent = "✕";
    rm.addEventListener("click", () => {
      state.mentionedTabIds.delete(tid);
      renderAttachmentChips();
    });
    chip.appendChild(rm);
    attachmentChipsEl.appendChild(chip);
  }

  if (state.screenshot) {
    count++;
    const chip = document.createElement("div");
    chip.className = "removable-chip";
    chip.innerHTML = `<span>📷 Page Screenshot</span>`;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "chip-remove-btn";
    rm.textContent = "✕";
    rm.addEventListener("click", () => {
      state.screenshot = null;
      renderAttachmentChips();
    });
    chip.appendChild(rm);
    attachmentChipsEl.appendChild(chip);
  }

  attachmentChipsEl.classList.toggle("hidden", count === 0);
}

function appendUserMessageDOM(text, attachments = []) {
  welcomeStateEl.classList.add("hidden");
  const wrap = document.createElement("div");
  wrap.className = "msg-user";

  if (Array.isArray(attachments) && attachments.length > 0) {
    const attRow = document.createElement("div");
    attRow.className = "msg-attachments";
    for (const att of attachments) {
      const b = document.createElement("span");
      b.className = "att-badge";
      if (att.kind === "screenshot") {
        b.textContent = "📷 Screenshot";
      } else if (att.kind === "mentioned-tab") {
        b.textContent = `@ ${att.title || `Tab #${att.tabId}`}`;
      } else {
        b.textContent = `📄 ${att.title || "Active Tab"}`;
      }
      attRow.appendChild(b);
    }
    wrap.appendChild(attRow);
  }

  const txtEl = document.createElement("div");
  txtEl.className = "msg-user-text";
  txtEl.textContent = text;
  wrap.appendChild(txtEl);
  messagesListEl.appendChild(wrap);
  scrollToBottom(true);
}

function createAssistantTurnDOM({ thoughts = "", toolCalls = [], text = "", streaming = false } = {}) {
  welcomeStateEl.classList.add("hidden");
  const container = document.createElement("div");
  container.className = "msg-assistant";

  const thoughtDetails = document.createElement("details");
  thoughtDetails.className = `thought-details${thoughts ? "" : " hidden"}`;
  if (streaming && thoughts && !text) thoughtDetails.open = true;
  const thoughtSummary = document.createElement("summary");
  thoughtSummary.textContent = streaming ? "Thinking…" : "Thought process";
  const thoughtBody = document.createElement("div");
  thoughtBody.className = "thought-body";
  thoughtBody.textContent = thoughts || "";
  thoughtDetails.append(thoughtSummary, thoughtBody);

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
      card.innerHTML = `<span class="tool-status-dot"></span><span class="tool-card-title"></span>`;
      toolNodesById.set(id, card);
      toolsStack.appendChild(card);
    }
    card.classList.toggle("completed", tc.status === "completed");
    card.classList.toggle("failed", tc.status === "failed");
    const label = tc.title || tc.name || "Tool action";
    card.querySelector(".tool-card-title").textContent = label;
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
    mdBody.innerHTML = `<div class="typing-indicator"><span>Working…</span></div>`;
  }

  const footer = document.createElement("div");
  footer.className = `turn-footer${streaming ? " hidden" : ""}`;
  footer.innerHTML = `<span>Synced with Antigravity Desktop</span><button type="button" class="open-app-inline">Open in App ↗</button>`;
  footer.querySelector(".open-app-inline").addEventListener("click", () => {
    openInDesktopApp();
  });

  container.append(thoughtDetails, toolsStack, permissionsStack, mdBody, footer);
  messagesListEl.appendChild(container);
  scrollToBottom(true);

  return {
    container,
    thoughtDetails,
    thoughtSummary,
    thoughtBody,
    toolsStack,
    permissionsStack,
    upsertToolCard,
    mdBody,
    footer,
    rawText: text || "",
    rawThoughts: thoughts || "",
  };
}

function renderPermissionRequestCard(refs, payload) {
  if (!refs) return;
  const { permRequestId, toolCall, options } = payload;
  const card = document.createElement("div");
  card.className = "permission-card";
  const toolTitle = toolCall?.title || toolCall?.name || "Tool Execution";
  const detailText =
    toolCall?.args?.CommandLine ||
    (toolCall?.args ? JSON.stringify(toolCall.args) : "") ||
    toolTitle;

  card.innerHTML = `
    <div class="perm-header">Approval requested · ${escapeHtml(toolCall?.name || "Action")}</div>
    <div class="perm-detail">${escapeHtml(detailText)}</div>
    <div class="perm-actions"></div>
  `;
  const actionsRow = card.querySelector(".perm-actions");
  const opts =
    Array.isArray(options) && options.length > 0
      ? options
      : [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ];

  for (const opt of opts) {
    const btn = document.createElement("button");
    btn.type = "button";
    const isAllow = /allow/i.test(opt.kind || opt.optionId || "");
    btn.className = isAllow ? "primary-sm-btn" : "mini-btn danger-subtle";
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
      liveAssistantRefs.thoughtDetails.classList.remove("hidden");
      if (!liveAssistantRefs.rawText) liveAssistantRefs.thoughtDetails.open = true;
      liveAssistantRefs.thoughtBody.textContent = liveAssistantRefs.rawThoughts;
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      liveAssistantRefs.upsertToolCard(update);
    } else if (update.sessionUpdate === "agent_message_chunk" && update.content?.text) {
      liveAssistantRefs.rawText += update.content.text;
      liveAssistantRefs.thoughtDetails.open = false;
      liveAssistantRefs.thoughtSummary.textContent = "Thought process";
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

  // Expand `/shortcut` if the user typed an exact shortcut command
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
  slashPopover.classList.add("hidden");
  tabsPopover.classList.add("hidden");

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
        permissionMode: permissionSelect.value || "auto",
        autoApprovePermissions: false,
        modelId: modelSelect.value || null,
        includeActiveTab: Boolean(includeActiveTabCb.checked),
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
    } else {
      state.currentSessionId = res.sessionId || state.currentSessionId;
      if (res.title) {
        state.sessionTitle = res.title;
        headerTitleEl.textContent = res.title;
      }
      if (!liveAssistantRefs.rawText) {
        liveAssistantRefs.mdBody.innerHTML = `<p><em>Turn completed (${escapeHtml(res.stopReason || "done")}).</em></p>`;
      }
      liveAssistantRefs.thoughtSummary.textContent = "Thought process";
      liveAssistantRefs.footer.classList.remove("hidden");
    }
  } catch (err) {
    if (liveAssistantRefs) {
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
  welcomeStateEl.classList.remove("hidden");
  historyDrawer.classList.add("hidden");
  schedulesDrawer.classList.add("hidden");
  promptInput.focus();
}

async function loadChromeSessionIntoView(sessionId) {
  historyDrawer.classList.add("hidden");
  schedulesDrawer.classList.add("hidden");
  const res = await chrome.runtime.sendMessage({
    type: "sidepanel:loadSession",
    sessionId,
  });
  if (!res?.ok || !res.session) {
    messagesListEl.innerHTML = `<div class="error-bubble">${escapeHtml(
      res?.error || "Unable to load session.",
    )}</div>`;
    welcomeStateEl.classList.add("hidden");
    return;
  }
  const sess = res.session;
  state.currentSessionId = sess.sessionId;
  state.sessionTitle = sess.title || "Browser Chat";
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
    historyListEl.innerHTML = `<p class="drawer-note">No Chrome Side Panel chats yet. Send a message below to start one!</p>`;
    return;
  }

  for (const s of state.sessions) {
    const card = document.createElement("div");
    card.className = "session-card";
    const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
    card.innerHTML = `
      <div class="session-card-top">
        <div class="session-card-title">${escapeHtml(s.title || "Browser Chat")}</div>
        <div class="session-card-actions">
          <button type="button" class="text-link-btn open-app-btn" title="Open in Antigravity Desktop App">App ↗</button>
          <button type="button" class="chip-remove-btn del-sess-btn" title="Remove from Chrome list">✕</button>
        </div>
      </div>
      <div class="session-card-meta">
        <span>${escapeHtml(s.interactionMode === "agent" ? "Agent Mode" : "Chat Mode")} · ${s.messageCount || 0} msgs</span>
        <span>${escapeHtml(when)}</span>
      </div>
    `;
    card.querySelector(".session-card-title").addEventListener("click", () => {
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
    schedulesListEl.innerHTML = `<p class="drawer-note">No scheduled browser tasks yet. Create one above to run recurring checks automatically.</p>`;
    return;
  }

  for (const task of state.schedules) {
    const card = document.createElement("div");
    card.className = "schedule-card";
    const lastInfo = task.lastRunAt
      ? `Last: ${new Date(task.lastRunAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} (${task.lastStatus || "ok"})`
      : "Not run yet";
    card.innerHTML = `
      <div class="session-card-top">
        <div class="session-card-title">${escapeHtml(task.name)}</div>
        <div class="session-card-actions">
          <button type="button" class="mini-btn run-now-btn">Run Now</button>
          ${task.lastSessionId ? '<button type="button" class="text-link-btn view-run-btn">View</button>' : ""}
          <button type="button" class="chip-remove-btn del-sched-btn">✕</button>
        </div>
      </div>
      <div class="session-card-meta">
        <span>Every ${task.intervalMinutes}m · ${task.interactionMode === "agent" ? "Agent" : "Chat"}</span>
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
        btn.textContent = "Run Now";
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
      title: `/${sk.name}`,
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
    slashListEl.innerHTML = `<div class="popover-item-sub" style="padding:6px 8px;">No matching /shortcuts. Click '+ Save Custom' above to create one!</div>`;
    return;
  }

  for (const item of combined) {
    const row = document.createElement("div");
    row.className = "popover-item";
    row.innerHTML = `
      <div class="popover-item-main">
        <div class="popover-item-title">/${escapeHtml(item.command)} <span style="font-weight:400;color:var(--text-muted)">· ${escapeHtml(
      item.kindLabel,
    )}</span></div>
        <div class="popover-item-sub">${escapeHtml(item.description || item.title || "")}</div>
      </div>
      ${!item.builtin && !item.isSkill ? '<button type="button" class="chip-remove-btn del-sc-btn" title="Delete shortcut">✕</button>' : ""}
    `;
    row.addEventListener("click", (e) => {
      if (e.target.closest(".del-sc-btn")) return;
      slashPopover.classList.add("hidden");
      if (item.isSkill) {
        promptInput.value = `/${item.command} `;
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
    tabsPickerListEl.innerHTML = `<div class="popover-item-sub" style="padding:6px 8px;">No matching open tabs.</div>`;
    return;
  }

  for (const t of candidates) {
    const isActive = state.activeTab?.tabId === t.tabId;
    const isSelected = state.mentionedTabIds.has(t.tabId);
    const row = document.createElement("div");
    row.className = `popover-item${isSelected ? " selected" : ""}`;
    row.innerHTML = `
      <div class="popover-item-main">
        <div class="popover-item-title">${isSelected ? "✓ " : ""}${escapeHtml(t.title || t.url || `Tab #${t.tabId}`)}${
      isActive ? " (Active)" : ""
    }</div>
        <div class="popover-item-sub">${escapeHtml(t.url || "")}</div>
      </div>
    `;
    row.addEventListener("click", () => {
      if (state.mentionedTabIds.has(t.tabId)) {
        state.mentionedTabIds.delete(t.tabId);
      } else {
        state.mentionedTabIds.add(t.tabId);
      }
      // Strip trailing `@query` if triggered via `@` in textarea
      promptInput.value = promptInput.value.replace(/(^|\s)@[^\s]*$/, "$1");
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

// Event Listeners
newChatBtn.addEventListener("click", startNewChat);
openDesktopBtn.addEventListener("click", () => openInDesktopApp());

bridgeStatusBtn.addEventListener("click", async () => {
  bridgeLabelEl.textContent = "Reconnecting…";
  const status = await chrome.runtime.sendMessage({ type: "sidepanel:reconnect" });
  renderBridgeStatus(status);
});

detachAllBtn.addEventListener("click", async () => {
  const status = await chrome.runtime.sendMessage({ type: "sidepanel:finishAll" });
  renderBridgeStatus(status);
});

historyBtn.addEventListener("click", () => {
  schedulesDrawer.classList.add("hidden");
  const opening = historyDrawer.classList.contains("hidden");
  historyDrawer.classList.toggle("hidden", !opening);
  if (opening) renderHistoryDrawer();
});

closeHistoryBtn.addEventListener("click", () => historyDrawer.classList.add("hidden"));

schedulesBtn.addEventListener("click", () => {
  historyDrawer.classList.add("hidden");
  const opening = schedulesDrawer.classList.contains("hidden");
  schedulesDrawer.classList.toggle("hidden", !opening);
  if (opening) renderSchedulesDrawer();
});

closeSchedulesBtn.addEventListener("click", () => schedulesDrawer.classList.add("hidden"));

scheduleForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("sched-name").value.trim();
  const targetUrl = document.getElementById("sched-url").value.trim();
  const prompt = document.getElementById("sched-prompt").value.trim();
  const intervalMinutes = Number(document.getElementById("sched-interval").value) || 60;
  const interactionMode = document.getElementById("sched-mode").value;
  if (!name || !prompt) return;

  const res = await chrome.runtime.sendMessage({
    type: "sidepanel:saveSchedule",
    payload: { name, targetUrl, prompt, intervalMinutes, interactionMode, enabled: true },
  });
  if (res?.tasks) {
    state.schedules = res.tasks;
    scheduleForm.reset();
    renderSchedulesDrawer();
  }
});

quickGridEl.addEventListener("click", (e) => {
  const card = e.target.closest(".quick-card");
  if (!card) return;
  const scName = card.dataset.shortcut;
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
    copyBtn.textContent = "Copied!";
    setTimeout(() => {
      copyBtn.textContent = "Copy";
    }, 1400);
  });
});

modeChatBtn.addEventListener("click", () => {
  state.interactionMode = "chat";
  updateModeUI();
});

modeAgentBtn.addEventListener("click", () => {
  state.interactionMode = "agent";
  updateModeUI();
});

permissionSelect.addEventListener("change", () => {
  state.permissionMode = permissionSelect.value;
  if (state.currentSessionId) {
    chrome.runtime.sendMessage({
      type: "sidepanel:setConfig",
      payload: { sessionId: state.currentSessionId, modeId: state.permissionMode },
    });
  }
});

modelSelect.addEventListener("change", () => {
  state.modelId = modelSelect.value;
  if (state.currentSessionId) {
    chrome.runtime.sendMessage({
      type: "sidepanel:setConfig",
      payload: { sessionId: state.currentSessionId, modelId: state.modelId },
    });
  }
});

includeActiveTabCb.addEventListener("change", () => {
  state.includeActiveTab = includeActiveTabCb.checked;
});

mentionTabsBtn.addEventListener("click", async () => {
  slashPopover.classList.add("hidden");
  const opening = tabsPopover.classList.contains("hidden");
  tabsPopover.classList.toggle("hidden", !opening);
  if (opening) {
    await refreshTabsList();
    renderTabsPicker("");
  }
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
      color: "cyan",
    },
  });
  tabsPopover.classList.add("hidden");
});

screenshotBtn.addEventListener("click", async () => {
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

slashBtn.addEventListener("click", () => {
  tabsPopover.classList.add("hidden");
  const opening = slashPopover.classList.contains("hidden");
  slashPopover.classList.toggle("hidden", !opening);
  if (opening) renderSlashPopover("");
});

openSaveShortcutBtn.addEventListener("click", () => {
  const hidden = saveShortcutBox.classList.contains("hidden");
  saveShortcutBox.classList.toggle("hidden", !hidden);
  if (hidden && promptInput.value.trim()) {
    document.getElementById("custom-sc-prompt").value = promptInput.value.trim();
  }
});

saveCustomScBtn.addEventListener("click", async () => {
  const command = document.getElementById("custom-sc-cmd").value.trim();
  const title = document.getElementById("custom-sc-title").value.trim();
  const prompt = document.getElementById("custom-sc-prompt").value.trim();
  const interactionMode = document.getElementById("custom-sc-mode").value;
  if (!command || !prompt) return;
  const res = await chrome.runtime.sendMessage({
    type: "sidepanel:saveShortcut",
    payload: { command, title, prompt, interactionMode },
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
  promptInput.style.height = `${Math.min(130, promptInput.scrollHeight)}px`;

  const val = promptInput.value;
  if (/^\/[a-zA-Z0-9_-]*$/.test(val)) {
    tabsPopover.classList.add("hidden");
    slashPopover.classList.remove("hidden");
    renderSlashPopover(val);
    return;
  }
  slashPopover.classList.add("hidden");

  const atMatch = /(?:^|\s)@([^\s]*)$/.exec(val);
  if (atMatch) {
    tabsPopover.classList.remove("hidden");
    renderTabsPicker(atMatch[1] || "");
  } else {
    tabsPopover.classList.add("hidden");
  }
});

promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    slashPopover.classList.add("hidden");
    tabsPopover.classList.add("hidden");
    return;
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendPromptNow();
  }
});

sendBtn.addEventListener("click", () => sendPromptNow());

// Connect Live Runtime Port & Bootstrap Initial State
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
    if (!schedulesDrawer.classList.contains("hidden")) renderSchedulesDrawer();
  }
});

(async function bootstrap() {
  updateModeUI();
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
      lastNativeError: err?.message || "Initializing extension service worker…",
    });
  }
})();
