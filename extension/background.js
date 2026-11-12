// Antigravity in Chrome — MV3 Service Worker, Side Panel Controller & Native Messaging Bridge
const NATIVE_HOST_NAME = "com.antigravity.browser_bridge";
const KEEPALIVE_ALARM = "ag-native-bridge-watchdog";
const SCHEDULE_ALARM_PREFIX = "ag-sched:";
const MAX_STORED_CHROME_SESSIONS = 50;
const MAX_BROWSER_ACTIVITY = 60;
const MAX_RECORDED_ACTIONS = 120;

const VALID_GROUP_COLORS = new Set([
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
]);

const BUILTIN_SHORTCUTS = [
  {
    id: "builtin-summarize",
    command: "summarize",
    title: "Summarize this page",
    description: "Concise executive summary, key takeaways, and action items from the current tab.",
    prompt:
      "Summarize this webpage clearly: give a 2-sentence TL;DR, bulleted key takeaways, and any notable numbers, links, or caveats.",
    interactionMode: "chat",
    builtin: true,
  },
  {
    id: "builtin-extract",
    command: "extract-table",
    title: "Extract structured data",
    description: "Pull tables, prices, specs, or lists on this page into clean Markdown / JSON.",
    prompt:
      "Extract the main structured data, items, tables, or metrics from this page into a clean Markdown table (and compact JSON block if helpful).",
    interactionMode: "chat",
    builtin: true,
  },
  {
    id: "builtin-selection",
    command: "explain-selection",
    title: "Explain highlighted text",
    description: "Explain or fact-check the text currently selected on the active tab.",
    prompt:
      "Explain the selected text on this page in plain, clear language, including how it relates to the surrounding page context.",
    interactionMode: "chat",
    builtin: true,
  },
  {
    id: "builtin-compare",
    command: "compare-tabs",
    title: "Compare attached tabs",
    description: "Compare pricing, docs, or specs across the active tab and @-mentioned tabs.",
    prompt:
      "Compare the active tab and all attached @-mentioned tabs side-by-side in a clear comparison table with pros, cons, and a recommendation.",
    interactionMode: "chat",
    builtin: true,
  },
  {
    id: "builtin-organize",
    command: "organize-tabs",
    title: "Group & tidy open tabs",
    description: "Agent Mode: organize open browser tabs into clean color-coded Tab Groups.",
    prompt:
      "Inspect my open browser tabs using computer-use and organize related research/work tabs into clean, descriptive color-coded Tab Groups without closing any of my tabs.",
    interactionMode: "agent",
    builtin: true,
  },
  {
    id: "builtin-audit",
    command: "audit-page",
    title: "Inspect console & UX issues",
    description: "Agent Mode: inspect console errors, failed network requests, and accessibility on this tab.",
    prompt:
      "Claim this browser tab in-place using computer-use, inspect its accessibility snapshot, console messages, and failed network requests, and report any bugs or UX issues.",
    interactionMode: "agent",
    builtin: true,
  },
];

let nativePort = null;
let lastNativeError = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let browserIdentityPromise = null;

// Outbound Extension -> Native Host JSON-RPC requests (`agent.*`)
let nextExtRpcId = 1;
const pendingNativeRpcs = new Map(); // rpcId -> { resolve, reject, timer }

// Live Side Panel UI Ports
const sidepanelPorts = new Set();

// Desktop MCP Bridge telemetry
let desktopBridgeInfo = {
  desktopMcpClients: 0,
  lastMethod: null,
  ts: 0,
};

// Chrome-originated Side Panel conversations (NEVER includes Desktop-originated chats!)
// sessionId -> { sessionId, title, createdAt, updatedAt, interactionMode, permissionMode, modelId, originUrl, originTitle, scheduledTaskName, messages }
const chromeSessions = new Map();
// requestId -> { sessionId, userText, interactionMode, permissionMode, modelId, originUrl, originTitle, scheduledTaskName, assistantMsg }
const activeTurnByRequest = new Map();
let localStateLoaded = false;
let persistChromeSessionsTimer = null;

// Attached debuggers: tabId -> Promise | true
const attachedTabs = new Set();
const pendingAttachByTab = new Map();
const attachedChildTargets = new Set();

// OOPIF child target tracking: sessionId -> { tabId, targetId, targetInfo }
const childSessionMap = new Map();
// Target.sendMessageToTarget fallback waiters: msgId -> { resolve, reject, timer }
let nextTargetMsgId = 1;
const pendingTargetMessages = new Map();

// Session & tab ownership tracking:
// tabOwnership: Map<tabId, { sessionId, role: "scratch" | "claimed" | "deliverable" | "handoff", createdByAgent: boolean }>
const tabOwnership = new Map();
// sessionMeta: Map<sessionId, { title: string, color: string, groupsByWindow: Map<windowId, groupId> }>
const sessionMeta = new Map();

// Expression cache for large repetitive Runtime.evaluate / callFunctionOn scripts
const expressionCache = new Map();

// Codex in Chrome parity: per-host Site Access Governance ("allow" | "ask" | "block")
const sitePermissions = new Map();

// Codex in Chrome parity: persisted workspace, system instructions, & theme settings
let extensionSettings = {
  cwd: "",
  customInstructions: "",
  theme: "system", // "system" | "dark" | "light"
  defaultApprovalMode: "auto", // "auto" | "ask" | "full"
};

// Codex in Chrome parity: chronological Browser Activity Stream (ring buffer)
let nextActivityId = 1;
const browserActivityLog = [];
const lastCdpActivityByKey = new Map();

// Codex in Chrome parity: "Record a browser demonstration" -> reusable /shortcut skill (up to 120 actions)
let recordingState = {
  active: false,
  tabId: null,
  startedAt: 0,
  originUrl: "",
  originTitle: "",
  steps: [],
};

// Codex in Chrome parity: Interactive Webpage Element Picker state
let pickerState = {
  active: false,
  tabId: null,
  startedAt: 0,
};

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

function normalizeHostFromUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return "";
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return normalizeSiteHost(parsed.hostname);
  } catch {
    return "";
  }
}

function getSitePolicyForHost(rawHost) {
  const candidates = getHostCandidateChain(rawHost);
  for (const candidate of candidates) {
    const rule = sitePermissions.get(candidate);
    if (rule === "allow" || rule === "ask" || rule === "block") {
      return rule;
    }
  }
  return "allow";
}

function getInheritedParentPolicyForHost(rawHost) {
  const candidates = getHostCandidateChain(rawHost).slice(1);
  for (const ancestor of candidates) {
    const rule = sitePermissions.get(ancestor);
    if (rule === "allow" || rule === "ask" || rule === "block") {
      return rule;
    }
  }
  return "allow";
}

function isHostConfirmedForSession(rawHost, confirmedHostsSet) {
  if (!confirmedHostsSet || confirmedHostsSet.size === 0) return false;
  const candidates = getHostCandidateChain(rawHost);
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (confirmedHostsSet.has(candidate)) return true;
    if (i < candidates.length - 1 && sitePermissions.get(candidate) === "ask") {
      return false;
    }
  }
  return false;
}

function getSitePolicyForUrl(rawUrl) {
  return getSitePolicyForHost(normalizeHostFromUrl(rawUrl));
}

function assertHostNotBlocked(rawUrlOrHost, surfaceLabel = "Browser control") {
  const host = normalizeSiteHost(rawUrlOrHost);
  if (host && getSitePolicyForHost(host) === "block") {
    const err = new Error(
      `${surfaceLabel} is blocked on ${host} by Antigravity in Chrome site permissions.`,
    );
    err.code = -32021;
    throw err;
  }
}

function pruneOrphanAllowSiteRules() {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [ruleHost, rulePolicy] of Array.from(sitePermissions.entries())) {
      if (rulePolicy === "allow" && getInheritedParentPolicyForHost(ruleHost) === "allow") {
        sitePermissions.delete(ruleHost);
        changed = true;
      }
    }
  }
}

function getSitePermissionsSnapshot() {
  const out = {};
  for (const [host, policy] of sitePermissions.entries()) {
    out[host] = policy;
  }
  return out;
}

async function setSitePermissionForHost(rawHost, rawPolicy) {
  await ensureLocalStateLoaded();
  const host = normalizeSiteHost(rawHost);
  if (!host) throw new Error("Valid hostname is required for site access permission.");
  const requested = String(rawPolicy || "").trim().toLowerCase();
  if (requested === "reset") {
    sitePermissions.delete(host);
  } else {
    const policy = ["allow", "ask", "block"].includes(requested) ? requested : "allow";
    if (policy === "allow" && getInheritedParentPolicyForHost(host) === "allow") {
      sitePermissions.delete(host);
    } else {
      sitePermissions.set(host, policy);
    }
  }
  pruneOrphanAllowSiteRules();
  const effectivePolicy = getSitePolicyForHost(host);
  const snapshot = getSitePermissionsSnapshot();
  try {
    if (chrome.storage?.local?.set) {
      await chrome.storage.local.set({ agSitePermissions: snapshot });
    }
  } catch {}
  broadcastToSidePanels({
    type: "sidepanel:sitePermissionsUpdated",
    permissions: snapshot,
  });
  return { ok: true, host, policy: effectivePolicy, permissions: snapshot };
}

async function saveExtensionSettings(patch = {}) {
  await ensureLocalStateLoaded();
  const next = { ...extensionSettings };
  if (typeof patch.cwd === "string") next.cwd = patch.cwd.trim();
  if (typeof patch.customInstructions === "string") next.customInstructions = patch.customInstructions.slice(0, 8000);
  if (["system", "dark", "light"].includes(patch.theme)) next.theme = patch.theme;
  if (["auto", "ask", "full"].includes(patch.defaultApprovalMode)) {
    next.defaultApprovalMode = patch.defaultApprovalMode;
  }
  extensionSettings = next;
  try {
    if (chrome.storage?.local?.set) {
      await chrome.storage.local.set({ agExtensionSettings: extensionSettings });
    }
  } catch {}
  broadcastToSidePanels({
    type: "sidepanel:settingsUpdated",
    settings: { ...extensionSettings },
  });
  return { ok: true, settings: { ...extensionSettings } };
}

function recordBrowserActivity({ kind = "action", title, detail = "", tabId = null, source = "mcp" } = {}) {
  if (!title) return null;
  const entry = {
    id: `act-${nextActivityId++}`,
    ts: Date.now(),
    kind,
    title: String(title),
    detail: String(detail || ""),
    tabId: typeof tabId === "number" ? tabId : null,
    source,
  };
  browserActivityLog.push(entry);
  while (browserActivityLog.length > MAX_BROWSER_ACTIVITY) {
    browserActivityLog.shift();
  }
  broadcastToSidePanels({
    type: "sidepanel:browserActivity",
    entry,
    activityLog: browserActivityLog.slice(),
  });
  return entry;
}

function getRecordingSnapshot() {
  return {
    active: Boolean(recordingState.active),
    tabId: recordingState.tabId,
    startedAt: recordingState.startedAt,
    originUrl: recordingState.originUrl,
    originTitle: recordingState.originTitle,
    stepCount: recordingState.steps.length,
    maxActions: MAX_RECORDED_ACTIONS,
    steps: recordingState.steps.slice(-20),
  };
}

function getPickerSnapshot() {
  return {
    active: Boolean(pickerState.active),
    tabId: pickerState.tabId,
    startedAt: pickerState.startedAt,
  };
}

function normalizeGroupColor(color) {
  const c = String(color || "cyan").trim().toLowerCase();
  if (VALID_GROUP_COLORS.has(c)) return c;
  if (c === "gray") return "grey";
  if (c === "sky" || c === "teal" || c === "aqua") return "cyan";
  if (c === "violet" || c === "indigo") return "purple";
  if (c === "amber") return "orange";
  return "cyan";
}

function sanitizeForContextEnvelope(rawText) {
  if (rawText == null) return "";
  return String(rawText)
    .replace(/<\/browser_sidepanel_context>/gi, "<\\/browser_sidepanel_context>")
    .replace(/<browser_sidepanel_context>/gi, "<\\browser_sidepanel_context>")
    .replace(/<\/attached_file>/gi, "<\\/attached_file>")
    .replace(/<attached_file\b/gi, "<\\attached_file");
}

function stripInjectedBrowserContext(rawText) {
  if (typeof rawText !== "string") return "";
  return rawText.replace(/^<browser_sidepanel_context>[\s\S]*?<\/browser_sidepanel_context>\s*/i, "").trim();
}

function isSafeInjectableUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return false;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  if (/chromewebstore\.google\.com|addons\.mozilla\.org/i.test(parsed.hostname)) {
    return false;
  }
  return true;
}

async function configureSidePanelBehavior() {
  try {
    if (chrome.sidePanel?.setPanelBehavior) {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    }
  } catch {}
}

function setupContextMenus() {
  try {
    if (!chrome.contextMenus?.create) return;
    chrome.contextMenus.removeAll?.(() => {
      try {
        chrome.contextMenus.create({
          id: "ag-ask-selection",
          title: "Ask Antigravity about selection",
          contexts: ["selection"],
        });
        chrome.contextMenus.create({
          id: "ag-open-sidepanel",
          title: "Open Antigravity in Chrome",
          contexts: ["page"],
        });
      } catch {}
    });
  } catch {}
}

function broadcastToSidePanels(msg) {
  for (const port of Array.from(sidepanelPorts)) {
    try {
      port.postMessage(msg);
    } catch {
      sidepanelPorts.delete(port);
    }
  }
}

async function ensureLocalStateLoaded() {
  if (localStateLoaded) return;
  localStateLoaded = true;
  try {
    if (!chrome.storage?.local?.get) return;
    const data = await chrome.storage.local.get([
      "agChromeSessions",
      "agSitePermissions",
      "agExtensionSettings",
    ]);
    if (Array.isArray(data?.agChromeSessions)) {
      for (const item of data.agChromeSessions) {
        if (item && typeof item.sessionId === "string" && item.sessionId) {
          chromeSessions.set(item.sessionId, item);
        }
      }
    }
    if (data?.agSitePermissions && typeof data.agSitePermissions === "object") {
      for (const [rawHost, policy] of Object.entries(data.agSitePermissions)) {
        const normalizedHost = normalizeSiteHost(rawHost);
        if (normalizedHost && ["allow", "ask", "block"].includes(policy)) {
          sitePermissions.set(normalizedHost, policy);
        }
      }
      pruneOrphanAllowSiteRules();
    }
    if (data?.agExtensionSettings && typeof data.agExtensionSettings === "object") {
      extensionSettings = {
        ...extensionSettings,
        ...data.agExtensionSettings,
      };
    }
  } catch {}
}

function schedulePersistChromeSessions() {
  if (persistChromeSessionsTimer) return;
  persistChromeSessionsTimer = setTimeout(async () => {
    persistChromeSessionsTimer = null;
    await flushChromeSessionsNow();
  }, 250);
}

async function flushChromeSessionsNow() {
  try {
    if (!chrome.storage?.local?.set) return;
    const sorted = Array.from(chromeSessions.values())
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, MAX_STORED_CHROME_SESSIONS);
    await chrome.storage.local.set({ agChromeSessions: sorted });
  } catch {}
}

function getChromeSessionsSummaryList() {
  return Array.from(chromeSessions.values())
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map((s) => ({
      sessionId: s.sessionId,
      title: s.title || "Browser Chat",
      createdAt: s.createdAt || 0,
      updatedAt: s.updatedAt || 0,
      interactionMode: s.interactionMode || "chat",
      permissionMode: s.permissionMode || "auto",
      modelId: s.modelId || "",
      originUrl: s.originUrl || "",
      originTitle: s.originTitle || "",
      scheduledTaskName: s.scheduledTaskName || null,
      messageCount: Array.isArray(s.messages) ? s.messages.length : 0,
    }));
}

