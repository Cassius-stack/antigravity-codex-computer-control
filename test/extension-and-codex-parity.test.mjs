import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import {
  BUILD_AX_SNAPSHOT_EXPR,
  buildPrepareBrowserCursorForScreenshotExpr,
  buildSetActiveTabIndicatorExpr,
} from "../src/browser-ax.mjs";
import { ExtensionSocketClient } from "../src/extension-bridge.mjs";
import {
  CAPTCHA_HANDOFF_BANNER,
  assertSafeBrowserUrl,
  checkBrowserUrlSafety,
  detectCaptchaChallenge,
} from "../src/safety-policy.mjs";
import { createComputerUseServer } from "../src/server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

function createJsonRpcPair(mcp) {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  mcp.input = clientToServer;
  mcp.output = serverToClient;
}

function attachMcpRpcHelper(clientToServer, serverToClient) {
  const responses = new Map();
  let buf = "";
  serverToClient.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id != null && responses.has(msg.id)) {
        responses.get(msg.id)(msg);
        responses.delete(msg.id);
      }
    }
  });

  let nextId = 1;
  return function rpc(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve) => {
      responses.set(id, resolve);
      clientToServer.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };
}

/**
 * Create an in-process MV3 Chrome Extension Service Worker VM running the REAL `extension/background.js`
 * wired over 4-byte uint32 LE Native Messaging stdio frames to a REAL `bin/antigravity-native-host.mjs` process!
 */
