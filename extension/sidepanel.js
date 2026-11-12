// Antigravity in Chrome — 2026 Google Gemini Neural Expressive + Codex in Chrome Side Panel

const hasExtensionRuntime = Boolean(globalThis.chrome?.runtime?.id);

async function sendRuntimeMessage(msg) {
  if (!hasExtensionRuntime || !chrome.runtime?.sendMessage) {
    return { ok: false, error: "Extension runtime unavailable" };
  }
  return await chrome.runtime.sendMessage(msg);
}

const state = {
  currentSessionId: null,
  sessionTitle: "New thread",
  interactionMode: "chat", // "chat" | "agent"
  permissionMode: "auto", // "auto" | "ask" | "full"
  modelId: "gemini-4-carbon-medium",
  thoughtLevel: "medium", // "low" | "medium" | "high"
  userSelectedModel: false,
  models: [
    { modelId: "gemini-4-carbon-medium", name: "Gemini 4 Carbon (Medium)" },
    { modelId: "gemini-4-carbon-high", name: "Gemini 4 Carbon (High)" },
    { modelId: "gemini-4-carbon-low", name: "Gemini 4 Carbon (Low)" },
    { modelId: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
    { modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
    { modelId: "claude-sonnet-4-6-thinking", name: "Claude Sonnet 4.6 (Thinking)" },
    { modelId: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
  ],
  running: false,
  activeRequestId: null,
  includeActiveTab: true,
  activeTab: null,
  allTabs: [],
  mentionedTabIds: new Set(),
  pickedElements: [], // [{ id, tagName, selector, label, role, rect, text, htmlSnippet, styles, url, title }]
  screenshot: null, // { dataUrl, base64 }
  attachedFiles: [], // [{ id, name, mimeType, kind: "image"|"file", dataUrl?, base64?, textContent?, size }]
  liveSelection: "",
  dismissedSelectionText: "",
  sitePermissions: {},
  confirmedHostsForSession: new Set(),
  settings: {
    cwd: "",
    customInstructions: "",
    theme: "system",
    defaultApprovalMode: "auto",
  },
  activityLog: [],
  recording: {
    active: false,
    stepCount: 0,
    maxActions: 120,
    steps: [],
  },
  picker: {
    active: false,
    tabId: null,
  },
  kbActiveIndex: 0,
  sessions: [],
  historyFilter: "",
  shortcuts: { builtin: [], custom: [] },
  agySkills: [],
  schedules: [],
  bridgeStatus: null,
  agentStatus: null,
  schedInterval: 60,
  schedMode: "chat",
  customScMode: "chat",
  drawerScMode: "agent",
};

const SVG = {
  sparkle: `<svg viewBox="0 0 32 32" width="21" height="21" aria-hidden="true"><use href="#gemini-spark-4c"/></svg>`,
  chevronDown: `<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M5.5 7.75L10 12.25l4.5-4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  check: `<svg class="model-option-check" viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4.2 10.5l3.8 3.8 7.8-8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  spinner: `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M10 3a7 7 0 1 1-4.95 2.05" stroke-linecap="round"/></svg>`,
  checkSmall: `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.1" aria-hidden="true"><path d="M4.5 10.5l3.6 3.6 7.4-7.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  alertSmall: `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M10 6.5v4M10 13.5h.01" stroke-linecap="round"/></svg>`,
  closeXs: `<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.85" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke-linecap="round"/></svg>`,
  globeXs: `<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><circle cx="10" cy="10" r="7.2"/><path d="M3 10h14M10 2.8c2 2 3.1 4.5 3.1 7.2S12 15.2 10 17.2c-2-2-3.1-4.5-3.1-7.2S8 4.8 10 2.8Z"/></svg>`,
  imageXs: `<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><rect x="2.8" y="4" width="14.4" height="12" rx="2.2"/><circle cx="7.4" cy="8.4" r="1.3"/><path d="M17.2 13l-3.6-3.6L7.8 15.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  fileXs: `<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="M6 3.5h5.5L15.5 7.5v9a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5v-11A1.5 1.5 0 0 1 6 3.5Z"/><path d="M11.2 3.5v4.2h4.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  quoteXs: `<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 7.5h4v4H6.5L5 14M11 7.5h4v4h-2.5L11 14" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  targetXs: `<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10" cy="10" r="5.5"/><path d="M10 2.5v2.2M10 15.3v2.2M2.5 10h2.2M15.3 10h2.2" stroke-linecap="round"/></svg>`,
  copySm: `<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><rect x="6.8" y="6.8" width="9.4" height="9.4" rx="2"/><path d="M4.2 12.8V5.2a1.8 1.8 0 0 1 1.8-1.8h7.6" stroke-linecap="round"/></svg>`,
  retrySm: `<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="M15.8 7.5A6 6 0 1 0 16 12.2M16 4v3.8h-3.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  openExtSm: `<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="M11.5 4.5h4v4M15.5 4.5L8.5 11.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 5.5H5.8A1.8 1.8 0 0 0 4 7.3v6.9A1.8 1.8 0 0 0 5.8 16h6.9a1.8 1.8 0 0 0 1.8-1.8V11" stroke-linecap="round"/></svg>`,
  slashSm: `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.85" aria-hidden="true"><path d="M12.5 4L7.5 16" stroke-linecap="round"/></svg>`,
};

// DOM References
const appShellEl = document.getElementById("app-shell");
const dropzoneOverlay = document.getElementById("dropzone-overlay");

const historyBtn = document.getElementById("history-btn");
const modelMenuBtn = document.getElementById("model-menu-btn");
const modelCurrentLabelEl = document.getElementById("model-current-label");
const modelEffortTagEl = document.getElementById("model-effort-tag");
const workspaceMiniTagEl = document.getElementById("workspace-mini-tag");
const headerTitleEl = document.getElementById("header-title");

const bridgeStatusPill = document.getElementById("bridge-status-pill");
const bridgePillText = document.getElementById("bridge-pill-text");
const headerOpenAppBtn = document.getElementById("header-open-app-btn");
const settingsBtn = document.getElementById("settings-btn");
const settingsWorkspaceDotEl = document.getElementById("settings-workspace-dot");
const newChatBtn = document.getElementById("new-chat-btn");

const modelPopover = document.getElementById("model-popover");
const modelOptionsListEl = document.getElementById("model-options-list");
const thoughtLevelSegmentedEl = document.getElementById("thought-level-segmented");
const permissionSegmentedEl = document.getElementById("permission-segmented");
const popoverWorkspaceRowEl = document.getElementById("popover-workspace-row");
const bridgeReconnectRow = document.getElementById("bridge-reconnect-row");
const bridgeLabelEl = document.getElementById("bridge-label");
const bridgeStatusBtn = document.getElementById("bridge-status-btn");

const settingsPopover = document.getElementById("settings-popover");
const settingsCurrentHostEl = document.getElementById("settings-current-host");
const sitePolicySegmentedEl = document.getElementById("site-policy-segmented");
const configuredSitesListEl = document.getElementById("configured-sites-list");
const settingsCwdInput = document.getElementById("settings-cwd-input");
const settingsInstructionsInput = document.getElementById("settings-instructions-input");
const themeSegmentedEl = document.getElementById("theme-segmented");
const saveSettingsBtn = document.getElementById("save-settings-btn");

const desktopActivityBar = document.getElementById("desktop-activity-bar");
const desktopActivityText = document.getElementById("desktop-activity-text");
const toggleActivityStreamBtn = document.getElementById("toggle-activity-stream-btn");
const inlineActivityDrawer = document.getElementById("inline-activity-drawer");
const inlineActivityList = document.getElementById("inline-activity-list");
const clearInlineActivityBtn = document.getElementById("clear-inline-activity-btn");
const detachAllBtn = document.getElementById("detach-all-btn");

const recordingBar = document.getElementById("recording-bar");
const recordingStatusText = document.getElementById("recording-status-text");
const recordingStepPreview = document.getElementById("recording-step-preview");
const stopRecordingBtn = document.getElementById("stop-recording-btn");
const cancelRecordingBtn = document.getElementById("cancel-recording-btn");

const elementPickerBar = document.getElementById("element-picker-bar");
const cancelElementPickerBtn = document.getElementById("cancel-element-picker-btn");

const setupBanner = document.getElementById("setup-banner");
const setupBannerTitle = document.getElementById("setup-banner-title");
const setupBannerDesc = document.getElementById("setup-banner-desc");
const bannerReconnectBtn = document.getElementById("banner-reconnect-btn");

const historyDrawer = document.getElementById("history-drawer");
const closeHistoryBtn = document.getElementById("close-history-btn");
const drawerTabsGroup = document.getElementById("drawer-tabs-group");
const drawerPanelChats = document.getElementById("drawer-panel-chats");
const drawerPanelSkills = document.getElementById("drawer-panel-skills");
const drawerPanelSchedules = document.getElementById("drawer-panel-schedules");
const drawerPanelActivity = document.getElementById("drawer-panel-activity");

const openDesktopBtn = document.getElementById("open-desktop-btn");
const historySearchInput = document.getElementById("history-search-input");
const historyListEl = document.getElementById("history-list");

const drawerRecordBtn = document.getElementById("drawer-record-btn");
const drawerScCmdInput = document.getElementById("drawer-sc-cmd");
const drawerScTitleInput = document.getElementById("drawer-sc-title");
const drawerScPromptInput = document.getElementById("drawer-sc-prompt");
const drawerScModeGroup = document.getElementById("drawer-sc-mode-group");
const drawerSaveScBtn = document.getElementById("drawer-save-sc-btn");
const drawerSkillsListEl = document.getElementById("drawer-skills-list");

const scheduleForm = document.getElementById("schedule-form");
const schedIntervalGroup = document.getElementById("sched-interval-group");
const schedModeGroup = document.getElementById("sched-mode-group");
const schedulesListEl = document.getElementById("schedules-list");

const drawerClearActivityBtn = document.getElementById("drawer-clear-activity-btn");
const drawerActivityListEl = document.getElementById("drawer-activity-list");

const chatViewport = document.getElementById("chat-viewport");
const welcomeStateEl = document.getElementById("welcome-state");
const greetingHeadlineEl = document.getElementById("greeting-headline");
const quickGridEl = document.getElementById("quick-grid");
const messagesListEl = document.getElementById("messages-list");

const fileInput = document.getElementById("file-input");
const pagePreviewPopover = document.getElementById("page-preview-popover");
const closePagePreviewBtn = document.getElementById("close-page-preview-btn");
const previewPageTitle = document.getElementById("preview-page-title");
const previewPageUrl = document.getElementById("preview-page-url");
const previewStatsRow = document.getElementById("preview-stats-row");
const previewSitePolicyGroup = document.getElementById("preview-site-policy-group");
const previewSelectionBox = document.getElementById("preview-selection-box");
const previewSelectionText = document.getElementById("preview-selection-text");
const previewExcerptText = document.getElementById("preview-excerpt-text");

const addMenuBtn = document.getElementById("add-menu-btn");
const pickElementBtn = document.getElementById("pick-element-btn");
const addMenuPopover = document.getElementById("add-menu-popover");
const menuAttachFileBtn = document.getElementById("menu-attach-file-btn");
const screenshotBtn = document.getElementById("screenshot-btn");
const menuPickElementBtn = document.getElementById("menu-pick-element-btn");
const menuShareTabsBtn = document.getElementById("menu-share-tabs-btn");
const menuRecordBtn = document.getElementById("menu-record-btn");
const menuShortcutsBtn = document.getElementById("menu-shortcuts-btn");
const schedulesBtn = document.getElementById("schedules-btn");

const slashPopover = document.getElementById("slash-popover");
const slashListEl = document.getElementById("slash-list");
const openSaveShortcutBtn = document.getElementById("open-save-shortcut-btn");
const saveShortcutBox = document.getElementById("save-shortcut-box");
const customScModeGroup = document.getElementById("custom-sc-mode-group");
const saveCustomScBtn = document.getElementById("save-custom-sc-btn");

const tabsPopover = document.getElementById("tabs-popover");
const tabsPickerListEl = document.getElementById("tabs-picker-list");
const groupMentionedBtn = document.getElementById("group-mentioned-btn");

const composerNoticeEl = document.getElementById("composer-notice");
const composerCard = document.getElementById("composer-card");
const thinkingWave = document.getElementById("thinking-wave");
const activeTabChipEl = document.getElementById("active-tab-chip");
const inspectActiveTabBtn = document.getElementById("inspect-active-tab-btn");
const activeTabFaviconEl = document.getElementById("active-tab-favicon");
const activeTabGlobeEl = document.getElementById("active-tab-globe");
const activeTabTitleEl = document.getElementById("active-tab-title");
const activeTabPolicyDotEl = document.getElementById("active-tab-policy-dot");
const activeTabPolicyTagEl = document.getElementById("active-tab-policy-tag");
const unshareActiveTabBtn = document.getElementById("unshare-active-tab-btn");
const reshareActiveTabBtn = document.getElementById("reshare-active-tab-btn");

const selectionChipEl = document.getElementById("selection-chip");
const selectionChipTextEl = document.getElementById("selection-chip-text");
const dismissSelectionBtn = document.getElementById("dismiss-selection-btn");
const attachmentChipsEl = document.getElementById("attachment-chips");

const promptInput = document.getElementById("prompt-input");
const modeSwitchGroup = document.getElementById("mode-switch-group");
const modeChatBtn = document.getElementById("mode-chat-btn");
const agentModeToggle = document.getElementById("agent-mode-toggle");
const approvalCycleBtn = document.getElementById("approval-cycle-btn");
const approvalInlineLabel = document.getElementById("approval-inline-label");
const voiceBtn = document.getElementById("voice-btn");
const sendBtn = document.getElementById("send-btn");
const sendIcon = document.getElementById("send-icon");
const stopIcon = document.getElementById("stop-icon");

let liveAssistantRefs = null;
let dragDepth = 0;
let speechRecognition = null;
let isListeningVoice = false;

activeTabFaviconEl.addEventListener("error", () => {
  activeTabFaviconEl.classList.add("hidden");
  activeTabGlobeEl.classList.remove("hidden");
});

const MULTI_PART_PUBLIC_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "gov.uk",
  "ac.uk",
  "me.uk",
  "net.uk",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "gov.au",
  "co.jp",
  "or.jp",
  "ne.jp",
  "ac.jp",
  "go.jp",
  "co.nz",
  "org.nz",
  "govt.nz",
  "ac.nz",
  "com.br",
  "org.br",
  "gov.br",
  "edu.br",
  "co.in",
  "net.in",
  "org.in",
  "gov.in",
  "ac.in",
  "com.sg",
  "edu.sg",
  "gov.sg",
  "com.hk",
  "edu.hk",
  "gov.hk",
  "co.kr",
  "or.kr",
  "go.kr",
  "com.tw",
  "org.tw",
  "gov.tw",
  "co.za",
  "org.za",
  "gov.za",
  "com.mx",
  "org.mx",
  "gob.mx",
  "com.tr",
  "gov.tr",
  "edu.tr",
  "co.il",
  "org.il",
  "gov.il",
  "com.ar",
  "org.ar",
  "gob.ar",
]);

function getMinRegistrableLabels(parts) {
  if (parts.length >= 2) {
    const tail2 = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    if (MULTI_PART_PUBLIC_SUFFIXES.has(tail2)) {
      return 3;
    }
  }
  return 2;
}

function stripLeadingWwwIfRegistrable(hostname) {
  if (!hostname.startsWith("www.")) return hostname;
  const rest = hostname.slice(4);
  if (!rest) return hostname;
  const restParts = rest.split(".").filter(Boolean);
  return restParts.length >= getMinRegistrableLabels(restParts) ? rest : hostname;
}

function normalizeSiteHost(rawHostOrUrl) {
  const raw = String(rawHostOrUrl || "").trim();
  if (!raw) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
      return stripLeadingWwwIfRegistrable(parsed.hostname.toLowerCase().replace(/\.+$/, ""));
    } catch {
      return "";
    }
  }
  const stripped = raw
    .toLowerCase()
    .replace(/\/.*$/, "")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");
  if (!stripped) return "";
  if (stripped.startsWith("[")) {
    const endBracket = stripped.indexOf("]");
    return endBracket > 0 ? stripped.slice(0, endBracket + 1) : stripped;
  }
  const hostOnly = stripped.includes(":") && stripped.indexOf(":") === stripped.lastIndexOf(":")
    ? stripped.replace(/:\d+$/, "")
    : stripped;
  return stripLeadingWwwIfRegistrable(hostOnly.replace(/\.+$/, ""));
}