function getOrCreateSession(sessionId = "default", defaults = {}) {
  const sid = String(sessionId || "default");
  let meta = sessionMeta.get(sid);
  if (!meta) {
    meta = {
      sessionId: sid,
      title: defaults.title || "Antigravity",
      color: normalizeGroupColor(defaults.color || "cyan"),
      groupsByWindow: new Map(),
    };
    sessionMeta.set(sid, meta);
  } else {
    if (defaults.title) meta.title = String(defaults.title);
    if (defaults.color) meta.color = normalizeGroupColor(defaults.color);
  }
  return meta;
}

async function persistSessionState() {
  try {
    if (!chrome.storage?.session) return;
    const ownershipEntries = Array.from(tabOwnership.entries());
    const sessionsEntries = Array.from(sessionMeta.entries()).map(([sid, m]) => [
      sid,
      {
        title: m.title,
        color: m.color,
        groupsByWindow: Array.from(m.groupsByWindow.entries()),
      },
    ]);
    await chrome.storage.session.set({
      agOwnership: ownershipEntries,
      agSessions: sessionsEntries,
    });
  } catch {}
}

async function restoreSessionState() {
  try {
    if (!chrome.storage?.session) return;
    const data = await chrome.storage.session.get(["agOwnership", "agSessions"]);
    if (Array.isArray(data?.agOwnership)) {
      for (const [tabId, info] of data.agOwnership) {
        if (typeof tabId === "number" && info && typeof info === "object") {
          tabOwnership.set(tabId, info);
        }
      }
    }
    if (Array.isArray(data?.agSessions)) {
      for (const [sid, raw] of data.agSessions) {
        if (sid && raw && typeof raw === "object") {
          sessionMeta.set(sid, {
            sessionId: sid,
            title: raw.title || "Antigravity",
            color: normalizeGroupColor(raw.color || "cyan"),
            groupsByWindow: new Map(Array.isArray(raw.groupsByWindow) ? raw.groupsByWindow : []),
          });
        }
      }
    }
  } catch {}
}

async function detectBrowserIdentity() {
  if (browserIdentityPromise) return browserIdentityPromise;
  browserIdentityPromise = (async () => {
    const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
    try {
      if (typeof navigator !== "undefined" && navigator.brave && typeof navigator.brave.isBrave === "function") {
        const isBrave = await navigator.brave.isBrave();
        if (isBrave) {
          return { browserFamily: "brave", browserName: "Brave", userAgent: ua };
        }
      }
    } catch {}
    if (/Edg\//.test(ua)) {
      return { browserFamily: "edge", browserName: "Microsoft Edge", userAgent: ua };
    }
    if (/OPR\//.test(ua)) {
      return { browserFamily: "opera", browserName: "Opera", userAgent: ua };
    }
    if (/Vivaldi/i.test(ua)) {
      return { browserFamily: "vivaldi", browserName: "Vivaldi", userAgent: ua };
    }
    return { browserFamily: "chrome", browserName: "Google Chrome", userAgent: ua };
  })();
  return browserIdentityPromise;
}

async function ensureOffscreenKeepalive() {
  try {
    if (!chrome.offscreen?.createDocument) return;
    if (chrome.offscreen.hasDocument) {
      const exists = await chrome.offscreen.hasDocument();
      if (exists) return;
    }
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "Maintain persistent Native Messaging bridge connection for Antigravity Computer Control.",
    });
  } catch {}
}

function sendNativeMessage(payload) {
  if (!nativePort) return false;
  try {
    nativePort.postMessage(payload);
    return true;
  } catch (err) {
    lastNativeError = err?.message || String(err);
    nativePort = null;
    scheduleReconnect();
    return false;
  }
}

function emitNotification(method, params) {
  sendNativeMessage({
    jsonrpc: "2.0",
    method,
    params,
  });
}

async function callNativeAgentRpc(method, params = {}, timeoutMs = 0) {
  if (!nativePort) {
    await connectNativeBridge();
  }
  if (!nativePort) {
    throw new Error(
      lastNativeError ||
        "Native Messaging host is disconnected. Run ./install.sh in antigravity-codex-computer-control and click Reconnect.",
    );
  }
  const id = `ext-rpc-${nextExtRpcId++}`;
  return new Promise((resolve, reject) => {
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        pendingNativeRpcs.delete(id);
        reject(new Error(`Native host request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
    pendingNativeRpcs.set(id, { resolve, reject, timer });
    const ok = sendNativeMessage({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });
    if (!ok) {
      if (timer) clearTimeout(timer);
      pendingNativeRpcs.delete(id);
      reject(new Error("Failed to send message over Native Messaging port"));
    }
  });
}

function scheduleReconnect(immediate = false) {
  if (nativePort) return;
  if (reconnectTimer) {
    if (!immediate) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const delay = immediate ? 50 : Math.min(15_000, 400 * Math.pow(1.7, Math.min(reconnectAttempt, 8)));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNativeBridge();
  }, delay);
}

async function connectNativeBridge() {
  if (nativePort) return true;
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    nativePort = port;
    lastNativeError = null;
    reconnectAttempt = 0;

    port.onMessage.addListener((msg) => {
      handleNativeIncoming(msg);
    });

    port.onDisconnect.addListener(() => {
      const errMsg = chrome.runtime.lastError?.message || "Native host disconnected";
      lastNativeError = errMsg;
      if (nativePort === port) {
        nativePort = null;
      }
      for (const [, pending] of pendingNativeRpcs.entries()) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(new Error(errMsg));
      }
      pendingNativeRpcs.clear();
      reconnectAttempt += 1;
      scheduleReconnect(false);
      buildPopupStatus().then((status) => broadcastToSidePanels({ type: "sidepanel:bridgeStatus", status }));
    });

    const ident = await detectBrowserIdentity();
    emitNotification("bridgeHello", {
      extensionId: chrome.runtime.id,
      version: chrome.runtime.getManifest?.()?.version || "3.0.0",
      ...ident,
      attachedTabIds: Array.from(attachedTabs),
    });
    buildPopupStatus().then((status) => broadcastToSidePanels({ type: "sidepanel:bridgeStatus", status }));
    return true;
  } catch (err) {
    lastNativeError = err?.message || String(err);
    nativePort = null;
    reconnectAttempt += 1;
    scheduleReconnect(false);
    return false;
  }
}

async function ensureDebuggerAttached(tabId) {
  const tid = Number(tabId);
  if (!Number.isInteger(tid) || tid <= 0) {
    throw new Error(`Invalid tabId for debugger attach: ${tabId}`);
  }
  try {
    const tabInfo = await chrome.tabs.get(tid);
    assertHostNotBlocked(tabInfo?.url || tabInfo?.pendingUrl || "");
  } catch (err) {
    if (err?.code === -32021) throw err;
  }
  if (attachedTabs.has(tid)) return { attached: true, alreadyAttached: true };
  if (pendingAttachByTab.has(tid)) {
    return pendingAttachByTab.get(tid);
  }
  const p = (async () => {
    try {
      await chrome.debugger.attach({ tabId: tid }, "1.3");
      attachedTabs.add(tid);
      buildPopupStatus().then((status) => broadcastToSidePanels({ type: "sidepanel:bridgeStatus", status }));
      return { attached: true, alreadyAttached: false };
    } catch (err) {
      const msg = err?.message || String(err);
      if (/Another debugger is already attached|already attached/i.test(msg)) {
        attachedTabs.add(tid);
        return { attached: true, alreadyAttached: true };
      }
      throw err;
    } finally {
      pendingAttachByTab.delete(tid);
    }
  })();
  pendingAttachByTab.set(tid, p);
  return p;
}

async function detachDebuggerSafe(tabId) {
  const tid = Number(tabId);
  if (!Number.isInteger(tid) || tid <= 0) return { detached: false };
  attachedTabs.delete(tid);
  for (const [sid, info] of childSessionMap.entries()) {
    if (info.tabId === tid) {
      childSessionMap.delete(sid);
      if (info.targetId && attachedChildTargets.has(info.targetId)) {
        attachedChildTargets.delete(info.targetId);
        try {
          await chrome.debugger.detach({ targetId: info.targetId });
        } catch {}
      }
    }
  }
  try {
    await chrome.debugger.detach({ tabId: tid });
    buildPopupStatus().then((status) => broadcastToSidePanels({ type: "sidepanel:bridgeStatus", status }));
    return { detached: true, tabId: tid };
  } catch {
    return { detached: false, tabId: tid };
  }
}

async function sendCdpCommand({ tabId, targetId, sessionId, method, params = {}, expressionCacheKey }) {
  if (!method || typeof method !== "string") {
    throw new Error("sendCdp requires a string CDP method");
  }
  let finalParams = params && typeof params === "object" ? { ...params } : {};
  if (expressionCacheKey) {
    const cachedExpr = expressionCache.get(expressionCacheKey);
    if (!cachedExpr) {
      const err = new Error(`Expression cache miss for key: ${expressionCacheKey}`);
      err.code = -32004;
      throw err;
    }
    if (method === "Runtime.evaluate") {
      finalParams.expression = cachedExpr;
    } else if (method === "Runtime.callFunctionOn") {
      finalParams.functionDeclaration = cachedExpr;
    }
  }

  if ((method === "Page.navigate" || method === "Target.createTarget") && finalParams.url) {
    assertHostNotBlocked(String(finalParams.url));
  }

  // Child OOPIF routing when sessionId or explicit child targetId is provided
  const childInfo = sessionId ? childSessionMap.get(sessionId) : null;
  const effectiveChildTargetId = targetId || childInfo?.targetId || null;

  if (effectiveChildTargetId) {
    if (childInfo?.targetInfo?.url) {
      assertHostNotBlocked(String(childInfo.targetInfo.url));
    }
    const checkParentTabId = Number(tabId ?? childInfo?.tabId);
    if (Number.isInteger(checkParentTabId) && checkParentTabId > 0) {
      try {
        const parentTab = await chrome.tabs.get(checkParentTabId);
        assertHostNotBlocked(parentTab?.url || parentTab?.pendingUrl || "");
      } catch (err) {
        if (err?.code === -32021) throw err;
      }
    }
    if (typeof chrome.debugger?.getTargets === "function") {
      try {
        const targets = await chrome.debugger.getTargets();
        const foundTarget = Array.isArray(targets)
          ? targets.find((t) => t?.id === effectiveChildTargetId)
          : null;
        if (foundTarget?.url) {
          assertHostNotBlocked(String(foundTarget.url));
        }
      } catch (err) {
        if (err?.code === -32021) throw err;
      }
    }
    try {
      if (!attachedChildTargets.has(effectiveChildTargetId)) {
        try {
          await chrome.debugger.attach({ targetId: effectiveChildTargetId }, "1.3");
          attachedChildTargets.add(effectiveChildTargetId);
        } catch (attachErr) {
          if (!/already attached/i.test(attachErr?.message || "")) {
            throw attachErr;
          }
          attachedChildTargets.add(effectiveChildTargetId);
        }
      }
      return await chrome.debugger.sendCommand({ targetId: effectiveChildTargetId }, method, finalParams);
    } catch (directErr) {
      // Fallback: tunnel via Target.sendMessageToTarget on parent tab if sessionId is known
      const parentTabId = tabId ?? childInfo?.tabId;
      if (sessionId && parentTabId) {
        await ensureDebuggerAttached(parentTabId);
        const msgId = nextTargetMsgId++;
        const rawPayload = JSON.stringify({ id: msgId, method, params: finalParams });
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingTargetMessages.delete(msgId);
            reject(new Error(`Timed out waiting for OOPIF Target response to ${method}`));
          }, 15_000);
          pendingTargetMessages.set(msgId, { resolve, reject, timer });
          chrome.debugger
            .sendCommand({ tabId: Number(parentTabId) }, "Target.sendMessageToTarget", {
              sessionId,
              message: rawPayload,
            })
            .catch((e) => {
              clearTimeout(timer);
              pendingTargetMessages.delete(msgId);
              reject(e);
            });
        });
      }
      throw directErr;
    }
  }

  const tid = Number(tabId);
  if (!Number.isInteger(tid) || tid <= 0) {
    throw new Error("sendCdp requires tabId or targetId");
  }
  try {
    const tabInfo = await chrome.tabs.get(tid);
    const tabHost = normalizeHostFromUrl(tabInfo?.url || tabInfo?.pendingUrl || "");
    if (tabHost && getSitePolicyForHost(tabHost) === "block") {
      const err = new Error(
        `Browser control is blocked on ${tabHost} by Antigravity in Chrome site permissions.`,
      );
      err.code = -32021;
      throw err;
    }
  } catch (err) {
    if (err?.code === -32021) throw err;
  }
  await ensureDebuggerAttached(tid);
  const cdpResult = await chrome.debugger.sendCommand({ tabId: tid }, method, finalParams);
  recordThrottledCdpActivity(tid, method, finalParams);
  return cdpResult;
}

function recordThrottledCdpActivity(tabId, method, params = {}) {
  const now = Date.now();
  const key = `${tabId}:${method}`;
  const prev = lastCdpActivityByKey.get(key) || 0;
  if (method === "Page.navigate") {
    lastCdpActivityByKey.set(key, now);
    recordBrowserActivity({
      kind: "navigate",
      title: "Navigated tab",
      detail: String(params.url || ""),
      tabId,
      source: "mcp",
    });
  } else if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") {
    if (now - prev < 400) return;
    lastCdpActivityByKey.set(key, now);
    recordBrowserActivity({
      kind: "click",
      title: `Clicked at (${Math.round(params.x || 0)}, ${Math.round(params.y || 0)})`,
      detail: `Tab #${tabId}`,
      tabId,
      source: "mcp",
    });
  } else if (method === "Input.insertText" && params.text) {
    if (now - prev < 400) return;
    lastCdpActivityByKey.set(key, now);
    recordBrowserActivity({
      kind: "type",
      title: "Typed into page",
      detail: `${String(params.text).length} chars · Tab #${tabId}`,
      tabId,
      source: "mcp",
    });
  } else if (method === "Page.captureScreenshot") {
    if (now - prev < 1200) return;
    lastCdpActivityByKey.set(key, now);
    recordBrowserActivity({
      kind: "screenshot",
      title: "Captured page screenshot",
      detail: `Tab #${tabId}`,
      tabId,
      source: "mcp",
    });
  }
}

async function buildAllTabsSnapshot() {
  const [tabs, groups] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabGroups?.query ? chrome.tabGroups.query({}) : Promise.resolve([]),
  ]);
  const groupMap = new Map();
  for (const g of groups) {
    groupMap.set(g.id, {
      id: g.id,
      title: g.title || "",
      color: g.color || "grey",
      collapsed: Boolean(g.collapsed),
      windowId: g.windowId,
    });
  }
  const NO_GROUP = chrome.tabGroups?.TAB_GROUP_ID_NONE ?? -1;
  return tabs.map((t) => {
    const gid = typeof t.groupId === "number" ? t.groupId : NO_GROUP;
    const tg = gid !== NO_GROUP ? groupMap.get(gid) || { id: gid, title: "", color: "grey", collapsed: false } : null;
    const own = tabOwnership.get(t.id) || null;
    return {
      tabId: t.id,
      windowId: t.windowId,
      index: t.index,
      active: Boolean(t.active),
      pinned: Boolean(t.pinned),
      audible: Boolean(t.audible),
      discarded: Boolean(t.discarded),
      status: t.status || "complete",
      groupId: gid,
      tabGroup: tg,
      title: t.title || "",
      url: t.url || t.pendingUrl || "",
      favIconUrl: t.favIconUrl || "",
      lastAccessed: t.lastAccessed || 0,
      attached: attachedTabs.has(t.id),
      ownership: own ? { sessionId: own.sessionId, role: own.role, createdByAgent: own.createdByAgent } : null,
    };
  });
}

