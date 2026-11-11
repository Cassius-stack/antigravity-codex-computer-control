// Antigravity in Chrome — MV3 Service Worker & Native Messaging JSON-RPC 2.0 Server
const NATIVE_HOST_NAME = "com.antigravity.browser_bridge";
const KEEPALIVE_ALARM = "ag-native-bridge-watchdog";
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

let nativePort = null;
let lastNativeError = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let browserIdentityPromise = null;

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
      reconnectAttempt += 1;
      scheduleReconnect(false);
    });

    const ident = await detectBrowserIdentity();
    emitNotification("bridgeHello", {
      extensionId: chrome.runtime.id,
      version: chrome.runtime.getManifest?.()?.version || "2.0.0",
      ...ident,
      attachedTabIds: Array.from(attachedTabs),
    });
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

const rpcHandlers = {
  async ping() {
    const ident = await detectBrowserIdentity();
    return { pong: true, ts: Date.now(), ...ident };
  },

  async getInfo() {
    const ident = await detectBrowserIdentity();
    return {
      extensionId: chrome.runtime.id,
      version: chrome.runtime.getManifest?.()?.version || "2.0.0",
      ...ident,
      attachedTabIds: Array.from(attachedTabs),
      capabilities: [
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
      // Detach debugger on handoff so user interacts cleanly without debugger banner
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
  const { id, method, params } = msg;
  if (!method) return;
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
  }
});

// Offscreen Keepalive Port
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "ag-offscreen-keepalive") {
    port.onMessage.addListener(() => {
      if (!nativePort) {
        connectNativeBridge();
      }
    });
  }
});

// Popup & Internal Runtime Messages
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
    sessionGroups,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;
  if (msg.type === "popup:getStatus") {
    buildPopupStatus().then(sendResponse);
    return true;
  }
  if (msg.type === "popup:reconnect") {
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
  if (msg.type === "popup:finishAll") {
    (async () => {
      await rpcHandlers.finalizeSession({ sessionId: "*", closeScratchTabs: true, detachAll: true });
      sendResponse(await buildPopupStatus());
    })();
    return true;
  }
  return false;
});

// Watchdog Alarm & Startup Hooks
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    ensureOffscreenKeepalive();
    if (!nativePort) {
      connectNativeBridge();
    }
  }
});

chrome.runtime.onInstalled.addListener(() => {
  ensureOffscreenKeepalive();
  connectNativeBridge();
});

chrome.runtime.onStartup.addListener(() => {
  ensureOffscreenKeepalive();
  connectNativeBridge();
});

// Immediate boot initialization
(async () => {
  await restoreSessionState();
  await ensureOffscreenKeepalive();
  await connectNativeBridge();
})();