function getHostCandidateChain(rawHost) {
  const host = normalizeSiteHost(rawHost);
  if (!host) return [];
  if (host.startsWith("[") || host.includes(":") || /^\d+(?:\.\d+){3}$/.test(host)) {
    return [host];
  }
  const parts = host.split(".").filter(Boolean);
  const minLabels = getMinRegistrableLabels(parts);
  if (parts.length < minLabels) return [host];
  const chain = [];
  for (let i = 0; i <= parts.length - minLabels; i += 1) {
    chain.push(parts.slice(i).join("."));
  }
  return chain;
}

function parseHost(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return normalizeSiteHost(u.hostname);
  } catch {
    return "";
  }
}

function getPolicyForHost(host) {
  const perms = state.sitePermissions || {};
  for (const candidate of getHostCandidateChain(host)) {
    const rule = perms[candidate];
    if (rule === "allow" || rule === "ask" || rule === "block") {
      return rule;
    }
  }
  return "allow";
}

function getInheritedParentPolicy(host) {
  const perms = state.sitePermissions || {};
  for (const ancestor of getHostCandidateChain(host).slice(1)) {
    const rule = perms[ancestor];
    if (rule === "allow" || rule === "ask" || rule === "block") {
      return rule;
    }
  }
  return "allow";
}

function applyTheme(themeChoice = state.settings.theme) {
  const pref = ["system", "dark", "light"].includes(themeChoice) ? themeChoice : "system";
  let resolved = pref;
  if (pref === "system") {
    resolved = window.matchMedia?.("(prefers-color-scheme: light)")?.matches ? "light" : "dark";
  }
  document.documentElement.setAttribute("data-theme", resolved);
  for (const btn of themeSegmentedEl.querySelectorAll(".seg-btn")) {
    btn.classList.toggle("active", btn.dataset.themeChoice === pref);
  }
}

window.matchMedia?.("(prefers-color-scheme: light)")?.addEventListener?.("change", () => {
  if (state.settings.theme === "system") applyTheme("system");
});

function updateGreetingByTime() {
  const hr = new Date().getHours();
  if (hr >= 5 && hr < 12) {
    greetingHeadlineEl.textContent = "Good morning";
  } else if (hr >= 12 && hr < 18) {
    greetingHeadlineEl.textContent = "Good afternoon";
  } else {
    greetingHeadlineEl.textContent = "Good evening";
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
  const inlineCodeSpans = [];
  let out = escapedLine.replace(/`([^`]+)`/g, (_m, codeInner) => {
    const idx = inlineCodeSpans.length;
    inlineCodeSpans.push(`<code>${codeInner}</code>`);
    return `@@AG_INLINECODE_${idx}@@`;
  });
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[\s(])\*([^*]+)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
  out = out.replace(/@@AG_INLINECODE_(\d+)@@/g, (_m, idxStr) => inlineCodeSpans[Number(idxStr)] || "");
  return out;
}

function renderMarkdownSafe(rawMarkdown) {
  const src = String(rawMarkdown ?? "").replace(/\r\n/g, "\n");
  if (!src.trim()) return "";

  const codeBlocks = [];
  let withPlaceholders = src.replace(/```([a-zA-Z0-9_+-]*)[ \t]*\n([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang: lang || "code", code: code.replace(/\n$/, "") });
    return `\n@@AG_CODEBLOCK_${idx}@@\n`;
  });

  // Handle streaming unclosed fenced code block at the tail of the message
  withPlaceholders = withPlaceholders.replace(/```([a-zA-Z0-9_+-]*)[ \t]*\n([\s\S]*)$/g, (_m, lang, code) => {
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
        `<div class="table-scroll-wrap"><table><thead><tr>${headers
          .map((h) => `<th>${h}</th>`)
          .join("")}</tr></thead><tbody>${bodyRows
          .map((cols) => `<tr>${cols.map((c) => `<td>${c}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
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

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushLists();
      htmlParts.push("<hr />");
      continue;
    }

    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      flushLists();
      const level = headingMatch[1].length;
      htmlParts.push(`<h${level}>${formatInlineMarkdown(escapeHtml(headingMatch[2]))}</h${level}>`);
      continue;
    }

    const quoteMatch = /^>\s?(.*)$/.exec(trimmed);
    if (quoteMatch) {
      flushLists();
      htmlParts.push(`<blockquote>${formatInlineMarkdown(escapeHtml(quoteMatch[1]))}</blockquote>`);
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
  settingsPopover.classList.add("hidden");
  pagePreviewPopover.classList.add("hidden");
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
    thinkingWave.classList.remove("hidden");
  } else {
    const hasContent =
      promptInput.value.trim().length > 0 ||
      state.attachedFiles.length > 0 ||
      state.pickedElements.length > 0 ||
      Boolean(state.screenshot);
    sendBtn.disabled = !hasContent;
    sendBtn.classList.remove("running");
    sendIcon.classList.remove("hidden");
    stopIcon.classList.add("hidden");
    sendBtn.title = "Send";
    sendBtn.setAttribute("aria-label", "Send");
    thinkingWave.classList.add("hidden");
  }
}

function updateModeUI() {
  const isAgent = state.interactionMode === "agent";
  modeChatBtn.classList.toggle("active", !isAgent);
  agentModeToggle.classList.toggle("active", isAgent);
  composerCard.classList.toggle("agent-mode-active", isAgent);
  promptInput.placeholder = isAgent
    ? "Tell Antigravity what to do in this browser…"
    : "Ask Antigravity or type @tab, /shortcut…";
}

function updateApprovalUI() {
  const perm = ["auto", "ask", "full"].includes(state.permissionMode) ? state.permissionMode : "auto";
  state.permissionMode = perm;
  approvalCycleBtn.dataset.perm = perm;
  approvalInlineLabel.textContent = perm === "full" ? "Full" : perm === "ask" ? "Ask" : "Auto";
  for (const seg of permissionSegmentedEl.querySelectorAll(".seg-btn")) {
    seg.classList.toggle("active", seg.dataset.perm === perm);
  }
}

function updateWorkspaceBadgeUI() {
  const cwd = String(state.settings.cwd || "").trim();
  if (cwd) {
    const base = cwd.split("/").filter(Boolean).pop() || cwd;
    workspaceMiniTagEl.textContent = base;
    workspaceMiniTagEl.title = `Workspace: ${cwd}`;
    workspaceMiniTagEl.classList.remove("hidden");
    popoverWorkspaceRowEl?.classList.remove("hidden");
    if (popoverWorkspaceRowEl) popoverWorkspaceRowEl.title = `Workspace: ${cwd} (click to edit)`;
    settingsWorkspaceDotEl?.classList.remove("hidden");
    settingsBtn.title = `Site access, workspace (${base}) & custom instructions`;
  } else {
    workspaceMiniTagEl.classList.add("hidden");
    popoverWorkspaceRowEl?.classList.add("hidden");
    settingsWorkspaceDotEl?.classList.add("hidden");
    settingsBtn.title = "Site access, workspace & custom instructions";
  }
}