async function addTabToSessionGroup(tab, session, { groupTitle, groupColor } = {}) {
  if (!chrome.tabs?.group || !chrome.tabGroups?.update) return null;
  const NO_GROUP = chrome.tabGroups.TAB_GROUP_ID_NONE ?? -1;
  const title = groupTitle != null ? String(groupTitle) : session.title || "Antigravity";
  const color = normalizeGroupColor(groupColor || session.color || "cyan");
  session.title = title;
  session.color = color;

  let existingGroupId = session.groupsByWindow.get(tab.windowId);
  if (existingGroupId != null && existingGroupId !== NO_GROUP) {
    try {
      await chrome.tabGroups.get(existingGroupId);
    } catch {
      existingGroupId = null;
      session.groupsByWindow.delete(tab.windowId);
    }
  }

  let groupId;
  if (existingGroupId != null) {
    groupId = await chrome.tabs.group({ groupId: existingGroupId, tabIds: [tab.id] });
  } else {
    groupId = await chrome.tabs.group({
      createProperties: { windowId: tab.windowId },
      tabIds: [tab.id],
    });
    session.groupsByWindow.set(tab.windowId, groupId);
  }
  const updatedGroup = await chrome.tabGroups.update(groupId, { title, color });
  return {
    id: updatedGroup.id,
    title: updatedGroup.title || title,
    color: updatedGroup.color || color,
    collapsed: Boolean(updatedGroup.collapsed),
  };
}

/**
 * Extract clean readable page context via `chrome.scripting.executeScript` (ZERO debugger banner!).
 */
async function extractReadableTabContext(tabId, { maxChars = 14000, ignoreSitePolicy = false } = {}) {
  const tid = Number(tabId);
  if (!Number.isInteger(tid) || tid <= 0) return null;
  let tab;
  try {
    tab = await chrome.tabs.get(tid);
  } catch {
    return null;
  }
  const rawUrl = tab.url || tab.pendingUrl || "";
  const host = normalizeHostFromUrl(rawUrl);
  const sitePolicy = getSitePolicyForHost(host);
  const baseMeta = {
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title || "",
    url: rawUrl,
    host,
    sitePolicy,
    blockedBySitePolicy: false,
    readable: false,
    selection: "",
    metaDescription: "",
    headings: [],
    linksCount: 0,
    buttonsCount: 0,
    inputsCount: 0,
    text: "",
    truncated: false,
  };
  if (!ignoreSitePolicy && sitePolicy === "block") {
    return { ...baseMeta, blockedBySitePolicy: true };
  }
  if (!isSafeInjectableUrl(rawUrl) || !chrome.scripting?.executeScript) {
    return baseMeta;
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tid },
      args: [maxChars],
      func: (limit) => {
        const selection = (window.getSelection?.()?.toString() || "").trim().slice(0, 4000);
        const metaEl =
          document.querySelector('meta[name="description"]') ||
          document.querySelector('meta[property="og:description"]');
        const metaDescription = (metaEl?.getAttribute("content") || "").trim().slice(0, 600);
        const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
          .map((h) => (h.innerText || h.textContent || "").replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .slice(0, 20);
        const root = document.querySelector("main, article, [role='main']") || document.body;
        const rawText = (root?.innerText || document.body?.innerText || "")
          .replace(/\r/g, "")
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        return {
          title: document.title || "",
          url: location.href,
          selection,
          metaDescription,
          headings,
          linksCount: document.querySelectorAll("a[href]").length,
          buttonsCount: document.querySelectorAll("button, [role='button']").length,
          inputsCount: document.querySelectorAll("input, textarea, select").length,
          text: rawText.slice(0, limit),
          truncated: rawText.length > limit,
        };
      },
    });
    const extracted = results?.[0]?.result;
    if (extracted && typeof extracted === "object") {
      return {
        ...baseMeta,
        ...extracted,
        host: normalizeHostFromUrl(extracted.url || rawUrl) || host,
        sitePolicy: getSitePolicyForHost(normalizeHostFromUrl(extracted.url || rawUrl) || host),
        readable: true,
      };
    }
  } catch {}
  return baseMeta;
}

async function captureVisibleTabPng(windowId = null) {
  if (!chrome.tabs?.captureVisibleTab) {
    throw new Error("Tab screenshot capture is unavailable in this context.");
  }
  const dataUrl =
    typeof windowId === "number" && windowId >= 0
      ? await chrome.tabs.captureVisibleTab(windowId, { format: "png" })
      : await chrome.tabs.captureVisibleTab({ format: "png" });
  const prefix = "data:image/png;base64,";
  const base64 = dataUrl.startsWith(prefix) ? dataUrl.slice(prefix.length) : dataUrl.split(",")[1] || "";
  return {
    dataUrl,
    base64,
    mimeType: "image/png",
  };
}

function formatTabContextSection(label, ctx, _browserFamily) {
  if (!ctx) return "";
  const mcpTabId = `ext-tab-${ctx.tabId}`;
  const lines = [
    `### ${sanitizeForContextEnvelope(label)}`,
    `- Title: ${sanitizeForContextEnvelope(ctx.title || "(Untitled)")}`,
    `- URL: ${sanitizeForContextEnvelope(ctx.url || "(empty)")}`,
    `- Browser Tab ID (pass as \`tab_id\` to computer-use MCP): \`${mcpTabId}\` (numeric tabId: ${ctx.tabId}, windowId: ${ctx.windowId})`,
  ];
  if (ctx.metaDescription) {
    lines.push(`- Meta Description: ${sanitizeForContextEnvelope(ctx.metaDescription)}`);
  }
  if (ctx.selection) {
    lines.push(`- Highlighted Selection on Page:\n"""\n${sanitizeForContextEnvelope(ctx.selection)}\n"""`);
  }
  if (Array.isArray(ctx.headings) && ctx.headings.length > 0) {
    lines.push(`- Key Headings: ${sanitizeForContextEnvelope(ctx.headings.slice(0, 12).join(" | "))}`);
  }
  if (ctx.readable && ctx.text) {
    lines.push(
      `- Visible Page Content${ctx.truncated ? " (excerpt)" : ""}:\n\`\`\`text\n${sanitizeForContextEnvelope(ctx.text)}\n\`\`\``,
    );
  }
  return lines.join("\n");
}

function formatPickedElementSection(el, idx = 1) {
  if (!el || typeof el !== "object") return "";
  const selector = sanitizeForContextEnvelope(el.selector || el.tagName || "element");
  const pageUrl = el.url || el.pageUrl || "";
  const pageTitle = el.title || el.pageTitle || "";
  const lines = [
    `### Picked Webpage Element #${idx}: \`${selector}\``,
    `- Tag: \`<${sanitizeForContextEnvelope(el.tagName || "div")}>\`` +
      (el.role ? ` · Role: \`${sanitizeForContextEnvelope(el.role)}\`` : "") +
      (el.label ? ` · Label: "${sanitizeForContextEnvelope(el.label)}"` : ""),
  ];
  if (pageTitle || pageUrl) {
    lines.push(
      `- Page: ${pageTitle ? `"${sanitizeForContextEnvelope(pageTitle)}" ` : ""}${pageUrl ? `(${sanitizeForContextEnvelope(pageUrl)})` : ""}`.trim(),
    );
  }
  if (pageUrl) {
    lines.push(`- Page URL: ${sanitizeForContextEnvelope(pageUrl)}`);
  }
  if (el.rect && typeof el.rect === "object") {
    lines.push(
      `- Bounding Box: x=${Number(el.rect.x || 0)}, y=${Number(el.rect.y || 0)}, width=${Number(el.rect.width || 0)}px, height=${Number(el.rect.height || 0)}px`,
    );
  }
  if (el.styles && typeof el.styles === "object") {
    const stylePairs = Object.entries(el.styles)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`)
      .join("; ");
    if (stylePairs) {
      lines.push(`- Computed Styles: \`${sanitizeForContextEnvelope(stylePairs)}\``);
    }
  }
  if (el.text) {
    lines.push(`- Element Text:\n"""\n${sanitizeForContextEnvelope(String(el.text).slice(0, 400))}\n"""`);
  }
  if (el.htmlSnippet) {
    lines.push(
      `- DOM OuterHTML Snippet:\n\`\`\`html\n${sanitizeForContextEnvelope(String(el.htmlSnippet).slice(0, 800))}\n\`\`\``,
    );
  }
  return lines.join("\n");
}

function handleAgentStreamEvent(params = {}) {
  const { event, requestId, sessionId, update } = params;
  const turn = requestId ? activeTurnByRequest.get(requestId) : null;

  if (event === "session_created" && sessionId) {
    if (turn) {
      turn.sessionId = sessionId;
      const now = Date.now();
      const record = {
        sessionId,
        title: turn.initialTitle || "New Browser Chat",
        createdAt: now,
        updatedAt: now,
        interactionMode: turn.interactionMode || "chat",
        permissionMode: turn.permissionMode || "auto",
        modelId: turn.modelId || "",
        cwd: turn.cwd || "",
        originUrl: turn.originUrl || "",
        originTitle: turn.originTitle || "",
        scheduledTaskName: turn.scheduledTaskName || null,
        messages: [
          {
            role: "user",
            text: turn.userText,
            attachments: turn.attachments || [],
            ts: now,
          },
          turn.assistantMsg,
        ],
      };
      chromeSessions.set(sessionId, record);
      schedulePersistChromeSessions();
    }
  } else if (event === "session_update" && sessionId && update) {
    const rec = chromeSessions.get(sessionId);
    if (rec) {
      rec.updatedAt = Date.now();
      if (update.sessionUpdate === "session_info_update" && update.title) {
        rec.title = update.title;
        schedulePersistChromeSessions();
      }
      const targetMsg = turn?.assistantMsg || rec.messages?.[rec.messages.length - 1];
      if (targetMsg && targetMsg.role === "assistant") {
        if (update.sessionUpdate === "agent_message_chunk" && update.content?.text) {
          targetMsg.text = (targetMsg.text || "") + update.content.text;
        } else if (update.sessionUpdate === "agent_thought_chunk" && update.content?.text) {
          targetMsg.thoughts = (targetMsg.thoughts || "") + update.content.text;
        } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
          if (!Array.isArray(targetMsg.toolCalls)) targetMsg.toolCalls = [];
          const existing = targetMsg.toolCalls.find((tc) => tc.toolCallId === update.toolCallId);
          if (existing) {
            if (update.status) existing.status = update.status;
            if (update.title) existing.title = update.title;
          } else {
            const toolTitle = update.title || update.name || "Tool";
            targetMsg.toolCalls.push({
              toolCallId: update.toolCallId,
              name: update.name || "tool",
              title: toolTitle,
              status: update.status || "in_progress",
              kind: update.kind || "other",
            });
            recordBrowserActivity({
              kind: "tool",
              title: toolTitle,
              detail: update.name || "agent tool",
              source: "sidepanel",
            });
          }
        }
        schedulePersistChromeSessions();
      }
    }
  }

  broadcastToSidePanels({
    type: "sidepanel:agentEvent",
    payload: params,
  });
}

async function checkTabSiteAccessOrPrompt(tabId, confirmedHostsSet) {
  if (!tabId) return null;
  let tab;
  try {
    tab = await chrome.tabs.get(Number(tabId));
  } catch {
    return null;
  }
  const rawUrl = tab.url || tab.pendingUrl || "";
  const host = normalizeHostFromUrl(rawUrl);
  if (!host) return null;
  const policy = getSitePolicyForHost(host);
  if (policy === "block") {
    const err = new Error(
      `Site access is blocked for ${host}. Change Site Access to Allow or Ask every time to let Antigravity read or act on this site.`,
    );
    err.code = -32021;
    throw err;
  }
  if (policy === "ask" && !isHostConfirmedForSession(host, confirmedHostsSet)) {
    return {
      ok: false,
      code: -32020,
      requiresSiteConfirmation: true,
      host,
      url: rawUrl,
      title: tab.title || host,
      error: `Antigravity needs your permission to access ${host}.`,
    };
  }
  return null;
}

