// Antigravity in Chrome — MV3 Service Worker, Side Panel Controller & Native Messaging Bridge
const NATIVE_HOST_NAME = "com.antigravity.browser_bridge";
const KEEPALIVE_ALARM = "ag-native-bridge-watchdog";
const SCHEDULE_ALARM_PREFIX = "ag-sched:";
const MAX_STORED_CHROME_SESSIONS = 50;

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

function normalizeGroupColor(color) {
  const c = String(color || "cyan").trim().toLowerCase();
  if (VALID_GROUP_COLORS.has(c)) return c;
  if (c === "gray") return "grey";
  if (c === "sky" || c === "teal" || c === "aqua") return "cyan";
  if (c === "violet" || c === "indigo") return "purple";
  if (c === "amber") return "orange";
  return "cyan";
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
    const data = await chrome.storage.local.get(["agChromeSessions"]);
    if (Array.isArray(data?.agChromeSessions)) {
      for (const item of data.agChromeSessions) {
        if (item && typeof item.sessionId === "string" && item.sessionId) {
          chromeSessions.set(item.sessionId, item);
        }
      }
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

  // Child OOPIF routing when sessionId or explicit child targetId is provided
  const childInfo = sessionId ? childSessionMap.get(sessionId) : null;
  const effectiveChildTargetId = targetId || childInfo?.targetId || null;

  if (effectiveChildTargetId) {
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
  await ensureDebuggerAttached(tid);
  return await chrome.debugger.sendCommand({ tabId: tid }, method, finalParams);
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
async function extractReadableTabContext(tabId, { maxChars = 14000 } = {}) {
  const tid = Number(tabId);
  if (!Number.isInteger(tid) || tid <= 0) return null;
  let tab;
  try {
    tab = await chrome.tabs.get(tid);
  } catch {
    return null;
  }
  const rawUrl = tab.url || tab.pendingUrl || "";
  const baseMeta = {
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title || "",
    url: rawUrl,
    readable: false,
    selection: "",
    metaDescription: "",
    headings: [],
    text: "",
  };
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

function formatTabContextSection(label, ctx, browserFamily) {
  if (!ctx) return "";
  const mcpTabId = `ext:${browserFamily}:${ctx.tabId}`;
  const lines = [
    `### ${label}`,
    `- Title: ${ctx.title || "(Untitled)"}`,
    `- URL: ${ctx.url || "(empty)"}`,
    `- Browser Tab ID (for computer-use MCP): \`${mcpTabId}\` (numeric tabId: ${ctx.tabId}, windowId: ${ctx.windowId})`,
  ];
  if (ctx.metaDescription) {
    lines.push(`- Meta Description: ${ctx.metaDescription}`);
  }
  if (ctx.selection) {
    lines.push(`- Highlighted Selection on Page:\n"""\n${ctx.selection}\n"""`);
  }
  if (Array.isArray(ctx.headings) && ctx.headings.length > 0) {
    lines.push(`- Key Headings: ${ctx.headings.slice(0, 12).join(" | ")}`);
  }
  if (ctx.readable && ctx.text) {
    lines.push(
      `- Visible Page Content${ctx.truncated ? " (excerpt)" : ""}:\n\`\`\`text\n${ctx.text}\n\`\`\``,
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
            targetMsg.toolCalls.push({
              toolCallId: update.toolCallId,
              name: update.name || "tool",
              title: update.title || update.name || "Tool",
              status: update.status || "in_progress",
              kind: update.kind || "other",
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

async function runSidePanelPrompt({
  requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  sessionId = null,
  userText = "",
  interactionMode = "chat",
  permissionMode = "auto",
  autoApprovePermissions = false,
  modelId = null,
  includeActiveTab = true,
  activeTabId = null,
  mentionedTabIds = [],
  screenshotBase64 = null,
  scheduledTaskName = null,
} = {}) {
  await ensureLocalStateLoaded();
  const ident = await detectBrowserIdentity();
  const browserFamily = ident.browserFamily || "chrome";

  // Verify existing Chrome session if resuming
  if (sessionId && !chromeSessions.has(sessionId)) {
    throw new Error(
      "Conversations created in the Antigravity Desktop App cannot be opened in Antigravity in Chrome. Start a new chat here to view it in both Chrome and the Desktop App.",
    );
  }

  let resolvedActiveTabId = activeTabId;
  if (includeActiveTab && !resolvedActiveTabId) {
    try {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (active?.id) resolvedActiveTabId = active.id;
    } catch {}
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
      attachments.push({
        kind: "active-tab",
        tabId: activeCtx.tabId,
        title: activeCtx.title || activeCtx.url || `Tab #${activeCtx.tabId}`,
        url: activeCtx.url || "",
      });
      contextSections.push(formatTabContextSection("Active Webpage Tab", activeCtx, browserFamily));
    }
  }

  const uniqueMentions = Array.from(new Set((mentionedTabIds || []).map(Number).filter((n) => n > 0 && n !== resolvedActiveTabId)));
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

  if (screenshotBase64) {
    attachments.push({ kind: "screenshot", label: "Tab Screenshot" });
  }

  const modeBanner =
    interactionMode === "agent"
      ? `[Interaction Mode: Agent / Browser Control — Use computer-use MCP tools (browser_tab_state, browser_tab_action, browser_open_tab, browser_manage) to inspect and act on the live ${ident.browserName} browser.]`
      : `[Interaction Mode: Chat / Read-Only — Answer directly using the live page/tab context below without mutating browser tabs unless asked to switch to Agent Mode.]`;

  const contextEnvelope = `<browser_sidepanel_context>\n${modeBanner}${
    contextSections.length > 0 ? `\n\n${contextSections.join("\n\n")}` : ""
  }\n</browser_sidepanel_context>\n\n`;

  const cleanText = String(userText || "").trim();
  const fullPromptText = `${contextEnvelope}${cleanText}`;

  const promptBlocks = [];
  if (screenshotBase64) {
    promptBlocks.push({
      type: "image",
      data: screenshotBase64,
      mimeType: "image/png",
    });
  }
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

  const now = Date.now();
  if (sessionId && chromeSessions.has(sessionId)) {
    const rec = chromeSessions.get(sessionId);
    rec.updatedAt = now;
    rec.interactionMode = interactionMode;
    rec.permissionMode = permissionMode;
    if (modelId) rec.modelId = modelId;
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
    originUrl,
    originTitle,
    scheduledTaskName,
    assistantMsg,
  });

  try {
    const res = await callNativeAgentRpc("agent.prompt", {
      requestId,
      sessionId,
      promptBlocks,
      modeId: permissionMode || "auto",
      modelId: modelId || null,
      autoApprovePermissions: Boolean(autoApprovePermissions),
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
    if (url !== undefined) patch.url = String(url);
    if (typeof active === "boolean") patch.active = active;
    if (typeof pinned === "boolean") patch.pinned = pinned;
    if (typeof muted === "boolean") patch.muted = muted;
    const t = await chrome.tabs.update(tid, patch);
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
    return { ok: true, tabId: tid };
  },

  async claimTab({ sessionId = "default", tabId } = {}) {
    const tid = Number(tabId);
    const tab = await chrome.tabs.get(tid);
    getOrCreateSession(sessionId);
    const existing = tabOwnership.get(tid);
    // Claim in-place: NEVER move a user's personal tab into the agent Tab Group and NEVER close on finalizeSession!
    tabOwnership.set(tid, {
      sessionId: String(sessionId || "default"),
      role: "claimed",
      createdByAgent: existing?.createdByAgent ?? false,
    });
    await persistSessionState();
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
    const items = await chrome.downloads.search(q);
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
    const opts = { url: String(url), conflictAction, saveAs: Boolean(saveAs) };
    if (filename) opts.filename = String(filename);
    const downloadId = await chrome.downloads.download(opts);
    return { ok: true, downloadId };
  },

  async "cookies.getAll"({ url, domain, name, path, secure, session } = {}) {
    const details = {};
    if (url) details.url = String(url);
    if (domain) details.domain = String(domain);
    if (name) details.name = String(name);
    if (path) details.path = String(path);
    if (typeof secure === "boolean") details.secure = secure;
    if (typeof session === "boolean") details.session = session;
    const cookies = await chrome.cookies.getAll(details);
    return { cookies };
  },

  async "cookies.set"(cookie = {}) {
    if (!cookie || !cookie.url || !cookie.name) {
      throw new Error("cookies.set requires url and name");
    }
    const setCookie = await chrome.cookies.set(cookie);
    return { ok: Boolean(setCookie), cookie: setCookie };
  },

  async "cookies.remove"({ url, name } = {}) {
    if (!url || !name) throw new Error("cookies.remove requires url and name");
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
    const items = await chrome.history.search(q);
    return { items };
  },

  async "bookmarks.search"({ query = "" } = {}) {
    const items = await chrome.bookmarks.search(String(query ?? ""));
    return { items };
  },

  async "bookmarks.getRecent"({ numberOfItems = 25 } = {}) {
    const items = await chrome.bookmarks.getRecent(Math.max(1, Math.min(200, Number(numberOfItems) || 25)));
    return { items };
  },

  async "bookmarks.create"({ parentId, title, url } = {}) {
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
});

if (chrome.tabs?.onActivated?.addListener) {
  chrome.tabs.onActivated.addListener((activeInfo) => {
    broadcastToSidePanels({ type: "sidepanel:tabsChanged", tabId: activeInfo.tabId });
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
      });
    })();
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
    callNativeAgentRpc("agent.cancel", { sessionId: msg.sessionId }, 8_000)
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
        const live = await callNativeAgentRpc("agent.loadSession", { sessionId: sid }, 18_000);
        if (live?.ok && Array.isArray(live.messages) && live.messages.length > 0) {
          const cleanedMessages = live.messages.map((m, idx) => ({
            ...m,
            text: m.role === "user" ? stripInjectedBrowserContext(m.text) : m.text,
            attachments:
              m.role === "user" && localRec?.messages?.[idx]?.attachments
                ? localRec.messages[idx].attachments
                : [],
          }));
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
    callNativeAgentRpc("agent.setConfig", msg.payload || {}, 8_000)
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
  ensureOffscreenKeepalive();
  connectNativeBridge();
  syncScheduleAlarms().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  configureSidePanelBehavior();
  ensureOffscreenKeepalive();
  connectNativeBridge();
  syncScheduleAlarms().catch(() => {});
});

// Immediate boot initialization
(async () => {
  await configureSidePanelBehavior();
  await restoreSessionState();
  await ensureLocalStateLoaded();
  await ensureOffscreenKeepalive();
  await connectNativeBridge();
  await syncScheduleAlarms().catch(() => {});
})();