function launchNativeHostWithRealExtension({
  sockDir,
  brand = "brave",
  initialTabs = [],
  onDebuggerCommand = null,
  extraHostEnv = {},
}) {
  const hostScript = path.join(PROJECT_ROOT, "bin", "antigravity-native-host.mjs");
  const hostProc = spawn(process.execPath, [hostScript], {
    cwd: PROJECT_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      AG_BRIDGE_SOCK_DIR: sockDir,
      ...extraHostEnv,
    },
  });

  const makeEvent = () => {
    const listeners = new Set();
    return {
      addListener: (fn) => listeners.add(fn),
      removeListener: (fn) => listeners.delete(fn),
      emit: (...args) => {
        for (const fn of [...listeners]) fn(...args);
      },
    };
  };

  let nextTabId = 100;
  let nextGroupId = 500;
  const tabs = new Map();
  const tabGroups = new Map();
  const attachedTargets = new Set();
  const downloads = new Map();
  const cookies = [
    { name: "sid", value: "abc123", domain: "example.test", path: "/", secure: true, httpOnly: true },
  ];
  const bookmarks = [
    { id: "bm-1", title: "Antigravity Docs", url: "https://antigravity.example.test/docs" },
  ];
  const historyItems = [
    { id: "h-1", title: "Release Notes", url: "https://antigravity.example.test/releases", lastVisitTime: Date.now() },
  ];
  const sessionStorageMap = {};
  const localStorageMap = {};
  const createdAlarms = new Map();
  let sidePanelBehavior = null;

  for (const t of initialTabs) {
    tabs.set(t.id, {
      id: t.id,
      windowId: t.windowId ?? 1,
      index: tabs.size,
      active: Boolean(t.active),
      pinned: Boolean(t.pinned),
      groupId: t.groupId ?? -1,
      title: t.title ?? "Tab",
      url: t.url ?? "https://example.test/",
      status: "complete",
      lastAccessed: Date.now(),
    });
  }

  const debuggerOnEvent = makeEvent();
  const debuggerOnDetach = makeEvent();
  const tabsOnRemoved = makeEvent();
  const tabsOnUpdated = makeEvent();
  const tabsOnActivated = makeEvent();
  const downloadsOnCreated = makeEvent();
  const downloadsOnChanged = makeEvent();
  const alarmsOnAlarm = makeEvent();
  const runtimeOnConnect = makeEvent();
  const runtimeOnMessage = makeEvent();
  const runtimeOnInstalled = makeEvent();
  const runtimeOnStartup = makeEvent();

  // Wire Chrome's 4-byte uint32 LE Native Messaging framing to hostProc stdin/stdout
  const portOnMessage = makeEvent();
  const portOnDisconnect = makeEvent();

  let stdoutBuf = Buffer.alloc(0);
  hostProc.stdout.on("data", (chunk) => {
    stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
    while (stdoutBuf.length >= 4) {
      const len = stdoutBuf.readUInt32LE(0);
      if (stdoutBuf.length < 4 + len) break;
      const jsonStr = stdoutBuf.subarray(4, 4 + len).toString("utf8");
      stdoutBuf = stdoutBuf.subarray(4 + len);
      const msg = JSON.parse(jsonStr);
      portOnMessage.emit(msg);
    }
  });
  hostProc.on("exit", () => {
    portOnDisconnect.emit();
  });

  const nativePortObj = {
    postMessage(msg) {
      if (!hostProc.stdin.writable) return;
      const body = Buffer.from(JSON.stringify(msg), "utf8");
      const hdr = Buffer.allocUnsafe(4);
      hdr.writeUInt32LE(body.length, 0);
      hostProc.stdin.write(Buffer.concat([hdr, body]));
    },
    disconnect() {
      try {
        hostProc.stdin.end();
      } catch {}
    },
    onMessage: portOnMessage,
    onDisconnect: portOnDisconnect,
  };

  let envClosed = false;
  const swTimers = new Set();
  const swSetTimeout = (fn, ms, ...args) => {
    if (envClosed) return 0;
    const t = setTimeout(() => {
      swTimers.delete(t);
      if (!envClosed) fn(...args);
    }, ms);
    t.unref?.();
    swTimers.add(t);
    return t;
  };
  const swClearTimeout = (t) => {
    swTimers.delete(t);
    clearTimeout(t);
  };

  const chromeMock = {
    runtime: {
      id: "cnipmpbdggdeocaigfifflifphanoiic",
      lastError: null,
      getManifest: () => ({ version: "3.0.0", name: "Antigravity in Chrome" }),
      connectNative(name) {
        if (envClosed) throw new Error("Bridge test environment closed");
        assert.equal(name, "com.antigravity.browser_bridge");
        return nativePortObj;
      },
      getContexts: async () => [],
      onConnect: runtimeOnConnect,
      onMessage: runtimeOnMessage,
      onInstalled: runtimeOnInstalled,
      onStartup: runtimeOnStartup,
    },
    sidePanel: {
      setPanelBehavior: async (opts) => {
        sidePanelBehavior = opts;
      },
    },
    offscreen: {
      Reason: { BLOBS: "BLOBS" },
      createDocument: async () => {},
    },
    alarms: {
      create: (name, info) => {
        createdAlarms.set(name, info);
      },
      getAll: async () => Array.from(createdAlarms.entries()).map(([name, info]) => ({ name, ...info })),
      clear: async (name) => createdAlarms.delete(name),
      onAlarm: alarmsOnAlarm,
    },
    storage: {
      session: {
        get: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) out[k] = sessionStorageMap[k];
          return out;
        },
        set: async (obj) => Object.assign(sessionStorageMap, obj),
      },
      local: {
        get: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) out[k] = localStorageMap[k];
          return out;
        },
        set: async (obj) => Object.assign(localStorageMap, obj),
      },
    },
    scripting: {
      executeScript: async ({ target }) => {
        const t = tabs.get(target?.tabId);
        if (!t) throw new Error(`No tab ${target?.tabId}`);
        return [
          {
            result: {
              title: t.title || "Page",
              url: t.url || "https://example.test/",
              selection: t.selection || "",
              metaDescription: `Summary of ${t.title}`,
              headings: [`H1: ${t.title}`],
              linksCount: 5,
              buttonsCount: 2,
              inputsCount: 1,
              text: t.bodyText || `Visible page text for ${t.title} at ${t.url}`,
              truncated: false,
            },
          },
        ];
      },
    },
    windows: {
      getAll: async () => [{ id: 1, focused: true, type: "normal" }],
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      query: async (q = {}) => {
        const all = [...tabGroups.values()];
        return q.windowId != null ? all.filter((g) => g.windowId === q.windowId) : all;
      },
      get: async (groupId) => {
        const g = tabGroups.get(groupId);
        if (!g) throw new Error(`No group with id ${groupId}`);
        return { ...g };
      },
      update: async (groupId, props = {}) => {
        const g = tabGroups.get(groupId);
        if (!g) throw new Error(`No group with id ${groupId}`);
        if (props.title !== undefined) g.title = props.title;
        if (props.color !== undefined) g.color = props.color;
        if (props.collapsed !== undefined) g.collapsed = props.collapsed;
        return { ...g };
      },
    },
    tabs: {
      query: async (q = {}) => {
        let list = [...tabs.values()];
        if (q.windowId != null) list = list.filter((t) => t.windowId === q.windowId);
        if (q.groupId != null) list = list.filter((t) => t.groupId === q.groupId);
        return list.map((t) => ({ ...t }));
      },
      get: async (tabId) => {
        const t = tabs.get(tabId);
        if (!t) throw new Error(`No tab with id: ${tabId}`);
        return { ...t };
      },
      create: async (opts = {}) => {
        const id = nextTabId++;
        const tab = {
          id,
          windowId: opts.windowId ?? 1,
          index: tabs.size,
          active: Boolean(opts.active),
          pinned: false,
          groupId: -1,
          title: opts.url || "New Tab",
          url: opts.url || "about:blank",
          status: "complete",
          lastAccessed: Date.now(),
        };
        tabs.set(id, tab);
        return { ...tab };
      },
      update: async (tabId, props = {}) => {
        const t = tabs.get(tabId);
        if (!t) throw new Error(`No tab with id: ${tabId}`);
        if (props.url !== undefined) {
          t.url = props.url;
          t.title = `Loaded ${props.url}`;
        }
        if (props.active !== undefined) t.active = Boolean(props.active);
        tabsOnUpdated.emit(tabId, props, { ...t });
        return { ...t };
      },
      remove: async (tabIds) => {
        const list = Array.isArray(tabIds) ? tabIds : [tabIds];
        for (const id of list) {
          const existed = tabs.get(id);
          if (existed) {
            tabs.delete(id);
            attachedTargets.delete(`tab:${id}`);
            tabsOnRemoved.emit(id, { windowId: existed.windowId, isWindowClosing: false });
          }
        }
      },
      group: async ({ tabIds, groupId, createProperties }) => {
        const list = Array.isArray(tabIds) ? tabIds : [tabIds];
        let gid = groupId;
        if (gid == null || !tabGroups.has(gid)) {
          gid = nextGroupId++;
          tabGroups.set(gid, {
            id: gid,
            windowId: createProperties?.windowId ?? tabs.get(list[0])?.windowId ?? 1,
            title: "",
            color: "grey",
            collapsed: false,
          });
        }
        for (const id of list) {
          const t = tabs.get(id);
          if (t) t.groupId = gid;
        }
        return gid;
      },
      ungroup: async (tabIds) => {
        const list = Array.isArray(tabIds) ? tabIds : [tabIds];
        for (const id of list) {
          const t = tabs.get(id);
          if (t) t.groupId = -1;
        }
      },
      captureVisibleTab: async () =>
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      onRemoved: tabsOnRemoved,
      onUpdated: tabsOnUpdated,
      onActivated: tabsOnActivated,
    },
    debugger: {
      attach: async (Debuggee, _version) => {
        const key = Debuggee.tabId != null ? `tab:${Debuggee.tabId}` : `target:${Debuggee.targetId}`;
        if (Debuggee.tabId != null) {
          const tab = tabs.get(Debuggee.tabId);
          if (!tab) throw new Error(`No tab ${Debuggee.tabId}`);
          if (/^(chrome|brave):\/\//i.test(tab.url)) {
            throw new Error(`Cannot access a chrome:// URL`);
          }
        }
        attachedTargets.add(key);
      },
      detach: async (Debuggee) => {
        const key = Debuggee.tabId != null ? `tab:${Debuggee.tabId}` : `target:${Debuggee.targetId}`;
        attachedTargets.delete(key);
      },
      sendCommand: async (Debuggee, method, params = {}) => {
        if (onDebuggerCommand) {
          const custom = await onDebuggerCommand(Debuggee, method, params, {
            tabs,
            emitCdpEvent: (source, evMethod, evParams) => debuggerOnEvent.emit(source, evMethod, evParams),
            emitDetach: (source, reason) => {
              if (source.tabId != null) attachedTargets.delete(`tab:${source.tabId}`);
              debuggerOnDetach.emit(source, reason);
            },
          });
          if (custom !== undefined) return custom;
        }
        const t = Debuggee.tabId != null ? tabs.get(Debuggee.tabId) : null;
        if (method === "Runtime.evaluate") {
          const expr = String(params.expression || "");
          if (expr === "document.readyState") return { result: { value: "complete" } };
          if (expr.includes('Object.defineProperty(window, "__agCuaMap"')) {
            return {
              result: {
                value: {
                  title: t?.title || "Page",
                  url: t?.url || "https://example.test/",
                  viewport: { width: 1280, height: 800 },
                  scroll: { x: 0, y: 0 },
                  lines: [`  [1] heading "${t?.title || "Page"}" @(40,40 300x32)`],
                  elementCount: 1,
                },
              },
            };
          }
          return { result: { value: { ok: true } } };
        }
        if (method === "Page.navigate" && t) {
          t.url = params.url;
          t.title = `Navigated ${params.url}`;
          return { frameId: "main" };
        }
        if (method === "Network.getCookies") {
          return { cookies };
        }
        return {};
      },
      onEvent: debuggerOnEvent,
      onDetach: debuggerOnDetach,
    },
    downloads: {
      search: async ({ limit = 30 } = {}) => [...downloads.values()].slice(-limit),
      download: async ({ url, filename }) => {
        const id = downloads.size + 1;
        const item = {
          id,
          url,
          filename: filename || `/tmp/dl-${id}.bin`,
          state: "complete",
          bytesReceived: 1024,
          totalBytes: 1024,
          mime: "application/octet-stream",
          startTime: new Date().toISOString(),
          endTime: new Date().toISOString(),
        };
        downloads.set(id, item);
        downloadsOnCreated.emit(item);
        downloadsOnChanged.emit({ id, state: { current: "complete" } });
        return id;
      },
      onCreated: downloadsOnCreated,
      onChanged: downloadsOnChanged,
    },
    cookies: {
      getAll: async () => cookies,
      set: async (c) => {
        cookies.push(c);
        return c;
      },
      remove: async ({ name }) => {
        const idx = cookies.findIndex((c) => c.name === name);
        if (idx !== -1) cookies.splice(idx, 1);
        return { name };
      },
    },
    history: {
      search: async ({ text = "" }) =>
        historyItems.filter((h) => !text || h.title.toLowerCase().includes(text.toLowerCase()) || h.url.includes(text)),
    },
    bookmarks: {
      search: async (q) => {
        const needle = typeof q === "string" ? q : q?.query || "";
        return bookmarks.filter((b) => b.title.toLowerCase().includes(needle.toLowerCase()) || b.url.includes(needle));
      },
      getRecent: async (count) => bookmarks.slice(0, count),
      create: async ({ parentId, title, url }) => {
        const bm = { id: `bm-${bookmarks.length + 1}`, parentId: parentId || "1", title, url };
        bookmarks.push(bm);
        return bm;
      },
    },
  };

  const bgCode = fs.readFileSync(path.join(PROJECT_ROOT, "extension", "background.js"), "utf8");
  const swContext = vm.createContext({
    chrome: chromeMock,
    navigator: {
      userAgent:
        brand === "brave"
          ? "Mozilla/5.0 AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36"
          : "Mozilla/5.0 AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36",
      ...(brand === "brave" ? { brave: { isBrave: async () => true } } : {}),
    },
    console,
    setTimeout: swSetTimeout,
    clearTimeout: swClearTimeout,
    Date,
    Map,
    Set,
    Promise,
    JSON,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Error,
    RegExp,
    URL,
  });
  vm.runInContext(bgCode, swContext, { filename: "extension/background.js" });

  return {
    hostProc,
    tabs,
    tabGroups,
    attachedTargets,
    downloads,
    cookies,
    bookmarks,
    createdAlarms,
    alarmsOnAlarm,
    getSidePanelBehavior: () => sidePanelBehavior,
    sendRuntimeMessage(msg) {
      return new Promise((resolve) => {
        runtimeOnMessage.emit(msg, {}, resolve);
      });
    },
    connectSidePanelPort() {
      const msgListeners = new Set();
      const discListeners = new Set();
      const portForBg = {
        name: "ag-sidepanel",
        postMessage: (m) => {
          for (const fn of [...msgListeners]) fn(m);
        },
        onMessage: { addListener: () => {} },
        onDisconnect: { addListener: (fn) => discListeners.add(fn) },
      };
      runtimeOnConnect.emit(portForBg);
      return {
        onMessage(fn) {
          msgListeners.add(fn);
        },
        disconnect() {
          for (const fn of [...discListeners]) fn();
        },
      };
    },
    debuggerOnEvent,
    debuggerOnDetach,
    downloadsOnCreated,
    downloadsOnChanged,
    async waitForSocket(timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (fs.existsSync(sockDir)) {
          const socks = fs.readdirSync(sockDir).filter((f) => f.endsWith(".sock"));
          if (socks.length > 0) {
            return path.join(sockDir, socks[0]);
          }
        }
        await new Promise((r) => setTimeout(r, 40));
      }
      throw new Error(`Timed out waiting for native host socket in ${sockDir}`);
    },
    async close() {
      envClosed = true;
      for (const t of swTimers) clearTimeout(t);
      swTimers.clear();
      try {
        hostProc.stdin.end();
      } catch {}
      await new Promise((resolve) => {
        if (hostProc.exitCode !== null) return resolve();
        const t = setTimeout(() => {
          try {
            hostProc.kill("SIGKILL");
          } catch {}
          resolve();
        }, 1500);
        hostProc.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    },
  };
}