async function runSidePanelPrompt({
  requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  sessionId = null,
  userText = "",
  interactionMode = "chat",
  permissionMode = "auto",
  autoApprovePermissions = false,
  modelId = null,
  thoughtLevel = null,
  includeActiveTab = true,
  activeTabId = null,
  includeSelection = true,
  selectionOverride = null,
  mentionedTabIds = [],
  pickedElements = [],
  screenshotBase64 = null,
  attachedFiles = [],
  cwd = null,
  customInstructions = null,
  siteAccessConfirmedHosts = [],
  scheduledTaskName = null,
} = {}) {
  await ensureLocalStateLoaded();
  const ident = await detectBrowserIdentity();
  const browserFamily = ident.browserFamily || "chrome";

  // Verify existing Chrome session if resuming
  if (sessionId && !chromeSessions.has(sessionId)) {
    const err = new Error(
      "Conversations created in the Antigravity Desktop App cannot be opened in Antigravity in Chrome. Start a new chat here to view it in both Chrome and the Desktop App.",
    );
    err.code = -32010;
    throw err;
  }

  const confirmedHostsSet = new Set(
    (Array.isArray(siteAccessConfirmedHosts) ? siteAccessConfirmedHosts : [])
      .map((h) => normalizeSiteHost(h))
      .filter(Boolean),
  );

  let resolvedActiveTabId = activeTabId;
  if ((includeActiveTab || interactionMode === "agent") && !resolvedActiveTabId) {
    try {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (active?.id) resolvedActiveTabId = active.id;
    } catch {}
  }

  if ((includeActiveTab || interactionMode === "agent") && resolvedActiveTabId) {
    const gate = await checkTabSiteAccessOrPrompt(resolvedActiveTabId, confirmedHostsSet);
    if (gate) return gate;
  }

  const uniqueMentions = Array.from(
    new Set((mentionedTabIds || []).map(Number).filter((n) => n > 0 && n !== resolvedActiveTabId)),
  );
  for (const mTabId of uniqueMentions.slice(0, 6)) {
    const gate = await checkTabSiteAccessOrPrompt(mTabId, confirmedHostsSet);
    if (gate) return gate;
  }

  const contextSections = [];
  const attachments = [];
  let originUrl = "";
  let originTitle = "";

  if (includeActiveTab && resolvedActiveTabId) {
    const activeCtx = await extractReadableTabContext(resolvedActiveTabId, { maxChars: 14_000 });
    if (activeCtx) {
      originUrl = activeCtx.url || "";
      originTitle = activeCtx.title || "";
      if (includeSelection === false) {
        activeCtx.selection = "";
      } else if (typeof selectionOverride === "string" && selectionOverride.trim()) {
        activeCtx.selection = selectionOverride.trim().slice(0, 4000);
      }
      attachments.push({
        kind: "active-tab",
        tabId: activeCtx.tabId,
        title: activeCtx.title || activeCtx.url || `Tab #${activeCtx.tabId}`,
        url: activeCtx.url || "",
      });
      if (activeCtx.selection) {
        attachments.push({
          kind: "selection",
          label: "Selection",
          preview: activeCtx.selection.slice(0, 140),
        });
      }
      contextSections.push(formatTabContextSection("Active Webpage Tab", activeCtx, browserFamily));
    }
  } else if (includeSelection !== false && typeof selectionOverride === "string" && selectionOverride.trim()) {
    const trimmedSel = selectionOverride.trim().slice(0, 4000);
    attachments.push({
      kind: "selection",
      label: "Selection",
      preview: trimmedSel.slice(0, 140),
    });
    contextSections.push(`### Highlighted Webpage Selection\n"""\n${sanitizeForContextEnvelope(trimmedSel)}\n"""`);
  }

  for (const mTabId of uniqueMentions.slice(0, 6)) {
    const mCtx = await extractReadableTabContext(mTabId, { maxChars: 8_000 });
    if (mCtx) {
      attachments.push({
        kind: "mentioned-tab",
        tabId: mCtx.tabId,
        title: mCtx.title || mCtx.url || `Tab #${mCtx.tabId}`,
        url: mCtx.url || "",
      });
      contextSections.push(formatTabContextSection(`@-Mentioned Tab (#${mCtx.tabId})`, mCtx, browserFamily));
    }
  }

  if (Array.isArray(pickedElements) && pickedElements.length > 0) {
    let pickIdx = 1;
    for (const el of pickedElements.slice(0, 8)) {
      if (!el || typeof el !== "object") continue;
      const selector = String(el.selector || el.tagName || "element").slice(0, 140);
      attachments.push({
        kind: "element",
        selector,
        label: String(el.label || selector).slice(0, 96),
        tagName: String(el.tagName || "div").toLowerCase(),
      });
      const section = formatPickedElementSection(el, pickIdx++);
      if (section) contextSections.push(section);
    }
  }

  if (screenshotBase64) {
    attachments.push({ kind: "screenshot", label: "Tab Screenshot" });
  }

  const promptBlocks = [];
  if (screenshotBase64) {
    promptBlocks.push({
      type: "image",
      data: screenshotBase64,
      mimeType: "image/png",
    });
  }

  if (Array.isArray(attachedFiles)) {
    for (const fileItem of attachedFiles.slice(0, 8)) {
      if (!fileItem || typeof fileItem !== "object") continue;
      const fileName = String(fileItem.name || "attachment").slice(0, 180);
      const mimeType = String(fileItem.mimeType || "application/octet-stream");
      const isImage = fileItem.kind === "image" || mimeType.startsWith("image/");
      if (isImage && typeof fileItem.base64 === "string" && fileItem.base64.length > 0) {
        promptBlocks.push({
          type: "image",
          data: fileItem.base64,
          mimeType: mimeType.startsWith("image/") ? mimeType : "image/png",
        });
        attachments.push({
          kind: "image",
          label: fileName,
          mimeType,
        });
      } else if (typeof fileItem.textContent === "string" && fileItem.textContent.length > 0) {
        const clipped = sanitizeForContextEnvelope(fileItem.textContent.slice(0, 32_000));
        const truncatedSuffix = fileItem.textContent.length > 32_000 ? "\n...[truncated]..." : "";
        const safeName = sanitizeForContextEnvelope(fileName);
        contextSections.push(
          `### Attached Local File: ${safeName} (${sanitizeForContextEnvelope(mimeType)})\n<attached_file name="${safeName.replace(/"/g, "'")}">\n${clipped}${truncatedSuffix}\n</attached_file>`,
        );
        attachments.push({
          kind: "file",
          label: fileName,
          mimeType,
          size: Number(fileItem.size || fileItem.textContent.length),
        });
      }
    }
  }

  const modeBanner =
    interactionMode === "agent"
      ? `[Interaction Mode: Agent / Browser Control — Call call_mcp_tool(ServerName: "computer-use", ToolName: "browser_tab_state" | "browser_tab_action" | "browser_open_tab" | "browser_manage", Arguments: { tab_id: "ext-tab-...", ... }) directly to inspect and act on the live ${ident.browserName} browser without reading JSON schema files first.]`
      : `[Interaction Mode: Chat / Read-Only — Answer directly using the live page/tab context below without mutating browser tabs unless asked to switch to Agent Mode.]`;

  const contextEnvelope = `<browser_sidepanel_context>\n${modeBanner}${
    contextSections.length > 0 ? `\n\n${contextSections.join("\n\n")}` : ""
  }\n</browser_sidepanel_context>\n\n`;

  const cleanText = String(userText || "").trim();
  const fullPromptText = `${contextEnvelope}${cleanText}`;

  promptBlocks.push({
    type: "text",
    text: fullPromptText,
  });

  const assistantMsg = {
    role: "assistant",
    text: "",
    thoughts: "",
    toolCalls: [],
    ts: Date.now(),
  };

  const initialTitle =
    scheduledTaskName
      ? `🕒 ${scheduledTaskName}`
      : cleanText.replace(/\s+/g, " ").slice(0, 64) || originTitle || "Browser Chat";

  const effectiveCwd = String(cwd ?? extensionSettings.cwd ?? "").trim() || null;
  const effectiveInstructions = String(customInstructions ?? extensionSettings.customInstructions ?? "").trim() || null;

  const now = Date.now();
  if (sessionId && chromeSessions.has(sessionId)) {
    const rec = chromeSessions.get(sessionId);
    rec.updatedAt = now;
    rec.interactionMode = interactionMode;
    rec.permissionMode = permissionMode;
    if (modelId) rec.modelId = modelId;
    if (effectiveCwd) rec.cwd = effectiveCwd;
    if (!Array.isArray(rec.messages)) rec.messages = [];
    rec.messages.push(
      {
        role: "user",
        text: cleanText,
        attachments,
        ts: now,
      },
      assistantMsg,
    );
    schedulePersistChromeSessions();
  }

  activeTurnByRequest.set(requestId, {
    requestId,
    sessionId,
    userText: cleanText,
    attachments,
    initialTitle,
    interactionMode,
    permissionMode,
    modelId: modelId || "",
    cwd: effectiveCwd || "",
    originUrl,
    originTitle,
    scheduledTaskName,
    assistantMsg,
  });

  if (interactionMode === "agent") {
    recordBrowserActivity({
      kind: "agent",
      title: "Started Agent turn",
      detail: cleanText.slice(0, 96) || originTitle || "Browser task",
      tabId: resolvedActiveTabId || null,
      source: "sidepanel",
    });
  }

  const normPerm = String(permissionMode || extensionSettings.defaultApprovalMode || "auto").toLowerCase();
  const effectiveModeId = normPerm === "ask" || normPerm === "default" ? "default" : "auto";
  const effectiveAutoApprove =
    normPerm === "full" ? true : normPerm === "ask" || normPerm === "default" ? false : Boolean(autoApprovePermissions);

  try {
    const res = await callNativeAgentRpc("agent.prompt", {
      requestId,
      sessionId,
      promptBlocks,
      modeId: effectiveModeId,
      permissionMode: normPerm,
      modelId: modelId || null,
      thoughtLevel: thoughtLevel || null,
      autoApprovePermissions: effectiveAutoApprove,
      cwd: effectiveCwd,
      systemPromptAppend: effectiveInstructions,
    });
    const finalSessionId = res?.sessionId || sessionId;
    if (finalSessionId && chromeSessions.has(finalSessionId)) {
      const rec = chromeSessions.get(finalSessionId);
      if (res?.title) rec.title = res.title;
      rec.updatedAt = Date.now();
      await flushChromeSessionsNow();
    }
    broadcastToSidePanels({
      type: "sidepanel:sessionsUpdated",
      sessions: getChromeSessionsSummaryList(),
    });
    return {
      ok: true,
      requestId,
      sessionId: finalSessionId,
      title: res?.title || chromeSessions.get(finalSessionId)?.title || initialTitle,
      stopReason: res?.stopReason || "end_turn",
      usage: res?.usage || null,
    };
  } finally {
    activeTurnByRequest.delete(requestId);
  }
}

// Codex in Chrome parity: "Record a browser demonstration" -> reusable /shortcut skill
async function injectRecorderIntoTab(tabId) {
  const tid = Number(tabId);
  if (!Number.isInteger(tid) || tid <= 0 || !chrome.scripting?.executeScript) return false;
  let tab;
  try {
    tab = await chrome.tabs.get(tid);
  } catch {
    return false;
  }
  const url = tab.url || tab.pendingUrl || "";
  if (!isSafeInjectableUrl(url) || getSitePolicyForUrl(url) === "block") return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => {
        if (typeof window.__agDemoRecorderCleanup === "function") {
          window.__agDemoRecorderCleanup();
        }
        const describeEl = (el) => {
          if (!el || !el.tagName) return { selector: "page", label: "page" };
          const tag = el.tagName.toLowerCase();
          const aria = (el.getAttribute?.("aria-label") || "").trim();
          const placeholder = (el.getAttribute?.("placeholder") || "").trim();
          const name = (el.getAttribute?.("name") || "").trim();
          const id = (el.id || "").trim();
          const role = (el.getAttribute?.("role") || "").trim();
          const text = ((el.innerText || el.value || "").replace(/\s+/g, " ").trim() || "").slice(0, 60);
          const label = aria || text || placeholder || name || (id ? `#${id}` : tag);
          let selector = tag;
          if (id) selector = `${tag}#${id}`;
          else if (aria) selector = `${tag}[aria-label="${aria.replace(/"/g, "'").slice(0, 48)}"]`;
          else if (name) selector = `${tag}[name="${name.replace(/"/g, "'").slice(0, 48)}"]`;
          else if (role) selector = `${tag}[role="${role}"]`;
          return { selector, label: label.slice(0, 72) };
        };
        const isSensitiveInput = (el) => {
          if (!el) return false;
          const type = String(el.type || "").toLowerCase();
          const ac = String(el.autocomplete || "").toLowerCase();
          const nm = String(el.name || el.id || "").toLowerCase();
          if (type === "password") return true;
          if (/password|passwd|secret|token|cvv|cvc|cc-number|cc-csc/.test(`${ac} ${nm}`)) return true;
          return false;
        };
        const badge = document.createElement("div");
        badge.id = "__ag-demo-recorder-pill";
        badge.style.cssText =
          "position:fixed;top:12px;right:12px;z-index:2147483647;display:flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;background:rgba(19,19,20,0.92);backdrop-filter:blur(12px);border:1px solid rgba(242,139,130,0.45);color:#E3E3E3;font:600 12px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;box-shadow:0 8px 24px rgba(0,0,0,0.36);pointer-events:none;";
        const dotEl = document.createElement("span");
        dotEl.style.cssText = "width:8px;height:8px;border-radius:50%;background:#EA4335;box-shadow:0 0 8px #EA4335;";
        const labelEl = document.createElement("span");
        labelEl.textContent = "Recording workflow · Antigravity";
        badge.appendChild(dotEl);
        badge.appendChild(labelEl);
        document.documentElement.appendChild(badge);

        const resolveEventTarget = (ev) => {
          const raw = (typeof ev.composedPath === "function" && ev.composedPath()[0]) || ev.target;
          return raw && raw.nodeType === 1 ? raw : ev.target;
        };
        const onClick = (ev) => {
          const baseTarget = resolveEventTarget(ev);
          const target =
            baseTarget?.closest?.("button, a, input, select, textarea, [role='button'], [role='tab'], [role='menuitem'], label") ||
            baseTarget;
          const info = describeEl(target);
          try {
            chrome.runtime.sendMessage({
              type: "recorder:step",
              step: {
                kind: "click",
                selector: info.selector,
                label: info.label,
                url: location.href,
                title: document.title,
              },
            });
          } catch {}
        };
        const onChange = (ev) => {
          const target = resolveEventTarget(ev);
          if (!target || !/^(INPUT|TEXTAREA|SELECT)$/i.test(target.tagName || "")) return;
          const info = describeEl(target);
          const redacted = isSensitiveInput(target);
          const rawVal = target.type === "checkbox" || target.type === "radio" ? String(Boolean(target.checked)) : String(target.value || "");
          try {
            chrome.runtime.sendMessage({
              type: "recorder:step",
              step: {
                kind: "input",
                inputType: String(target.type || "text").toLowerCase(),
                selector: info.selector,
                label: info.label,
                value: redacted ? "[REDACTED]" : rawVal.slice(0, 160),
                redacted,
                url: location.href,
                title: document.title,
              },
            });
          } catch {}
        };
        const onKeyDown = (ev) => {
          if (ev.key !== "Enter") return;
          const info = describeEl(ev.target);
          try {
            chrome.runtime.sendMessage({
              type: "recorder:step",
              step: {
                kind: "keypress",
                key: "Enter",
                selector: info.selector,
                label: info.label,
                url: location.href,
                title: document.title,
              },
            });
          } catch {}
        };

        document.addEventListener("click", onClick, true);
        document.addEventListener("change", onChange, true);
        document.addEventListener("keydown", onKeyDown, true);
        window.__agDemoRecorderCleanup = () => {
          document.removeEventListener("click", onClick, true);
          document.removeEventListener("change", onChange, true);
          document.removeEventListener("keydown", onKeyDown, true);
          badge.remove();
          delete window.__agDemoRecorderCleanup;
        };
      },
    });
    return true;
  } catch {
    return false;
  }
}

async function removeRecorderFromTab(tabId) {
  const tid = Number(tabId);
  if (!Number.isInteger(tid) || tid <= 0 || !chrome.scripting?.executeScript) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => {
        if (typeof window.__agDemoRecorderCleanup === "function") {
          window.__agDemoRecorderCleanup();
        } else {
          document.getElementById("__ag-demo-recorder-pill")?.remove();
        }
      },
    });
  } catch {}
}