function updateRunningUI(running) {
  state.running = Boolean(running);
  appShellEl.classList.toggle("is-streaming", state.running);
  syncSendButtonState();
}

const MODEL_FAMILY_SUBTITLES = {
  "gemini-4-carbon": "Pro reasoning & browser control",
  "gemini-4-argon": "Deep research & complex coding",
  "gemini-3.8-flash": "Fast multimodal responses",
  "claude-sonnet-4-6": "Balanced coding & analysis",
  "claude-opus-4-6": "Frontier deep reasoning",
  "gpt-oss-120b": "Open-weight reasoning",
};

function parseModelVariantInfo(modelObj) {
  const id = String(modelObj?.modelId || "").trim();
  const rawName = String(modelObj?.name || id).trim();
  const suffixMatch = /^(.*)-(low|medium|high|thinking)$/i.exec(id);
  const familyId = suffixMatch ? suffixMatch[1] : id;
  let variantKey = suffixMatch ? suffixMatch[2].toLowerCase() : "";
  if (!variantKey) {
    const parenMatch = /\((low|medium|high|thinking)\)\s*$/i.exec(rawName);
    if (parenMatch) variantKey = parenMatch[1].toLowerCase();
  }
  const familyName = rawName.replace(/\s*\((low|medium|high|thinking)\)\s*$/i, "").trim() || familyId;
  return { id, rawName, familyId, familyName, variantKey };
}

function buildGroupedModelFamilies(modelsList) {
  const map = new Map();
  for (const m of Array.isArray(modelsList) ? modelsList : []) {
    if (!m?.modelId) continue;
    const info = parseModelVariantInfo(m);
    let fam = map.get(info.familyId);
    if (!fam) {
      fam = {
        familyId: info.familyId,
        name: info.familyName,
        subtitle: MODEL_FAMILY_SUBTITLES[info.familyId] || "",
        defaultModelId: info.id,
        variants: {},
        modelIds: new Set(),
      };
      map.set(info.familyId, fam);
    }
    fam.modelIds.add(info.id);
    if (info.variantKey) {
      fam.variants[info.variantKey] = info.id;
    } else {
      fam.variants.base = info.id;
    }
    if (info.variantKey === "medium") {
      fam.defaultModelId = info.id;
    }
  }
  return Array.from(map.values());
}

function resolveFamilyModelIdForEffort(fam, effort) {
  if (!fam) return state.modelId;
  const eff = ["low", "medium", "high"].includes(effort) ? effort : "medium";
  if (fam.variants[eff]) return fam.variants[eff];
  if (eff === "low" && fam.variants.base) return fam.variants.base;
  if ((eff === "medium" || eff === "high") && fam.variants.thinking) return fam.variants.thinking;
  return (
    fam.variants.medium ||
    fam.variants.high ||
    fam.variants.thinking ||
    fam.variants.base ||
    fam.variants.low ||
    fam.defaultModelId
  );
}

function inferEffortFromModelId(modelId, fallback = "medium") {
  const m = /-(low|medium|high|thinking)$/i.exec(String(modelId || ""));
  if (!m) return fallback;
  const v = m[1].toLowerCase();
  if (v === "thinking") return fallback === "low" ? "medium" : fallback;
  return v;
}

function formatModelDisplayName(rawName) {
  const cleaned = String(rawName || "Gemini 4 Carbon")
    .replace(/\s*\(.*?\)\s*/g, "")
    .replace(/^(?:Google|Anthropic|OpenAI)\s+/i, "")
    .replace(/^Claude\s+/i, "")
    .trim();
  return cleaned || "Gemini 4 Carbon";
}

function renderModelMenu() {
  const families = buildGroupedModelFamilies(state.models);
  const activeFamily =
    families.find((f) => f.modelIds.has(state.modelId)) ||
    families[0] || {
      familyId: "gemini-4-carbon",
      name: "Gemini 4 Carbon",
      subtitle: MODEL_FAMILY_SUBTITLES["gemini-4-carbon"],
      defaultModelId: state.modelId,
      variants: { medium: state.modelId },
      modelIds: new Set([state.modelId]),
    };

  state.thoughtLevel = inferEffortFromModelId(state.modelId, state.thoughtLevel || "medium");
  modelCurrentLabelEl.textContent = formatModelDisplayName(activeFamily.name);
  if (modelEffortTagEl) {
    modelEffortTagEl.textContent =
      state.thoughtLevel === "high" ? "High" : state.thoughtLevel === "low" ? "Low" : "Med";
  }
  headerTitleEl.textContent = state.sessionTitle || "New thread";

  modelOptionsListEl.innerHTML = "";
  for (const fam of families) {
    const btn = document.createElement("button");
    btn.type = "button";
    const selected = fam.familyId === activeFamily.familyId;
    btn.className = `model-option-btn${selected ? " selected" : ""}`;
    btn.innerHTML = `
      <span class="model-opt-copy">
        <span class="model-opt-name">${escapeHtml(fam.name)}</span>
        ${fam.subtitle ? `<span class="model-opt-sub">${escapeHtml(fam.subtitle)}</span>` : ""}
      </span>
      ${SVG.check}
    `;
    btn.addEventListener("click", () => {
      state.userSelectedModel = true;
      state.modelId = resolveFamilyModelIdForEffort(fam, state.thoughtLevel);
      renderModelMenu();
      closeAllPopovers();
      sendRuntimeMessage({
        type: "sidepanel:setConfig",
        payload: {
          sessionId: state.currentSessionId || null,
          modelId: state.modelId,
          thoughtLevel: state.thoughtLevel,
        },
      });
    });
    modelOptionsListEl.appendChild(btn);
  }

  if (thoughtLevelSegmentedEl) {
    for (const seg of thoughtLevelSegmentedEl.querySelectorAll(".seg-btn")) {
      seg.classList.toggle("active", seg.dataset.thought === state.thoughtLevel);
    }
  }

  updateApprovalUI();
}

function renderSettingsPopover() {
  const host = parseHost(state.activeTab?.url || "");
  settingsCurrentHostEl.textContent = host || "All sites";
  const currentPolicy = getPolicyForHost(host);
  for (const btn of sitePolicySegmentedEl.querySelectorAll(".seg-btn")) {
    btn.classList.toggle("active", btn.dataset.sitePolicy === currentPolicy);
    btn.disabled = !host;
  }

  const customRules = Object.entries(state.sitePermissions || {}).filter(
    ([ruleHost, p]) => p && (p !== "allow" || getInheritedParentPolicy(ruleHost) !== "allow"),
  );
  if (customRules.length === 0) {
    configuredSitesListEl.classList.add("hidden");
    configuredSitesListEl.innerHTML = "";
  } else {
    configuredSitesListEl.classList.remove("hidden");
    configuredSitesListEl.innerHTML = "";
    for (const [ruleHost, rulePolicy] of customRules) {
      const chip = document.createElement("span");
      chip.className = "site-rule-chip";
      chip.innerHTML = `<strong>${escapeHtml(ruleHost)}</strong><span>${escapeHtml(rulePolicy)}</span><button type="button" class="chip-dismiss-btn" title="Remove site rule">${SVG.closeXs}</button>`;
      chip.querySelector("button").addEventListener("click", async () => {
        const res = await sendRuntimeMessage({
          type: "sidepanel:setSitePermission",
          host: ruleHost,
          policy: "reset",
        });
        if (res?.permissions) {
          state.sitePermissions = res.permissions;
          renderSettingsPopover();
          syncSharedPageChipUI();
        }
      });
      configuredSitesListEl.appendChild(chip);
    }
  }

  settingsCwdInput.value = state.settings.cwd || "";
  settingsInstructionsInput.value = state.settings.customInstructions || "";
  applyTheme(state.settings.theme);
}

function renderRecordingUI(rec = state.recording) {
  state.recording = rec || { active: false, stepCount: 0, maxActions: 120, steps: [] };
  if (!state.recording.active) {
    recordingBar.classList.add("hidden");
    return;
  }
  recordingBar.classList.remove("hidden");
  const count = Number(state.recording.stepCount || state.recording.steps?.length || 1);
  const max = Number(state.recording.maxActions || 120);
  recordingStatusText.textContent = `Recording workflow · ${count}/${max}`;
  const lastStep = Array.isArray(state.recording.steps)
    ? state.recording.steps[state.recording.steps.length - 1]
    : null;
  recordingStepPreview.textContent = lastStep
    ? `${lastStep.kind}: ${lastStep.label || lastStep.url || ""}`
    : "Interact with the active tab to capture steps…";
}

function renderPickerUI(picker = state.picker) {
  state.picker = picker || { active: false, tabId: null };
  const isActive = Boolean(state.picker.active);
  elementPickerBar.classList.toggle("hidden", !isActive);
  pickElementBtn.classList.toggle("active", isActive);
}