test("Manifest, Antigravity Plugin Schema, and Browser Safety & CAPTCHA Policy verification", () => {
  // 1. Verify extension/manifest.json
  const extManifest = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "extension", "manifest.json"), "utf8"));
  assert.equal(extManifest.manifest_version, 3);
  assert.equal(extManifest.name, "Antigravity in Chrome");
  assert.equal(extManifest.version, "3.0.0");
  assert.ok(extManifest.key && extManifest.key.length > 100, "MV3 manifest must embed deterministic public key");
  assert.equal(extManifest.side_panel?.default_path, "sidepanel.html", "MV3 manifest must declare side_panel.default_path");
  assert.equal(
    extManifest.action?.default_popup,
    undefined,
    "MV3 action must omit default_popup so toolbar click opens the docked Side Panel via openPanelOnActionClick",
  );
  for (const sidePanelFile of ["sidepanel.html", "sidepanel.css", "sidepanel.js"]) {
    assert.ok(
      fs.existsSync(path.join(PROJECT_ROOT, "extension", sidePanelFile)),
      `Missing Side Panel asset ${sidePanelFile}`,
    );
  }
  for (const perm of [
    "sidePanel",
    "activeTab",
    "debugger",
    "tabs",
    "tabGroups",
    "downloads",
    "cookies",
    "storage",
    "history",
    "bookmarks",
    "webNavigation",
    "scripting",
    "nativeMessaging",
    "alarms",
    "offscreen",
  ]) {
    assert.ok(extManifest.permissions.includes(perm), `extension/manifest.json missing permission '${perm}'`);
  }
  assert.deepEqual(extManifest.host_permissions, ["<all_urls>"]);
  for (const sz of ["16", "32", "48", "128"]) {
    assert.ok(
      fs.existsSync(path.join(PROJECT_ROOT, "extension", extManifest.icons[sz])),
      `Missing extension icon ${sz}`,
    );
  }
  assert.equal(fs.existsSync("/tmp/ag_ext_key.json"), false, "/tmp/ag_ext_key.json must be deleted after embedding");

  // 2. Verify plugin/ bundle strictly adheres to Antigravity schema
  const pluginJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "plugin", "plugin.json"), "utf8"));
  const validPluginKeys = new Set([
    "name",
    "description",
    "logo",
    "suggestedPrompts",
    "displayName",
    "version",
    "author",
    "homepage",
    "repository",
    "disabled",
  ]);
  for (const key of Object.keys(pluginJson)) {
    assert.ok(validPluginKeys.has(key), `Invalid unknown key '${key}' in plugin/plugin.json`);
  }
  assert.equal(pluginJson.name, "antigravity-computer-use");
  assert.equal(pluginJson.displayName, "Antigravity Computer Control");
  assert.equal(pluginJson.version, "3.0.0");
  assert.equal(pluginJson.suggestedPrompts.length, 3);
  assert.ok(fs.existsSync(path.join(PROJECT_ROOT, "plugin", pluginJson.logo)));
  assert.equal(
    fs.existsSync(path.join(PROJECT_ROOT, "plugin", "mcp_config.json")),
    false,
    "plugin/ must NOT contain mcp_config.json so computer-use stays unprefixed",
  );
  const agentsRule = fs.readFileSync(path.join(PROJECT_ROOT, "plugin", "rules", "AGENTS.md"), "utf8");
  assert.equal(agentsRule.startsWith("---"), false, "plugin/rules/AGENTS.md must be plain markdown without frontmatter");
  assert.ok(fs.existsSync(path.join(PROJECT_ROOT, "plugin", "skills", "computer-use", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(PROJECT_ROOT, "plugin", "skills", "browser-control", "SKILL.md")));

  // 3. Verify URL safety blocker & CAPTCHA challenge detector
  assert.equal(checkBrowserUrlSafety("https://github.com/").safe, true);
  assert.equal(checkBrowserUrlSafety("about:blank").safe, true);
  assert.equal(checkBrowserUrlSafety("chrome://settings/passwords").safe, false);
  assert.equal(checkBrowserUrlSafety("brave://settings/passwords").safe, false);
  assert.equal(checkBrowserUrlSafety("edge://settings/payments").safe, false);
  assert.equal(checkBrowserUrlSafety("file:///etc/passwd").safe, false);
  assert.throws(
    () => assertSafeBrowserUrl("brave://settings/passwords"),
    /blocked by safety policy|Blocked unsafe URL/i,
  );

  const turnstileCheck = detectCaptchaChallenge({
    title: "Just a moment...",
    url: "https://protected.example.test/",
    captchaSignals: ["turnstile:iframe"],
  });
  assert.equal(turnstileCheck.detected, true);
  assert.ok(turnstileCheck.providers.includes("cloudflare-turnstile"));
  assert.match(CAPTCHA_HANDOFF_BANNER, /HANDOFF REQUIRED: Anti-bot\/CAPTCHA challenge detected/);
});

test("Native Messaging Host <-> Extension Bridge Multiplexing, Lazy Attach, Tab Groups, claimTab In-Place, finalizeSession, and expressionCacheKey", async (t) => {
  const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-bridge-e2e-"));
  const bridgeEnv = launchNativeHostWithRealExtension({
    sockDir,
    brand: "brave",
    initialTabs: [
      { id: 10, windowId: 1, active: true, title: "Personal Inbox", url: "https://mail.example.test/inbox" },
      { id: 11, windowId: 1, active: false, title: "Messy Doc 1", url: "https://docs.example.test/1" },
      { id: 12, windowId: 1, active: false, title: "Messy Doc 2", url: "https://docs.example.test/2" },
    ],
  });

  t.after(async () => {
    await bridgeEnv.close();
    fs.rmSync(sockDir, { recursive: true, force: true });
  });

  const sockPath = await bridgeEnv.waitForSocket();

  // Verify strict Unix permissions: 0700 directory and 0600 socket
  const dirMode = fs.statSync(sockDir).mode & 0o777;
  const sockMode = fs.statSync(sockPath).mode & 0o777;
  assert.equal(dirMode, 0o700, `Expected 0700 socket dir permissions, got ${dirMode.toString(8)}`);
  assert.equal(sockMode, 0o600, `Expected 0600 socket permissions, got ${sockMode.toString(8)}`);

  // 1. Verify concurrent multi-client socket multiplexing + expressionCacheKey
  const rawClientA = new ExtensionSocketClient(sockPath);
  const rawClientB = new ExtensionSocketClient(sockPath);
  await Promise.all([rawClientA.connect(), rawClientB.connect()]);
  assert.equal(rawClientA.info.browserFamily, "brave");
  assert.equal(rawClientB.info.browserName, "Brave");

  const [pingA, pingB] = await Promise.all([
    rawClientA.request("ping", {}),
    rawClientB.request("ping", {}),
  ]);
  assert.equal(pingA.pong, true);
  assert.equal(pingB.pong, true);

  await rawClientA.request("registerCachedExpression", {
    key: "test_cached_expr",
    expression: "document.readyState",
  });
  const cachedEval = await rawClientB.request("sendCdp", {
    tabId: 11,
    method: "Runtime.evaluate",
    expressionCacheKey: "test_cached_expr",
    params: { returnByValue: true },
  });
  assert.equal(cachedEval.result.value, "complete");
  await rawClientA.request("detachDebugger", { tabId: 11 });
  rawClientA.close();
  rawClientB.close();
  assert.equal(bridgeEnv.attachedTargets.size, 0, "All tabs must be detached before MCP discovery check");

  // 2. Spin up MCP Server pointed at sockDir + mock JXA returning Brave (superseded) & Chrome (unbridged -> setupHint) & Arc
  let capturedListTabsJxa = "";
  const mockJxaRunner = async (script, opSpec = {}) => {
    if (opSpec.op === "list_tabs") {
      capturedListTabsJxa = script;
      return JSON.stringify([
        {
          id: "brave",
          name: "Brave Browser",
          kind: "chromium",
          tabs: [{ id: "brave:w1:t1", windowIndex: 1, tabIndex: 1, title: "Personal Inbox", url: "https://mail.example.test/inbox" }],
        },
        {
          id: "chrome",
          name: "Google Chrome",
          kind: "chromium",
          tabs: [{ id: "chrome:w1:t1", windowIndex: 1, tabIndex: 1, title: "Unbridged Chrome Tab", url: "https://example.org" }],
        },
      ]);
    }
    return "[]";
  };

  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const { mcp, browserManager } = createComputerUseServer({
    input: clientToServer,
    output: serverToClient,
    jxaRunner: mockJxaRunner,
    extensionSockDir: sockDir,
  });
  browserManager.discoverCDPEndpoints = async () => [];
  mcp.start();
  const rpc = attachMcpRpcHelper(clientToServer, serverToClient);

  t.after(async () => {
    await mcp.shutdown();
  });

  await rpc("initialize", { protocolVersion: "2024-11-05" });

  // 3. Extension-First discovery + Lazy Attach + Arc support + setupHint on unbridged Chrome
  const listRes = await rpc("tools/call", { name: "browser_list", arguments: {} });
  const { browsers } = JSON.parse(listRes.result.content[0].text);
  assert.match(capturedListTabsJxa, /appName:\s*"Arc"/, "listMacOSAppleEventTabs must include Arc");

  const extBrave = browsers.find((b) => b.type === "extension" && b.brand === "brave");
  assert.ok(extBrave, "Brave Extension browser must be discovered first");
  assert.equal(extBrave.controlMode, "extension_cdp");
  assert.equal(extBrave.controllableViaCDP, true);
  assert.equal(
    browsers.some((b) => b.id === "brave" && b.type === "macos_app"),
    false,
    "Extension-connected Brave must supersede apple_events fallback for Brave",
  );

  const fallbackChrome = browsers.find((b) => b.id === "chrome" && b.type === "macos_app");
  assert.ok(fallbackChrome, "Unbridged Chrome with open tabs should appear in fallback list");
  assert.match(fallbackChrome.setupHint, /chrome:\/\/extensions/, "Unbridged Chromium must include setupHint");
  assert.equal(
    bridgeEnv.attachedTargets.size,
    0,
    "browser_list MUST NOT attach chrome.debugger (zero premature debugging banner)",
  );

  // 4. Inspect personal user tab -> lazy attach + claimed IN-PLACE (never moved into a Tab Group!)
  const personalTabEntry = extBrave.tabs.find((t) => t.chromeTabId === 10);
  const personalState = await rpc("tools/call", {
    name: "browser_tab_state",
    arguments: { tab_id: personalTabEntry.id },
  });
  assert.match(personalState.result.content[0].text, /Personal Inbox/);
  assert.equal(bridgeEnv.attachedTargets.has("tab:10"), true, "Debugger attaches lazily when inspected");
  assert.equal(bridgeEnv.tabs.get(10).groupId, -1, "Personal tab must stay ungrouped (claimed in-place)");

  // 5. Open 2 new agent tabs via browser_open_tab with custom Tab Group title & color
  const openRes = await rpc("tools/call", {
    name: "browser_open_tab",
    arguments: {
      browser_id: "brave",
      urls: ["https://research.example.test/one", "https://research.example.test/two"],
      group_title: "Sprint Research",
      group_color: "purple",
    },
  });
  assert.ok(!openRes.result.isError, JSON.stringify(openRes.result));

  const createdTabs = [...bridgeEnv.tabs.values()].filter((t) => t.id >= 100);
  assert.equal(createdTabs.length, 2);
  assert.equal(createdTabs[0].active, false, "Agent-created tabs must open in background by default");
  assert.equal(createdTabs[0].groupId, createdTabs[1].groupId, "Both agent tabs must share one Chrome Tab Group");
  const agentGroup = bridgeEnv.tabGroups.get(createdTabs[0].groupId);
  assert.equal(agentGroup.title, "Sprint Research");
  assert.equal(agentGroup.color, "purple");

  // 6. Rename session group, mark first agent tab deliverable, organize user messy tabs, query history & bookmarks
  const renameRes = await rpc("tools/call", {
    name: "browser_manage",
    arguments: { action: "name_session", browser_id: "brave", name: "PR Audit", color: "cyan" },
  });
  assert.equal(JSON.parse(renameRes.result.content[0].text).title, "PR Audit");
  assert.equal(agentGroup.color, "cyan");

  const refreshedList = await browserManager.listTabs({ browser: "brave" });
  const agentTab1 = refreshedList.find((t) => t.chromeTabId === createdTabs[0].id);
  await rpc("tools/call", {
    name: "browser_manage",
    arguments: { action: "mark_tab", tab_id: agentTab1.id, status: "deliverable" },
  });

  // Group messy user tabs 11 & 12 by topic
  const groupMessyRes = await rpc("tools/call", {
    name: "browser_manage",
    arguments: {
      action: "group_tabs",
      browser_id: "brave",
      tab_ids: [11, 12],
      title: "Docs Archive",
      color: "green",
      collapsed: true,
    },
  });
  const messyGroup = JSON.parse(groupMessyRes.result.content[0].text);
  assert.equal(messyGroup.title, "Docs Archive");
  assert.equal(bridgeEnv.tabs.get(11).groupId, messyGroup.groupId);

  const histRes = await rpc("tools/call", {
    name: "browser_manage",
    arguments: { action: "search_history", browser_id: "brave", query: "Release" },
  });
  assert.equal(JSON.parse(histRes.result.content[0].text).items.length, 1);

  const bmCreateRes = await rpc("tools/call", {
    name: "browser_manage",
    arguments: {
      action: "create_bookmark",
      browser_id: "brave",
      title: "Saved Deliverable",
      url: "https://research.example.test/one",
    },
  });
  assert.equal(JSON.parse(bmCreateRes.result.content[0].text).bookmark.title, "Saved Deliverable");

  // 7. Finalize session: closes unmarked scratch tab, keeps personal claimed tab & deliverable tab, detaches ALL debuggers!
  const finRes = await rpc("tools/call", {
    name: "browser_manage",
    arguments: { action: "finalize_session", browser_id: "brave" },
  });
  const finData = JSON.parse(finRes.result.content[0].text);
  assert.equal(finData.ok, true);
  assert.equal(bridgeEnv.tabs.has(10), true, "Claimed personal user tab MUST NEVER be closed on finalizeSession");
  assert.equal(bridgeEnv.tabs.has(createdTabs[0].id), true, "Deliverable tab MUST remain open on finalizeSession");
  assert.equal(bridgeEnv.tabs.has(createdTabs[1].id), false, "Unmarked scratch tab MUST close on finalizeSession");
  assert.equal(bridgeEnv.attachedTargets.size, 0, "finalizeSession MUST detach chrome.debugger so banner disappears");

  // 8. Verify socket file cleans up automatically when native host exits
  await bridgeEnv.close();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(fs.existsSync(sockPath), false, "Native host must unlink its Unix socket on exit");
});