// Codex in Chrome parity: Interactive Webpage Element Picker (Trusted-Types-safe, zero debugger banner)
async function injectElementPickerIntoTab(tabId) {
  const tid = Number(tabId);
  if (!Number.isInteger(tid) || tid <= 0 || !chrome.scripting?.executeScript) return false;
  let tab;
  try {
    tab = await chrome.tabs.get(tid);
  } catch {
    return false;
  }
  const url = tab.url || tab.pendingUrl || "";
  if (!isSafeInjectableUrl(url) || getSitePolicyForUrl(url) === "block") return false;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => {
        if (typeof window.__agElementPickerCleanup === "function") {
          window.__agElementPickerCleanup();
        }

        const cssIdent = (s) => String(s || "").replace(/[^a-zA-Z0-9_-]/g, "");
        const buildSelector = (el) => {
          if (!el || !el.tagName) return "body";
          const parts = [];
          let cur = el;
          let depth = 0;
          while (cur && cur.nodeType === 1 && depth < 3) {
            const tag = cur.tagName.toLowerCase();
            if (tag === "html" || tag === "body") break;
            if (cur.id) {
              const safeId = cssIdent(cur.id);
              parts.unshift(safeId ? `${tag}#${safeId}` : tag);
              break;
            }
            const testId = cur.getAttribute?.("data-testid") || cur.getAttribute?.("data-test");
            if (testId) {
              parts.unshift(`${tag}[data-testid="${String(testId).replace(/"/g, "'").slice(0, 48)}"]`);
              break;
            }
            const aria = (cur.getAttribute?.("aria-label") || "").trim();
            if (aria && depth === 0) {
              parts.unshift(`${tag}[aria-label="${aria.replace(/"/g, "'").slice(0, 40)}"]`);
              break;
            }
            const cls = Array.from(cur.classList || [])
              .map(cssIdent)
              .filter((c) => c && c.length < 36)
              .slice(0, 2);
            parts.unshift(cls.length > 0 ? `${tag}.${cls.join(".")}` : tag);
            cur = cur.parentElement;
            depth++;
          }
          return parts.join(" > ") || el.tagName.toLowerCase();
        };

        const isSensitive = (el) => {
          if (!el) return false;
          const type = String(el.type || "").toLowerCase();
          const ac = String(el.autocomplete || "").toLowerCase();
          const nm = String(el.name || el.id || "").toLowerCase();
          if (type === "password") return true;
          return /password|passwd|secret|token|cvv|cvc|cc-number|cc-csc/.test(`${ac} ${nm}`);
        };

        const root = document.createElement("div");
        root.id = "__ag-element-picker-root";
        root.style.cssText =
          "position:fixed;inset:0;z-index:2147483646;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;";

        const banner = document.createElement("div");
        banner.style.cssText =
          "position:fixed;top:14px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:8px;padding:7px 14px;border-radius:999px;background:rgba(19,19,20,0.94);border:1px solid rgba(168,199,250,0.38);color:#E3E3E3;font-size:12px;font-weight:500;box-shadow:0 8px 28px rgba(0,0,0,0.38);backdrop-filter:blur(12px);pointer-events:none;";
        const spark = document.createElement("span");
        spark.style.cssText =
          "width:8px;height:8px;border-radius:50%;background:#4285F4;box-shadow:0 0 8px rgba(66,133,244,0.8);";
        const bannerText = document.createElement("span");
        bannerText.textContent = "Click any element to attach to Antigravity · Esc to cancel";
        banner.appendChild(spark);
        banner.appendChild(bannerText);

        const box = document.createElement("div");
        box.style.cssText =
          "position:fixed;display:none;border:2px solid #4285F4;background:rgba(66,133,244,0.12);border-radius:6px;box-sizing:border-box;transition:all 45ms ease-out;pointer-events:none;";

        const tagPill = document.createElement("div");
        tagPill.style.cssText =
          "position:fixed;display:none;padding:3px 8px;border-radius:6px;background:#131314;border:1px solid rgba(168,199,250,0.35);color:#A8C7FA;font:600 11px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;max-width:340px;overflow:hidden;text-overflow:ellipsis;box-shadow:0 4px 14px rgba(0,0,0,0.35);pointer-events:none;";

        root.appendChild(box);
        root.appendChild(tagPill);
        root.appendChild(banner);
        document.documentElement.appendChild(root);

        const prevCursor = document.documentElement.style.cursor;
        document.documentElement.style.cursor = "crosshair";

        let hoveredEl = null;

        const onMouseMove = (ev) => {
          const rawTarget = (typeof ev.composedPath === "function" && ev.composedPath()[0]) || ev.target;
          const target = rawTarget && rawTarget.nodeType === 1 ? rawTarget : ev.target;
          if (!target || target.nodeType !== 1 || root.contains(target)) return;
          hoveredEl = target;
          const r = target.getBoundingClientRect();
          box.style.display = "block";
          box.style.left = `${Math.round(r.left)}px`;
          box.style.top = `${Math.round(r.top)}px`;
          box.style.width = `${Math.max(2, Math.round(r.width))}px`;
          box.style.height = `${Math.max(2, Math.round(r.height))}px`;

          const sel = buildSelector(target);
          tagPill.textContent = `${sel} · ${Math.round(r.width)}×${Math.round(r.height)}`;
          tagPill.style.display = "block";
          const pillTop = r.top > 30 ? r.top - 26 : Math.min(window.innerHeight - 28, r.bottom + 6);
          const pillLeft = Math.max(8, Math.min(window.innerWidth - 260, r.left));
          tagPill.style.top = `${Math.round(pillTop)}px`;
          tagPill.style.left = `${Math.round(pillLeft)}px`;
        };

        const cleanup = () => {
          document.removeEventListener("mousemove", onMouseMove, true);
          document.removeEventListener("click", onClick, true);
          document.removeEventListener("mousedown", swallowPointer, true);
          document.removeEventListener("mouseup", swallowPointer, true);
          document.removeEventListener("keydown", onKeyDown, true);
          document.documentElement.style.cursor = prevCursor;
          root.remove();
          delete window.__agElementPickerCleanup;
        };

        const swallowPointer = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
        };

        const onClick = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          ev.stopImmediatePropagation?.();
          const rawTarget = (typeof ev.composedPath === "function" && ev.composedPath()[0]) || ev.target;
          const el = hoveredEl || (rawTarget && rawTarget.nodeType === 1 ? rawTarget : ev.target);
          if (!el || el.nodeType !== 1) {
            cleanup();
            return;
          }
          const r = el.getBoundingClientRect();
          const selector = buildSelector(el);
          const aria = (el.getAttribute?.("aria-label") || "").trim();
          const placeholder = (el.getAttribute?.("placeholder") || "").trim();
          const alt = (el.getAttribute?.("alt") || "").trim();
          const sensitive = isSensitive(el);
          const rawText = sensitive
            ? "[REDACTED]"
            : ((el.innerText || el.value || "").replace(/\s+/g, " ").trim() || "").slice(0, 320);
          const label = (aria || alt || placeholder || rawText || selector).slice(0, 96);
          let htmlSnippet = "";
          try {
            const clone = el.cloneNode(true);
            if (clone.querySelectorAll) {
              for (const inp of clone.querySelectorAll("input[type='password'], input[name*='secret'], input[name*='token']")) {
                inp.setAttribute("value", "[REDACTED]");
              }
            }
            if (sensitive && clone.setAttribute) {
              clone.setAttribute("value", "[REDACTED]");
            }
            htmlSnippet = String(clone.outerHTML || "").replace(/\s+/g, " ").trim().slice(0, 700);
          } catch {}

          let styles = {};
          try {
            const cs = window.getComputedStyle(el);
            styles = {
              display: cs.display || "",
              position: cs.position || "",
              color: cs.color || "",
              backgroundColor: cs.backgroundColor || "",
              fontSize: cs.fontSize || "",
              borderRadius: cs.borderRadius || "",
            };
          } catch {}

          const payload = {
            tagName: el.tagName.toLowerCase(),
            selector,
            label,
            role: (el.getAttribute?.("role") || "").trim(),
            id: el.id || "",
            classes: Array.from(el.classList || []).slice(0, 8),
            rect: {
              x: Math.round(r.left),
              y: Math.round(r.top),
              width: Math.round(r.width),
              height: Math.round(r.height),
            },
            text: rawText,
            htmlSnippet,
            styles,
            url: location.href,
            title: document.title,
          };

          cleanup();
          try {
            chrome.runtime.sendMessage({
              type: "picker:elementSelected",
              element: payload,
            });
          } catch {}
        };

        const onKeyDown = (ev) => {
          if (ev.key === "Escape") {
            ev.preventDefault();
            ev.stopPropagation();
            cleanup();
            try {
              chrome.runtime.sendMessage({ type: "picker:canceled" });
            } catch {}
          }
        };

        document.addEventListener("mousemove", onMouseMove, true);
        document.addEventListener("mousedown", swallowPointer, true);
        document.addEventListener("mouseup", swallowPointer, true);
        document.addEventListener("click", onClick, true);
        document.addEventListener("keydown", onKeyDown, true);
        window.__agElementPickerCleanup = cleanup;
      },
    });
    return true;
  } catch {
    return false;
  }
}

async function removeElementPickerFromTab(tabId) {
  const tid = Number(tabId);
  if (!Number.isInteger(tid) || tid <= 0 || !chrome.scripting?.executeScript) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => {
        if (typeof window.__agElementPickerCleanup === "function") {
          window.__agElementPickerCleanup();
        } else {
          document.getElementById("__ag-element-picker-root")?.remove();
        }
      },
    });
  } catch {}
}

async function startElementPicker({ tabId = null } = {}) {
  await ensureLocalStateLoaded();
  let resolvedTabId = tabId ? Number(tabId) : null;
  if (!resolvedTabId) {
    try {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (active?.id) resolvedTabId = active.id;
    } catch {}
  }
  if (!resolvedTabId) {
    throw new Error("Open an http/https webpage tab to pick an element.");
  }
  const tab = await chrome.tabs.get(resolvedTabId);
  const url = tab.url || tab.pendingUrl || "";
  const host = normalizeHostFromUrl(url);
  if (host && getSitePolicyForHost(host) === "block") {
    const err = new Error(`Site access is blocked for ${host}. Allow site access before picking elements.`);
    err.code = -32021;
    throw err;
  }
  if (!isSafeInjectableUrl(url)) {
    throw new Error("Element picker is only available on standard http/https webpages.");
  }
  if (pickerState.active && pickerState.tabId) {
    await removeElementPickerFromTab(pickerState.tabId).catch(() => {});
  }
  const injected = await injectElementPickerIntoTab(resolvedTabId);
  if (!injected) {
    throw new Error("Could not activate the element picker on this tab.");
  }
  pickerState = {
    active: true,
    tabId: resolvedTabId,
    startedAt: Date.now(),
  };
  const snapshot = getPickerSnapshot();
  broadcastToSidePanels({
    type: "sidepanel:pickerState",
    picker: snapshot,
  });
  return { ok: true, picker: snapshot };
}

async function cancelElementPicker() {
  if (pickerState.active && pickerState.tabId) {
    await removeElementPickerFromTab(pickerState.tabId).catch(() => {});
  }
  pickerState = {
    active: false,
    tabId: null,
    startedAt: 0,
  };
  const snapshot = getPickerSnapshot();
  broadcastToSidePanels({
    type: "sidepanel:pickerState",
    picker: snapshot,
  });
  return { ok: true, picker: snapshot };
}

async function startDemonstrationRecording({ tabId = null } = {}) {
  await ensureLocalStateLoaded();
  let resolvedTabId = tabId ? Number(tabId) : null;
  if (!resolvedTabId) {
    try {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (active?.id) resolvedTabId = active.id;
    } catch {}
  }
  if (!resolvedTabId) {
    throw new Error("Open an http/https browser tab to record a workflow demonstration.");
  }
  const tab = await chrome.tabs.get(resolvedTabId);
  const url = tab.url || tab.pendingUrl || "";
  const host = normalizeHostFromUrl(url);
  if (host && getSitePolicyForHost(host) === "block") {
    const err = new Error(`Site access is blocked for ${host}. Allow site access before recording.`);
    err.code = -32021;
    throw err;
  }
  if (recordingState.active && recordingState.tabId) {
    await removeRecorderFromTab(recordingState.tabId).catch(() => {});
  }
  recordingState = {
    active: true,
    tabId: resolvedTabId,
    startedAt: Date.now(),
    originUrl: url,
    originTitle: tab.title || host || "Webpage",
    steps: [
      {
        index: 1,
        kind: "navigate",
        label: `Open ${tab.title || host || url}`,
        url,
        ts: Date.now(),
      },
    ],
  };
  await injectRecorderIntoTab(resolvedTabId);
  recordBrowserActivity({
    kind: "record",
    title: "Started workflow recording",
    detail: tab.title || url,
    tabId: resolvedTabId,
    source: "sidepanel",
  });
  const snapshot = getRecordingSnapshot();
  broadcastToSidePanels({ type: "sidepanel:recordingUpdated", recording: snapshot });
  return { ok: true, recording: snapshot };
}

function appendRecordedStep(rawStep = {}, senderTabId = null) {
  if (!recordingState.active) {
    return { ok: false, active: false, recording: getRecordingSnapshot() };
  }
  if (senderTabId && recordingState.tabId && Number(senderTabId) !== Number(recordingState.tabId)) {
    return { ok: false, ignored: true, recording: getRecordingSnapshot() };
  }
  if (rawStep.url && getSitePolicyForUrl(String(rawStep.url)) === "block") {
    return { ok: false, blocked: true, recording: getRecordingSnapshot() };
  }
  if (recordingState.steps.length >= MAX_RECORDED_ACTIONS) {
    const cappedSnapshot = { ...getRecordingSnapshot(), capped: true };
    broadcastToSidePanels({ type: "sidepanel:recordingUpdated", recording: cappedSnapshot });
    return { ok: false, capped: true, recording: cappedSnapshot };
  }
  const isSensitive =
    Boolean(rawStep.redacted) ||
    String(rawStep.inputType || "").toLowerCase() === "password" ||
    /password|secret|cvv|cc-number/i.test(String(rawStep.selector || ""));
  const kind = String(rawStep.kind || "click");
  const label = String(rawStep.label || rawStep.selector || kind).trim().slice(0, 100);
  const selector = String(rawStep.selector || "").trim().slice(0, 120);
  const value =
    rawStep.value !== undefined
      ? isSensitive
        ? "[REDACTED]"
        : String(rawStep.value).slice(0, 160)
      : undefined;

  const step = {
    index: recordingState.steps.length + 1,
    kind,
    label,
    selector,
    ...(value !== undefined ? { value } : {}),
    ...(rawStep.key ? { key: String(rawStep.key) } : {}),
    redacted: isSensitive,
    url: String(rawStep.url || recordingState.originUrl || ""),
    ts: Date.now(),
  };
  recordingState.steps.push(step);
  const snapshot = getRecordingSnapshot();
  broadcastToSidePanels({ type: "sidepanel:recordingUpdated", recording: snapshot });
  return { ok: true, step, recording: snapshot };
}

function buildShortcutDraftFromRecording(steps = [], originTitle = "", originUrl = "") {
  const host = normalizeHostFromUrl(originUrl) || "site";
  const slugHost = host.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "workflow";
  const stepLines = steps.map((s, idx) => {
    if (s.kind === "navigate") {
      return `${idx + 1}. Navigate to ${s.url || originUrl}`;
    }
    if (s.kind === "input") {
      const valText = s.redacted ? "<ask user or use existing session credentials — password redacted>" : JSON.stringify(s.value ?? "");
      return `${idx + 1}. Fill "${s.label}" (${s.selector || "input"}) with ${valText}`;
    }
    if (s.kind === "keypress") {
      return `${idx + 1}. Press ${s.key || "Enter"} on "${s.label}" (${s.selector || "focused field"})`;
    }
    return `${idx + 1}. Click "${s.label}" (${s.selector || "element"})`;
  });
  const prompt = [
    `Reproduce this recorded browser workflow on ${originTitle || host} (${originUrl || "active tab"}) using computer-use browser tools:`,
    ...stepLines,
    `Verify each step visually or via accessibility snapshot before proceeding, and pause for human handoff if a login/2FA or CAPTCHA wall appears.`,
  ].join("\n");
  return {
    command: `${slugHost}-flow`,
    title: `${originTitle ? originTitle.slice(0, 38) : host} workflow`,
    description: `Recorded ${steps.length}-step browser workflow on ${host}`,
    interactionMode: "agent",
    prompt,
  };
}

async function stopDemonstrationRecording({ cancel = false } = {}) {
  const prevTabId = recordingState.tabId;
  const steps = recordingState.steps.slice();
  const originTitle = recordingState.originTitle;
  const originUrl = recordingState.originUrl;
  recordingState.active = false;
  if (prevTabId) {
    await removeRecorderFromTab(prevTabId).catch(() => {});
  }
  const snapshot = getRecordingSnapshot();
  broadcastToSidePanels({ type: "sidepanel:recordingUpdated", recording: snapshot });
  if (cancel) {
    recordBrowserActivity({
      kind: "record",
      title: "Canceled workflow recording",
      detail: `${steps.length} steps discarded`,
      tabId: prevTabId,
      source: "sidepanel",
    });
    return { ok: true, canceled: true, recording: snapshot };
  }
  const shortcutDraft = buildShortcutDraftFromRecording(steps, originTitle, originUrl);
  recordBrowserActivity({
    kind: "record",
    title: "Completed workflow recording",
    detail: `${steps.length} steps captured`,
    tabId: prevTabId,
    source: "sidepanel",
  });
  return {
    ok: true,
    canceled: false,
    stepCount: steps.length,
    steps,
    shortcutDraft,
    recording: snapshot,
  };
}

// Scheduled Browser Tasks Management (`chrome.alarms` + `chrome.storage.local`)
async function getStoredShortcuts() {
  let custom = [];
  try {
    if (chrome.storage?.local?.get) {
      const data = await chrome.storage.local.get(["agCustomShortcuts"]);
      if (Array.isArray(data?.agCustomShortcuts)) custom = data.agCustomShortcuts;
    }
  } catch {}
  return {
    builtin: BUILTIN_SHORTCUTS,
    custom,
  };
}