function renderActivityStreamUI() {
  const items = Array.isArray(state.activityLog) ? state.activityLog.slice().reverse() : [];

  inlineActivityList.innerHTML = "";
  for (const act of items.slice(0, 12)) {
    const row = document.createElement("div");
    row.className = "activity-item";
    const tStr = act.ts ? new Date(act.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
    row.innerHTML = `<div class="activity-item-main">${escapeHtml(act.title)}<span>${escapeHtml(act.detail || "")}</span></div><span class="activity-item-time">${escapeHtml(tStr)}</span>`;
    inlineActivityList.appendChild(row);
  }

  drawerActivityListEl.innerHTML = "";
  if (items.length === 0) {
    drawerActivityListEl.innerHTML = `<p class="sheet-empty">No browser actions recorded in this session yet.</p>`;
    return;
  }
  for (const act of items) {
    const card = document.createElement("div");
    card.className = "tonal-list-card";
    const tStr = act.ts ? new Date(act.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
    card.innerHTML = `
      <div class="tonal-card-top">
        <div class="tonal-card-title" style="cursor:default">${escapeHtml(act.title)}</div>
        <span class="session-title-badge">${escapeHtml(act.source === "sidepanel" ? "Side Panel" : "Desktop MCP")}</span>
      </div>
      <div class="tonal-card-meta">
        <span>${escapeHtml(act.detail || act.kind || "Browser event")}</span>
        <span>${escapeHtml(tStr)}</span>
      </div>
    `;
    drawerActivityListEl.appendChild(card);
  }
}

function renderBridgeStatus(status) {
  if (!status) return;
  state.bridgeStatus = status;
  if (status.sitePermissions) state.sitePermissions = status.sitePermissions;
  if (status.recording) renderRecordingUI(status.recording);
  if (status.picker) renderPickerUI(status.picker);

  const online = Boolean(status.nativeConnected);
  bridgeStatusPill.classList.toggle("offline", !online);
  bridgePillText.textContent = online ? "Live" : "Offline";
  bridgeReconnectRow.classList.toggle("hidden", online);
  bridgeLabelEl.textContent = online ? "Connected" : "Native bridge offline";

  updateGreetingByTime();

  const attachedCount = Number(status.attachedTabCount || 0);
  const groups = Array.isArray(status.sessionGroups) ? status.sessionGroups : [];
  const isControlling = attachedCount > 0 || groups.length > 0;
  appShellEl.classList.toggle("is-controlling", isControlling);

  if (isControlling) {
    desktopActivityBar.classList.remove("hidden");
    const parts = [];
    if (groups.length > 0) {
      parts.push(groups.map((g) => g.title || "Antigravity").join(", "));
    }
    if (attachedCount > 0) {
      parts.push(`${attachedCount} tab${attachedCount > 1 ? "s" : ""} controlled`);
    }
    desktopActivityText.textContent = parts.join(" · ");
  } else {
    desktopActivityBar.classList.add("hidden");
    inlineActivityDrawer.classList.add("hidden");
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

  syncSharedPageChipUI();
}

function populateAgentCatalog(agentStatus) {
  if (!agentStatus || !agentStatus.ok) return;
  state.agentStatus = agentStatus;
  if (Array.isArray(agentStatus.availableCommands)) {
    state.agySkills = agentStatus.availableCommands;
  }
  if (Array.isArray(agentStatus.models) && agentStatus.models.length > 0) {
    state.models = agentStatus.models;
    if (!state.userSelectedModel && agentStatus.currentModelId && state.models.some((m) => m.modelId === agentStatus.currentModelId)) {
      state.modelId = agentStatus.currentModelId;
    } else if (!state.models.some((m) => m.modelId === state.modelId)) {
      state.modelId = agentStatus.currentModelId || state.models[0].modelId;
    }
  }
  if (
    !state.userSelectedModel &&
    agentStatus.currentThoughtLevel &&
    ["low", "medium", "high"].includes(agentStatus.currentThoughtLevel)
  ) {
    state.thoughtLevel = agentStatus.currentThoughtLevel;
    const families = buildGroupedModelFamilies(state.models);
    const activeFamily = families.find((f) => f.modelIds.has(state.modelId)) || families[0];
    if (activeFamily) {
      state.modelId = resolveFamilyModelIdForEffort(activeFamily, state.thoughtLevel);
    }
  }
  renderModelMenu();
  renderBridgeStatus(state.bridgeStatus);
}

function syncSelectionChipUI() {
  const sel = String(state.liveSelection || "").trim();
  if (!sel || sel === state.dismissedSelectionText) {
    selectionChipEl.classList.add("hidden");
    return;
  }
  selectionChipEl.classList.remove("hidden");
  selectionChipTextEl.textContent = sel.replace(/\s+/g, " ").slice(0, 56);
  selectionChipEl.title = sel.slice(0, 320);
}

function syncSharedPageChipUI() {
  const active = state.activeTab;
  if (!active) {
    activeTabChipEl.classList.add("hidden");
    reshareActiveTabBtn.classList.add("hidden");
    return;
  }

  const host = parseHost(active.url || "");
  const policy = getPolicyForHost(host);

  const syncFavicon = () => {
    if (active.favIconUrl && /^https?:|^data:/i.test(active.favIconUrl)) {
      activeTabFaviconEl.src = active.favIconUrl;
      activeTabFaviconEl.classList.remove("hidden");
      activeTabGlobeEl.classList.add("hidden");
    } else {
      activeTabFaviconEl.classList.add("hidden");
      activeTabGlobeEl.classList.remove("hidden");
    }
  };

  if (policy === "block" && host) {
    activeTabChipEl.classList.remove("hidden", "is-ask");
    activeTabChipEl.classList.add("is-blocked");
    activeTabChipEl.title = `Site access blocked for ${host} — click to inspect or change access`;
    reshareActiveTabBtn.classList.add("hidden");
    unshareActiveTabBtn.classList.add("hidden");
    activeTabTitleEl.textContent = active.title || host;
    activeTabPolicyDotEl?.classList.add("hidden");
    if (activeTabPolicyTagEl) {
      activeTabPolicyTagEl.textContent = "Blocked";
      activeTabPolicyTagEl.className = "shared-page-policy-tag policy-block";
    }
    syncFavicon();
    return;
  }

  activeTabChipEl.classList.remove("is-blocked");
  unshareActiveTabBtn.classList.remove("hidden");

  if (state.includeActiveTab && policy !== "block") {
    activeTabChipEl.classList.remove("hidden");
    activeTabChipEl.classList.toggle("is-ask", Boolean(host && policy === "ask"));
    activeTabChipEl.title = host
      ? `Sharing ${host} (${policy === "ask" ? "Ask every time" : "Allowed"}) — click to preview bounded context & site access`
      : "Click to preview bounded page context";
    reshareActiveTabBtn.classList.add("hidden");
    activeTabTitleEl.textContent = active.title || host || "Current page";

    if (host && policy === "ask") {
      activeTabPolicyDotEl?.classList.add("hidden");
      if (activeTabPolicyTagEl) {
        activeTabPolicyTagEl.textContent = "Ask";
        activeTabPolicyTagEl.className = "shared-page-policy-tag policy-ask";
      }
    } else {
      activeTabPolicyTagEl?.classList.add("hidden");
      activeTabPolicyDotEl?.classList.toggle("hidden", !host);
    }
    syncFavicon();
  } else {
    activeTabChipEl.classList.add("hidden");
    activeTabChipEl.classList.remove("is-ask");
    reshareActiveTabBtn.classList.toggle("hidden", policy === "block");
  }
}

async function refreshLiveSelectionFromActiveTab() {
  if (!state.activeTab?.tabId || !state.includeActiveTab) {
    state.liveSelection = "";
    syncSelectionChipUI();
    return;
  }
  const host = parseHost(state.activeTab.url || "");
  if (!host || getPolicyForHost(host) === "block") {
    state.liveSelection = "";
    syncSelectionChipUI();
    return;
  }
  try {
    const res = await sendRuntimeMessage({
      type: "sidepanel:previewPageContext",
      tabId: state.activeTab.tabId,
      maxChars: 1200,
    });
    if (res?.ok && res.context) {
      const nextSel = String(res.context.selection || "").trim();
      if (nextSel !== state.liveSelection) {
        if (!nextSel) state.dismissedSelectionText = "";
        state.liveSelection = nextSel;
        syncSelectionChipUI();
      }
    }
  } catch {}
}

async function openBoundedPagePreview() {
  closeAllPopovers();
  pagePreviewPopover.classList.remove("hidden");
  previewPageTitle.textContent = state.activeTab?.title || "Inspecting page…";
  previewPageUrl.textContent = state.activeTab?.url || "";
  previewStatsRow.innerHTML = "";
  previewSelectionBox.classList.add("hidden");
  previewExcerptText.textContent = "Reading visible page context…";

  const host = parseHost(state.activeTab?.url || "");
  const policy = getPolicyForHost(host);
  for (const btn of previewSitePolicyGroup.querySelectorAll(".seg-btn")) {
    btn.classList.toggle("active", btn.dataset.sitePolicy === policy);
    btn.disabled = !host;
  }

  const res = await sendRuntimeMessage({
    type: "sidepanel:previewPageContext",
    tabId: state.activeTab?.tabId || null,
    maxChars: 4500,
  });

  if (!res?.ok || !res.context) {
    previewExcerptText.textContent = res?.error || "Page preview unavailable on internal browser pages.";
    return;
  }
  const ctx = res.context;
  previewPageTitle.textContent = ctx.title || state.activeTab?.title || "(Untitled)";
  previewPageUrl.textContent = ctx.url || "";
  previewStatsRow.innerHTML = `
    <span>${Number(ctx.linksCount || 0)} links</span>
    <span>·</span>
    <span>${Number(ctx.buttonsCount || 0)} buttons</span>
    <span>·</span>
    <span>${Number(ctx.inputsCount || 0)} inputs</span>
  `;

  if (ctx.blockedBySitePolicy) {
    previewExcerptText.textContent = `Site access is blocked for ${ctx.host}. Switch to Allow or Ask above to share page context.`;
    return;
  }

  if (ctx.selection) {
    previewSelectionBox.classList.remove("hidden");
    previewSelectionText.textContent = ctx.selection;
  } else {
    previewSelectionBox.classList.add("hidden");
  }

  previewExcerptText.textContent =
    ctx.text || "(No readable body text extracted — restricted or empty page)";
}

function updateActiveTabBar(tabs) {
  state.allTabs = Array.isArray(tabs) ? tabs : [];
  const active =
    state.allTabs.find((t) => t.active && !/^(chrome-extension):\/\//i.test(t.url || "")) ||
    state.allTabs.find((t) => t.active) ||
    null;
  const changedTab = active?.tabId !== state.activeTab?.tabId || active?.url !== state.activeTab?.url;
  state.activeTab = active;
  syncSharedPageChipUI();

  const validIds = new Set(state.allTabs.map((t) => t.tabId));
  for (const id of Array.from(state.mentionedTabIds)) {
    if (!validIds.has(id)) state.mentionedTabIds.delete(id);
  }
  renderAttachmentChips();
  if (changedTab) {
    state.dismissedSelectionText = "";
    refreshLiveSelectionFromActiveTab();
  }
}

function renderAttachmentChips() {
  attachmentChipsEl.innerHTML = "";

  for (const elItem of state.pickedElements) {
    const chip = document.createElement("div");
    chip.className = "removable-chip picked-element-chip";
    chip.title = elItem.label ? `${elItem.selector} — ${elItem.label}` : elItem.selector;

    const ic = document.createElement("span");
    ic.innerHTML = SVG.targetXs;
    if (ic.firstElementChild) chip.appendChild(ic.firstElementChild);

    const lbl = document.createElement("span");
    lbl.textContent = (elItem.selector || elItem.tagName || "element").slice(0, 30);
    chip.appendChild(lbl);

    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "chip-dismiss-btn";
    rm.innerHTML = SVG.closeXs;
    rm.addEventListener("click", () => {
      state.pickedElements = state.pickedElements.filter((x) => x.id !== elItem.id);
      renderAttachmentChips();
      syncSendButtonState();
    });
    chip.appendChild(rm);
    attachmentChipsEl.appendChild(chip);
  }

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
    lbl.textContent = `@${(tab.title || tab.url || `Tab ${tid}`).slice(0, 26)}`;
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
    lbl.textContent = "Tab screenshot";
    chip.appendChild(lbl);

    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "chip-dismiss-btn";
    rm.innerHTML = SVG.closeXs;
    rm.addEventListener("click", () => {
      state.screenshot = null;
      renderAttachmentChips();
      syncSendButtonState();
    });
    chip.appendChild(rm);
    attachmentChipsEl.appendChild(chip);
  }

  for (const fileItem of state.attachedFiles) {
    const chip = document.createElement("div");
    chip.className = "removable-chip";
    if (fileItem.kind === "image" && fileItem.dataUrl) {
      const thumb = document.createElement("img");
      thumb.className = "shot-thumb";
      thumb.src = fileItem.dataUrl;
      thumb.alt = "";
      chip.appendChild(thumb);
    } else {
      const ic = document.createElement("span");
      ic.innerHTML = SVG.fileXs;
      chip.appendChild(ic.firstElementChild);
    }
    const lbl = document.createElement("span");
    lbl.textContent = fileItem.name;
    chip.appendChild(lbl);

    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "chip-dismiss-btn";
    rm.innerHTML = SVG.closeXs;
    rm.addEventListener("click", () => {
      state.attachedFiles = state.attachedFiles.filter((f) => f.id !== fileItem.id);
      renderAttachmentChips();
      syncSendButtonState();
    });
    chip.appendChild(rm);
    attachmentChipsEl.appendChild(chip);
  }
}

let composerNoticeTimer = null;

function showComposerNotice(message) {
  if (!composerNoticeEl) return;
  if (composerNoticeTimer) clearTimeout(composerNoticeTimer);
  composerNoticeEl.textContent = String(message || "");
  composerNoticeEl.classList.remove("hidden");
  composerNoticeTimer = setTimeout(() => {
    composerNoticeEl.classList.add("hidden");
  }, 4600);
}

const KNOWN_BINARY_EXT_RE =
  /\.(pdf|zip|gz|tgz|tar|rar|7z|dmg|pkg|iso|exe|dll|so|dylib|bin|wasm|sqlite|sqlite3|db|doc|docx|xls|xlsx|ppt|pptx|odt|epub|mp3|wav|ogg|flac|m4a|mp4|mov|avi|mkv|webm|woff|woff2|ttf|otf|ico)$/i;
const KNOWN_BINARY_MIME_RE =
  /^(application\/(pdf|zip|gzip|x-gzip|x-tar|x-rar|x-7z|wasm|vnd\.openxmlformats|msword|vnd\.ms-)|audio\/|video\/|font\/)/i;

async function isLikelyBinaryFile(file) {
  const name = String(file?.name || "");
  const mime = String(file?.type || "").toLowerCase();
  if (KNOWN_BINARY_EXT_RE.test(name) || KNOWN_BINARY_MIME_RE.test(mime)) {
    return true;
  }
  try {
    const probeSlice = file.slice(0, 4096);
    if (typeof probeSlice.arrayBuffer === "function") {
      const bytes = new Uint8Array(await probeSlice.arrayBuffer());
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 0) return true;
      }
    }
  } catch {}
  return false;
}

async function handleFilesAdded(fileList) {
  const incoming = Array.from(fileList || []);
  for (const file of incoming) {
    if (state.attachedFiles.length >= 8) {
      showComposerNotice("Maximum of 8 attachments reached.");
      break;
    }
    const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    if (file.type.startsWith("image/")) {
      const dataUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => resolve("");
        reader.readAsDataURL(file);
      });
      const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : "";
      if (base64) {
        state.attachedFiles.push({
          id,
          name: file.name || "pasted-image.png",
          mimeType: file.type || "image/png",
          kind: "image",
          dataUrl,
          base64,
          size: file.size,
        });
      }
    } else if (file.size > 2 * 1024 * 1024) {
      showComposerNotice(`"${file.name || "File"}" exceeds the 2 MB text attachment limit.`);
    } else if (await isLikelyBinaryFile(file)) {
      showComposerNotice(`"${file.name || "Binary file"}" cannot be read as text. Attach images or code/text files.`);
    } else {
      try {
        const textContent = await file.text();
        if (textContent.includes("\u0000")) {
          showComposerNotice(`"${file.name || "Binary file"}" contains binary data and was skipped.`);
          continue;
        }
        state.attachedFiles.push({
          id,
          name: file.name || "attachment.txt",
          mimeType: file.type || "text/plain",
          kind: "file",
          textContent: textContent.slice(0, 32_000),
          size: file.size,
        });
      } catch {}
    }
  }
  renderAttachmentChips();
  syncSendButtonState();
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
      b.className = att.kind === "element" ? "att-badge att-element" : "att-badge";
      if (att.kind === "screenshot" || att.kind === "image") {
        b.innerHTML = `${SVG.imageXs}<span>${escapeHtml(att.label || "Image")}</span>`;
      } else if (att.kind === "file") {
        b.innerHTML = `${SVG.fileXs}<span>${escapeHtml(att.label || "File")}</span>`;
      } else if (att.kind === "selection") {
        b.innerHTML = `${SVG.quoteXs}<span>${escapeHtml(att.preview || "Selection")}</span>`;
      } else if (att.kind === "element") {
        b.innerHTML = `${SVG.targetXs}<span>${escapeHtml(att.selector || att.label || "Element")}</span>`;
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

function createAssistantTurnDOM({
  thoughts = "",
  toolCalls = [],
  text = "",
  userPromptForShortcut = "",
  streaming = false,
} = {}) {
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
  thoughtLabel.textContent = streaming && !text ? "Thinking…" : "Show thinking";
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
    mdBody.innerHTML = `<span class="streaming-placeholder">Thinking…</span>`;
  }

  const footer = document.createElement("div");
  footer.className = `turn-footer${streaming ? " hidden" : ""}`;

  const copyTurnBtn = document.createElement("button");
  copyTurnBtn.type = "button";
  copyTurnBtn.className = "turn-action-btn";
  copyTurnBtn.innerHTML = `${SVG.copySm}<span>Copy</span>`;

  const retryTurnBtn = document.createElement("button");
  retryTurnBtn.type = "button";
  retryTurnBtn.className = "turn-action-btn";
  retryTurnBtn.innerHTML = `${SVG.retrySm}<span>Retry</span>`;
  retryTurnBtn.addEventListener("click", () => {
    if (!state.running && userPromptForShortcut) {
      sendPromptNow(userPromptForShortcut);
    }
  });

  const saveSkillBtn = document.createElement("button");
  saveSkillBtn.type = "button";
  saveSkillBtn.className = "turn-action-btn";
  saveSkillBtn.innerHTML = `${SVG.slashSm}<span>Save /skill</span>`;
  saveSkillBtn.addEventListener("click", () => {
    openDrawerTab("skills");
    if (userPromptForShortcut) {
      drawerScPromptInput.value = userPromptForShortcut;
      drawerScTitleInput.value = userPromptForShortcut.slice(0, 36);
    }
  });

  const openAppBtn = document.createElement("button");
  openAppBtn.type = "button";
  openAppBtn.className = "turn-action-btn";
  openAppBtn.innerHTML = `${SVG.openExtSm}<span>Open in app</span>`;
  openAppBtn.addEventListener("click", () => openInDesktopApp());

  footer.append(copyTurnBtn, retryTurnBtn, saveSkillBtn, openAppBtn);
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

function applyPermissionModeChange(nextMode) {
  state.permissionMode = nextMode;
  updateApprovalUI();
  sendRuntimeMessage({
    type: "sidepanel:saveSettings",
    settings: { defaultApprovalMode: state.permissionMode },
  });
  sendRuntimeMessage({
    type: "sidepanel:setConfig",
    payload: {
      sessionId: state.currentSessionId || null,
      requestId: state.activeRequestId || null,
      permissionMode: state.permissionMode,
      autoApprovePermissions: state.permissionMode === "full",
    },
  });
}

function renderPermissionRequestCard(refs, payload) {
  if (!refs) return;
  const { permRequestId, toolCall, options } = payload;
  const card = document.createElement("div");
  card.className = "permission-card";
  if (permRequestId) {
    card.dataset.permRequestId = String(permRequestId);
  }
  const mcpInnerTool =
    toolCall?.name === "call_mcp_tool"
      ? toolCall?.args?.ToolName || toolCall?.args?.toolName || null
      : null;
  const displayName = mcpInnerTool || toolCall?.name || "action";
  const toolTitle = toolCall?.title || displayName || "Action";
  const detailText =
    toolCall?.args?.CommandLine ||
    (mcpInnerTool && toolCall?.args?.Arguments ? JSON.stringify(toolCall.args.Arguments) : "") ||
    (toolCall?.args ? JSON.stringify(toolCall.args) : "") ||
    toolTitle;

  card.innerHTML = `
    <div class="perm-header">Approve ${escapeHtml(displayName)}?</div>
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

  const allowOpt = opts.find((o) => /allow/i.test(o.kind || o.optionId || "")) || opts[0];

  for (const opt of opts) {
    const btn = document.createElement("button");
    btn.type = "button";
    const isAllow = /allow/i.test(opt.kind || opt.optionId || "");
    btn.className = isAllow ? "primary-pill-btn compact" : "tonal-btn compact";
    btn.textContent = opt.name || opt.optionId;
    btn.addEventListener("click", async () => {
      card.remove();
      await sendRuntimeMessage({
        type: "sidepanel:respondPermission",
        permRequestId,
        optionId: opt.optionId,
      });
    });
    actionsRow.appendChild(btn);
  }

  if (
    state.permissionMode !== "full" &&
    allowOpt &&
    !opts.some((o) => /always/i.test(o.name || ""))
  ) {
    const alwaysBtn = document.createElement("button");
    alwaysBtn.type = "button";
    alwaysBtn.className = "tonal-btn compact";
    alwaysBtn.textContent = "Always allow (Full)";
    alwaysBtn.addEventListener("click", async () => {
      card.remove();
      applyPermissionModeChange("full");
      await sendRuntimeMessage({
        type: "sidepanel:respondPermission",
        permRequestId,
        optionId: allowOpt.optionId,
      });
    });
    actionsRow.appendChild(alwaysBtn);
  }

  refs.permissionsStack.appendChild(card);
  scrollToBottom(true);
}

function renderSiteAccessConfirmationCard(refs, gateInfo, retryCallback) {
  const host = gateInfo.host || "this site";
  refs.sparkleEl.classList.remove("streaming");
  refs.mdBody.innerHTML = "";

  const card = document.createElement("div");
  card.className = "permission-card";
  card.innerHTML = `
    <div class="perm-header">Allow Antigravity to access ${escapeHtml(host)}?</div>
    <div class="perm-detail">${escapeHtml(gateInfo.url || host)}</div>
    <div class="perm-actions">
      <button type="button" class="tonal-btn compact" data-site-act="block">Block site</button>
      <button type="button" class="tonal-btn compact" data-site-act="once">Allow once</button>
      <button type="button" class="primary-pill-btn compact" data-site-act="always">Always allow</button>
    </div>
  `;

  card.querySelector('[data-site-act="once"]').addEventListener("click", () => {
    state.confirmedHostsForSession.add(host);
    refs.container.remove();
    retryCallback();
  });

  card.querySelector('[data-site-act="always"]').addEventListener("click", async () => {
    const res = await sendRuntimeMessage({
      type: "sidepanel:setSitePermission",
      host,
      policy: "allow",
    });
    if (res?.permissions) state.sitePermissions = res.permissions;
    state.confirmedHostsForSession.add(host);
    syncSharedPageChipUI();
    refs.container.remove();
    retryCallback();
  });

  card.querySelector('[data-site-act="block"]').addEventListener("click", async () => {
    const res = await sendRuntimeMessage({
      type: "sidepanel:setSitePermission",
      host,
      policy: "block",
    });
    if (res?.permissions) state.sitePermissions = res.permissions;
    syncSharedPageChipUI();
    card.innerHTML = `<div class="perm-header">Access blocked for ${escapeHtml(host)}</div>`;
  });

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

  if (event === "permission_resolved") {
    if (payload.permRequestId) {
      const cards = document.querySelectorAll(".permission-card[data-perm-request-id]");
      for (const c of cards) {
        if (c.dataset.permRequestId === String(payload.permRequestId)) {
          c.remove();
        }
      }
    }
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
        liveAssistantRefs.thoughtLabel.textContent = "Thinking…";
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

async function stopRunningPrompt() {
  if (!state.running) return;
  await sendRuntimeMessage({
    type: "sidepanel:cancelPrompt",
    sessionId: state.currentSessionId || null,
    requestId: state.activeRequestId || null,
  });
}

async function sendPromptNow(overridePromptText = null, retryContext = null) {
  if (state.running) {
    return;
  }

  let rawInput =
    retryContext?.rawInput ??
    (overridePromptText !== null ? String(overridePromptText) : promptInput.value.trim());

  if (!rawInput && (state.attachedFiles.length > 0 || state.pickedElements.length > 0 || state.screenshot)) {
    rawInput =
      state.pickedElements.length > 0
        ? "Inspect the selected webpage element(s) and help me with them."
        : "Analyze the attached context and help me with it.";
  }
  if (!rawInput) return;

  if (!retryContext && rawInput.startsWith("/")) {
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

  const includeSelection =
    retryContext?.includeSelection ??
    Boolean(state.liveSelection && state.liveSelection !== state.dismissedSelectionText);
  const selectionOverride = retryContext?.selectionOverride ?? (includeSelection ? state.liveSelection : null);
  const screenshotSnapshot = retryContext ? retryContext.screenshotSnapshot || null : state.screenshot;
  const screenshotBase64 = retryContext ? retryContext.screenshotBase64 : state.screenshot?.base64 || null;
  const filesPayload = retryContext ? retryContext.filesPayload : state.attachedFiles.slice();
  const pickedPayload = retryContext ? retryContext.pickedPayload || [] : state.pickedElements.slice();

  if (!retryContext) {
    const attachmentsPreview = [];
    const activeHost = parseHost(state.activeTab?.url || "");
    if (state.includeActiveTab && state.activeTab && getPolicyForHost(activeHost) !== "block") {
      attachmentsPreview.push({
        kind: "active-tab",
        tabId: state.activeTab.tabId,
        title: state.activeTab.title || state.activeTab.url,
      });
    }
    if (includeSelection && selectionOverride) {
      attachmentsPreview.push({
        kind: "selection",
        preview: selectionOverride.slice(0, 60),
      });
    }
    for (const tid of state.mentionedTabIds) {
      const t = state.allTabs.find((x) => x.tabId === tid);
      if (t) attachmentsPreview.push({ kind: "mentioned-tab", tabId: tid, title: t.title || t.url });
    }
    for (const pEl of pickedPayload) {
      attachmentsPreview.push({
        kind: "element",
        selector: pEl.selector || pEl.tagName || "element",
        label: pEl.label || pEl.selector || "Element",
      });
    }
    if (screenshotBase64) {
      attachmentsPreview.push({ kind: "screenshot", label: "Tab screenshot" });
    }
    for (const f of filesPayload) {
      attachmentsPreview.push({ kind: f.kind, label: f.name });
    }

    state.screenshot = null;
    state.attachedFiles = [];
    state.pickedElements = [];
    renderAttachmentChips();
    syncSendButtonState();

    appendUserMessageDOM(rawInput, attachmentsPreview);
  }

  const currentTurnRefs = createAssistantTurnDOM({
    userPromptForShortcut: rawInput,
    streaming: true,
  });
  liveAssistantRefs = currentTurnRefs;

  const requestId = `ui-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  state.activeRequestId = requestId;
  updateRunningUI(true);

  try {
    const res = await sendRuntimeMessage({
      type: "sidepanel:sendPrompt",
      payload: {
        requestId,
        sessionId: state.currentSessionId,
        userText: rawInput,
        interactionMode: state.interactionMode,
        permissionMode: state.permissionMode || "auto",
        autoApprovePermissions: state.permissionMode === "full",
        modelId: state.modelId || null,
        thoughtLevel: state.thoughtLevel || "medium",
        includeActiveTab: Boolean(state.includeActiveTab),
        activeTabId: state.activeTab?.tabId || null,
        includeSelection,
        selectionOverride,
        mentionedTabIds: Array.from(state.mentionedTabIds),
        pickedElements: pickedPayload,
        screenshotBase64,
        attachedFiles: filesPayload,
        cwd: state.settings.cwd || null,
        customInstructions: state.settings.customInstructions || null,
        siteAccessConfirmedHosts: Array.from(state.confirmedHostsForSession),
      },
    });

    if (res?.requiresSiteConfirmation) {
      renderSiteAccessConfirmationCard(currentTurnRefs, res, () => {
        sendPromptNow(null, {
          rawInput,
          includeSelection,
          selectionOverride,
          screenshotSnapshot,
          screenshotBase64,
          filesPayload,
          pickedPayload,
        });
      });
      return;
    }

    if (!res?.ok) {
      if (res?.code === -32021) {
        // Restore attachments if blocked by site access policy before sending
        if (screenshotSnapshot && !state.screenshot) state.screenshot = screenshotSnapshot;
        if (filesPayload.length > 0 && state.attachedFiles.length === 0) state.attachedFiles = filesPayload;
        if (pickedPayload.length > 0 && state.pickedElements.length === 0) state.pickedElements = pickedPayload;
        renderAttachmentChips();
        syncSendButtonState();
      }
      const errDiv = document.createElement("div");
      errDiv.className = "error-bubble";
      errDiv.textContent = res?.error || "Request failed.";
      currentTurnRefs.mdBody.innerHTML = "";
      currentTurnRefs.mdBody.appendChild(errDiv);
      currentTurnRefs.sparkleEl.classList.remove("streaming");
    } else {
      state.currentSessionId = res.sessionId || state.currentSessionId;
      if (res.title) {
        state.sessionTitle = res.title;
        headerTitleEl.textContent = res.title;
      }
      if (!currentTurnRefs.rawText) {
        currentTurnRefs.mdBody.innerHTML =
          res.stopReason === "cancelled" ? `<p><em>Stopped.</em></p>` : `<p><em>Completed.</em></p>`;
      }
      finalizeAssistantTurnDOM(currentTurnRefs);
    }
  } catch (err) {
    currentTurnRefs.sparkleEl.classList.remove("streaming");
    currentTurnRefs.mdBody.innerHTML = `<div class="error-bubble">${escapeHtml(
      err?.message || String(err),
    )}</div>`;
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
  state.sessionTitle = "New thread";
  headerTitleEl.textContent = "New thread";
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

  const res = await sendRuntimeMessage({
    type: "sidepanel:loadSession",
    sessionId,
  });
  if (!res?.ok || !res.session) {
    messagesListEl.innerHTML = `<div class="error-bubble">${escapeHtml(
      res?.error || "Unable to load thread.",
    )}</div>`;
    welcomeStateEl.classList.add("hidden");
    return;
  }

  const sess = res.session;
  state.currentSessionId = sess.sessionId;
  state.sessionTitle = sess.title || "Thread";
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
  let prevUserText = "";
  for (const m of msgs) {
    if (m.role === "user") {
      prevUserText = m.text || "";
      appendUserMessageDOM(prevUserText, m.attachments || []);
    } else {
      createAssistantTurnDOM({
        thoughts: m.thoughts || "",
        toolCalls: m.toolCalls || [],
        text: m.text || "",
        userPromptForShortcut: prevUserText,
        streaming: false,
      });
    }
  }
  scrollToBottom(true);
}

function renderHistoryDrawer() {
  historyListEl.innerHTML = "";
  const needle = String(state.historyFilter || "").trim().toLowerCase();
  const filtered = (state.sessions || []).filter(
    (s) =>
      !needle ||
      (s.title || "").toLowerCase().includes(needle) ||
      (s.originTitle || "").toLowerCase().includes(needle) ||
      (s.originUrl || "").toLowerCase().includes(needle),
  );

  if (filtered.length === 0) {
    historyListEl.innerHTML = `<p class="sheet-empty">${
      needle ? "No matching threads found." : "No Chrome threads yet. Start chatting to sync with Antigravity.app."
    }</p>`;
    return;
  }

  for (const s of filtered) {
    const card = document.createElement("div");
    card.className = "tonal-list-card";
    const when = s.updatedAt
      ? new Date(s.updatedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : "";
    card.innerHTML = `
      <div class="tonal-card-top">
        <div class="tonal-card-title">${escapeHtml(s.title || "Thread")}</div>
        <div class="tonal-card-actions">
          <button type="button" class="text-link-btn open-app-btn" title="Open in Antigravity.app">Open ↗</button>
          <button type="button" class="chip-dismiss-btn del-sess-btn" title="Delete thread" aria-label="Delete">${SVG.closeXs}</button>
        </div>
      </div>
      <div class="tonal-card-meta">
        <span>${escapeHtml(s.interactionMode === "agent" ? "Agent" : "Chat")} · ${s.messageCount || 0} msgs</span>
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
      const resp = await sendRuntimeMessage({
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

function renderSkillsDrawer() {
  drawerSkillsListEl.innerHTML = "";
  const items = [
    ...(state.shortcuts.custom || []).map((s) => ({ ...s, badge: "Saved" })),
    ...(state.shortcuts.builtin || []).map((s) => ({
      ...s,
      badge: s.interactionMode === "agent" ? "Agent" : "Built-in",
    })),
  ];

  for (const item of items) {
    const card = document.createElement("div");
    card.className = "tonal-list-card";
    card.innerHTML = `
      <div class="tonal-card-top">
        <div class="tonal-card-title">/${escapeHtml(item.command)} · ${escapeHtml(item.title || "")}</div>
        <div class="tonal-card-actions">
          <button type="button" class="tonal-btn compact run-sc-btn">Run</button>
          ${!item.builtin ? `<button type="button" class="chip-dismiss-btn del-sc-btn" title="Delete">${SVG.closeXs}</button>` : ""}
        </div>
      </div>
      <div class="tonal-card-meta">
        <span>${escapeHtml(item.description || "")}</span>
        <span>${escapeHtml(item.badge)}</span>
      </div>
    `;
    card.querySelector(".run-sc-btn").addEventListener("click", () => {
      historyDrawer.classList.add("hidden");
      if (item.interactionMode) {
        state.interactionMode = item.interactionMode;
        updateModeUI();
      }
      sendPromptNow(item.prompt);
    });
    const delBtn = card.querySelector(".del-sc-btn");
    if (delBtn) {
      delBtn.addEventListener("click", async () => {
        const res = await sendRuntimeMessage({
          type: "sidepanel:deleteShortcut",
          payload: { id: item.id },
        });
        if (res?.custom) {
          state.shortcuts.custom = res.custom;
          renderSkillsDrawer();
        }
      });
    }
    drawerSkillsListEl.appendChild(card);
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
      ? `Last ${new Date(task.lastRunAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : "Pending";
    card.innerHTML = `
      <div class="tonal-card-top">
        <div class="tonal-card-title">${escapeHtml(task.name)}</div>
        <div class="tonal-card-actions">
          <button type="button" class="tonal-btn compact run-now-btn">Run now</button>
          ${task.lastSessionId ? '<button type="button" class="text-link-btn view-run-btn">View</button>' : ""}
          <button type="button" class="chip-dismiss-btn del-sched-btn" aria-label="Delete">${SVG.closeXs}</button>
        </div>
      </div>
      <div class="tonal-card-meta">
        <span>Every ${task.intervalMinutes}m · ${task.interactionMode === "agent" ? "Agent" : "Chat"}</span>
        <span>${escapeHtml(lastInfo)}</span>
      </div>
    `;
    card.querySelector(".run-now-btn").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = "Running…";
      try {
        const res = await sendRuntimeMessage({ type: "sidepanel:runScheduleNow", id: task.id });
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
      const res = await sendRuntimeMessage({
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

function syncPopoverKeyboardHighlight(listContainer) {
  if (!listContainer) return;
  const rows = Array.from(listContainer.querySelectorAll(".popover-item"));
  if (rows.length === 0) return;
  const clamped = ((state.kbActiveIndex % rows.length) + rows.length) % rows.length;
  state.kbActiveIndex = clamped;
  rows.forEach((r, idx) => {
    r.classList.toggle("kb-active", idx === clamped);
    if (idx === clamped) {
      r.scrollIntoView?.({ block: "nearest" });
    }
  });
}

function renderSlashPopover(filterText = "") {
  const needle = filterText.replace(/^\/+/, "").trim().toLowerCase();
  slashListEl.innerHTML = "";
  state.kbActiveIndex = 0;

  const combined = [
    ...(state.shortcuts.custom || []).map((s) => ({ ...s, kindLabel: "Saved" })),
    ...(state.shortcuts.builtin || []).map((s) => ({
      ...s,
      kindLabel: s.interactionMode === "agent" ? "Agent" : "Page",
    })),
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
    slashListEl.innerHTML = `<div class="popover-item-sub" style="padding:8px 10px;">No matching shortcuts.</div>`;
    return;
  }

  for (const item of combined) {
    const row = document.createElement("div");
    row.className = "popover-item";
    row.innerHTML = `
      <span class="popover-item-icon">${SVG.slashSm}</span>
      <div class="popover-item-main">
        <div class="popover-item-title">/${escapeHtml(item.command)} <span style="font-weight:400;color:var(--text-muted)">· ${escapeHtml(
      item.kindLabel,
    )}</span></div>
        <div class="popover-item-sub">${escapeHtml(item.description || item.title || "")}</div>
      </div>
      ${!item.builtin && !item.isSkill ? `<button type="button" class="chip-dismiss-btn del-sc-btn" title="Delete">${SVG.closeXs}</button>` : ""}
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
        const res = await sendRuntimeMessage({
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
  syncPopoverKeyboardHighlight(slashListEl);
}

function renderTabsPicker(filterText = "") {
  const needle = filterText.trim().toLowerCase();
  tabsPickerListEl.innerHTML = "";
  state.kbActiveIndex = 0;
  const openBrowserTabs = state.allTabs.filter((t) => !/^chrome-extension:\/\//i.test(t.url || ""));
  const showChromeAllOption =
    openBrowserTabs.length > 0 &&
    (!needle ||
      "chrome".includes(needle) ||
      "browser".includes(needle) ||
      "all".includes(needle) ||
      "tabs".includes(needle));
  const matchesActiveAlias =
    Boolean(needle) &&
    ("page".includes(needle) || "current".includes(needle) || "active".includes(needle) || "tab".includes(needle));

  const candidates = openBrowserTabs.filter(
    (t) =>
      !needle ||
      (t.title || "").toLowerCase().includes(needle) ||
      (t.url || "").toLowerCase().includes(needle) ||
      (matchesActiveAlias && (t.tabId === state.activeTab?.tabId || "tab".includes(needle))),
  );

  if (!showChromeAllOption && candidates.length === 0) {
    tabsPickerListEl.innerHTML = `<div class="popover-item-sub" style="padding:8px 10px;">No open tabs found.</div>`;
    return;
  }

  if (showChromeAllOption) {
    const targetBatch = openBrowserTabs.slice(0, 6);
    const allSelected = targetBatch.every((t) => state.mentionedTabIds.has(t.tabId));
    const chromeRow = document.createElement("div");
    chromeRow.className = `popover-item${allSelected ? " selected" : ""}`;
    const bName = state.bridgeStatus?.browserName || "Chrome";
    chromeRow.innerHTML = `
      <span class="popover-item-icon">${allSelected ? SVG.checkSmall : SVG.globeXs}</span>
      <div class="popover-item-main">
        <div class="popover-item-title">@Chrome · All open tabs</div>
        <div class="popover-item-sub">Reference ${targetBatch.length} open ${escapeHtml(bName)} tab${
          targetBatch.length === 1 ? "" : "s"
        }</div>
      </div>
    `;
    chromeRow.addEventListener("click", () => {
      if (allSelected) {
        for (const t of targetBatch) state.mentionedTabIds.delete(t.tabId);
      } else {
        for (const t of targetBatch) state.mentionedTabIds.add(t.tabId);
      }
      promptInput.value = promptInput.value.replace(/(^|\s)@[^\s]*$/, "$1");
      syncSendButtonState();
      renderAttachmentChips();
      closeAllPopovers();
      promptInput.focus();
    });
    tabsPickerListEl.appendChild(chromeRow);
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
      <div class="popover-item-title">${escapeHtml(t.title || t.url || `Tab ${t.tabId}`)}${isActive ? " · Active" : ""}</div>
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
  syncPopoverKeyboardHighlight(tabsPickerListEl);
}

async function toggleElementPickerFromUI() {
  closeAllPopovers();
  historyDrawer.classList.add("hidden");
  if (state.picker.active) {
    const res = await sendRuntimeMessage({ type: "sidepanel:cancelElementPicker" });
    renderPickerUI(res?.picker || { active: false, tabId: null });
    return;
  }
  const res = await sendRuntimeMessage({
    type: "sidepanel:startElementPicker",
    payload: { tabId: state.activeTab?.tabId || null },
  });
  if (res?.ok && res.picker) {
    renderPickerUI(res.picker);
  } else if (res?.error) {
    welcomeStateEl.classList.add("hidden");
    const errDiv = document.createElement("div");
    errDiv.className = "error-bubble";
    errDiv.textContent = res.error;
    messagesListEl.appendChild(errDiv);
    scrollToBottom(true);
  }
}

async function startWorkflowRecordingFromUI() {
  closeAllPopovers();
  historyDrawer.classList.add("hidden");
  const res = await sendRuntimeMessage({
    type: "sidepanel:startRecording",
    payload: { tabId: state.activeTab?.tabId || null },
  });
  if (res?.ok && res.recording) {
    renderRecordingUI(res.recording);
  } else if (res?.error) {
    welcomeStateEl.classList.add("hidden");
    const errDiv = document.createElement("div");
    errDiv.className = "error-bubble";
    errDiv.textContent = res.error;
    messagesListEl.appendChild(errDiv);
  }
}

async function openInDesktopApp(sessionId = state.currentSessionId) {
  await sendRuntimeMessage({
    type: "sidepanel:openInDesktopApp",
    sessionId,
  });
}

async function refreshTabsList() {
  const res = await sendRuntimeMessage({ type: "sidepanel:listTabs" });
  if (res?.ok && Array.isArray(res.tabs)) {
    updateActiveTabBar(res.tabs);
  }
}

async function reconnectNativeBridge() {
  const status = await sendRuntimeMessage({ type: "sidepanel:reconnect" });
  renderBridgeStatus(status);
}

function openDrawerTab(tabName = "chats") {
  closeAllPopovers();
  historyDrawer.classList.remove("hidden");
  drawerPanelChats.classList.toggle("hidden", tabName !== "chats");
  drawerPanelSkills.classList.toggle("hidden", tabName !== "skills");
  drawerPanelSchedules.classList.toggle("hidden", tabName !== "schedules");
  drawerPanelActivity.classList.toggle("hidden", tabName !== "activity");

  for (const btn of drawerTabsGroup.querySelectorAll(".seg-btn")) {
    btn.classList.toggle("active", btn.dataset.drawerTab === tabName);
  }

  if (tabName === "chats") renderHistoryDrawer();
  else if (tabName === "skills") renderSkillsDrawer();
  else if (tabName === "schedules") renderSchedulesDrawer();
  else if (tabName === "activity") renderActivityStreamUI();
}

// Global & Popover Dismiss Listeners
document.addEventListener("click", (e) => {
  if (
    !e.target.closest(".glass-popover") &&
    !e.target.closest("#model-menu-btn") &&
    !e.target.closest("#settings-btn") &&
    !e.target.closest("#add-menu-btn") &&
    !e.target.closest("#inspect-active-tab-btn") &&
    !e.target.closest("#welcome-preview-btn")
  ) {
    closeAllPopovers();
  }
});

// Top Header Events
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

settingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const willOpen = settingsPopover.classList.contains("hidden");
  closeAllPopovers();
  if (willOpen) {
    renderSettingsPopover();
    settingsPopover.classList.remove("hidden");
  }
});

sitePolicySegmentedEl.addEventListener("click", async (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn || !btn.dataset.sitePolicy) return;
  const host = parseHost(state.activeTab?.url || "");
  if (!host) return;
  const res = await sendRuntimeMessage({
    type: "sidepanel:setSitePermission",
    host,
    policy: btn.dataset.sitePolicy,
  });
  if (res?.permissions) {
    state.sitePermissions = res.permissions;
    renderSettingsPopover();
    syncSharedPageChipUI();
    refreshLiveSelectionFromActiveTab();
  }
});

previewSitePolicyGroup.addEventListener("click", async (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn || !btn.dataset.sitePolicy) return;
  const host = parseHost(state.activeTab?.url || "");
  if (!host) return;
  const res = await sendRuntimeMessage({
    type: "sidepanel:setSitePermission",
    host,
    policy: btn.dataset.sitePolicy,
  });
  if (res?.permissions) {
    state.sitePermissions = res.permissions;
    syncSharedPageChipUI();
    refreshLiveSelectionFromActiveTab();
    openBoundedPagePreview();
  }
});

themeSegmentedEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn || !btn.dataset.themeChoice) return;
  state.settings.theme = btn.dataset.themeChoice;
  applyTheme(state.settings.theme);
  sendRuntimeMessage({
    type: "sidepanel:saveSettings",
    settings: { theme: state.settings.theme },
  });
});

saveSettingsBtn.addEventListener("click", async () => {
  const res = await sendRuntimeMessage({
    type: "sidepanel:saveSettings",
    settings: {
      cwd: settingsCwdInput.value.trim(),
      customInstructions: settingsInstructionsInput.value,
      theme: state.settings.theme,
    },
  });
  if (res?.settings) {
    state.settings = res.settings;
    updateWorkspaceBadgeUI();
  }
  closeAllPopovers();
});

if (thoughtLevelSegmentedEl) {
  thoughtLevelSegmentedEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn || !btn.dataset.thought) return;
    const nextThought = btn.dataset.thought;
    state.userSelectedModel = true;
    state.thoughtLevel = nextThought;
    const families = buildGroupedModelFamilies(state.models);
    const activeFamily = families.find((f) => f.modelIds.has(state.modelId)) || families[0];
    if (activeFamily) {
      state.modelId = resolveFamilyModelIdForEffort(activeFamily, nextThought);
    }
    renderModelMenu();
    sendRuntimeMessage({
      type: "sidepanel:setConfig",
      payload: {
        sessionId: state.currentSessionId || null,
        modelId: state.modelId,
        thoughtLevel: state.thoughtLevel,
      },
    });
  });
}

permissionSegmentedEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn || !btn.dataset.perm) return;
  applyPermissionModeChange(btn.dataset.perm);
});

approvalCycleBtn.addEventListener("click", () => {
  const order = ["auto", "ask", "full"];
  const idx = order.indexOf(state.permissionMode);
  applyPermissionModeChange(order[(idx + 1) % order.length]);
});

bridgeStatusPill.addEventListener("click", () => {
  if (!state.bridgeStatus?.nativeConnected) {
    reconnectNativeBridge();
  } else {
    openDrawerTab("activity");
  }
});

bridgeStatusBtn.addEventListener("click", reconnectNativeBridge);
bannerReconnectBtn.addEventListener("click", reconnectNativeBridge);

headerOpenAppBtn.addEventListener("click", () => openInDesktopApp());
openDesktopBtn.addEventListener("click", () => openInDesktopApp());
newChatBtn.addEventListener("click", startNewChat);

// Browser Activity & Recording Controls
toggleActivityStreamBtn.addEventListener("click", () => {
  inlineActivityDrawer.classList.toggle("hidden");
  renderActivityStreamUI();
});

const clearActivityHandler = async () => {
  await sendRuntimeMessage({ type: "sidepanel:clearActivity" });
  state.activityLog = [];
  renderActivityStreamUI();
};
clearInlineActivityBtn.addEventListener("click", clearActivityHandler);
drawerClearActivityBtn.addEventListener("click", clearActivityHandler);

detachAllBtn.addEventListener("click", async () => {
  const status = await sendRuntimeMessage({ type: "sidepanel:finishAll" });
  renderBridgeStatus(status);
});

stopRecordingBtn.addEventListener("click", async () => {
  const res = await sendRuntimeMessage({
    type: "sidepanel:stopRecording",
    payload: { cancel: false },
  });
  renderRecordingUI(res?.recording);
  if (res?.shortcutDraft) {
    openDrawerTab("skills");
    drawerScCmdInput.value = res.shortcutDraft.command || "recorded-flow";
    drawerScTitleInput.value = res.shortcutDraft.title || "Recorded workflow";
    drawerScPromptInput.value = res.shortcutDraft.prompt || "";
    state.drawerScMode = "agent";
    for (const b of drawerScModeGroup.querySelectorAll(".seg-btn")) {
      b.classList.toggle("active", b.dataset.scMode === "agent");
    }
  }
});

cancelRecordingBtn.addEventListener("click", async () => {
  const res = await sendRuntimeMessage({
    type: "sidepanel:stopRecording",
    payload: { cancel: true },
  });
  renderRecordingUI(res?.recording);
});

cancelElementPickerBtn.addEventListener("click", async () => {
  const res = await sendRuntimeMessage({ type: "sidepanel:cancelElementPicker" });
  renderPickerUI(res?.picker || { active: false, tabId: null });
});

// Drawer Events
historyBtn.addEventListener("click", () => {
  if (!historyDrawer.classList.contains("hidden")) {
    historyDrawer.classList.add("hidden");
  } else {
    openDrawerTab("chats");
  }
});

closeHistoryBtn.addEventListener("click", () => historyDrawer.classList.add("hidden"));

drawerTabsGroup.addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn || !btn.dataset.drawerTab) return;
  openDrawerTab(btn.dataset.drawerTab);
});

historySearchInput.addEventListener("input", () => {
  state.historyFilter = historySearchInput.value;
  renderHistoryDrawer();
});

drawerRecordBtn.addEventListener("click", startWorkflowRecordingFromUI);

drawerScModeGroup.addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  state.drawerScMode = btn.dataset.scMode || "agent";
  for (const el of drawerScModeGroup.querySelectorAll(".seg-btn")) {
    el.classList.toggle("active", el === btn);
  }
});

drawerSaveScBtn.addEventListener("click", async () => {
  const command = drawerScCmdInput.value.trim();
  const title = drawerScTitleInput.value.trim();
  const prompt = drawerScPromptInput.value.trim();
  if (!command || !prompt) return;
  const res = await sendRuntimeMessage({
    type: "sidepanel:saveShortcut",
    payload: { command, title, prompt, interactionMode: state.drawerScMode },
  });
  if (res?.custom) {
    state.shortcuts.custom = res.custom;
    drawerScCmdInput.value = "";
    drawerScTitleInput.value = "";
    drawerScPromptInput.value = "";
    renderSkillsDrawer();
  }
});

schedulesBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  openDrawerTab("schedules");
});

schedIntervalGroup.addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  state.schedInterval = Number(btn.dataset.interval) || 60;
  for (const el of schedIntervalGroup.querySelectorAll(".seg-btn")) {
    el.classList.toggle("active", el === btn);
  }
});

schedModeGroup.addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  state.schedMode = btn.dataset.schedMode || "chat";
  for (const el of schedModeGroup.querySelectorAll(".seg-btn")) {
    el.classList.toggle("active", el === btn);
  }
});

scheduleForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("sched-name").value.trim();
  const targetUrl = document.getElementById("sched-url").value.trim();
  const prompt = document.getElementById("sched-prompt").value.trim();
  if (!name || !prompt) return;

  const res = await sendRuntimeMessage({
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

// Active Page Preview & Workflow Chips
inspectActiveTabBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!pagePreviewPopover.classList.contains("hidden")) {
    pagePreviewPopover.classList.add("hidden");
  } else {
    openBoundedPagePreview();
  }
});

popoverWorkspaceRowEl?.addEventListener("click", (e) => {
  e.stopPropagation();
  closeAllPopovers();
  renderSettingsPopover();
  settingsPopover.classList.remove("hidden");
  settingsCwdInput.focus();
});

closePagePreviewBtn.addEventListener("click", () => pagePreviewPopover.classList.add("hidden"));

quickGridEl.addEventListener("click", (e) => {
  const pill = e.target.closest(".workflow-chip");
  if (!pill) return;
  if (pill.dataset.action === "pick-element") {
    toggleElementPickerFromUI();
    return;
  }
  if (pill.dataset.action === "record") {
    startWorkflowRecordingFromUI();
    return;
  }
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

// Composer Mode, Attachments, Drag & Drop, Paste, & Voice
modeSwitchGroup.addEventListener("click", (e) => {
  const btn = e.target.closest(".mode-pill-opt");
  if (!btn || !btn.dataset.mode) return;
  state.interactionMode = btn.dataset.mode === "agent" ? "agent" : "chat";
  updateModeUI();
  promptInput.focus();
});

unshareActiveTabBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  state.includeActiveTab = false;
  state.liveSelection = "";
  syncSharedPageChipUI();
  syncSelectionChipUI();
});

reshareActiveTabBtn.addEventListener("click", () => {
  state.includeActiveTab = true;
  syncSharedPageChipUI();
  refreshLiveSelectionFromActiveTab();
});

dismissSelectionBtn.addEventListener("click", () => {
  state.dismissedSelectionText = state.liveSelection;
  syncSelectionChipUI();
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

menuAttachFileBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  closeAllPopovers();
  fileInput.click();
});

fileInput.addEventListener("change", async () => {
  if (fileInput.files?.length) {
    await handleFilesAdded(fileInput.files);
    fileInput.value = "";
  }
});

appShellEl.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types?.includes("Files")) return;
  e.preventDefault();
  dragDepth += 1;
  dropzoneOverlay.classList.remove("hidden");
});

appShellEl.addEventListener("dragover", (e) => {
  if (!e.dataTransfer?.types?.includes("Files")) return;
  e.preventDefault();
});

appShellEl.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    dropzoneOverlay.classList.add("hidden");
  }
});

appShellEl.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropzoneOverlay.classList.add("hidden");
  if (e.dataTransfer?.files?.length) {
    await handleFilesAdded(e.dataTransfer.files);
  }
});

promptInput.addEventListener("paste", async (e) => {
  const items = Array.from(e.clipboardData?.items || []);
  const imageFiles = items
    .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
    .map((it) => it.getAsFile())
    .filter(Boolean);
  if (imageFiles.length > 0) {
    e.preventDefault();
    await handleFilesAdded(imageFiles);
  }
});

menuShareTabsBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  closeAllPopovers();
  await refreshTabsList();
  renderTabsPicker("");
  tabsPopover.classList.remove("hidden");
});

pickElementBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleElementPickerFromUI();
});

menuPickElementBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleElementPickerFromUI();
});

screenshotBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  closeAllPopovers();
  screenshotBtn.disabled = true;
  try {
    const res = await sendRuntimeMessage({
      type: "sidepanel:captureScreenshot",
      windowId: state.activeTab?.windowId ?? null,
    });
    if (res?.ok && res.base64) {
      state.screenshot = { dataUrl: res.dataUrl, base64: res.base64 };
      renderAttachmentChips();
      syncSendButtonState();
    }
  } finally {
    screenshotBtn.disabled = false;
  }
});

menuRecordBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  startWorkflowRecordingFromUI();
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
  await sendRuntimeMessage({
    type: "sidepanel:groupTabsNow",
    payload: {
      tabIds: ids,
      title: state.sessionTitle === "New thread" ? "Antigravity" : state.sessionTitle.slice(0, 22),
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
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  state.customScMode = btn.dataset.scMode || "chat";
  for (const el of customScModeGroup.querySelectorAll(".seg-btn")) {
    el.classList.toggle("active", el === btn);
  }
});

saveCustomScBtn.addEventListener("click", async () => {
  const command = document.getElementById("custom-sc-cmd").value.trim();
  const title = document.getElementById("custom-sc-title").value.trim();
  const prompt = document.getElementById("custom-sc-prompt").value.trim();
  if (!command || !prompt) return;
  const res = await sendRuntimeMessage({
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

// Voice Dictation (Web Speech API)
const SpeechRecCtor = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
if (!SpeechRecCtor) {
  voiceBtn.classList.add("hidden");
} else {
  voiceBtn.addEventListener("click", () => {
    if (isListeningVoice && speechRecognition) {
      speechRecognition.stop();
      return;
    }
    try {
      speechRecognition = new SpeechRecCtor();
      speechRecognition.continuous = false;
      speechRecognition.interimResults = false;
      speechRecognition.onstart = () => {
        isListeningVoice = true;
        voiceBtn.classList.add("listening");
      };
      speechRecognition.onresult = (ev) => {
        const transcript = ev.results?.[0]?.[0]?.transcript || "";
        if (transcript) {
          promptInput.value = `${promptInput.value}${promptInput.value ? " " : ""}${transcript.trim()}`;
          promptInput.dispatchEvent(new Event("input"));
          promptInput.focus();
        }
      };
      speechRecognition.onend = () => {
        isListeningVoice = false;
        voiceBtn.classList.remove("listening");
      };
      speechRecognition.onerror = () => {
        isListeningVoice = false;
        voiceBtn.classList.remove("listening");
      };
      speechRecognition.start();
    } catch {}
  });
}

promptInput.addEventListener("focus", () => {
  refreshLiveSelectionFromActiveTab();
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
  const slashOpen = !slashPopover.classList.contains("hidden");
  const tabsOpen = !tabsPopover.classList.contains("hidden");
  if ((slashOpen || tabsOpen) && !e.isComposing) {
    const activeList = slashOpen ? slashListEl : tabsPickerListEl;
    const rows = activeList.querySelectorAll(".popover-item");
    if (rows.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        state.kbActiveIndex += 1;
        syncPopoverKeyboardHighlight(activeList);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        state.kbActiveIndex -= 1;
        syncPopoverKeyboardHighlight(activeList);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        const targetRow = rows[state.kbActiveIndex];
        if (targetRow) {
          e.preventDefault();
          targetRow.click();
          return;
        }
      }
    }
  }

  if (e.key === "Escape") {
    if (state.picker.active) {
      sendRuntimeMessage({ type: "sidepanel:cancelElementPicker" }).then((res) => {
        renderPickerUI(res?.picker || { active: false, tabId: null });
      });
    }
    closeAllPopovers();
    return;
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!state.running) {
      sendPromptNow();
    }
  }
});

sendBtn.addEventListener("click", () => {
  if (state.running) {
    stopRunningPrompt();
  } else {
    sendPromptNow();
  }
});

// Live Runtime Port & Initial Bootstrap
if (hasExtensionRuntime && chrome.runtime?.connect) {
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
    } else if (msg.type === "sidepanel:sitePermissionsUpdated") {
      state.sitePermissions = msg.permissions || {};
      syncSharedPageChipUI();
      refreshLiveSelectionFromActiveTab();
      if (!settingsPopover.classList.contains("hidden")) renderSettingsPopover();
    } else if (msg.type === "sidepanel:settingsUpdated") {
      state.settings = { ...state.settings, ...(msg.settings || {}) };
      applyTheme(state.settings.theme);
      updateWorkspaceBadgeUI();
    } else if (msg.type === "sidepanel:browserActivity") {
      state.activityLog = msg.activityLog || [];
      renderActivityStreamUI();
    } else if (msg.type === "sidepanel:browserActivityCleared") {
      state.activityLog = [];
      renderActivityStreamUI();
    } else if (msg.type === "sidepanel:recordingUpdated") {
      renderRecordingUI(msg.recording);
    } else if (msg.type === "sidepanel:pickerState") {
      renderPickerUI(msg.picker);
    } else if (msg.type === "sidepanel:elementPicked") {
      renderPickerUI(msg.picker || { active: false, tabId: null });
      if (msg.element && state.pickedElements.length < 8) {
        state.pickedElements.push({
          id: `pick-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          ...msg.element,
        });
        renderAttachmentChips();
        syncSendButtonState();
        promptInput.focus();
      }
    } else if (msg.type === "sidepanel:quoteSelection" && msg.selectionText) {
      const activeHost = parseHost(state.activeTab?.url || "");
      if (activeHost && getPolicyForHost(activeHost) === "block") return;
      state.dismissedSelectionText = "";
      state.liveSelection = String(msg.selectionText).trim();
      syncSelectionChipUI();
      promptInput.focus();
    }
  });
}

(async function bootstrap() {
  applyTheme("system");
  updateGreetingByTime();
  updateModeUI();
  updateApprovalUI();
  renderModelMenu();
  syncSendButtonState();
  if (!hasExtensionRuntime) return;
  try {
    const init = await sendRuntimeMessage({ type: "sidepanel:init" });
    if (init?.ok) {
      state.sessions = init.sessions || [];
      state.shortcuts = init.shortcuts || { builtin: [], custom: [] };
      state.schedules = init.schedules || [];
      state.sitePermissions = init.sitePermissions || {};
      if (init.settings) {
        state.settings = { ...state.settings, ...init.settings };
        state.permissionMode = state.settings.defaultApprovalMode || "auto";
      }
      state.activityLog = init.activityLog || [];
      applyTheme(state.settings.theme);
      updateWorkspaceBadgeUI();
      updateApprovalUI();
      renderActivityStreamUI();
      renderRecordingUI(init.recording);
      renderPickerUI(init.picker);
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