test("Full Codex Browser Parity: Two-Tier upload_files, Downloads, Non-Blocking JS Dialogs + beforeunload, Iframe Offsets + OOPIF frameLocator, 500-Entry Ring Buffers, Cookies/Storage, Take Over & CAPTCHA Handoff", async (t) => {
  // 1. Direct unit check on BUILD_AX_SNAPSHOT_EXPR same-origin <iframe> coordinate accumulation
  const makeFrameNode = (tag, rect, extra = {}) => ({
    nodeType: 1,
    tagName: tag.toUpperCase(),
    id: extra.id || "",
    className: extra.className || "",
    clientLeft: extra.clientLeft || 0,
    clientTop: extra.clientTop || 0,
    clientWidth: rect.width,
    clientHeight: rect.height,
    children: extra.children || [],
    childNodes: extra.children || [],
    innerText: extra.text || "",
    textContent: extra.text || "",
    contentDocument: extra.contentDocument || null,
    getAttribute: (k) => extra.attrs?.[k] ?? null,
    hasAttribute: (k) => Boolean(extra.attrs && k in extra.attrs),
    getBoundingClientRect: () => ({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
    }),
  });

  const iframeBtn = makeFrameNode(
    "button",
    { left: 30, top: 40, width: 100, height: 32 },
    { id: "inner-pay", text: "Confirm Payment" },
  );
  const iframeBody = makeFrameNode("body", { left: 0, top: 0, width: 400, height: 300 }, { children: [iframeBtn] });
  const iframeEl = makeFrameNode(
    "iframe",
    { left: 200, top: 150, width: 400, height: 300 },
    {
      id: "same-origin-frame",
      clientLeft: 4,
      clientTop: 6,
      contentDocument: { body: iframeBody },
    },
  );
  const topBody = makeFrameNode("body", { left: 0, top: 0, width: 1280, height: 800 }, { children: [iframeEl] });
  const iframeSandbox = vm.createContext({
    window: null,
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    document: {
      title: "Iframe Host",
      body: topBody,
      documentElement: topBody,
      activeElement: null,
      querySelectorAll: () => [],
    },
    location: { href: "https://shop.example.test/checkout" },
    innerWidth: 1280,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1", cursor: "pointer" }),
  });
  iframeSandbox.window = iframeSandbox;
  const iframeSnap = vm.runInContext(BUILD_AX_SNAPSHOT_EXPR(), iframeSandbox);
  const joinedLines = iframeSnap.lines.join("\n");
  // Expected top-level coords: (200 + 4 + 30, 150 + 6 + 40) = @(234,196 100x32)
  assert.match(
    joinedLines,
    /button "Confirm Payment" @\(234,196 100x32\)/,
    `Same-origin iframe child coordinates must accumulate iframe rect + border offset; got:\n${joinedLines}`,
  );

  // 2. Verify Active-Tab 2px Glow + [Antigravity · Take Over] ShadowRoot indicator & screenshot hiding
  const domById = new Map();
  const makeOverlayEl = (tag, ns = "http://www.w3.org/1999/xhtml") => {
    const classes = new Set();
    let clickHandler = null;
    let idVal = "";
    let ownText = "";
    const el = {
      nodeType: 1,
      namespaceURI: ns,
      tagName: ns.includes("svg") ? tag : tag.toUpperCase(),
      get id() {
        return idVal;
      },
      set id(v) {
        idVal = String(v || "");
        if (idVal) domById.set(idVal, this);
      },
      get className() {
        return [...classes].join(" ");
      },
      set className(v) {
        classes.clear();
        String(v || "")
          .split(/\s+/)
          .filter(Boolean)
          .forEach((k) => classes.add(k));
      },
      get textContent() {
        return ownText + this.children.map((c) => c.textContent || "").join("");
      },
      set textContent(v) {
        ownText = String(v ?? "");
        this.children = [];
        this.childNodes = [];
      },
      style: { cssText: "", display: "", opacity: "", transform: "", filter: "" },
      attributes: new Map(),
      children: [],
      childNodes: [],
      shadowRoot: null,
      isConnected: true,
      classList: {
        add: (...tks) => tks.forEach((k) => classes.add(k)),
        remove: (...tks) => tks.forEach((k) => classes.delete(k)),
        contains: (k) => classes.has(k),
      },
      setAttribute(k, v) {
        this.attributes.set(k, String(v));
        if (k === "id") {
          this.id = String(v);
        } else if (k === "class") {
          this.className = String(v);
        }
      },
      getAttribute(k) {
        return this.attributes.get(k) ?? null;
      },
      appendChild(c) {
        this.children.push(c);
        this.childNodes.push(c);
        if (c && c.id) domById.set(c.id, c);
        return c;
      },
      attachShadow() {
        this.shadowRoot = makeOverlayEl("shadow-root");
        return this.shadowRoot;
      },
      addEventListener(ev, fn) {
        if (ev === "click") clickHandler = fn;
      },
      triggerClick() {
        if (clickHandler) clickHandler({ preventDefault() {}, stopPropagation() {} });
      },
      remove() {},
      querySelector(sel) {
        return this.querySelectorAll(sel)[0] ?? null;
      },
      querySelectorAll(sel) {
        const out = [];
        for (const c of this.children) {
          if (sel.startsWith(".") && c.classList.contains(sel.slice(1))) out.push(c);
          else if (c.tagName?.toLowerCase() === sel.toLowerCase()) out.push(c);
          if (c.querySelectorAll) out.push(...c.querySelectorAll(sel));
        }
        return out;
      },
    };
    return el;
  };
  let takeOverPayloads = [];
  const overlayDoc = makeOverlayEl("html");
  const overlaySandbox = vm.createContext({
    window: null,
    performance: { now: () => 100 },
    document: {
      documentElement: overlayDoc,
      createElement: (t) => makeOverlayEl(t),
      createElementNS: (ns, t) => makeOverlayEl(t, ns),
      getElementById: (id) => domById.get(id) ?? null,
    },
    innerWidth: 1280,
    innerHeight: 800,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    __agCuaControl: (payload) => takeOverPayloads.push(JSON.parse(payload)),
  });
  overlaySandbox.window = overlaySandbox;

  const indOn = vm.runInContext(buildSetActiveTabIndicatorExpr(true), overlaySandbox);
  assert.equal(indOn.active, true);
  const hostShadow = domById.get("__ag_cua_cursor_host__").shadowRoot;
  assert.equal(hostShadow.querySelector(".ag-session-chrome").style.display, "block");
  assert.match(hostShadow.querySelector(".ag-takeover-btn").textContent, /Antigravity · Take Over/);

  // Automatically hidden during screenshot prep and restored afterward!
  vm.runInContext(buildPrepareBrowserCursorForScreenshotExpr(true, { awaitFrame: false }), overlaySandbox);
  assert.equal(hostShadow.querySelector(".ag-session-chrome").style.display, "none");
  vm.runInContext(buildPrepareBrowserCursorForScreenshotExpr(false), overlaySandbox);
  assert.equal(hostShadow.querySelector(".ag-session-chrome").style.display, "block");

  // Clicking Take Over invokes __agCuaControl binding and hides session chrome
  hostShadow.querySelector(".ag-takeover-btn").triggerClick();
  assert.equal(takeOverPayloads.length, 1);
  assert.equal(takeOverPayloads[0].action, "take_over");
  assert.equal(hostShadow.querySelector(".ag-session-chrome").style.display, "none");

  // 3. Full End-to-End CDP Parity Suite via Real Extension Bridge
  const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-parity-e2e-"));
  const tmpUploadFile = path.join(sockDir, "sample-upload.txt");
  fs.writeFileSync(tmpUploadFile, "Antigravity Tier-2 DataTransfer Payload 🚀\n", "utf8");

  // Track virtual page state inside onDebuggerCommand
  const pageState = {
    rejectCdpFileUrlUpload: false,
    tier1UploadedFiles: null,
    chooserUploadedFiles: null,
    tier2UploadedFiles: null,
    dropzoneDroppedFiles: null,
    openDialogOnClick: false,
    openBeforeUnloadOnNav: false,
    handledDialogs: [],
    localStorage: {},
    sessionStorage: {},
    oopifClicked: 0,
    captchaActive: false,
  };

  // Real VM sandbox for Tier-2 DataTransfer staging & Web Storage expressions
  const uploadInputFiles = [];
  const dropzoneEvents = [];
  const pageVm = vm.createContext({
    window: null,
    atob: (b64) => Buffer.from(b64, "base64").toString("binary"),
    Uint8Array,
    File: class File {
      constructor(parts, name, opts = {}) {
        this.name = name;
        this.size = parts.reduce((n, p) => n + p.byteLength, 0);
        this.type = opts.type || "";
        this.text = Buffer.from(parts[0]).toString("utf8");
      }
    },
    DataTransfer: class DataTransfer {
      constructor() {
        const list = [];
        this.items = { add: (f) => list.push(f) };
        this.files = list;
      }
    },
    Event: class Event {
      constructor(type, opts) {
        this.type = type;
        Object.assign(this, opts);
      }
    },
    DragEvent: class DragEvent {
      constructor(type, opts) {
        this.type = type;
        this.dataTransfer = opts?.dataTransfer;
      }
    },
    localStorage: {
      _map: new Map(),
      get length() { return this._map.size; },
      key(i) { return [...this._map.keys()][i] ?? null; },
      getItem(k) { return this._map.has(k) ? this._map.get(k) : null; },
      setItem(k, v) { this._map.set(k, String(v)); },
      removeItem(k) { this._map.delete(k); },
      clear() { this._map.clear(); },
    },
    sessionStorage: {
      _map: new Map(),
      get length() { return this._map.size; },
      key(i) { return [...this._map.keys()][i] ?? null; },
      getItem(k) { return this._map.has(k) ? this._map.get(k) : null; },
      setItem(k, v) { this._map.set(k, String(v)); },
      removeItem(k) { this._map.delete(k); },
      clear() { this._map.clear(); },
    },
    document: {
      querySelectorAll(sel) {
        const m = this.querySelector(sel);
        return m ? [m] : [];
      },
      querySelector(sel) {
        if (sel === "#file-input") {
          return {
            tagName: "INPUT",
            type: "file",
            files: null,
            isConnected: true,
            getBoundingClientRect: () => ({ left: 80, top: 80, width: 40, height: 40 }),
            dispatchEvent(ev) {
              if (ev.type === "change") {
                uploadInputFiles.splice(0, uploadInputFiles.length, ...this.files);
              }
            },
          };
        }
        if (sel === "#dropzone") {
          return {
            tagName: "DIV",
            isConnected: true,
            getBoundingClientRect: () => ({ left: 160, top: 80, width: 120, height: 80 }),
            querySelector: () => null,
            dispatchEvent(ev) {
              if (ev.type === "drop") {
                dropzoneEvents.push(...(ev.dataTransfer?.files || []));
              }
            },
          };
        }
        return null;
      },
    },
  });
  pageVm.window = pageVm;

  let pendingDialogPromiseResolve = null;

  const bridgeEnv = launchNativeHostWithRealExtension({
    sockDir,
    brand: "brave",
    initialTabs: [
      { id: 20, windowId: 1, active: true, title: "Parity Workbench", url: "https://workbench.example.test/app" },
    ],
    onDebuggerCommand: async (Debuggee, method, params, helpers) => {
      // Child OOPIF target command
      if (Debuggee.targetId === "oopif-frame-99") {
        if (method === "Runtime.evaluate") {
          const expr = String(params.expression || "");
          if (expr.includes("#pay-now")) {
            return {
              result: {
                value: { ok: true, x: 50, y: 30, rect: { x: 10, y: 10, width: 80, height: 40 }, tag: "BUTTON" },
              },
            };
          }
          return { result: { value: "OOPIF_EVAL_OK" } };
        }
        return {};
      }

      if (method === "Target.setAutoAttach") {
        // Advertise cross-origin OOPIF child target
        helpers.emitCdpEvent(Debuggee, "Target.attachedToTarget", {
          sessionId: "oopif-session-99",
          targetInfo: {
            targetId: "oopif-frame-99",
            type: "iframe",
            url: "https://payments.stripe-mock.example.test/frame",
          },
        });
        return {};
      }

      if (method === "Page.handleJavaScriptDialog") {
        pageState.handledDialogs.push(params);
        helpers.emitCdpEvent(Debuggee, "Page.javascriptDialogClosed", {
          result: Boolean(params.accept),
          userInput: params.promptText || "",
        });
        if (pendingDialogPromiseResolve) {
          const r = pendingDialogPromiseResolve;
          pendingDialogPromiseResolve = null;
          r();
        }
        return {};
      }

      if (method === "Page.navigate") {
        if (pageState.openBeforeUnloadOnNav) {
          pageState.openBeforeUnloadOnNav = false;
          // Simulate browser pausing Page.navigate on beforeunload until auto-accepted!
          const waitAccept = new Promise((resolve) => {
            pendingDialogPromiseResolve = resolve;
          });
          setTimeout(() => {
            helpers.emitCdpEvent(Debuggee, "Page.javascriptDialogOpening", {
              type: "beforeunload",
              message: "Changes you made may not be saved.",
              url: "https://workbench.example.test/app",
            });
          }, 15);
          await waitAccept;
        }
        const t = helpers.tabs.get(Debuggee.tabId);
        if (t) t.url = params.url;
        return { frameId: "main" };
      }

      if (method === "DOM.setFileInputFiles") {
        if (pageState.rejectCdpFileUrlUpload) {
          throw new Error("Not allowed to load local resource: file:///restricted");
        }
        if (params.backendNodeId === 777) {
          pageState.chooserUploadedFiles = params.files;
        } else {
          pageState.tier1UploadedFiles = params.files;
        }
        return {};
      }

      if (method === "DOM.describeNode") {
        return { node: { frameId: "oopif-frame-99" } };
      }

      if (method === "Runtime.callFunctionOn") {
        const decl = String(params.functionDeclaration || "");
        if (decl.includes("this.type === 'file'")) {
          return { result: { value: params.objectId === "obj-file-input" } };
        }
        if (decl.includes("sameOrigin")) {
          return {
            result: {
              value: {
                left: 300,
                top: 220,
                width: 320,
                height: 180,
                src: "https://payments.stripe-mock.example.test/frame",
                sameOrigin: false,
              },
            },
          };
        }
        return { result: { value: true } };
      }

      if (method === "Input.dispatchMouseEvent") {
        if (params.type === "mousePressed" && params.x === 350 && params.y === 250) {
          pageState.oopifClicked++;
        }
        if (params.type === "mousePressed" && params.x === 140 && params.y === 90) {
          // Chooser trigger button!
          helpers.emitCdpEvent(Debuggee, "Page.fileChooserOpened", {
            mode: "selectSingle",
            backendNodeId: 777,
          });
        }
        if (params.type === "mousePressed" && params.x === 420 && params.y === 90) {
          // Download button!
          setTimeout(async () => {
            await bridgeEnv.downloads;
            const id = 88;
            const item = {
              id,
              url: "blob:https://workbench.example.test/report-csv",
              filename: path.join(sockDir, "quarterly-report.csv"),
              state: "complete",
              bytesReceived: 4096,
              totalBytes: 4096,
              mime: "text/csv",
              startTime: new Date().toISOString(),
              endTime: new Date().toISOString(),
            };
            bridgeEnv.downloads.set(id, item);
            bridgeEnv.downloadsOnChanged.emit({ id, state: { current: "complete" } });
          }, 30);
        }
        if (params.type === "mouseReleased" && pageState.openDialogOnClick) {
          pageState.openDialogOnClick = false;
          // Simulate real Chrome pausing mouseReleased until JS dialog is handled!
          const waitHandled = new Promise((resolve) => {
            pendingDialogPromiseResolve = resolve;
          });
          setTimeout(() => {
            helpers.emitCdpEvent(Debuggee, "Page.javascriptDialogOpening", {
              type: "prompt",
              message: "Enter deployment tag:",
              defaultPrompt: "v2.0.0",
              url: "https://workbench.example.test/app",
            });
          }, 15);
          await waitHandled;
        }
        return {};
      }

      if (method === "Network.getResponseBody") {
        return {
          body: JSON.stringify({ ok: true, reqId: params.requestId }),
          base64Encoded: false,
        };
      }

      if (method === "Network.setCookies") {
        for (const c of params.cookies || []) bridgeEnv.cookies.push(c);
        return {};
      }

      if (method === "Network.deleteCookies") {
        const idx = bridgeEnv.cookies.findIndex((c) => c.name === params.name);
        if (idx !== -1) bridgeEnv.cookies.splice(idx, 1);
        return {};
      }

      if (method === "Runtime.evaluate") {
        const expr = String(params.expression || "");
        if (expr === "document.readyState") return { result: { value: "complete" } };
        if (expr.includes("iframe#pay-frame")) {
          return { result: { objectId: "obj-oopif-iframe" } };
        }
        if (expr.includes("#file-input") && !expr.includes("__agCuaUploadStaging") && !expr.includes("targetSpec")) {
          return { result: { objectId: "obj-file-input" } };
        }
        if (expr.includes("#dropzone") && !expr.includes("__agCuaUploadStaging") && !expr.includes("targetSpec")) {
          return { result: { objectId: "obj-dropzone" } };
        }
        if (expr.includes("__agCuaUploadStaging") || expr.includes("window.localStorage") || expr.includes("window.sessionStorage")) {
          const val = vm.runInContext(expr, pageVm);
          return { result: { value: val } };
        }
        if (expr.includes("const { targetSpec, focus } =")) {
          if (expr.includes("#choose-btn")) {
            return { result: { value: { ok: true, x: 140, y: 90, rect: { x: 100, y: 70, width: 80, height: 40 }, tag: "BUTTON" } } };
          }
          if (expr.includes("#dl-btn")) {
            return { result: { value: { ok: true, x: 420, y: 90, rect: { x: 380, y: 70, width: 80, height: 40 }, tag: "BUTTON" } } };
          }
          if (expr.includes("#prompt-btn")) {
            return { result: { value: { ok: true, x: 260, y: 90, rect: { x: 220, y: 70, width: 80, height: 40 }, tag: "BUTTON" } } };
          }
          return { result: { value: { ok: true, x: 100, y: 100, rect: { x: 80, y: 80, width: 40, height: 40 }, tag: "INPUT" } } };
        }
        if (expr.includes('Object.defineProperty(window, "__agCuaMap"')) {
          return {
            result: {
              value: {
                title: "Parity Workbench",
                url: helpers.tabs.get(Debuggee.tabId)?.url || "https://workbench.example.test/app",
                viewport: { width: 1280, height: 800 },
                scroll: { x: 0, y: 0 },
                lines: [`  [1] button "Open Prompt" @(220,70 80x40)`],
                elementCount: 1,
                captchaSignals: pageState.captchaActive ? ["recaptcha:iframe"] : [],
              },
            },
          };
        }
        return { result: { value: { ok: true } } };
      }

      return undefined;
    },
  });

  await bridgeEnv.waitForSocket();

  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const { mcp, browserManager } = createComputerUseServer({
    input: clientToServer,
    output: serverToClient,
    jxaRunner: async () => "[]",
    extensionSockDir: sockDir,
  });
  browserManager.discoverCDPEndpoints = async () => [];
  mcp.start();
  const rpc = attachMcpRpcHelper(clientToServer, serverToClient);

  t.after(async () => {
    await mcp.shutdown();
    await bridgeEnv.close();
    fs.rmSync(sockDir, { recursive: true, force: true });
  });

  await rpc("initialize", { protocolVersion: "2024-11-05" });
  const tabs = await browserManager.listTabs({ browser: "brave" });
  const tabId = tabs[0].id;

  // Trigger initial attach
  await rpc("tools/call", { name: "browser_tab_state", arguments: { tab_id: tabId } });

  // A. Tier-1 direct upload, File-Chooser button upload, AND automatic Tier-2 DataTransfer fallback + custom dropzone!
  const upTier1 = await rpc("tools/call", {
    name: "browser_tab_action",
    arguments: { tab_id: tabId, action: "upload_files", selector: "#file-input", files: [tmpUploadFile], return_state: false },
  });
  assert.match(upTier1.result.content[0].text, /\(cdp_dom\)/);
  assert.deepEqual(pageState.tier1UploadedFiles, [tmpUploadFile]);

  const upChooser = await rpc("tools/call", {
    name: "browser_tab_action",
    arguments: { tab_id: tabId, action: "upload_files", trigger_selector: "#choose-btn", files: [tmpUploadFile], return_state: false },
  });
  assert.match(upChooser.result.content[0].text, /\(file_chooser_cdp\)/);
  assert.deepEqual(pageState.chooserUploadedFiles, [tmpUploadFile]);

  // Force CDP file URL error -> must seamlessly fall back to Tier-2 chunked base64 DataTransfer File construction!
  pageState.rejectCdpFileUrlUpload = true;
  const upTier2 = await rpc("tools/call", {
    name: "browser_tab_action",
    arguments: { tab_id: tabId, action: "upload_files", selector: "#file-input", files: [tmpUploadFile], return_state: false },
  });
  assert.match(upTier2.result.content[0].text, /\(data_?transfer\)/);
  assert.equal(uploadInputFiles.length, 1);
  assert.equal(uploadInputFiles[0].name, "sample-upload.txt");
  assert.equal(uploadInputFiles[0].text, "Antigravity Tier-2 DataTransfer Payload 🚀\n");

  // Custom non-input #dropzone upload via dragenter/dragover/drop DataTransfer
  const upDropzone = await rpc("tools/call", {
    name: "browser_tab_action",
    arguments: { tab_id: tabId, action: "upload_files", selector: "#dropzone", files: [tmpUploadFile], return_state: false },
  });
  assert.match(upDropzone.result.content[0].text, /\(data_?transfer\)/);
  assert.equal(dropzoneEvents.length, 1);
  assert.equal(dropzoneEvents[0].name, "sample-upload.txt");

  // B. File Downloads (wait_for_download + list_downloads on blob: URL)
  const dlRes = await rpc("tools/call", {
    name: "browser_tab_action",
    arguments: { tab_id: tabId, action: "wait_for_download", click_selector: "#dl-btn", timeout_ms: 5000, return_state: false },
  });
  assert.ok(!dlRes.result.isError, JSON.stringify(dlRes.result));
  assert.match(dlRes.result.content[0].text, /quarterly-report\.csv/);

  const listDlRes = await rpc("tools/call", {
    name: "browser_tab_action",
    arguments: { tab_id: tabId, action: "list_downloads" },
  });
  assert.equal(JSON.parse(listDlRes.result.content[0].text).downloads.length, 1);

  // C. Non-blocking JS Dialogs (prompt + beforeunload auto-accept)
  pageState.openDialogOnClick = true;
  const t0 = Date.now();
  const promptClick = await rpc("tools/call", {
    name: "browser_tab_action",
    arguments: { tab_id: tabId, action: "click", selector: "#prompt-btn" },
  });
  const clickElapsed = Date.now() - t0;
  assert.ok(clickElapsed < 1500, `Click opening JS dialog must return immediately without 15s hang (took ${clickElapsed}ms)`);
  assert.match(promptClick.result.content[1].text, /\[JS DIALOG OPEN: type="prompt" message="Enter deployment tag:"/);

  const handleRes = await rpc("tools/call", {
    name: "browser_tab_action",
    arguments: { tab_id: tabId, action: "handle_dialog", accept: true, prompt_text: "v2.0.0-rc1", return_state: false },
  });
  assert.ok(!handleRes.result.isError);
  assert.equal(pageState.handledDialogs.at(-1).promptText, "v2.0.0-rc1");

  // beforeunload auto-accept on agent goto
  pageState.openBeforeUnloadOnNav = true;
  const gotoRes = await rpc("tools/call", {
    name: "browser_tab_action",
    arguments: { tab_id: tabId, action: "goto", url: "https://workbench.example.test/next", return_state: false },
  });
  assert.ok(!gotoRes.result.isError, JSON.stringify(gotoRes.result));
  assert.equal(pageState.handledDialogs.at(-1).accept, true, "beforeunload must auto-accept on agent navigation");

  // D. 500-Entry Console & Network Ring Buffers + Cookies + Storage + Cross-Origin OOPIF frameLocator via cua_repl (`js`)
  for (let i = 1; i <= 525; i++) {
    bridgeEnv.debuggerOnEvent.emit({ tabId: 20 }, "Runtime.consoleAPICalled", {
      type: i % 10 === 0 ? "error" : "log",
      timestamp: Date.now(),
      args: [{ value: `log-entry-${i}` }],
    });
    const reqId = `req-${i}`;
    bridgeEnv.debuggerOnEvent.emit({ tabId: 20 }, "Network.requestWillBeSent", {
      requestId: reqId,
      request: { url: `https://api.example.test/items/${i}`, method: "GET" },
      type: "Fetch",
    });
    bridgeEnv.debuggerOnEvent.emit({ tabId: 20 }, "Network.responseReceived", {
      requestId: reqId,
      response: { url: `https://api.example.test/items/${i}`, status: i === 525 ? 500 : 200, mimeType: "application/json" },
    });
    bridgeEnv.debuggerOnEvent.emit({ tabId: 20 }, "Network.loadingFinished", {
      requestId: reqId,
      encodedDataLength: 128,
    });
  }
  await new Promise((r) => setTimeout(r, 60));

  const replParityRes = await rpc("tools/call", {
    name: "js",
    arguments: {
      code: `
        const tab = await cua.getTab(${JSON.stringify(tabId)}, { emit: false });
        const allLogs = tab.logs({ limit: 500 });
        const errLogs = tab.logs({ level: "error", limit: 500 });
        const allNet = tab.network({ limit: 500 });
        const failedNet = tab.network({ status: 500 });
        const body525 = await tab.networkBody("req-525");

        await tab.setCookies([{ name: "theme", value: "midnight", domain: "example.test" }]);
        const ck = await tab.cookies();

        await tab.setStorage({ type: "local", entries: { draft: "saved-v2" } });
        const st = await tab.storage({ type: "local", key: "draft" });

        // Cross-origin OOPIF frameLocator!
        const payFrame = tab.frameLocator("iframe#pay-frame");
        const frameVal = await payFrame.evaluate("window.__oopifCheck");
        await payFrame.click("#pay-now");

        return {
          totalLogs: allLogs.totalBuffered,
          oldestLog: allLogs.logs[0].text,
          newestLog: allLogs.logs.at(-1).text,
          errCount: errLogs.logs.length,
          totalNet: allNet.totalBuffered,
          failedStatus: failedNet.requests[0]?.status,
          bodyReqId: JSON.parse(body525.body).reqId,
          cookieNames: ck.cookies.map((c) => c.name),
          storageVal: st.value,
          frameVal,
        };
      `,
    },
  });
  assert.ok(!replParityRes.result.isError, JSON.stringify(replParityRes.result));
  const replOut = JSON.parse(replParityRes.result.content[0].text);
  assert.equal(replOut.totalLogs, 500, "Console ring buffer must cap at 500 entries");
  assert.equal(replOut.oldestLog, "log-entry-26");
  assert.equal(replOut.newestLog, "log-entry-525");
  assert.equal(replOut.totalNet, 500, "Network ring buffer must cap at 500 entries");
  assert.equal(replOut.failedStatus, 500);
  assert.equal(replOut.bodyReqId, "req-525");
  assert.ok(replOut.cookieNames.includes("theme"));
  assert.equal(replOut.storageVal, "saved-v2");
  assert.equal(replOut.frameVal, "OOPIF_EVAL_OK");
  assert.equal(pageState.oopifClicked, 1, "OOPIF frameLocator.click must dispatch top-level offset coordinates");

  // E. CAPTCHA Handoff Banner & User Take Over / canceled_by_user detach
  pageState.captchaActive = true;
  const captchaState = await rpc("tools/call", {
    name: "browser_tab_state",
    arguments: { tab_id: tabId, disable_diff: true },
  });
  assert.match(
    captchaState.result.content[0].text,
    /\[HANDOFF REQUIRED: Anti-bot\/CAPTCHA challenge detected — do not attempt to solve; call mark_tab status='handoff' and ask the user\]/,
  );

  // Simulate user clicking "Cancel" on Brave's debugger infobar (canceled_by_user)
  const ctrl = await browserManager.getTab(tabId);
  bridgeEnv.debuggerOnDetach.emit({ tabId: 20 }, "canceled_by_user");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ctrl.takenOverByUser, true, "canceled_by_user detach must record takenOverByUser on tab controller");
});