async function saveCustomShortcut({ id, command, title, description, prompt, interactionMode = "chat" } = {}) {
  const cleanCmd = String(command || "")
    .trim()
    .replace(/^\/+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-");
  if (!cleanCmd || !prompt) {
    throw new Error("Shortcut requires a command name and prompt text.");
  }
  const { custom } = await getStoredShortcuts();
  const nextId = id || `sc-${Date.now()}`;
  const item = {
    id: nextId,
    command: cleanCmd,
    title: String(title || `/${cleanCmd}`).trim(),
    description: String(description || prompt).trim().slice(0, 140),
    prompt: String(prompt).trim(),
    interactionMode: interactionMode === "agent" ? "agent" : "chat",
    builtin: false,
  };
  const idx = custom.findIndex((c) => c.id === nextId || c.command === cleanCmd);
  if (idx !== -1) custom[idx] = item;
  else custom.unshift(item);
  if (chrome.storage?.local?.set) {
    await chrome.storage.local.set({ agCustomShortcuts: custom });
  }
  return { ok: true, shortcut: item, custom };
}

async function deleteCustomShortcut({ id } = {}) {
  const { custom } = await getStoredShortcuts();
  const filtered = custom.filter((c) => c.id !== id);
  if (chrome.storage?.local?.set) {
    await chrome.storage.local.set({ agCustomShortcuts: filtered });
  }
  return { ok: true, custom: filtered };
}

async function getScheduledTasks() {
  try {
    if (chrome.storage?.local?.get) {
      const data = await chrome.storage.local.get(["agScheduledTasks"]);
      if (Array.isArray(data?.agScheduledTasks)) return data.agScheduledTasks;
    }
  } catch {}
  return [];
}

async function syncScheduleAlarms() {
  const tasks = await getScheduledTasks();
  if (chrome.alarms?.getAll && chrome.alarms?.clear) {
    try {
      const existing = await chrome.alarms.getAll();
      for (const a of existing) {
        if (a.name?.startsWith(SCHEDULE_ALARM_PREFIX)) {
          const tid = a.name.slice(SCHEDULE_ALARM_PREFIX.length);
          const match = tasks.find((t) => t.id === tid && t.enabled);
          if (!match) {
            await chrome.alarms.clear(a.name);
          }
        }
      }
    } catch {}
  }
  for (const t of tasks) {
    const alarmName = `${SCHEDULE_ALARM_PREFIX}${t.id}`;
    if (t.enabled) {
      const mins = Math.max(1, Number(t.intervalMinutes) || 60);
      chrome.alarms.create(alarmName, {
        delayInMinutes: mins,
        periodInMinutes: mins,
      });
    } else if (chrome.alarms?.clear) {
      try {
        await chrome.alarms.clear(alarmName);
      } catch {}
    }
  }
}

async function saveScheduledTask({
  id,
  name,
  prompt,
  targetUrl = "",
  intervalMinutes = 60,
  interactionMode = "chat",
  enabled = true,
} = {}) {
  if (!name || !prompt) {
    throw new Error("Scheduled task requires a name and prompt.");
  }
  const tasks = await getScheduledTasks();
  const taskId = id || `sched-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const existing = tasks.find((t) => t.id === taskId);
  const record = {
    id: taskId,
    name: String(name).trim(),
    prompt: String(prompt).trim(),
    targetUrl: String(targetUrl || "").trim(),
    intervalMinutes: Math.max(1, Number(intervalMinutes) || 60),
    interactionMode: interactionMode === "agent" ? "agent" : "chat",
    enabled: Boolean(enabled),
    lastRunAt: existing?.lastRunAt || null,
    lastSessionId: existing?.lastSessionId || null,
    lastStatus: existing?.lastStatus || null,
  };
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx !== -1) tasks[idx] = record;
  else tasks.unshift(record);
  if (chrome.storage?.local?.set) {
    await chrome.storage.local.set({ agScheduledTasks: tasks });
  }
  await syncScheduleAlarms();
  return { ok: true, task: record, tasks };
}

async function deleteScheduledTask({ id } = {}) {
  const tasks = await getScheduledTasks();
  const filtered = tasks.filter((t) => t.id !== id);
  if (chrome.storage?.local?.set) {
    await chrome.storage.local.set({ agScheduledTasks: filtered });
  }
  if (chrome.alarms?.clear) {
    try {
      await chrome.alarms.clear(`${SCHEDULE_ALARM_PREFIX}${id}`);
    } catch {}
  }
  return { ok: true, tasks: filtered };
}

async function executeScheduledTask(taskId) {
  const tasks = await getScheduledTasks();
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Scheduled task '${taskId}' not found`);

  let targetTabId = null;
  let createdScratchTabId = null;
  if (task.targetUrl && isSafeInjectableUrl(task.targetUrl)) {
    const allTabs = await chrome.tabs.query({});
    const existingTab = allTabs.find((t) => (t.url || "").startsWith(task.targetUrl));
    if (existingTab) {
      targetTabId = existingTab.id;
    } else {
      const created = await rpcHandlers.createTab({
        sessionId: `sched-${task.id}`,
        url: task.targetUrl,
        active: false,
        groupTitle: `🕒 ${task.name.slice(0, 18)}`,
        groupColor: "purple",
      });
      targetTabId = created.tabId;
      createdScratchTabId = created.tabId;
    }
  }

  task.lastRunAt = Date.now();
  task.lastStatus = "running";
  if (chrome.storage?.local?.set) {
    await chrome.storage.local.set({ agScheduledTasks: tasks });
  }
  broadcastToSidePanels({ type: "sidepanel:schedulesUpdated", tasks });

  try {
    const res = await runSidePanelPrompt({
      userText: task.prompt,
      interactionMode: task.interactionMode || "chat",
      permissionMode: "auto",
      autoApprovePermissions: task.interactionMode !== "agent",
      includeActiveTab: Boolean(targetTabId),
      activeTabId: targetTabId,
      scheduledTaskName: task.name,
    });
    if (res?.ok === false) {
      const gateErr = new Error(res.error || "Scheduled task blocked by site access permissions.");
      gateErr.code = res.code;
      throw gateErr;
    }
    task.lastSessionId = res.sessionId || null;
    task.lastStatus = "completed";
    if (createdScratchTabId && task.interactionMode === "chat") {
      await rpcHandlers.closeTab({ tabId: createdScratchTabId }).catch(() => {});
    }
    if (chrome.storage?.local?.set) {
      await chrome.storage.local.set({ agScheduledTasks: tasks });
    }
    broadcastToSidePanels({ type: "sidepanel:schedulesUpdated", tasks });
    return { ok: true, sessionId: res.sessionId, task };
  } catch (err) {
    task.lastStatus = `error: ${err?.message || String(err)}`;
    if (chrome.storage?.local?.set) {
      await chrome.storage.local.set({ agScheduledTasks: tasks });
    }
    broadcastToSidePanels({ type: "sidepanel:schedulesUpdated", tasks });
    throw err;
  }
}

const rpcHandlers = {
  async ping() {
    const ident = await detectBrowserIdentity();
    return { pong: true, ts: Date.now(), ...ident };
  },

  async getInfo() {
    const ident = await detectBrowserIdentity();
    return {
      extensionId: chrome.runtime.id,
      version: chrome.runtime.getManifest?.()?.version || "3.0.0",
      ...ident,
      attachedTabIds: Array.from(attachedTabs),
      capabilities: [
        "sidePanel",
        "acpChat",
        "scheduledTasks",
        "sitePermissions",
        "activityStream",
        "demonstrationRecorder",
        "cdp",
        "tabGroups",
        "claimTab",
        "finalizeSession",
        "downloads",
        "cookies",
        "history",
        "bookmarks",
        "oopif",
        "expressionCache",
      ],
    };
  },

  async listAllTabs() {
    const tabs = await buildAllTabsSnapshot();
    return { tabs };
  },

  async getTab({ tabId } = {}) {
    const tid = Number(tabId);
    const t = await chrome.tabs.get(tid);
    return {
      tabId: t.id,
      windowId: t.windowId,
      active: Boolean(t.active),
      groupId: t.groupId,
      title: t.title || "",
      url: t.url || t.pendingUrl || "",
      status: t.status || "complete",
      attached: attachedTabs.has(t.id),
    };
  },

  async updateTab({ tabId, url, active, pinned, muted } = {}) {
    const tid = Number(tabId);
    const patch = {};
    if (url !== undefined) {
      const destHost = normalizeHostFromUrl(String(url));
      if (destHost && getSitePolicyForHost(destHost) === "block") {
        const err = new Error(
          `Browser control is blocked on ${destHost} by Antigravity in Chrome site permissions.`,
        );
        err.code = -32021;
        throw err;
      }
      patch.url = String(url);
    }
    if (typeof active === "boolean") patch.active = active;
    if (typeof pinned === "boolean") patch.pinned = pinned;
    if (typeof muted === "boolean") patch.muted = muted;
    const t = await chrome.tabs.update(tid, patch);
    if (url !== undefined) {
      recordBrowserActivity({
        kind: "navigate",
        title: "Navigated tab",
        detail: String(url),
        tabId: t.id,
        source: "mcp",
      });
    }
    return {
      ok: true,
      tabId: t.id,
      windowId: t.windowId,
      title: t.title || "",
      url: t.url || t.pendingUrl || "",
    };
  },

  async closeTab({ tabId } = {}) {
    const tid = Number(tabId);
    await detachDebuggerSafe(tid);
    tabOwnership.delete(tid);
    await chrome.tabs.remove(tid);
    await persistSessionState();
    recordBrowserActivity({
      kind: "close",
      title: `Closed scratch tab #${tid}`,
      detail: "",
      tabId: tid,
      source: "mcp",
    });
    return { ok: true, tabId: tid };
  },

  async claimTab({ sessionId = "default", tabId } = {}) {
    const tid = Number(tabId);
    const tab = await chrome.tabs.get(tid);
    const tabHost = normalizeHostFromUrl(tab.url || tab.pendingUrl || "");
    if (tabHost && getSitePolicyForHost(tabHost) === "block") {
      const err = new Error(
        `Browser control is blocked on ${tabHost} by Antigravity in Chrome site permissions.`,
      );
      err.code = -32021;
      throw err;
    }
    getOrCreateSession(sessionId);
    const existing = tabOwnership.get(tid);
    // Claim in-place: NEVER move a user's personal tab into the agent Tab Group and NEVER close on finalizeSession!
    tabOwnership.set(tid, {
      sessionId: String(sessionId || "default"),
      role: "claimed",
      createdByAgent: existing?.createdByAgent ?? false,
    });
    await persistSessionState();
    recordBrowserActivity({
      kind: "claim",
      title: "Claimed existing tab",
      detail: tab.title || tab.url || `Tab #${tab.id}`,
      tabId: tab.id,
      source: "mcp",
    });
    return {
      ok: true,
      tabId: tab.id,
      windowId: tab.windowId,
      groupId: tab.groupId,
      role: "claimed",
      title: tab.title || "",
      url: tab.url || "",
    };
  },

  async createTab({
    sessionId = "default",
    url = "about:blank",
    windowId,
    active = false,
    groupTitle,
    groupColor,
    ungroup = false,
  } = {}) {
    const destHost = normalizeHostFromUrl(String(url || ""));
    if (destHost && getSitePolicyForHost(destHost) === "block") {
      const err = new Error(
        `Browser control is blocked on ${destHost} by Antigravity in Chrome site permissions.`,
      );
      err.code = -32021;
      throw err;
    }
    const session = getOrCreateSession(sessionId, {
      title: groupTitle,
      color: groupColor,
    });
    const createProps = {
      url: url || "about:blank",
      active: Boolean(active),
    };
    if (typeof windowId === "number" && windowId >= 0) {
      createProps.windowId = windowId;
    }
    const created = await chrome.tabs.create(createProps);
    tabOwnership.set(created.id, {
      sessionId: session.sessionId,
      role: "scratch",
      createdByAgent: true,
    });

    let tabGroup = null;
    if (!ungroup) {
      try {
        tabGroup = await addTabToSessionGroup(created, session, { groupTitle, groupColor });
      } catch {}
    }
    await persistSessionState();
    recordBrowserActivity({
      kind: "tab",
      title: "Opened agent tab",
      detail: createProps.url,
      tabId: created.id,
      source: "mcp",
    });
    buildPopupStatus().then((status) => broadcastToSidePanels({ type: "sidepanel:bridgeStatus", status }));
    return {
      ok: true,
      tabId: created.id,
      windowId: created.windowId,
      active: Boolean(created.active),
      groupId: tabGroup ? tabGroup.id : created.groupId,
      tabGroup,
      title: created.title || "",
      url: created.url || created.pendingUrl || url,
      role: "scratch",
    };
  },

  async nameSession({ sessionId = "default", name, title, color, collapsed } = {}) {
    const desiredTitle = name != null ? String(name) : title != null ? String(title) : undefined;
    const desiredColor = color != null ? normalizeGroupColor(color) : undefined;
    const session = getOrCreateSession(sessionId, {
      title: desiredTitle,
      color: desiredColor,
    });
    const updatedGroups = [];
    for (const [winId, gid] of Array.from(session.groupsByWindow.entries())) {
      try {
        const patch = {};
        if (desiredTitle !== undefined) patch.title = desiredTitle;
        if (desiredColor !== undefined) patch.color = desiredColor;
        if (typeof collapsed === "boolean") patch.collapsed = collapsed;
        const g = await chrome.tabGroups.update(gid, patch);
        updatedGroups.push({
          id: g.id,
          windowId: g.windowId,
          title: g.title || "",
          color: g.color || "cyan",
          collapsed: Boolean(g.collapsed),
        });
      } catch {
        session.groupsByWindow.delete(winId);
      }
    }
    await persistSessionState();
    return {
      ok: true,
      sessionId: session.sessionId,
      title: session.title,
      color: session.color,
      groups: updatedGroups,
    };
  },

  async groupTabs({ tabIds = [], title, color, groupId, windowId, collapsed } = {}) {
    const ids = (Array.isArray(tabIds) ? tabIds : [tabIds]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (ids.length === 0) {
      throw new Error("groupTabs requires at least one numeric tabId");
    }
    const groupOpts = { tabIds: ids };
    if (typeof groupId === "number" && groupId >= 0) {
      groupOpts.groupId = groupId;
    } else if (typeof windowId === "number" && windowId >= 0) {
      groupOpts.createProperties = { windowId };
    }
    const gid = await chrome.tabs.group(groupOpts);
    const patch = {};
    if (title !== undefined) patch.title = String(title);
    if (color !== undefined) patch.color = normalizeGroupColor(color);
    if (typeof collapsed === "boolean") patch.collapsed = collapsed;
    const g = Object.keys(patch).length > 0 ? await chrome.tabGroups.update(gid, patch) : await chrome.tabGroups.get(gid);
    recordBrowserActivity({
      kind: "group",
      title: `Grouped ${ids.length} tab${ids.length === 1 ? "" : "s"}`,
      detail: g.title || "",
      tabId: ids[0] || null,
      source: "mcp",
    });
    return {
      ok: true,
      groupId: gid,
      title: g.title || "",
      color: g.color || "grey",
      collapsed: Boolean(g.collapsed),
      tabGroup: {
        id: g.id,
        windowId: g.windowId,
        title: g.title || "",
        color: g.color || "grey",
        collapsed: Boolean(g.collapsed),
      },
      tabIds: ids,
    };
  },

  async ungroupTabs({ tabIds = [] } = {}) {
    const ids = (Array.isArray(tabIds) ? tabIds : [tabIds]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (ids.length > 0) {
      await chrome.tabs.ungroup(ids);
    }
    return { ok: true, tabIds: ids };
  },

  async listTabGroups({ windowId } = {}) {
    const query = typeof windowId === "number" && windowId >= 0 ? { windowId } : {};
    const [groups, tabs] = await Promise.all([
      chrome.tabGroups.query(query),
      chrome.tabs.query(query),
    ]);
    const tabsByGroup = new Map();
    for (const t of tabs) {
      if (typeof t.groupId === "number" && t.groupId >= 0) {
        if (!tabsByGroup.has(t.groupId)) tabsByGroup.set(t.groupId, []);
        tabsByGroup.get(t.groupId).push(t.id);
      }
    }
    return {
      groups: groups.map((g) => ({
        id: g.id,
        windowId: g.windowId,
        title: g.title || "",
        color: g.color || "grey",
        collapsed: Boolean(g.collapsed),
        tabIds: tabsByGroup.get(g.id) || [],
      })),
    };
  },

  async updateTabGroup({ groupId, title, color, collapsed } = {}) {
    const gid = Number(groupId);
    if (!Number.isInteger(gid) || gid < 0) {
      throw new Error("updateTabGroup requires a valid groupId");
    }
    const patch = {};
    if (title !== undefined) patch.title = String(title);
    if (color !== undefined) patch.color = normalizeGroupColor(color);
    if (typeof collapsed === "boolean") patch.collapsed = collapsed;
    const g = await chrome.tabGroups.update(gid, patch);
    return {
      ok: true,
      groupId: g.id,
      title: g.title || "",
      color: g.color || "grey",
      collapsed: Boolean(g.collapsed),
      tabGroup: {
        id: g.id,
        windowId: g.windowId,
        title: g.title || "",
        color: g.color || "grey",
        collapsed: Boolean(g.collapsed),
      },
    };
  },

  async markTab({ sessionId = "default", tabId, status = "deliverable", activate } = {}) {
    const tid = Number(tabId);
    const normStatus = String(status || "deliverable").trim().toLowerCase();
    if (!["deliverable", "handoff", "scratch", "claimed"].includes(normStatus)) {
      throw new Error(`Invalid markTab status "${status}". Expected deliverable | handoff | scratch | claimed.`);
    }
    const existing = tabOwnership.get(tid);
    tabOwnership.set(tid, {
      sessionId: existing?.sessionId || String(sessionId || "default"),
      role: normStatus,
      createdByAgent: existing?.createdByAgent ?? false,
    });
    if (activate === true || (normStatus === "handoff" && activate !== false)) {
      try {
        const t = await chrome.tabs.update(tid, { active: true });
        if (t?.windowId != null) {
          await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
        }
      } catch {}
    }
    if (normStatus === "handoff") {
      await detachDebuggerSafe(tid);
    }
    await persistSessionState();
    recordBrowserActivity({
      kind: normStatus === "handoff" ? "handoff" : "mark",
      title:
        normStatus === "handoff"
          ? "Handed tab back for human input"
          : `Marked tab #${tid} as ${normStatus}`,
      detail: `Tab #${tid}`,
      tabId: tid,
      source: "mcp",
    });
    return { ok: true, tabId: tid, status: normStatus };
  },

  async finalizeSession({ sessionId, closeScratchTabs = true, detachAll = false } = {}) {
    const matchAll = !sessionId || sessionId === "*" || detachAll;
    const closedTabIds = [];
    const keptTabIds = [];
    const detachedTabIds = [];

    for (const [tid, own] of Array.from(tabOwnership.entries())) {
      if (!matchAll && own.sessionId !== sessionId) continue;
      if (attachedTabs.has(tid)) {
        await detachDebuggerSafe(tid);
        detachedTabIds.push(tid);
      }
      if (closeScratchTabs !== false && own.createdByAgent && own.role === "scratch") {
        try {
          await chrome.tabs.remove(tid);
          closedTabIds.push(tid);
        } catch {}
        tabOwnership.delete(tid);
      } else {
        keptTabIds.push(tid);
        if (matchAll) {
          tabOwnership.delete(tid);
        }
      }
    }

    if (matchAll || detachAll || tabOwnership.size === 0) {
      for (const tid of Array.from(attachedTabs)) {
        await detachDebuggerSafe(tid);
        if (!detachedTabIds.includes(tid)) detachedTabIds.push(tid);
      }
    }

    if (matchAll) {
      sessionMeta.clear();
    } else if (sessionId) {
      sessionMeta.delete(sessionId);
    }
    await persistSessionState();
    if (closedTabIds.length > 0 || detachedTabIds.length > 0) {
      recordBrowserActivity({
        kind: "finalize",
        title: "Released browser control",
        detail: `Detached ${detachedTabIds.length} · Closed ${closedTabIds.length} scratch`,
        source: "mcp",
      });
    }
    buildPopupStatus().then((status) => broadcastToSidePanels({ type: "sidepanel:bridgeStatus", status }));
    return {
      ok: true,
      closedTabIds,
      keptTabIds,
      detachedTabIds,
    };
  },

  async attachDebugger({ tabId } = {}) {
    return await ensureDebuggerAttached(tabId);
  },

  async detachDebugger({ tabId, all = false } = {}) {
    if (all) {
      const ids = Array.from(attachedTabs);
      for (const tid of ids) {
        await detachDebuggerSafe(tid);
      }
      return { ok: true, detachedTabIds: ids };
    }
    return await detachDebuggerSafe(tabId);
  },

  async registerCachedExpression({ key, expression } = {}) {
    if (!key || typeof expression !== "string") {
      throw new Error("registerCachedExpression requires key and string expression");
    }
    expressionCache.set(String(key), expression);
    return { ok: true, key: String(key), length: expression.length };
  },

  async sendCdp(params = {}) {
    return await sendCdpCommand(params);
  },

  async "downloads.list"({ limit = 30, state, query } = {}) {
    const q = { limit: Math.max(1, Math.min(200, Number(limit) || 30)), orderBy: ["-startTime"] };
    if (state) q.state = String(state);
    if (Array.isArray(query)) q.query = query.map(String);
    else if (typeof query === "string" && query.trim()) q.query = [query.trim()];
    const rawItems = await chrome.downloads.search(q);
    const items = Array.isArray(rawItems)
      ? rawItems.filter((d) => getSitePolicyForUrl(d?.finalUrl || d?.url || "") !== "block")
      : [];
    return {
      downloads: items.map((d) => ({
        id: d.id,
        url: d.finalUrl || d.url || "",
        originalUrl: d.url || "",
        filename: d.filename || "",
        mime: d.mime || "",
        state: d.state || "",
        bytesReceived: d.bytesReceived ?? 0,
        totalBytes: d.totalBytes ?? -1,
        startTime: d.startTime || "",
        endTime: d.endTime || "",
        error: d.error || null,
        exists: d.exists ?? true,
      })),
    };
  },

  async "downloads.download"({ url, filename, conflictAction = "uniquify", saveAs = false } = {}) {
    if (!url) throw new Error("downloads.download requires url");
    assertHostNotBlocked(String(url), "Download");
    const opts = { url: String(url), conflictAction, saveAs: Boolean(saveAs) };
    if (filename) opts.filename = String(filename);
    const downloadId = await chrome.downloads.download(opts);
    return { ok: true, downloadId };
  },

  async "cookies.getAll"({ url, domain, name, path, secure, session } = {}) {
    const details = {};
    if (url) {
      assertHostNotBlocked(String(url), "Cookie access");
      details.url = String(url);
    }
    if (domain) {
      assertHostNotBlocked(String(domain), "Cookie access");
      details.domain = String(domain);
    }
    if (name) details.name = String(name);
    if (path) details.path = String(path);
    if (typeof secure === "boolean") details.secure = secure;
    if (typeof session === "boolean") details.session = session;
    const rawCookies = await chrome.cookies.getAll(details);
    const cookies = Array.isArray(rawCookies)
      ? rawCookies.filter((c) => getSitePolicyForHost(c?.domain || "") !== "block")
      : [];
    return { cookies };
  },

  async "cookies.set"(cookie = {}) {
    if (!cookie || !cookie.url || !cookie.name) {
      throw new Error("cookies.set requires url and name");
    }
    assertHostNotBlocked(String(cookie.url), "Cookie access");
    if (cookie.domain) assertHostNotBlocked(String(cookie.domain), "Cookie access");
    const setCookie = await chrome.cookies.set(cookie);
    return { ok: Boolean(setCookie), cookie: setCookie };
  },

  async "cookies.remove"({ url, name } = {}) {
    if (!url || !name) throw new Error("cookies.remove requires url and name");
    assertHostNotBlocked(String(url), "Cookie access");
    const removed = await chrome.cookies.remove({ url: String(url), name: String(name) });
    return { ok: Boolean(removed), removed };
  },

  async "history.search"({ text = "", maxResults = 25, startTime, endTime } = {}) {
    const q = {
      text: String(text ?? ""),
      maxResults: Math.max(1, Math.min(200, Number(maxResults) || 25)),
    };
    if (typeof startTime === "number") q.startTime = startTime;
    if (typeof endTime === "number") q.endTime = endTime;
    const rawItems = await chrome.history.search(q);
    const items = Array.isArray(rawItems)
      ? rawItems.filter((h) => getSitePolicyForUrl(h?.url || "") !== "block")
      : [];
    return { items };
  },

  async "bookmarks.search"({ query = "" } = {}) {
    const rawItems = await chrome.bookmarks.search(String(query ?? ""));
    const items = Array.isArray(rawItems)
      ? rawItems.filter((b) => !b?.url || getSitePolicyForUrl(b.url) !== "block")
      : [];
    return { items };
  },

  async "bookmarks.getRecent"({ numberOfItems = 25 } = {}) {
    const rawItems = await chrome.bookmarks.getRecent(Math.max(1, Math.min(200, Number(numberOfItems) || 25)));
    const items = Array.isArray(rawItems)
      ? rawItems.filter((b) => !b?.url || getSitePolicyForUrl(b.url) !== "block")
      : [];
    return { items };
  },

  async "bookmarks.create"({ parentId, title, url } = {}) {
    if (url) assertHostNotBlocked(String(url), "Bookmark creation");
    const created = await chrome.bookmarks.create({
      ...(parentId ? { parentId: String(parentId) } : {}),
      ...(title ? { title: String(title) } : {}),
      ...(url ? { url: String(url) } : {}),
    });
    return { ok: true, bookmark: created };
  },
};

async function handleNativeIncoming(msg) {
  if (!msg || typeof msg !== "object") return;

  // 1. Response to an outbound `callNativeAgentRpc` request
  if (msg.id !== undefined && msg.id !== null && !msg.method) {
    const key = String(msg.id);
    const pending = pendingNativeRpcs.get(key);
    if (pending) {
      pendingNativeRpcs.delete(key);
      if (pending.timer) clearTimeout(pending.timer);
      if (msg.error) {
        const err = new Error(msg.error.message || JSON.stringify(msg.error));
        err.code = msg.error.code;
        pending.reject(err);
      } else {
        pending.resolve(msg.result);
      }
    }
    return;
  }

  const { id, method, params } = msg;
  if (!method) return;

  // 2. Native Host -> Side Panel Streaming Events & Telemetry
  if (method === "agentEvent") {
    handleAgentStreamEvent(params || {});
    return;
  }
  if (method === "desktopBridgeStatus") {
    desktopBridgeInfo = {
      desktopMcpClients: Number(params?.desktopMcpClients || 0),
      lastMethod: params?.lastMethod || null,
      ts: Number(params?.ts || Date.now()),
    };
    buildPopupStatus().then((status) => broadcastToSidePanels({ type: "sidepanel:bridgeStatus", status }));
    return;
  }

  // 3. Incoming MCP Server -> Extension JSON-RPC request
  const handler = rpcHandlers[method];
  if (!handler) {
    if (id !== undefined) {
      sendNativeMessage({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unknown extension RPC method: ${method}` },
      });
    }
    return;
  }
  try {
    await ensureLocalStateLoaded();
    const result = await handler(params || {});
    if (id !== undefined) {
      sendNativeMessage({
        jsonrpc: "2.0",
        id,
        result,
      });
    }
  } catch (err) {
    if (id !== undefined) {
      sendNativeMessage({
        jsonrpc: "2.0",
        id,
        error: {
          code: typeof err?.code === "number" ? err.code : -32000,
          message: err?.message || String(err),
        },
      });
    }
  }
}

// Chrome Debugger Events & User Cancel ("canceled_by_user") Propagation
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId ?? null;
  const targetId = source.targetId ?? null;
  if (method === "Target.attachedToTarget" && params?.sessionId && params?.targetInfo?.targetId) {
    childSessionMap.set(params.sessionId, {
      tabId,
      targetId: params.targetInfo.targetId,
      targetInfo: params.targetInfo,
    });
  } else if (method === "Target.detachedFromTarget" && params?.sessionId) {
    const info = childSessionMap.get(params.sessionId);
    childSessionMap.delete(params.sessionId);
    if (info?.targetId) attachedChildTargets.delete(info.targetId);
  } else if (method === "Target.receivedMessageFromTarget" && params?.message) {
    try {
      const parsed = JSON.parse(params.message);
      if (parsed && parsed.id != null && pendingTargetMessages.has(parsed.id)) {
        const waiter = pendingTargetMessages.get(parsed.id);
        pendingTargetMessages.delete(parsed.id);
        clearTimeout(waiter.timer);
        if (parsed.error) waiter.reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
        else waiter.resolve(parsed.result || {});
        return;
      }
      if (parsed && parsed.method) {
        emitNotification("cdpEvent", {
          tabId,
          targetId: childSessionMap.get(params.sessionId)?.targetId || targetId,
          sessionId: params.sessionId || null,
          method: parsed.method,
          params: parsed.params || {},
        });
        return;
      }
    } catch {}
  }

  emitNotification("cdpEvent", {
    tabId,
    targetId,
    sessionId: params?.sessionId || null,
    method,
    params: params || {},
  });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId != null) {
    attachedTabs.delete(source.tabId);
    if (reason === "canceled_by_user") {
      const own = tabOwnership.get(source.tabId);
      if (own) {
        own.role = "handoff";
        persistSessionState();
      }
    }
  }
  if (source.targetId != null) {
    attachedChildTargets.delete(source.targetId);
  }
  emitNotification("cdpDetached", {
    tabId: source.tabId ?? null,
    targetId: source.targetId ?? null,
    reason: reason || "unknown",
  });
  buildPopupStatus().then((status) => broadcastToSidePanels({ type: "sidepanel:bridgeStatus", status }));
});

// Download Lifecycle Notifications
chrome.downloads.onCreated.addListener((item) => {
  emitNotification("downloadEvent", {
    event: "created",
    item: {
      id: item.id,
      url: item.finalUrl || item.url || "",
      originalUrl: item.url || "",
      filename: item.filename || "",
      mime: item.mime || "",
      state: item.state || "in_progress",
      bytesReceived: item.bytesReceived ?? 0,
      totalBytes: item.totalBytes ?? -1,
      startTime: item.startTime || "",
    },
  });
});

chrome.downloads.onChanged.addListener((delta) => {
  emitNotification("downloadEvent", {
    event: "changed",
    delta,
  });
});

// Tab Lifecycle Notifications
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  attachedTabs.delete(tabId);
  if (tabOwnership.delete(tabId)) {
    persistSessionState();
  }
  if (recordingState.active && Number(tabId) === Number(recordingState.tabId)) {
    recordingState.active = false;
    broadcastToSidePanels({
      type: "sidepanel:recordingUpdated",
      recording: getRecordingSnapshot(),
    });
  }
  if (pickerState.active && Number(tabId) === Number(pickerState.tabId)) {
    pickerState = { active: false, tabId: null, startedAt: 0 };
    broadcastToSidePanels({
      type: "sidepanel:pickerState",
      picker: getPickerSnapshot(),
    });
  }
  emitNotification("tabRemoved", {
    tabId,
    windowId: removeInfo.windowId,
    isWindowClosing: Boolean(removeInfo.isWindowClosing),
  });
  broadcastToSidePanels({ type: "sidepanel:tabsChanged" });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status || changeInfo.url || changeInfo.title || changeInfo.groupId !== undefined) {
    emitNotification("tabUpdated", {
      tabId,
      changeInfo,
      tab: {
        tabId: tab.id,
        windowId: tab.windowId,
        groupId: tab.groupId,
        active: Boolean(tab.active),
        title: tab.title || "",
        url: tab.url || "",
        status: tab.status || "",
      },
    });
    broadcastToSidePanels({ type: "sidepanel:tabsChanged", tabId });
  }
  const updatedUrl = changeInfo.url || tab?.url || "";
  if (updatedUrl && attachedTabs.has(tabId) && getSitePolicyForUrl(updatedUrl) === "block") {
    detachDebuggerSafe(tabId).catch(() => {});
  }
  if (recordingState.active && Number(tabId) === Number(recordingState.tabId)) {
    if (updatedUrl && getSitePolicyForUrl(updatedUrl) === "block") {
      removeRecorderFromTab(tabId).catch(() => {});
    } else {
      if (changeInfo.url && isSafeInjectableUrl(changeInfo.url)) {
        appendRecordedStep(
          {
            kind: "navigate",
            label: `Navigate to ${changeInfo.url}`,
            url: changeInfo.url,
          },
          tabId,
        );
      }
      if (changeInfo.status === "complete") {
        injectRecorderIntoTab(tabId).catch(() => {});
      }
    }
  }
  if (pickerState.active && Number(tabId) === Number(pickerState.tabId)) {
    const nextUrl = changeInfo.url || tab?.url || "";
    if (nextUrl && (!isSafeInjectableUrl(nextUrl) || getSitePolicyForUrl(nextUrl) === "block")) {
      pickerState = { active: false, tabId: null, startedAt: 0 };
      broadcastToSidePanels({
        type: "sidepanel:pickerState",
        picker: getPickerSnapshot(),
      });
    } else if (changeInfo.status === "complete") {
      injectElementPickerIntoTab(tabId)
        .then((ok) => {
          if (!ok && pickerState.active && Number(pickerState.tabId) === Number(tabId)) {
            pickerState = { active: false, tabId: null, startedAt: 0 };
            broadcastToSidePanels({
              type: "sidepanel:pickerState",
              picker: getPickerSnapshot(),
            });
          }
        })
        .catch(() => {});
    }
  }
});

if (chrome.tabs?.onActivated?.addListener) {
  chrome.tabs.onActivated.addListener((activeInfo) => {
    broadcastToSidePanels({ type: "sidepanel:tabsChanged", tabId: activeInfo.tabId });
  });
}

if (chrome.contextMenus?.onClicked?.addListener) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    try {
      if (chrome.sidePanel?.open) {
        if (tab?.id) {
          chrome.sidePanel.open({ tabId: tab.id }).catch?.(() => {
            if (tab?.windowId) chrome.sidePanel.open({ windowId: tab.windowId }).catch?.(() => {});
          });
        } else if (tab?.windowId) {
          chrome.sidePanel.open({ windowId: tab.windowId }).catch?.(() => {});
        }
      }
      if (
        info?.menuItemId === "ag-ask-selection" &&
        info.selectionText &&
        getSitePolicyForUrl(tab?.url || info.pageUrl || "") !== "block"
      ) {
        setTimeout(() => {
          broadcastToSidePanels({
            type: "sidepanel:quoteSelection",
            selectionText: String(info.selectionText || "").trim().slice(0, 4000),
            tabId: tab?.id || null,
          });
        }, 160);
      }
    } catch {}
  });
}

// Offscreen Keepalive & Side Panel Live Ports
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "ag-offscreen-keepalive") {
    port.onMessage.addListener(() => {
      if (!nativePort) {
        connectNativeBridge();
      }
    });
    return;
  }
  if (port.name === "ag-sidepanel") {
    sidepanelPorts.add(port);
    port.onDisconnect.addListener(() => {
      sidepanelPorts.delete(port);
    });
  }
});

// Bridge & Side Panel Status Snapshot
async function buildPopupStatus() {
  await ensureLocalStateLoaded();
  const ident = await detectBrowserIdentity();
  const activeGroupIds = new Set();
  for (const m of sessionMeta.values()) {
    for (const gid of m.groupsByWindow.values()) {
      activeGroupIds.add(gid);
    }
  }
  const sessionGroups = [];
  for (const gid of activeGroupIds) {
    try {
      const g = await chrome.tabGroups.get(gid);
      sessionGroups.push({
        id: g.id,
        title: g.title || "Antigravity",
        color: g.color || "cyan",
      });
    } catch {}
  }
  return {
    nativeConnected: Boolean(nativePort),
    lastNativeError,
    ...ident,
    attachedTabCount: attachedTabs.size,
    attachedTabIds: Array.from(attachedTabs),
    sessionGroups,
    desktopBridgeInfo,
    sitePermissions: getSitePermissionsSnapshot(),
    recording: getRecordingSnapshot(),
    picker: getPickerSnapshot(),
    activityCount: browserActivityLog.length,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  // Legacy Popup & Bridge Status RPCs
  if (msg.type === "popup:getStatus" || msg.type === "sidepanel:getBridgeStatus") {
    buildPopupStatus().then(sendResponse);
    return true;
  }
  if (msg.type === "popup:reconnect" || msg.type === "sidepanel:reconnect") {
    (async () => {
      if (nativePort) {
        try {
          nativePort.disconnect();
        } catch {}
        nativePort = null;
      }
      reconnectAttempt = 0;
      await connectNativeBridge();
      sendResponse(await buildPopupStatus());
    })();
    return true;
  }
  if (msg.type === "popup:finishAll" || msg.type === "sidepanel:finishAll") {
    (async () => {
      await rpcHandlers.finalizeSession({ sessionId: "*", closeScratchTabs: true, detachAll: true });
      sendResponse(await buildPopupStatus());
    })();
    return true;
  }

  // Side Panel Bootstrap & Agent RPCs
  if (msg.type === "sidepanel:init") {
    (async () => {
      await ensureLocalStateLoaded();
      const [bridgeStatus, tabs, shortcuts, schedules, agentStatus] = await Promise.all([
        buildPopupStatus(),
        buildAllTabsSnapshot().catch(() => []),
        getStoredShortcuts(),
        getScheduledTasks(),
        callNativeAgentRpc("agent.getStatus", { warm: true }, 15_000).catch((err) => ({
          ok: false,
          error: err?.message || String(err),
        })),
      ]);
      sendResponse({
        ok: true,
        bridgeStatus,
        tabs,
        sessions: getChromeSessionsSummaryList(),
        shortcuts,
        schedules,
        agentStatus,
        sitePermissions: getSitePermissionsSnapshot(),
        settings: { ...extensionSettings },
        activityLog: browserActivityLog.slice(),
        recording: getRecordingSnapshot(),
        picker: getPickerSnapshot(),
      });
    })();
    return true;
  }

  if (msg.type === "sidepanel:previewPageContext") {
    (async () => {
      await ensureLocalStateLoaded();
      let tid = msg.tabId ? Number(msg.tabId) : null;
      if (!tid) {
        try {
          const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (active?.id) tid = active.id;
        } catch {}
      }
      if (!tid) {
        sendResponse({ ok: false, error: "No active browser tab found." });
        return;
      }
      const context = await extractReadableTabContext(tid, {
        maxChars: Math.max(500, Math.min(12_000, Number(msg.maxChars) || 4000)),
      });
      if (!context) {
        sendResponse({ ok: false, error: "Unable to inspect this tab." });
        return;
      }
      sendResponse({ ok: true, context });
    })().catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (msg.type === "sidepanel:getSitePermissions") {
    ensureLocalStateLoaded()
      .then(() => sendResponse({ ok: true, permissions: getSitePermissionsSnapshot() }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (msg.type === "sidepanel:setSitePermission") {
    setSitePermissionForHost(msg.host, msg.policy)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (msg.type === "sidepanel:getSettings") {
    ensureLocalStateLoaded()
      .then(() => sendResponse({ ok: true, settings: { ...extensionSettings } }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (msg.type === "sidepanel:saveSettings") {
    saveExtensionSettings(msg.settings || msg.payload || {})
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (msg.type === "sidepanel:clearActivity") {
    browserActivityLog.length = 0;
    broadcastToSidePanels({ type: "sidepanel:browserActivityCleared", activityLog: [] });
    sendResponse({ ok: true, activityLog: [] });
    return true;
  }

  if (msg.type === "sidepanel:startRecording") {
    startDemonstrationRecording(msg.payload || {})
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err), code: err?.code }));
    return true;
  }

  if (msg.type === "sidepanel:stopRecording") {
    stopDemonstrationRecording(msg.payload || {})
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (msg.type === "sidepanel:getRecordingState") {
    sendResponse({ ok: true, recording: getRecordingSnapshot() });
    return true;
  }

  if (msg.type === "recorder:step") {
    const res = appendRecordedStep(msg.step || {}, _sender?.tab?.id || null);
    sendResponse(res);
    return true;
  }

  if (msg.type === "sidepanel:startElementPicker") {
    startElementPicker(msg.payload || {})
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err), code: err?.code }));
    return true;
  }

  if (msg.type === "sidepanel:cancelElementPicker") {
    cancelElementPicker()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (msg.type === "picker:elementSelected") {
    const senderTabId = _sender?.tab?.id ?? null;
    if (!pickerState.active || (senderTabId != null && Number(senderTabId) !== Number(pickerState.tabId))) {
      sendResponse({ ok: false, ignored: true });
      return true;
    }
    const targetTabId = senderTabId ?? pickerState.tabId ?? null;
    pickerState = { active: false, tabId: null, startedAt: 0 };
    const picker = getPickerSnapshot();
    const rawEl = msg.element && typeof msg.element === "object" ? msg.element : null;
    const normUrl = rawEl ? String(rawEl.url || rawEl.pageUrl || "").trim() : "";
    const normTitle = rawEl ? String(rawEl.title || rawEl.pageTitle || "").trim() : "";
    const element = rawEl
      ? {
          ...rawEl,
          tabId: targetTabId,
          url: normUrl,
          pageUrl: normUrl,
          title: normTitle,
          pageTitle: normTitle,
        }
      : null;
    if (element) {
      const selLabel = element.selector || element.tagName || "element";
      recordBrowserActivity({
        kind: "element",
        title: `Picked element ${selLabel}`,
        detail: element.title || element.url || selLabel,
        tabId: targetTabId,
        source: "sidepanel",
      });
      broadcastToSidePanels({
        type: "sidepanel:elementPicked",
        element,
        picker,
      });
    } else {
      broadcastToSidePanels({
        type: "sidepanel:pickerState",
        picker,
      });
    }
    sendResponse({ ok: true, picker });
    return true;
  }

  if (msg.type === "picker:canceled") {
    const senderTabId = _sender?.tab?.id ?? null;
    if (!pickerState.active || (senderTabId != null && Number(senderTabId) !== Number(pickerState.tabId))) {
      sendResponse({ ok: false, ignored: true });
      return true;
    }
    pickerState = { active: false, tabId: null, startedAt: 0 };
    const picker = getPickerSnapshot();
    broadcastToSidePanels({
      type: "sidepanel:pickerState",
      picker,
    });
    sendResponse({ ok: true, picker });
    return true;
  }

  if (msg.type === "sidepanel:listTabs") {
    buildAllTabsSnapshot()
      .then((tabs) => sendResponse({ ok: true, tabs }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (msg.type === "sidepanel:captureScreenshot") {
    captureVisibleTabPng(msg.windowId)
      .then((shot) => sendResponse({ ok: true, ...shot }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (msg.type === "sidepanel:sendPrompt") {
    runSidePanelPrompt(msg.payload || {})
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err), code: err?.code }));
    return true;
  }

  if (msg.type === "sidepanel:cancelPrompt") {
    callNativeAgentRpc(
      "agent.cancel",
      {
        sessionId: msg.sessionId || null,
        requestId: msg.requestId || null,
      },
      8_000,
    )
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (msg.type === "sidepanel:respondPermission") {
    callNativeAgentRpc(
      "agent.respondPermission",
      {
        permRequestId: msg.permRequestId,
        optionId: msg.optionId,
      },
      8_000,
    )
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (msg.type === "sidepanel:loadSession") {
    (async () => {
      await ensureLocalStateLoaded();
      const sid = String(msg.sessionId || "").trim();
      if (!sid || !chromeSessions.has(sid)) {
        sendResponse({
          ok: false,
          code: -32010,
          error:
            "Conversations created in the Antigravity Desktop App cannot be opened in Antigravity in Chrome. Start a chat here to view it in both Chrome and the Desktop App.",
        });
        return;
      }
      const localRec = chromeSessions.get(sid);
      try {
        const effectiveCwd = localRec?.cwd || extensionSettings.cwd || null;
        const live = await callNativeAgentRpc(
          "agent.loadSession",
          { sessionId: sid, cwd: effectiveCwd },
          18_000,
        );
        if (live?.ok && Array.isArray(live.messages) && live.messages.length > 0) {
          const localUserMsgs = (localRec?.messages || []).filter((m) => m && m.role === "user");
          let userTurnIdx = 0;
          const cleanedMessages = live.messages.map((m) => {
            if (m.role === "user") {
              const matchedAttachments = localUserMsgs[userTurnIdx]?.attachments || [];
              userTurnIdx++;
              return {
                ...m,
                text: stripInjectedBrowserContext(m.text),
                attachments: matchedAttachments,
              };
            }
            return {
              ...m,
              attachments: [],
            };
          });
          localRec.messages = cleanedMessages;
          if (live.title) localRec.title = live.title;
          schedulePersistChromeSessions();
        }
      } catch {}
      sendResponse({
        ok: true,
        session: localRec,
      });
    })();
    return true;
  }

  if (msg.type === "sidepanel:deleteSession") {
    (async () => {
      await ensureLocalStateLoaded();
      chromeSessions.delete(String(msg.sessionId || ""));
      await flushChromeSessionsNow();
      sendResponse({ ok: true, sessions: getChromeSessionsSummaryList() });
    })();
    return true;
  }

  if (msg.type === "sidepanel:openInDesktopApp") {
    callNativeAgentRpc("agent.openInDesktopApp", { sessionId: msg.sessionId || null }, 8_000)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (msg.type === "sidepanel:setConfig") {
    const cfgPayload = msg.payload || {};
    if (cfgPayload.sessionId && cfgPayload.permissionMode && chromeSessions.has(cfgPayload.sessionId)) {
      chromeSessions.get(cfgPayload.sessionId).permissionMode = cfgPayload.permissionMode;
      schedulePersistChromeSessions();
    }
    callNativeAgentRpc("agent.setConfig", cfgPayload, 8_000)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (msg.type === "sidepanel:groupTabsNow") {
    rpcHandlers
      .groupTabs(msg.payload || {})
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  // Shortcuts & Scheduled Tasks RPCs
  if (msg.type === "sidepanel:saveShortcut") {
    saveCustomShortcut(msg.payload || {})
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (msg.type === "sidepanel:deleteShortcut") {
    deleteCustomShortcut(msg.payload || {})
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (msg.type === "sidepanel:saveSchedule") {
    saveScheduledTask(msg.payload || {})
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (msg.type === "sidepanel:deleteSchedule") {
    deleteScheduledTask(msg.payload || {})
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (msg.type === "sidepanel:runScheduleNow") {
    executeScheduledTask(msg.id)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  return false;
});

// Watchdog & Scheduled Task Alarms
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm?.name) return;
  if (alarm.name === KEEPALIVE_ALARM) {
    ensureOffscreenKeepalive();
    if (!nativePort) {
      connectNativeBridge();
    }
    return;
  }
  if (alarm.name.startsWith(SCHEDULE_ALARM_PREFIX)) {
    const taskId = alarm.name.slice(SCHEDULE_ALARM_PREFIX.length);
    executeScheduledTask(taskId).catch(() => {});
  }
});

chrome.runtime.onInstalled.addListener(() => {
  configureSidePanelBehavior();
  setupContextMenus();
  ensureOffscreenKeepalive();
  connectNativeBridge();
  syncScheduleAlarms().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  configureSidePanelBehavior();
  setupContextMenus();
  ensureOffscreenKeepalive();
  connectNativeBridge();
  syncScheduleAlarms().catch(() => {});
});

// Immediate boot initialization
(async () => {
  await configureSidePanelBehavior();
  setupContextMenus();
  await restoreSessionState();
  await ensureLocalStateLoaded();
  await ensureOffscreenKeepalive();
  await connectNativeBridge();
  await syncScheduleAlarms().catch(() => {});
})();