test("Docked Side Panel Chat Bar, Persistent agy ACP Bridge, One-Way Session Rule, Permission Prompts, Simultaneous Desktop MCP Control, and Scheduled Tasks", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-sidepanel-acp-"));
  const sockDir = path.join(tmpDir, "socks");
  const chromeSessionsFile = path.join(tmpDir, "chrome-sessions.json");
  const mockAgyPath = path.join(tmpDir, "mock-agy");
  const acpLogPath = path.join(tmpDir, "acp-invocations.json");

  // Deterministic Node mock of `agy` supporting `agy models` and `agy acp --app-data-dir antigravity`
  const mockAgyScript = `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const args = process.argv.slice(2);
if (args[0] === "models") {
  console.log("gemini-4-carbon-medium (Gemini 4 Carbon (Medium))");
  console.log("gemini-3.8-flash-low (Gemini 3.8 Flash (Low))");
  process.exit(0);
}
if (args[0] !== "acp") {
  process.exit(1);
}

const logPath = ${JSON.stringify(acpLogPath)};
const sessions = new Map();
// Seed a pre-existing Desktop-originated conversation (simulating Antigravity.app chat)
sessions.set("desktop-conv-9999", {
  cwd: "/",
  title: "Desktop Only Conversation",
  history: [{ promptText: "From desktop", replyText: "Desktop reply" }],
});

let sessionCounter = 1;
let permCounter = 1;
const pendingPerms = new Map();
const log = { argv: args, prompts: [] };
const flushLog = () => fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
flushLog();

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);

  // Response to server-initiated permission request
  if (msg.id !== undefined && !msg.method && pendingPerms.has(String(msg.id))) {
    const resFn = pendingPerms.get(String(msg.id));
    pendingPerms.delete(String(msg.id));
    resFn(msg.result);
    return;
  }

  const { id, method, params } = msg;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, embeddedContext: true },
          sessionCapabilities: { resume: {}, close: {}, load: {}, list: {} },
        },
        agentInfo: { name: "Mock Antigravity ACP Server", version: "1.5.5" },
      },
    });
    return;
  }

  if (method === "session/new") {
    const sid = \`chrome-sess-\${sessionCounter++}\`;
    sessions.set(sid, {
      cwd: params?.cwd || "/",
      modeId: "auto",
      modelId: "gemini-4-carbon-medium",
      systemAppend: params?._meta?.antigravity?.systemPrompt?.append || "",
      history: [],
    });
    send({
      jsonrpc: "2.0",
      id,
      result: {
        sessionId: sid,
        models: {
          currentModelId: "gemini-4-carbon-medium",
          availableModels: [
            { modelId: "gemini-4-carbon-medium", name: "Gemini 4 Carbon (Medium)" },
            { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
          ],
        },
        modes: {
          currentModeId: "auto",
          availableModes: [
            { id: "auto", name: "Auto" },
            { id: "default", name: "Ask" },
            { id: "plan", name: "Plan" },
          ],
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "plan", description: "Plan carefully" }],
        },
      },
    });
    return;
  }

  if (method === "session/set_mode") {
    const s = sessions.get(params.sessionId);
    if (s) s.modeId = params.modeId;
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (method === "session/set_model") {
    const s = sessions.get(params.sessionId);
    if (s) s.modelId = params.modelId;
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (method === "session/resume" || method === "session/close") {
    send({ jsonrpc: "2.0", id, result: { sessionId: params?.sessionId } });
    return;
  }

  if (method === "session/load") {
    const s = sessions.get(params.sessionId);
    if (!s) {
      send({ jsonrpc: "2.0", id, error: { code: -32004, message: "Not found" } });
      return;
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: params.sessionId,
        update: { sessionUpdate: "session_info_update", title: s.title || "Loaded Chrome Chat" },
      },
    });
    for (const turn of s.history) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: turn.promptText } },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: turn.replyText } },
        },
      });
    }
    send({ jsonrpc: "2.0", id, result: { sessionId: params.sessionId } });
    return;
  }

  if (method === "session/prompt") {
    const sid = params.sessionId;
    const s = sessions.get(sid);
    const blocks = params.prompt || [];
    const textBlock = blocks.find((b) => b.type === "text")?.text || "";
    const hasImage = blocks.some((b) => b.type === "image" && b.data);
    log.prompts.push({ sessionId: sid, hasImage, modeId: s?.modeId, text: textBlock });
    flushLog();

    // Emit auto-generated conversation title (like Antigravity Desktop store!)
    s.title = "Brave Page Comparison";
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: { sessionUpdate: "session_info_update", title: s.title },
      },
    });

    // Emit thought chunk
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Comparing attached Brave tabs..." } },
      },
    });

    // If session is in "default" (Ask) mode, request inline permission first!
    let permDecision = "auto";
    if (s?.modeId === "default") {
      const pId = String(permCounter++);
      const outcomePromise = new Promise((res) => pendingPerms.set(pId, res));
      send({
        jsonrpc: "2.0",
        id: pId,
        method: "session/request_permission",
        params: {
          sessionId: sid,
          toolCall: {
            toolCallId: "tc-perm-1",
            name: "browser_tab_action",
            title: "Click Submit on Brave Tab #10",
            args: { action: "click", element_index: 1 },
          },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        },
      });
      const permRes = await outcomePromise;
      permDecision = permRes?.outcome?.optionId || "cancelled";
    }

    // Emit tool call & completion
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-1",
          name: "read_page_context",
          title: "Read active Brave tab",
          status: "in_progress",
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          name: "read_page_context",
          title: "Read active Brave tab",
          status: "completed",
        },
      },
    });

    const replyText = \`Summary ready (image=\${hasImage}, perm=\${permDecision})\`;
    s.history.push({ promptText: textBlock, replyText });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: replyText } },
      },
    });

    send({
      jsonrpc: "2.0",
      id,
      result: {
        stopReason: "end_turn",
        usage: { inputTokens: 120, outputTokens: 18, totalTokens: 138 },
      },
    });
  }
});
`;
  fs.writeFileSync(mockAgyPath, mockAgyScript, { mode: 0o755 });
  fs.chmodSync(mockAgyPath, 0o755);

  const bridgeEnv = launchNativeHostWithRealExtension({
    sockDir,
    brand: "brave",
    extraHostEnv: {
      AGY_BIN: mockAgyPath,
      AG_ACP_APP_DATA_DIR: "antigravity",
      AG_ACP_DEFAULT_CWD: tmpDir,
      AG_CHROME_SESSIONS_FILE: chromeSessionsFile,
      AG_MOCK_OPEN_DESKTOP: "1",
    },
    initialTabs: [
      { id: 10, windowId: 1, active: true, title: "Pricing Tier A", url: "https://saas.example.test/pricing-a" },
      { id: 11, windowId: 1, active: false, title: "Pricing Tier B", url: "https://saas.example.test/pricing-b" },
    ],
  });

  t.after(async () => {
    await bridgeEnv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const sockPath = await bridgeEnv.waitForSocket();

  // 1. Verify `openPanelOnActionClick: true` was set automatically on boot
  assert.equal(
    bridgeEnv.getSidePanelBehavior()?.openPanelOnActionClick,
    true,
    "Extension must configure chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })",
  );

  // 2. Connect live Side Panel port & run `sidepanel:init`
  const spEvents = [];
  const spPort = bridgeEnv.connectSidePanelPort();
  spPort.onMessage((m) => spEvents.push(m));

  const initRes = await bridgeEnv.sendRuntimeMessage({ type: "sidepanel:init" });
  assert.equal(initRes.ok, true);
  assert.equal(initRes.agentStatus.ok, true);
  assert.equal(initRes.agentStatus.agyFound, true);
  assert.equal(initRes.agentStatus.acpReady, true);
  assert.ok(initRes.shortcuts.builtin.some((s) => s.command === "summarize"));

  // Verify `agy acp --app-data-dir antigravity` was invoked so Chrome chats share Antigravity Desktop's store
  const bootLog = JSON.parse(fs.readFileSync(acpLogPath, "utf8"));
  assert.deepEqual(bootLog.argv, ["acp", "--app-data-dir", "antigravity"]);

  // 3. Send Chat Mode prompt with Active Tab (#10) + @-Mentioned Tab (#11) + Screenshot
  const shotRes = await bridgeEnv.sendRuntimeMessage({ type: "sidepanel:captureScreenshot", windowId: 1 });
  assert.equal(shotRes.ok, true);

  const turn1Res = await bridgeEnv.sendRuntimeMessage({
    type: "sidepanel:sendPrompt",
    payload: {
      requestId: "req-turn-1",
      sessionId: null,
      userText: "Compare Pricing Tier A and Pricing Tier B.",
      interactionMode: "chat",
      permissionMode: "auto",
      modelId: "gemini-4-carbon-medium",
      includeActiveTab: true,
      activeTabId: 10,
      mentionedTabIds: [11],
      screenshotBase64: shotRes.base64,
    },
  });

  assert.equal(turn1Res.ok, true);
  assert.equal(turn1Res.sessionId, "chrome-sess-1");
  assert.equal(turn1Res.title, "Brave Page Comparison");

  // Zero debugger banner in Chat Mode!
  assert.equal(
    bridgeEnv.attachedTargets.size,
    0,
    "Chat Mode page reading must NOT attach chrome.debugger (zero debugging banner)",
  );

  // Verify streaming thoughts, tool calls, and markdown chunks reached the Side Panel port
  const agentEvents = spEvents.filter((e) => e.type === "sidepanel:agentEvent").map((e) => e.payload);
  assert.ok(agentEvents.some((e) => e.event === "session_created" && e.sessionId === "chrome-sess-1"));
  assert.ok(agentEvents.some((e) => e.update?.sessionUpdate === "agent_thought_chunk"));
  assert.ok(agentEvents.some((e) => e.update?.sessionUpdate === "tool_call"));
  assert.ok(
    agentEvents.some(
      (e) =>
        e.update?.sessionUpdate === "agent_message_chunk" &&
        e.update.content?.text?.includes("Summary ready (image=true, perm=auto)"),
    ),
  );

  // Verify ACP prompt received active tab, @-mentioned tab, and image block
  const afterTurn1Log = JSON.parse(fs.readFileSync(acpLogPath, "utf8"));
  assert.equal(afterTurn1Log.prompts[0].hasImage, true);
  assert.match(afterTurn1Log.prompts[0].text, /Pricing Tier A/);
  assert.match(afterTurn1Log.prompts[0].text, /@-Mentioned Tab \(#11\)/);
  assert.match(afterTurn1Log.prompts[0].text, /Pricing Tier B/);

  // 4. Send Turn 2 in "Ask" (`default`) Permission Mode and approve inline permission prompt!
  spPort.onMessage((m) => {
    if (m.type === "sidepanel:agentEvent" && m.payload?.event === "permission_request") {
      bridgeEnv.sendRuntimeMessage({
        type: "sidepanel:respondPermission",
        permRequestId: m.payload.permRequestId,
        optionId: "allow",
      });
    }
  });

  const turn2Res = await bridgeEnv.sendRuntimeMessage({
    type: "sidepanel:sendPrompt",
    payload: {
      requestId: "req-turn-2",
      sessionId: "chrome-sess-1",
      userText: "Now submit the form.",
      interactionMode: "agent",
      permissionMode: "default",
      includeActiveTab: true,
      activeTabId: 10,
    },
  });
  assert.equal(turn2Res.ok, true);
  assert.ok(
    spEvents.some(
      (e) =>
        e.type === "sidepanel:agentEvent" &&
        e.payload?.update?.sessionUpdate === "agent_message_chunk" &&
        e.payload.update.content?.text?.includes("perm=allow"),
    ),
    "Inline permission approval must resolve ACP session/request_permission",
  );

  // 5. Verify Exact One-Way Session Rule:
  //    a) Chrome-created chat CAN be reloaded in Chrome (with clean stripped user text) AND opened in Desktop App!
  const reloadChromeRes = await bridgeEnv.sendRuntimeMessage({
    type: "sidepanel:loadSession",
    sessionId: "chrome-sess-1",
  });
  assert.equal(reloadChromeRes.ok, true);
  assert.equal(reloadChromeRes.session.messages[0].text, "Compare Pricing Tier A and Pricing Tier B.");
  assert.ok(
    !reloadChromeRes.session.messages[0].text.includes("<browser_sidepanel_context>"),
    "Reloaded user message must strip internal <browser_sidepanel_context> wrapper",
  );

  const openAppRes = await bridgeEnv.sendRuntimeMessage({
    type: "sidepanel:openInDesktopApp",
    sessionId: "chrome-sess-1",
  });
  assert.equal(openAppRes.ok, true);
  assert.equal(openAppRes.launched, true);

  //    b) Desktop-originated Antigravity chat ("desktop-conv-9999") MUST BE BLOCKED from opening in Chrome!
  const blockedDesktopRes = await bridgeEnv.sendRuntimeMessage({
    type: "sidepanel:loadSession",
    sessionId: "desktop-conv-9999",
  });
  assert.equal(blockedDesktopRes.ok, false);
  assert.equal(blockedDesktopRes.code, -32010);
  assert.match(blockedDesktopRes.error, /cannot be opened in Antigravity in Chrome/i);

  // 6. Verify Simultaneous Desktop App -> Brave Tab Control over Unix Socket while Side Panel is open!
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const { mcp, browserManager } = createComputerUseServer({
    input: clientToServer,
    output: serverToClient,
    jxaRunner: async () => "[]",
    extensionSockDir: sockDir,
  });
  browserManager.discoverCDPEndpoints = async () => [];
  mcp.start();
  const desktopMcpRpc = attachMcpRpcHelper(clientToServer, serverToClient);
  t.after(async () => {
    await mcp.shutdown();
  });

  await desktopMcpRpc("initialize", { protocolVersion: "2024-11-05" });
  const desktopOpenTab = await desktopMcpRpc("tools/call", {
    name: "browser_open_tab",
    arguments: {
      url: "https://desktop-agent.example.test/research",
      group_title: "Desktop Task",
      group_color: "blue",
    },
  });
  assert.ok(!desktopOpenTab.result.isError, "Desktop MCP chat must simultaneously control Brave tabs & Tab Groups");
  assert.match(desktopOpenTab.result.content[0].text, /Navigated https:\/\/desktop-agent\.example\.test\/research|desktop-agent\.example\.test/);

  // 7. Verify Custom `/` Shortcut + Scheduled Browser Task (`chrome.alarms`) execution!
  const savedSc = await bridgeEnv.sendRuntimeMessage({
    type: "sidepanel:saveShortcut",
    payload: {
      command: "daily-digest",
      title: "Daily Digest",
      prompt: "Create my daily digest from this tab.",
      interactionMode: "chat",
    },
  });
  assert.equal(savedSc.ok, true);
  assert.equal(savedSc.shortcut.command, "daily-digest");

  const savedSched = await bridgeEnv.sendRuntimeMessage({
    type: "sidepanel:saveSchedule",
    payload: {
      name: "Hourly Pricing Check",
      targetUrl: "https://saas.example.test/pricing-a",
      prompt: "Check if Pricing Tier A changed.",
      intervalMinutes: 60,
      interactionMode: "chat",
      enabled: true,
    },
  });
  assert.equal(savedSched.ok, true);
  const alarmName = `ag-sched:${savedSched.task.id}`;
  assert.ok(bridgeEnv.createdAlarms.has(alarmName), "Saving an enabled schedule must register a chrome.alarms timer");

  const runSchedRes = await bridgeEnv.sendRuntimeMessage({
    type: "sidepanel:runScheduleNow",
    id: savedSched.task.id,
  });
  assert.equal(runSchedRes.ok, true);
  assert.equal(runSchedRes.sessionId, "chrome-sess-2");
  assert.equal(runSchedRes.task.lastStatus, "completed");

  spPort.disconnect();
});
