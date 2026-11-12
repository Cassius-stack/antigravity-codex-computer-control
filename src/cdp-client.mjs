import { spawn, execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  BUILD_AX_SNAPSHOT_EXPR,
  buildAppendUploadChunkExpr,
  buildBrowserCursorOverlayExpr,
  buildCommitDataTransferUploadExpr,
  buildGetActiveElementAnchorExpr,
  buildGetBrowserCursorStateExpr,
  buildInitUploadStagingExpr,
  buildPasteExpr,
  buildPrepareBrowserCursorForScreenshotExpr,
  buildPrepareElementExpr,
  buildRemoveBrowserCursorExpr,
  buildSecondaryActionExpr,
  buildSelectTextExpr,
  buildSetActiveTabIndicatorExpr,
  buildSetBrowserCursorTemporarilyHiddenExpr,
  buildSetValueExpr,
} from "./browser-ax.mjs";
import { ExtensionBridgeManager, ExtensionCDPConnection } from "./extension-bridge.mjs";
import { CDP_MODIFIER_BITS, parseCDPKeyChord } from "./keys.mjs";
import { assertSafeBrowserUrl, detectCaptchaChallenge } from "./safety-policy.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PROFILES_DIR = path.join(PROJECT_ROOT, ".browser-profiles");
const DEFAULT_DOWNLOAD_DIR = path.join(os.tmpdir(), "antigravity-downloads");
const RING_BUFFER_LIMIT = 500;

const MIME_BY_EXT = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".html": "text/html",
  ".htm": "text/html",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function guessMimeType(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

const DEFAULT_CDP_PORTS = [9223, 9222, 9224, 9229, 9333];

const KNOWN_MAC_BROWSERS = [
  {
    key: "chrome",
    name: "Google Chrome",
    family: "chromium",
    appPath: "/Applications/Google Chrome.app",
    binPath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    bundleId: "com.google.Chrome",
  },
  {
    key: "brave",
    name: "Brave Browser",
    family: "chromium",
    appPath: "/Applications/Brave Browser.app",
    binPath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    bundleId: "com.brave.Browser",
  },
  {
    key: "edge",
    name: "Microsoft Edge",
    family: "chromium",
    appPath: "/Applications/Microsoft Edge.app",
    binPath: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    bundleId: "com.microsoft.edgemac",
  },
  {
    key: "arc",
    name: "Arc",
    family: "chromium",
    appPath: "/Applications/Arc.app",
    binPath: "/Applications/Arc.app/Contents/MacOS/Arc",
    bundleId: "company.thebrowser.Browser",
  },
  {
    key: "safari",
    name: "Safari",
    family: "webkit",
    appPath: "/Applications/Safari.app",
    binPath: "/Applications/Safari.app/Contents/MacOS/Safari",
    bundleId: "com.apple.Safari",
  },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, timeoutMs = 400) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/**
 * Multiplexed WebSocket CDP Connection supporting browser-level Target.attachToTarget(flatten: true)
 */
export class CDPMultiplexConnection extends EventEmitter {
  /**
   * @param {string} wsUrl
   * @param {{ downloadDir?: string }} [opts]
   */
  constructor(wsUrl, opts = {}) {
    super();
    this.wsUrl = wsUrl;
    this.isExtension = false;
    this.downloadDir = opts.downloadDir || DEFAULT_DOWNLOAD_DIR;
    this._downloadConfigured = false;
    /** @type {WebSocket | null} */
    this.ws = null;
    this.connecting = null;
    this.nextId = 1;
    /** @type {Map<number, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
    this.pending = new Map();
    /** @type {Map<string, string>} targetId -> sessionId */
    this.targetSessions = new Map();
    /** @type {Map<string, { parentSessionId: string | null, targetInfo: any }>} childSessionId -> route */
    this.childSessions = new Map();
    /** @type {Map<string, any>} guid -> download info */
    this.downloadsByGuid = new Map();
  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        reject(new Error(`Timed out connecting to CDP WebSocket ${this.wsUrl}`));
      }, 5000);

      ws.addEventListener("open", () => {
        clearTimeout(timer);
        this.ws = ws;
        this.connecting = null;
        resolve();
      });

      ws.addEventListener("message", (ev) => {
        let msg;
        try {
          msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8"));
        } catch {
          return;
        }
        if (msg.method === "Target.attachedToTarget" && msg.params?.sessionId) {
          this.childSessions.set(msg.params.sessionId, {
            parentSessionId: msg.sessionId || null,
            targetInfo: msg.params.targetInfo || {},
          });
        }
        if (msg.method === "Target.detachedFromTarget" && msg.params?.sessionId) {
          this.childSessions.delete(msg.params.sessionId);
          for (const [tId, sId] of this.targetSessions.entries()) {
            if (sId === msg.params.sessionId) {
              this.targetSessions.delete(tId);
              this.emit("cdpDetached", {
                targetId: tId,
                sessionId: msg.params.sessionId,
                reason: "target_detached",
              });
            }
          }
        }
        if (msg.method === "Browser.downloadWillBegin" && msg.params?.guid) {
          try {
            fs.mkdirSync(this.downloadDir, { recursive: true });
          } catch {}
          const item = {
            id: msg.params.guid,
            guid: msg.params.guid,
            frameId: msg.params.frameId || null,
            url: msg.params.url || "",
            suggestedFilename: msg.params.suggestedFilename || msg.params.guid,
            filename: path.join(this.downloadDir, msg.params.suggestedFilename || msg.params.guid),
            state: "in_progress",
            bytesReceived: 0,
            totalBytes: -1,
            startTime: new Date().toISOString(),
            endTime: "",
          };
          this.downloadsByGuid.set(msg.params.guid, item);
          this.emit("downloadEvent", { event: "created", item });
        } else if (msg.method === "Browser.downloadProgress" && msg.params?.guid) {
          const prev = this.downloadsByGuid.get(msg.params.guid) || {
            id: msg.params.guid,
            guid: msg.params.guid,
            filename: path.join(this.downloadDir, msg.params.guid),
          };
          const mappedState =
            msg.params.state === "completed"
              ? "complete"
              : msg.params.state === "canceled"
                ? "interrupted"
                : "in_progress";
          const next = {
            ...prev,
            ...(msg.params.filePath ? { filename: msg.params.filePath } : {}),
            state: mappedState,
            bytesReceived: msg.params.receivedBytes ?? prev.bytesReceived ?? 0,
            totalBytes: msg.params.totalBytes ?? prev.totalBytes ?? -1,
            ...(mappedState !== "in_progress" ? { endTime: new Date().toISOString() } : {}),
          };
          this.downloadsByGuid.set(msg.params.guid, next);
          this.emit("downloadEvent", { event: "changed", item: next });
        }
        if (
          msg.method === "Page.screencastFrame" &&
          msg.params?.sessionId != null &&
          ws.readyState === WebSocket.OPEN
        ) {
          try {
            ws.send(
              JSON.stringify({
                id: this.nextId++,
                method: "Page.screencastFrameAck",
                params: { sessionId: msg.params.sessionId },
                ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
              }),
            );
          } catch {}
          return;
        }
        if (msg.method && msg.id == null) {
          const child = msg.sessionId ? this.childSessions.get(msg.sessionId) : null;
          const rootSessionId = child?.parentSessionId || msg.sessionId || null;
          let targetId = null;
          if (rootSessionId) {
            for (const [tId, sId] of this.targetSessions.entries()) {
              if (sId === rootSessionId) {
                targetId = tId;
                break;
              }
            }
          }
          this.emit("cdpEvent", {
            targetId,
            sessionId: msg.sessionId || null,
            rootSessionId,
            method: msg.method,
            params: msg.params || {},
          });
          return;
        }
        if (msg.id != null) {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) {
            p.reject(new Error(`CDP ${msg.error.message || JSON.stringify(msg.error)}`));
          } else {
            p.resolve(msg.result ?? {});
          }
        }
      });

      const onCloseOrError = (err) => {
        clearTimeout(timer);
        if (this.ws === ws) this.ws = null;
        this.connecting = null;
        this.targetSessions.clear();
        this.childSessions.clear();
        const reason = err instanceof Error ? err : new Error("CDP WebSocket closed");
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(reason);
        }
        this.pending.clear();
        reject(reason);
      };

      ws.addEventListener("error", () => onCloseOrError(new Error(`CDP WebSocket error on ${this.wsUrl}`)));
      ws.addEventListener("close", () => onCloseOrError(new Error(`CDP WebSocket closed: ${this.wsUrl}`)));
    });

    return this.connecting;
  }

  /**
   * @param {string} method
   * @param {Record<string, any>} [params]
   * @param {string} [sessionId]
   * @param {number} [timeoutMs]
   */
  async send(method, params = {}, sessionId = undefined, timeoutMs = 15000) {
    await this.connect();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId ? { sessionId } : {}),
          }),
        );
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  async ensureTargetSession(targetId) {
    const existing = this.targetSessions.get(targetId);
    if (existing) return existing;
    const { sessionId } = await this.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    if (!this._downloadConfigured) {
      this._downloadConfigured = true;
      try {
        fs.mkdirSync(this.downloadDir, { recursive: true });
      } catch {}
      await this.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: this.downloadDir,
        eventsEnabled: true,
      }).catch(() => {});
    }
    await this.send("Page.enable", {}, sessionId).catch(() => {});
    await this.send("Runtime.enable", {}, sessionId).catch(() => {});
    await this.send("DOM.enable", {}, sessionId).catch(() => {});
    await this.send("Network.enable", {}, sessionId).catch(() => {});
    await this.send("Runtime.addBinding", { name: "__agCuaControl" }, sessionId).catch(() => {});
    await this.send(
      "Target.setAutoAttach",
      {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: [{ type: "iframe", exclude: false }],
      },
      sessionId,
    ).catch(() => {});
    this.targetSessions.set(targetId, sessionId);
    return sessionId;
  }

  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }
}

/**
 * Controllable CDP Browser Tab — implements full Codex Tab & Target interface + Playwright-style locator() & frameLocator()
 */
export class CDPTabController {
  /**
   * @param {{
   *   id: string,
   *   targetId: string,
   *   browserId: string,
   *   httpEndpoint: string,
   *   conn: CDPMultiplexConnection | ExtensionCDPConnection,
   *   diffTracker: import("./diff.mjs").AXDiffTracker,
   *   onClosed?: (id: string) => void,
   *   sessionIdName?: string,
   *   title?: string,
   *   url?: string,
   *   tabGroup?: any,
   *   groupId?: number,
   *   windowId?: number,
   *   ownership?: any
   * }} cfg
   */
  constructor(cfg) {
    this.id = cfg.id;
    this.targetId = cfg.targetId;
    this.browserId = cfg.browserId;
    this.httpEndpoint = cfg.httpEndpoint;
    this.conn = cfg.conn;
    this.isExtensionTab = Boolean(this.conn?.isExtension);
    this.chromeTabId = this.isExtensionTab ? ExtensionCDPConnection.parseChromeTabId(this.targetId) : null;
    this.sessionIdName = cfg.sessionIdName || "default";
    this.controllableViaCDP = true;
    this.controlMode = this.isExtensionTab ? "extension_cdp" : "cdp";
    this.diffTracker = cfg.diffTracker;
    this.onClosed = cfg.onClosed;
    this.getCursorConfig = cfg.getCursorConfig;
    this.screencastActive = false;
    this.screencastTimer = null;
    this.cachedMeta = {
      title: cfg.title ?? "",
      url: cfg.url ?? "",
      tabGroup: cfg.tabGroup ?? null,
      groupId: cfg.groupId ?? -1,
      windowId: cfg.windowId ?? null,
      ownership: cfg.ownership ?? null,
    };
    this.cursorState = {
      visible: false,
      x: null,
      y: null,
      badge: null,
      highlightedRect: null,
      updatedAt: 0,
    };
    this.consoleLogs = [];
    this.networkRequests = [];
    this.networkById = new Map();
    this.activeDialog = null;
    this._dialogWaiters = new Set();
    this._navigatingByAgent = false;
    this.childFrames = new Map();
    this.takenOverByUser = false;
    this._activeIndicatorInjected = false;

    this._boundCdpEvent = (ev) => this._handleConnEvent(ev);
    this._boundCdpDetached = (ev) => this._handleConnDetached(ev);
    if (typeof this.conn?.on === "function") {
      this.conn.on("cdpEvent", this._boundCdpEvent);
      this.conn.on("cdpDetached", this._boundCdpDetached);
    }
  }

  _matchesTabEvent(ev) {
    if (!ev) return false;
    if (this.isExtensionTab && this.chromeTabId != null && ev.tabId != null) {
      return Number(ev.tabId) === this.chromeTabId;
    }
    if (ev.targetId && ev.targetId === this.targetId) return true;
    const rootSession = this.conn.targetSessions?.get(this.targetId);
    if (rootSession && (ev.sessionId === rootSession || ev.rootSessionId === rootSession)) return true;
    if (ev.sessionId && this.childFrames.has(ev.sessionId)) return true;
    return false;
  }

  _handleConnEvent(ev) {
    if (!this._matchesTabEvent(ev)) return;
    const { method, params = {} } = ev;

    if (method === "Target.attachedToTarget" && params.sessionId && params.targetInfo?.type === "iframe") {
      const childSessionId = params.sessionId;
      this.childFrames.set(childSessionId, {
        sessionId: childSessionId,
        targetId: params.targetInfo.targetId || "",
        url: params.targetInfo.url || "",
        title: params.targetInfo.title || "",
      });
      this.conn.send("Runtime.enable", {}, childSessionId).catch(() => {});
      this.conn.send("DOM.enable", {}, childSessionId).catch(() => {});
      this.conn.send("Page.enable", {}, childSessionId).catch(() => {});
      return;
    }

    if (method === "Target.detachedFromTarget" && params.sessionId) {
      this.childFrames.delete(params.sessionId);
      return;
    }

    if (method === "Runtime.bindingCalled" && params.name === "__agCuaControl") {
      let payload = null;
      try {
        payload = JSON.parse(String(params.payload || "{}"));
      } catch {}
      if (payload?.action === "take_over") {
        this._handleUserTakeOver("take_over_button").catch(() => {});
      }
      return;
    }

    if (method === "Page.loadEventFired" || (method === "Page.frameNavigated" && !params.frame?.parentId)) {
      if (this.conn.targetSessions?.has(this.targetId) && !this.takenOverByUser) {
        const sid = this.conn.targetSessions.get(this.targetId);
        if (sid) {
          this.conn
            .send(
              "Runtime.evaluate",
              { expression: buildSetActiveTabIndicatorExpr(true), returnByValue: true },
              sid,
              2000,
            )
            .catch(() => {});
        }
      }
      return;
    }

    if (method === "Page.javascriptDialogOpening") {
      const dlg = {
        type: params.type || "alert",
        message: params.message ?? "",
        url: params.url || "",
        defaultPrompt: params.defaultPrompt ?? "",
        hasBrowserHandler: Boolean(params.hasBrowserHandler),
        openedAt: Date.now(),
      };
      if (dlg.type === "beforeunload" && this._navigatingByAgent) {
        this.send("Page.handleJavaScriptDialog", { accept: true }, 3000).catch(() => {});
        return;
      }
      this.activeDialog = dlg;
      for (const resolveWaiter of Array.from(this._dialogWaiters)) {
        this._dialogWaiters.delete(resolveWaiter);
        try {
          resolveWaiter(dlg);
        } catch {}
      }
      return;
    }

    if (method === "Page.javascriptDialogClosed") {
      this.activeDialog = null;
      return;
    }

    if (method === "Runtime.consoleAPICalled") {
      const args = Array.isArray(params.args) ? params.args : [];
      const text = args
        .map((a) => {
          if (a == null) return "";
          if (a.value !== undefined) {
            return typeof a.value === "string" ? a.value : JSON.stringify(a.value);
          }
          return a.description || a.unserializableValue || `[${a.type || "object"}]`;
        })
        .join(" ");
      const topFrame = params.stackTrace?.callFrames?.[0] || null;
      this.consoleLogs.push({
        level: params.type || "log",
        text,
        timestamp: params.timestamp || Date.now(),
        url: topFrame?.url || "",
        lineNumber: topFrame?.lineNumber ?? null,
      });
      if (this.consoleLogs.length > RING_BUFFER_LIMIT) {
        this.consoleLogs.shift();
      }
      return;
    }

    if (method === "Runtime.exceptionThrown") {
      const det = params.exceptionDetails || {};
      const text = det.exception?.description || det.text || "Uncaught exception";
      this.consoleLogs.push({
        level: "exception",
        text,
        timestamp: params.timestamp || Date.now(),
        url: det.url || "",
        lineNumber: det.lineNumber ?? null,
      });
      if (this.consoleLogs.length > RING_BUFFER_LIMIT) {
        this.consoleLogs.shift();
      }
      return;
    }

    if (method === "Network.requestWillBeSent" && params.requestId) {
      const rid = String(params.requestId);
      let entry = this.networkById.get(rid);
      if (!entry) {
        entry = {
          requestId: rid,
          url: params.request?.url || "",
          method: params.request?.method || "GET",
          resourceType: params.type || "Other",
          requestHeaders: params.request?.headers || {},
          postData: params.request?.postData ?? null,
          status: null,
          statusText: "",
          mimeType: "",
          responseHeaders: {},
          encodedDataLength: 0,
          errorText: null,
          canceled: false,
          startedAt: Date.now(),
          finishedAt: null,
        };
        this.networkRequests.push(entry);
        this.networkById.set(rid, entry);
        if (this.networkRequests.length > RING_BUFFER_LIMIT) {
          const evicted = this.networkRequests.shift();
          if (evicted && this.networkById.get(evicted.requestId) === evicted) {
            this.networkById.delete(evicted.requestId);
          }
        }
      } else {
        entry.url = params.request?.url || entry.url;
        entry.method = params.request?.method || entry.method;
      }
      return;
    }

    if (method === "Network.responseReceived" && params.requestId) {
      const entry = this.networkById.get(String(params.requestId));
      if (entry && params.response) {
        entry.status = params.response.status ?? entry.status;
        entry.statusText = params.response.statusText ?? entry.statusText;
        entry.mimeType = params.response.mimeType ?? entry.mimeType;
        entry.responseHeaders = params.response.headers ?? entry.responseHeaders;
      }
      return;
    }

    if (method === "Network.loadingFinished" && params.requestId) {
      const entry = this.networkById.get(String(params.requestId));
      if (entry) {
        entry.encodedDataLength = params.encodedDataLength ?? entry.encodedDataLength;
        entry.finishedAt = Date.now();
      }
      return;
    }

    if (method === "Network.loadingFailed" && params.requestId) {
      const entry = this.networkById.get(String(params.requestId));
      if (entry) {
        entry.errorText = params.errorText || "Loading failed";
        entry.canceled = Boolean(params.canceled);
        entry.finishedAt = Date.now();
      }
    }
  }

  _handleConnDetached(ev) {
    const matches =
      (this.isExtensionTab && this.chromeTabId != null && Number(ev?.tabId) === this.chromeTabId) ||
      (ev?.targetId && ev.targetId === this.targetId);
    if (!matches) return;
    this._activeIndicatorInjected = false;
    this.screencastActive = false;
    this.cursorState.visible = false;
    if (ev?.reason === "canceled_by_user") {
      this._handleUserTakeOver("canceled_by_user").catch(() => {});
    }
  }

  async _handleUserTakeOver(reason = "take_over_button") {
    this.takenOverByUser = true;
    this.cursorState.visible = false;
    this._activeIndicatorInjected = false;
    this.stopCompositorAwake({ sendStop: false });

    const sid = this.conn.targetSessions?.get(this.targetId);
    if (reason === "take_over_button" && sid) {
      await this.conn
        .send("Runtime.evaluate", { expression: buildRemoveBrowserCursorExpr(), returnByValue: true }, sid, 800)
        .catch(() => {});
    }

    if (this.isExtensionTab && this.chromeTabId != null) {
      this.conn.targetSessions?.delete(this.targetId);
      await this.conn.client
        .request("markTab", {
          sessionId: this.sessionIdName,
          tabId: this.chromeTabId,
          status: "handoff",
          activate: false,
        })
        .catch(() => {});
    } else if (sid) {
      this.conn.targetSessions?.delete(this.targetId);
      await this.conn.send("Target.detachFromTarget", { sessionId: sid }, undefined, 1500).catch(() => {});
    }
  }

  async _raceWithDialog(opPromise, { settleDelayMs = 35 } = {}) {
    if (this.activeDialog) {
      opPromise.catch(() => {});
      const raceRes = await Promise.race([
        opPromise.then((v) => ({ done: true, value: v })),
        sleep(settleDelayMs).then(() => ({ done: false, dialog: this.activeDialog })),
      ]);
      return raceRes;
    }

    let waiterFn = null;
    const dialogTriggered = new Promise((resolve) => {
      waiterFn = (dlg) => {
        setTimeout(() => resolve({ done: false, dialog: dlg }), settleDelayMs);
      };
      this._dialogWaiters.add(waiterFn);
    });

    try {
      return await Promise.race([
        opPromise.then((v) => ({ done: true, value: v })),
        dialogTriggered.then((res) => {
          opPromise.catch(() => {});
          return res;
        }),
      ]);
    } finally {
      if (waiterFn) this._dialogWaiters.delete(waiterFn);
    }
  }

  async send(method, params = {}, timeoutMs = 15000) {
    const injectIndicatorIfFirstAttach = (wasAttached, sessionId) => {
      if (!wasAttached && !this._activeIndicatorInjected && method !== "Page.captureScreenshot") {
        this._activeIndicatorInjected = true;
        this.takenOverByUser = false;
        this.conn
          .send(
            "Runtime.evaluate",
            { expression: buildSetActiveTabIndicatorExpr(true), returnByValue: true },
            sessionId,
            2000,
          )
          .catch(() => {});
      }
    };

    try {
      const wasAttached = Boolean(this.conn.targetSessions?.has(this.targetId));
      const sessionId = await this.conn.ensureTargetSession(this.targetId);
      injectIndicatorIfFirstAttach(wasAttached, sessionId);
      return await this.conn.send(method, params, sessionId, timeoutMs);
    } catch (err) {
      // Retry once if session detached (e.g. cross-process navigation)
      if (/Session with given id not found|No session|Target closed|Debugger is not attached/i.test(err.message)) {
        this.conn.targetSessions.delete(this.targetId);
        this._activeIndicatorInjected = false;
        this.screencastActive = false;
        const sessionId = await this.conn.ensureTargetSession(this.targetId);
        injectIndicatorIfFirstAttach(false, sessionId);
        return await this.conn.send(method, params, sessionId, timeoutMs);
      }
      throw err;
    }
  }

  /**
   * Wake Chromium's background/occluded tab compositor via lightweight Page.startScreencast
   * without stealing focus or raising windows, preventing the 5s Input.dispatchMouseEvent stall
   * and keeping CSS animations ticking in non-headless Chrome (e.g. cdp-9223).
   */
  async ensureCompositorAwake(keepAliveMs) {
    const defaultIdle = Number(this.getCursorConfig?.()?.idleTimeoutMs ?? 8000);
    const holdMs = Math.max(2500, Number(keepAliveMs) || defaultIdle + 1500);
    if (this.screencastTimer) {
      clearTimeout(this.screencastTimer);
    }
    this.screencastTimer = setTimeout(() => {
      this.screencastTimer = null;
      if (this.screencastActive) {
        this.screencastActive = false;
        this.send("Page.stopScreencast", {}, 2000).catch(() => {});
      }
    }, holdMs);
    this.screencastTimer.unref?.();

    if (!this.screencastActive) {
      this.screencastActive = true;
      await this.send(
        "Page.startScreencast",
        {
          format: "jpeg",
          quality: 20,
          maxWidth: 160,
          maxHeight: 120,
          everyNthFrame: 30,
        },
        2000,
      ).catch(() => {
        this.screencastActive = false;
      });
    }
  }

  stopCompositorAwake({ sendStop = true } = {}) {
    if (this.screencastTimer) {
      clearTimeout(this.screencastTimer);
      this.screencastTimer = null;
    }
    if (this.screencastActive) {
      this.screencastActive = false;
      if (sendStop) {
        this.send("Page.stopScreencast", {}, 2000).catch(() => {});
      }
    }
  }

  isCursorCurrentlyVisible() {
    if (!this.cursorState.visible) return false;
    const timeoutMs = Number(this.getCursorConfig?.()?.idleTimeoutMs ?? 8000);
    if (this.cursorState.updatedAt > 0 && Date.now() - this.cursorState.updatedAt > timeoutMs + 250) {
      this.cursorState.visible = false;
      return false;
    }
    return true;
  }

  async showVirtualCursor(spec = {}, { showCursor = true } = {}) {
    const cfg = this.getCursorConfig?.() ?? { enabled: true, idleTimeoutMs: 8000 };
    if (showCursor === false || cfg.enabled === false || this.activeDialog) return null;
    await this.ensureCompositorAwake();
    try {
      const res = await this.evaluate(
        buildBrowserCursorOverlayExpr({
          ...spec,
          badge: null,
          showBadge: false,
          idleTimeoutMs: cfg.idleTimeoutMs,
          instant: cfg.glideEnabled === false ? true : Boolean(spec.instant),
        }),
      );
      if (res?.ok) {
        this.cursorState = {
          visible: true,
          x: res.x,
          y: res.y,
          badge: null,
          highlightedRect: res.highlightedRect ?? null,
          updatedAt: Date.now(),
        };
      }
      return res;
    } catch {
      return null;
    }
  }

  /**
   * Glide virtual cursor toward target and await ~80% ("CloseEnough") of glide duration
   * before dispatching press/mutation events, matching Codex cursor timing.
   */
  async glideCursorTo(spec = {}, { showCursor = true } = {}) {
    const res = await this.showVirtualCursor({ ...spec, ripple: false }, { showCursor });
    const glideMs = Number(res?.glideDurationMs ?? 0);
    if (glideMs > 0 && !res?.instant) {
      await sleep(Math.min(350, Math.max(0, Math.round(glideMs * 0.8))));
    }
    return res;
  }

  async hideCursor({ keepActiveIndicator = true } = {}) {
    this.cursorState.visible = false;
    this.stopCompositorAwake();
    await this.evaluate(buildRemoveBrowserCursorExpr()).catch(() => null);
    if (keepActiveIndicator && this.conn.targetSessions?.has(this.targetId) && !this.takenOverByUser) {
      await this.evaluate(buildSetActiveTabIndicatorExpr(true)).catch(() => null);
    }
    return { ok: true, tabId: this.id, visible: false };
  }

  async detach() {
    this.cursorState.visible = false;
    this._activeIndicatorInjected = false;
    this.stopCompositorAwake({ sendStop: false });
    const sid = this.conn.targetSessions?.get(this.targetId);
    if (sid && !this.activeDialog) {
      await this.conn
        .send("Runtime.evaluate", { expression: buildRemoveBrowserCursorExpr(), returnByValue: true }, sid, 1200)
        .catch(() => {});
    }
    if (this.isExtensionTab && this.chromeTabId != null) {
      await this.conn.detachTab(this.chromeTabId);
    } else if (sid) {
      this.conn.targetSessions.delete(this.targetId);
      await this.conn.send("Target.detachFromTarget", { sessionId: sid }, undefined, 1500).catch(() => {});
    }
    return { ok: true, tabId: this.id, detached: true };
  }

  async getCursorState() {
    if (this.activeDialog) {
      return { tabId: this.id, browserId: this.browserId, visible: false, badge: null };
    }
    const domState = await this.evaluate(buildGetBrowserCursorStateExpr()).catch(() => ({ visible: false }));
    if (domState?.visible) {
      this.cursorState = {
        ...this.cursorState,
        visible: true,
        x: domState.x,
        y: domState.y,
        badge: null,
        highlightedRect: domState.highlightedRect,
      };
    } else {
      this.cursorState.visible = false;
    }
    return {
      tabId: this.id,
      browserId: this.browserId,
      ...domState,
      badge: null,
    };
  }

  async getMetadata() {
    if (this.isExtensionTab && this.chromeTabId != null) {
      const t = await this.conn.client.request("getTab", { tabId: this.chromeTabId }, 3000).catch(() => null);
      if (t) {
        this.cachedMeta.title = t.title ?? this.cachedMeta.title;
        this.cachedMeta.url = t.url ?? this.cachedMeta.url;
        this.cachedMeta.groupId = t.groupId ?? this.cachedMeta.groupId;
        this.cachedMeta.windowId = t.windowId ?? this.cachedMeta.windowId;
      }
      return {
        id: this.id,
        providerTabId: this.targetId,
        chromeTabId: this.chromeTabId,
        browserId: this.browserId,
        controlMode: "extension_cdp",
        title: this.cachedMeta.title || "",
        url: this.cachedMeta.url || "",
        tabGroup: this.cachedMeta.tabGroup || null,
        ownership: this.cachedMeta.ownership || null,
      };
    }

    const { targetInfo } = await this.conn.send("Target.getTargetInfo", { targetId: this.targetId });
    this.cachedMeta.title = targetInfo?.title ?? "";
    this.cachedMeta.url = targetInfo?.url ?? "";
    return {
      id: this.id,
      providerTabId: this.targetId,
      browserId: this.browserId,
      controlMode: "cdp",
      title: this.cachedMeta.title,
      url: this.cachedMeta.url,
    };
  }

  async waitForDomSettled(maxWaitMs = 1500) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      if (this.activeDialog) return;
      try {
        const res = await this.send(
          "Runtime.evaluate",
          {
            expression: "document.readyState",
            returnByValue: true,
          },
          2000,
        );
        const state = res?.result?.value;
        if (state === "complete" || state === "interactive") {
          break;
        }
      } catch {
        // Ignore transient navigation context replacement
      }
      await sleep(70);
    }
    await sleep(60);
  }

  isPrivilegedNewTab(url) {
    const u = String(url ?? "").trim().toLowerCase();
    return (
      u.startsWith("chrome://") ||
      u.startsWith("brave://") ||
      u.startsWith("edge://") ||
      u.startsWith("arc://") ||
      u.startsWith("devtools://") ||
      u.startsWith("chrome-extension://")
    );
  }

  _formatActiveDialogBanner() {
    if (!this.activeDialog) return null;
    const d = this.activeDialog;
    const promptPart = d.defaultPrompt ? ` defaultPrompt=${JSON.stringify(d.defaultPrompt)}` : "";
    return `[JS DIALOG OPEN: type="${d.type}" message=${JSON.stringify(d.message)}${promptPart} — call browser_tab_action action="handle_dialog" (accept=true/false, prompt_text=...) before interacting with DOM]`;
  }

  /**
   * Capture indexed AX/DOM state with Codex-compatible diffing, JS dialog surfacing, and CAPTCHA handoff detection.
   */
  async getAXState(options = {}) {
    const meta = await this.getMetadata();
    const diffKey = `tab:${this.id}`;

    if (this.isPrivilegedNewTab(meta.url)) {
      const text = `Tab #${this.id} "${meta.title || "New tab"}" url="${meta.url}"\n  (Browser internal page — call goto(url) to navigate to a website)`;
      const formatted = this.diffTracker.format(diffKey, text, options);
      return {
        stateText: formatted.text,
        fullTree: text,
        isDiff: formatted.isDiff,
        meta,
      };
    }

    if (this.activeDialog) {
      const dialogBanner = this._formatActiveDialogBanner();
      const quickEval = await Promise.race([
        this.send(
          "Runtime.evaluate",
          {
            expression: BUILD_AX_SNAPSHOT_EXPR(options.maxElements ?? 600),
            returnByValue: true,
            awaitPromise: false,
          },
          400,
        ).catch(() => null),
        sleep(220).then(() => null),
      ]);
      if (!quickEval || quickEval.exceptionDetails) {
        const header = `Tab #${this.id} "${meta.title}" url="${meta.url}"`;
        const fullTree = [
          dialogBanner,
          header,
          `  (DOM main thread paused by active JavaScript '${this.activeDialog.type}' dialog — handle dialog first)`,
        ].join("\n");
        const formatted = this.diffTracker.format(diffKey, fullTree, options);
        return {
          stateText: formatted.text,
          fullTree,
          isDiff: formatted.isDiff,
          unchanged: formatted.unchanged,
          elementCount: 0,
          dialog: { ...this.activeDialog },
          meta,
        };
      }
    }

    await this.waitForDomSettled(1200);
    const evalRace = await this._raceWithDialog(
      this.send("Runtime.evaluate", {
        expression: BUILD_AX_SNAPSHOT_EXPR(options.maxElements ?? 600),
        returnByValue: true,
        awaitPromise: false,
      }),
      { settleDelayMs: 60 },
    );

    if (!evalRace.done) {
      const dialogBanner = this._formatActiveDialogBanner();
      const header = `Tab #${this.id} "${meta.title}" url="${meta.url}"`;
      const fullTree = [
        ...(dialogBanner ? [dialogBanner] : []),
        header,
        `  (DOM main thread paused by active JavaScript '${this.activeDialog?.type || "alert"}' dialog — handle dialog first)`,
      ].join("\n");
      const formatted = this.diffTracker.format(diffKey, fullTree, options);
      return {
        stateText: formatted.text,
        fullTree,
        isDiff: formatted.isDiff,
        unchanged: formatted.unchanged,
        elementCount: 0,
        ...(this.activeDialog ? { dialog: { ...this.activeDialog } } : {}),
        meta,
      };
    }

    const evalRes = evalRace.value;
    if (evalRes.exceptionDetails) {
      throw new Error(
        `Failed to inspect tab DOM: ${evalRes.exceptionDetails.text || evalRes.exceptionDetails.exception?.description}`,
      );
    }

    const snap = evalRes.result?.value ?? {
      title: meta.title,
      url: meta.url,
      viewport: { width: 1280, height: 800 },
      scroll: { x: 0, y: 0 },
      elementCount: 0,
      lines: [],
      captchaSignals: [],
    };

    const dialogBanner = this._formatActiveDialogBanner();
    const captcha = detectCaptchaChallenge(snap);
    const header = `Tab #${this.id} "${snap.title}" url="${snap.url}" viewport=${snap.viewport.width}x${snap.viewport.height} scroll=(${snap.scroll.x},${snap.scroll.y})`;
    const treeParts = [
      ...(dialogBanner ? [dialogBanner] : []),
      header,
      ...(snap.lines ?? []),
      ...(captcha.detected && captcha.banner ? [captcha.banner] : []),
    ];
    const fullTree = treeParts.join("\n");
    const formatted = this.diffTracker.format(diffKey, fullTree, options);
    let stateText = formatted.text;
    if (captcha.detected && captcha.banner && !stateText.includes(captcha.banner)) {
      stateText = `${stateText}\n${captcha.banner}`;
    }
    if (dialogBanner && !stateText.includes(dialogBanner)) {
      stateText = `${dialogBanner}\n${stateText}`;
    }

    return {
      stateText,
      fullTree,
      isDiff: formatted.isDiff,
      unchanged: formatted.unchanged,
      elementCount: snap.elementCount,
      captchaDetected: captcha.detected,
      ...(captcha.detected ? { captchaProviders: captcha.providers } : {}),
      ...(this.activeDialog ? { dialog: { ...this.activeDialog } } : {}),
      ...(this.isCursorCurrentlyVisible()
        ? {
            cursor: {
              x: this.cursorState.x,
              y: this.cursorState.y,
              badge: null,
              highlightedRect: this.cursorState.highlightedRect,
            },
          }
        : {}),
      meta: {
        ...meta,
        title: snap.title,
        url: snap.url,
      },
    };
  }

  /**
   * Capture background tab screenshot via CDP Page.captureScreenshot (requires zero macOS Screen Recording TCC).
   * Hides the virtual cursor overlay (and active-tab Take Over pill/border) by default so screenshots stay clean.
   */
  async getScreenshot({ markOnly = true, format = "jpeg", quality = 82, includeCursor = false } = {}) {
    if (markOnly) {
      this.diffTracker.markScreenshotOnly(`tab:${this.id}`);
    }
    const fmt = format === "png" ? "png" : "jpeg";
    let didHideOverlay = false;
    let didPrepCursor = false;
    if (!this.activeDialog) {
      if (!includeCursor) {
        const hideRes = await this.evaluate(buildSetBrowserCursorTemporarilyHiddenExpr(true)).catch(() => null);
        didHideOverlay = Boolean(hideRes?.wasPresent);
      } else {
        await this.ensureCompositorAwake();
        const prepRes = await this.evaluate(
          buildPrepareBrowserCursorForScreenshotExpr(true, { awaitFrame: true }),
        ).catch(() => null);
        didPrepCursor = Boolean(prepRes?.didPrep);
      }
    }
    let shot;
    try {
      shot = await this.send(
        "Page.captureScreenshot",
        {
          format: fmt,
          ...(fmt === "jpeg" ? { quality } : {}),
          captureBeyondViewport: false,
        },
        15000,
      );
    } finally {
      if (didHideOverlay) {
        await this.evaluate(buildSetBrowserCursorTemporarilyHiddenExpr(false)).catch(() => {});
      } else if (didPrepCursor) {
        await this.evaluate(buildPrepareBrowserCursorForScreenshotExpr(false)).catch(() => {});
      }
    }
    const bytes = Buffer.from(shot.data, "base64");
    return {
      mimeType: fmt === "png" ? "image/png" : "image/jpeg",
      base64: shot.data,
      bytes: new Uint8Array(bytes),
      cursorComposited: Boolean(includeCursor),
    };
  }

  async getAXStateAndScreenshot(options = {}) {
    const ax = await this.getAXState(options);
    const shot = await this.getScreenshot({
      markOnly: false,
      includeCursor: Boolean(options.includeCursor),
    });
    return {
      stateText: ax.stateText,
      fullTree: ax.fullTree,
      screenshot: shot,
      ...(ax.cursor ? { cursor: ax.cursor } : {}),
      meta: ax.meta,
    };
  }

  async evaluate(expression) {
    if (typeof expression === "function") {
      expression = `(${expression.toString()})()`;
    }
    const race = await this._raceWithDialog(
      this.send("Runtime.evaluate", {
        expression: String(expression),
        returnByValue: true,
        awaitPromise: true,
      }),
      { settleDelayMs: 40 },
    );
    if (!race.done) {
      return {
        dialogOpened: true,
        dialog: race.dialog,
      };
    }
    const res = race.value;
    if (res.exceptionDetails) {
      const desc =
        res.exceptionDetails.exception?.description ||
        res.exceptionDetails.text ||
        "JavaScript evaluation failed";
      throw new Error(desc);
    }
    return res.result?.value;
  }

  async goto(url) {
    if (typeof url !== "string" || !url.trim()) {
      throw new TypeError("goto requires a non-empty URL string");
    }
    let normalized = url.trim();
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized)) {
      normalized = `https://${normalized}`;
    }
    assertSafeBrowserUrl(normalized);
    this.cursorState.visible = false;
    this._navigatingByAgent = true;
    try {
      if (this.isExtensionTab && this.chromeTabId != null) {
        const curMeta = await this.getMetadata().catch(() => ({ url: this.cachedMeta.url }));
        if (this.isPrivilegedNewTab(curMeta.url) || !this.conn.targetSessions?.has(this.targetId)) {
          await this.conn.client.request("updateTab", { tabId: this.chromeTabId, url: normalized }, 5000);
          this.cachedMeta.url = normalized;
          await sleep(180);
          if (!this.isPrivilegedNewTab(normalized)) {
            await this.waitForDomSettled(4000);
          }
          return;
        }
      }
      await this.send("Page.navigate", { url: normalized }, 20000);
      this.cachedMeta.url = normalized;
      await sleep(120);
      await this.waitForDomSettled(4000);
    } finally {
      this._navigatingByAgent = false;
    }
  }

  async back() {
    this._navigatingByAgent = true;
    try {
      const hist = await this.send("Page.getNavigationHistory");
      if (hist.currentIndex > 0) {
        const entry = hist.entries[hist.currentIndex - 1];
        this.cursorState.visible = false;
        await this.send("Page.navigateToHistoryEntry", { entryId: entry.id });
        await sleep(100);
        await this.waitForDomSettled(3000);
      }
    } finally {
      this._navigatingByAgent = false;
    }
  }

  async forward() {
    this._navigatingByAgent = true;
    try {
      const hist = await this.send("Page.getNavigationHistory");
      if (hist.currentIndex < hist.entries.length - 1) {
        const entry = hist.entries[hist.currentIndex + 1];
        this.cursorState.visible = false;
        await this.send("Page.navigateToHistoryEntry", { entryId: entry.id });
        await sleep(100);
        await this.waitForDomSettled(3000);
      }
    } finally {
      this._navigatingByAgent = false;
    }
  }

  async reload() {
    this._navigatingByAgent = true;
    try {
      this.cursorState.visible = false;
      await this.send("Page.reload", {});
      await sleep(100);
      await this.waitForDomSettled(3000);
    } finally {
      this._navigatingByAgent = false;
    }
  }

  async close() {
    this._navigatingByAgent = true;
    try {
      this.cursorState.visible = false;
      this.stopCompositorAwake({ sendStop: false });
      if (typeof this.conn?.off === "function") {
        this.conn.off("cdpEvent", this._boundCdpEvent);
        this.conn.off("cdpDetached", this._boundCdpDetached);
      }
      if (this.isExtensionTab && this.chromeTabId != null) {
        await this.conn.client.request("closeTab", { tabId: this.chromeTabId }, 5000).catch(() => {});
      } else {
        await this.conn.send("Target.closeTarget", { targetId: this.targetId }).catch(() => {});
      }
      this.conn.targetSessions?.delete(this.targetId);
      this.diffTracker.reset(`tab:${this.id}`);
      this.onClosed?.(this.id);
    } finally {
      this._navigatingByAgent = false;
    }
  }

  /**
   * Hover / move virtual cursor + dispatch CDP mouseMoved event on elementIndex, [x, y], or selector.
   */
  async hover(target, options = {}) {
    let x, y;
    let rect = null;
    if (Array.isArray(target) && target.length === 2) {
      x = Number(target[0]);
      y = Number(target[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new TypeError("Coordinate hover target [x, y] must contain finite numbers");
      }
    } else if (typeof target === "number" || typeof target === "string") {
      const prep = await this.evaluate(buildPrepareElementExpr(target));
      if (!prep?.ok) {
        throw new Error(prep?.error || `Failed to locate hover target ${JSON.stringify(target)}`);
      }
      x = prep.x;
      y = prep.y;
      rect = prep.rect ?? null;
    } else {
      throw new TypeError("hover target must be an elementIndex (number), [x, y] coordinate array, or selector string");
    }

    const finalRect = options.rect ?? rect;
    if (options.dispatchMoveEvent !== false) {
      await this.ensureCompositorAwake();
      await this.glideCursorTo(
        {
          x,
          y,
          rect: finalRect,
        },
        { showCursor: options.showCursor },
      );
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
      });
      await sleep(35);
      await this.showVirtualCursor(
        {
          x,
          y,
          rect: finalRect,
          ripple: Boolean(options.ripple),
          effectOnly: true,
        },
        { showCursor: options.showCursor },
      );
    } else {
      await this.showVirtualCursor(
        {
          x,
          y,
          rect: finalRect,
          ripple: Boolean(options.ripple),
        },
        { showCursor: options.showCursor },
      );
    }
    return {
      ok: true,
      x: Math.round(x),
      y: Math.round(y),
      ...(finalRect ? { rect: finalRect } : {}),
    };
  }

  /**
   * Highlight a target element, selector, or [x, y] box in the tab with the virtual cursor without firing DOM click/hover events unless requested.
   */
  async highlight(target, options = {}) {
    return this.hover(target, {
      ...options,
      dispatchMoveEvent: Boolean(options.dispatchMoveEvent),
    });
  }

  /**
   * Click by elementIndex (number), [x, y] tuple, or CSS/text selector string.
   */
  async click(target, options = {}) {
    let x, y;
    let rect = null;
    let isElementTarget = false;
    let targetSpec = target;

    if (Array.isArray(target) && target.length === 2) {
      x = Number(target[0]);
      y = Number(target[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new TypeError("Coordinate click target [x, y] must contain finite numbers");
      }
    } else if (typeof target === "number" || typeof target === "string") {
      isElementTarget = true;
      const prep = await this.evaluate(buildPrepareElementExpr(target));
      if (!prep?.ok) {
        throw new Error(prep?.error || `Failed to locate target ${JSON.stringify(target)}`);
      }
      x = prep.x;
      y = prep.y;
      rect = prep.rect ?? null;
    } else {
      throw new TypeError("click target must be an elementIndex (number), [x, y] coordinate array, or selector string");
    }

    const rawBtn = String(options.mouseButton ?? "left").toLowerCase();
    const button =
      rawBtn === "right" || rawBtn === "r"
        ? "right"
        : rawBtn === "middle" || rawBtn === "m"
          ? "middle"
          : "left";
    const buttonsMask = button === "right" ? 2 : button === "middle" ? 4 : 1;
    const clickCount = Math.max(1, Math.min(5, Number(options.clickCount ?? 1)));
    const durationMs = Number(options.durationMs ?? 0);

    await this.ensureCompositorAwake();

    // Glide toward target (~80% CloseEnough threshold) before spawning click ripple + mousePressed
    await this.glideCursorTo(
      {
        x,
        y,
        rect,
        button,
      },
      { showCursor: options.showCursor },
    );

    let modifiers = 0;
    let chordSpec = null;
    if (options.key) {
      chordSpec = parseCDPKeyChord(options.key);
      modifiers = chordSpec.modifiers;
      await this.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: chordSpec.key,
        code: chordSpec.code,
        windowsVirtualKeyCode: chordSpec.windowsVirtualKeyCode,
        modifiers,
      });
    }

    try {
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
        modifiers,
      });

      await this.showVirtualCursor(
        {
          x,
          y,
          rect,
          button,
          clickCount,
          ripple: options.ripple !== false,
          effectOnly: true,
        },
        { showCursor: options.showCursor },
      );

      for (let i = 1; i <= clickCount; i++) {
        await this._raceWithDialog(
          this.send("Input.dispatchMouseEvent", {
            type: "mousePressed",
            x,
            y,
            button,
            buttons: buttonsMask,
            clickCount: i,
            modifiers,
          }),
        );
        if (this.activeDialog) break;
        if (durationMs > 0) {
          await sleep(Math.min(10000, durationMs));
        } else {
          await sleep(15);
        }
        await this._raceWithDialog(
          this.send("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x,
            y,
            button,
            buttons: 0,
            clickCount: i,
            modifiers,
          }),
        );
        if (this.activeDialog) break;
      }
    } finally {
      if (chordSpec && !this.activeDialog) {
        await this.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: chordSpec.key,
          code: chordSpec.code,
          windowsVirtualKeyCode: chordSpec.windowsVirtualKeyCode,
          modifiers: 0,
        }).catch(() => {});
      }
    }

    if (this.activeDialog) {
      return { ok: true, x: Math.round(x), y: Math.round(y), dialog: { ...this.activeDialog } };
    }

    // Brief settle in case click triggered navigation or UI update
    await sleep(60);
    if (isElementTarget && typeof targetSpec === "number" && !this.activeDialog) {
      await this.waitForDomSettled(800);
    }

    if (!this.activeDialog) {
      // Refresh cursor timer after input/DOM settle (and re-mount cleanly without duplicate click ripple if page navigated)
      await this.showVirtualCursor(
        {
          x,
          y,
          rect,
          button,
          clickCount,
          ripple: false,
          effectOnly: true,
        },
        { showCursor: options.showCursor },
      );
    }
    return { ok: true, x: Math.round(x), y: Math.round(y) };
  }

  async setValue(elementIndex, value, options = {}) {
    const explicitBadge =
      options.showBadge !== undefined
        ? Boolean(options.showBadge)
        : options.badge != null && String(options.badge).trim() !== "";
    const badge = options.badge ?? "Set Value";
    if (elementIndex != null && options.showCursor !== false) {
      const prep = await this.evaluate(buildPrepareElementExpr(elementIndex)).catch(() => null);
      if (prep?.ok) {
        await this.glideCursorTo(
          { x: prep.x, y: prep.y, rect: prep.rect, badge, showBadge: explicitBadge },
          { showCursor: options.showCursor },
        );
      }
    }
    const res = await this.evaluate(buildSetValueExpr(elementIndex, value));
    if (!res?.ok) {
      throw new Error(res?.error || `Failed to setValue on element [${elementIndex}]`);
    }
    if (Number.isFinite(res.x) && Number.isFinite(res.y)) {
      await this.showVirtualCursor(
        {
          x: res.x,
          y: res.y,
          rect: res.rect,
          effectOnly: true,
          ripple: Boolean(options.ripple),
          badge,
          showBadge: explicitBadge,
        },
        { showCursor: options.showCursor },
      );
    }
    await sleep(30);
  }

  async typeText(elementIndex, text, options = {}) {
    if (typeof text !== "string") {
      throw new TypeError("typeText requires a string 'text'");
    }
    const explicitBadge =
      options.showBadge !== undefined
        ? Boolean(options.showBadge)
        : options.badge != null && String(options.badge).trim() !== "";
    const badge = options.badge ?? "Type";
    if (elementIndex != null) {
      const prep = await this.evaluate(buildPrepareElementExpr(elementIndex, { focus: true }));
      if (!prep?.ok) {
        throw new Error(prep?.error || `Failed to focus element [${elementIndex}]`);
      }
      await this.glideCursorTo(
        { x: prep.x, y: prep.y, rect: prep.rect, badge, showBadge: explicitBadge },
        { showCursor: options.showCursor },
      );
    } else if (this.isCursorCurrentlyVisible()) {
      await this.showVirtualCursor(
        { badge, showBadge: explicitBadge, effectOnly: true },
        { showCursor: options.showCursor },
      );
    } else if (options.showCursor !== false) {
      const anchor = await this.evaluate(buildGetActiveElementAnchorExpr()).catch(() => null);
      if (anchor?.hasActiveElement && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)) {
        await this.glideCursorTo(
          { x: anchor.x, y: anchor.y, rect: anchor.rect, badge, showBadge: explicitBadge },
          { showCursor: options.showCursor },
        );
      }
    }
    // Split on newlines so \n triggers real Enter key events
    const segments = text.split("\n");
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].length > 0) {
        await this.send("Input.insertText", { text: segments[i] });
      }
      if (i < segments.length - 1) {
        await this.pressKey(null, "Return", { showCursor: false });
      }
    }
    if (this.isCursorCurrentlyVisible()) {
      await this.showVirtualCursor(
        { badge, showBadge: explicitBadge, effectOnly: true },
        { showCursor: options.showCursor },
      );
    }
    await sleep(30);
  }

  async pressKey(elementIndex, key, options = {}) {
    const clippedKey = String(key ?? "").length > 14 ? `${String(key).slice(0, 12)}..` : String(key ?? "");
    const explicitBadge =
      options.showBadge !== undefined
        ? Boolean(options.showBadge)
        : options.badge != null && String(options.badge).trim() !== "";
    const badge = options.badge ?? `Key: ${clippedKey}`;
    if (elementIndex != null) {
      const prep = await this.evaluate(buildPrepareElementExpr(elementIndex, { focus: true }));
      if (!prep?.ok) {
        throw new Error(prep?.error || `Failed to focus element [${elementIndex}]`);
      }
      await this.glideCursorTo(
        { x: prep.x, y: prep.y, rect: prep.rect, badge, showBadge: explicitBadge },
        { showCursor: options.showCursor },
      );
    } else if (this.isCursorCurrentlyVisible()) {
      await this.showVirtualCursor(
        { badge, showBadge: explicitBadge, effectOnly: true },
        { showCursor: options.showCursor },
      );
    } else if (options.showCursor !== false) {
      const anchor = await this.evaluate(buildGetActiveElementAnchorExpr()).catch(() => null);
      if (anchor?.hasActiveElement && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)) {
        await this.glideCursorTo(
          { x: anchor.x, y: anchor.y, rect: anchor.rect, badge, showBadge: explicitBadge },
          { showCursor: options.showCursor },
        );
      }
    }
    const spec = parseCDPKeyChord(key);
    await this.send("Input.dispatchKeyEvent", {
      type: spec.text ? "keyDown" : "rawKeyDown",
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
      nativeVirtualKeyCode: spec.nativeVirtualKeyCode,
      modifiers: spec.modifiers,
      ...(spec.location ? { location: spec.location } : {}),
      ...(spec.text ? { text: spec.text, unmodifiedText: spec.text } : {}),
      ...(spec.commands ? { commands: spec.commands } : {}),
    });
    const dur = Number(options.durationMs ?? 0);
    if (dur > 0) {
      await sleep(Math.min(10000, dur));
    } else {
      await sleep(12);
    }
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
      nativeVirtualKeyCode: spec.nativeVirtualKeyCode,
      modifiers: spec.modifiers,
      ...(spec.location ? { location: spec.location } : {}),
    });
    if (this.isCursorCurrentlyVisible()) {
      await this.showVirtualCursor(
        { badge, showBadge: explicitBadge, effectOnly: true },
        { showCursor: options.showCursor },
      );
    }
    await sleep(30);
  }

  async paste(elementIndex, text, options = {}) {
    const explicitBadge =
      options.showBadge !== undefined
        ? Boolean(options.showBadge)
        : options.badge != null && String(options.badge).trim() !== "";
    const badge = options.badge ?? "Paste";
    if (elementIndex != null && options.showCursor !== false) {
      const prep = await this.evaluate(buildPrepareElementExpr(elementIndex)).catch(() => null);
      if (prep?.ok) {
        await this.glideCursorTo(
          { x: prep.x, y: prep.y, rect: prep.rect, badge, showBadge: explicitBadge },
          { showCursor: options.showCursor },
        );
      }
    }
    const res = await this.evaluate(buildPasteExpr(elementIndex, text, options.format ?? "text"));
    if (!res?.ok) {
      throw new Error(res?.error || "Paste into browser tab failed");
    }
    if (Number.isFinite(res.x) && Number.isFinite(res.y)) {
      await this.showVirtualCursor(
        {
          x: res.x,
          y: res.y,
          rect: res.rect,
          effectOnly: true,
          ripple: Boolean(options.ripple),
          badge,
          showBadge: explicitBadge,
        },
        { showCursor: options.showCursor },
      );
    }
    await sleep(30);
  }

  async selectText(elementIndex, text, options = {}) {
    const explicitBadge =
      options.showBadge !== undefined
        ? Boolean(options.showBadge)
        : options.badge != null && String(options.badge).trim() !== "";
    const badge = options.badge ?? "Select";
    if (elementIndex != null && options.showCursor !== false) {
      const prep = await this.evaluate(buildPrepareElementExpr(elementIndex)).catch(() => null);
      if (prep?.ok) {
        await this.glideCursorTo(
          { x: prep.x, y: prep.y, rect: prep.rect, badge, showBadge: explicitBadge },
          { showCursor: options.showCursor },
        );
      }
    }
    const res = await this.evaluate(buildSelectTextExpr(elementIndex, text, options));
    if (!res?.ok) {
      throw new Error(res?.error || `selectText failed on element [${elementIndex}]`);
    }
    if (Number.isFinite(res.x) && Number.isFinite(res.y)) {
      await this.showVirtualCursor(
        {
          x: res.x,
          y: res.y,
          rect: res.rect,
          effectOnly: true,
          ripple: Boolean(options.ripple),
          badge,
          showBadge: explicitBadge,
        },
        { showCursor: options.showCursor },
      );
    }
  }

  async performSecondaryAction(elementIndex, action, options = {}) {
    const explicitBadge =
      options.showBadge !== undefined
        ? Boolean(options.showBadge)
        : options.badge != null && String(options.badge).trim() !== "";
    const badge = options.badge ?? String(action ?? "Action");
    if (elementIndex != null && options.showCursor !== false) {
      const prep = await this.evaluate(buildPrepareElementExpr(elementIndex)).catch(() => null);
      if (prep?.ok) {
        await this.glideCursorTo(
          { x: prep.x, y: prep.y, rect: prep.rect, button: "secondary", badge, showBadge: explicitBadge },
          { showCursor: options.showCursor },
        );
      }
    }
    const res = await this.evaluate(buildSecondaryActionExpr(elementIndex, action));
    if (!res?.ok) {
      throw new Error(res?.error || `performSecondaryAction('${action}') failed on element [${elementIndex}]`);
    }
    if (Number.isFinite(res.x) && Number.isFinite(res.y)) {
      await this.showVirtualCursor(
        {
          x: res.x,
          y: res.y,
          rect: res.rect,
          button: "secondary",
          ripple: options.ripple !== false,
          effectOnly: true,
          badge,
          showBadge: explicitBadge,
        },
        { showCursor: options.showCursor },
      );
    }
  }

  async scroll(target, direction = "down", pages = 1, options = {}) {
    let x = null;
    let y = null;
    let rect = null;
    if (Array.isArray(target) && target.length === 2) {
      x = Number(target[0]);
      y = Number(target[1]);
    } else if (typeof target === "number" || typeof target === "string") {
      const prep = await this.evaluate(buildPrepareElementExpr(target));
      if (prep?.ok) {
        x = prep.x;
        y = prep.y;
        rect = prep.rect ?? null;
      }
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      if (this.isCursorCurrentlyVisible() && Number.isFinite(this.cursorState.x) && Number.isFinite(this.cursorState.y)) {
        x = this.cursorState.x;
        y = this.cursorState.y;
      } else {
        const anchor = await this.evaluate(buildGetActiveElementAnchorExpr()).catch(() => null);
        x = anchor?.viewport?.width ? Math.round(anchor.viewport.width / 2) : 640;
        y = anchor?.viewport?.height ? Math.round(anchor.viewport.height / 2) : 400;
      }
    }

    const amt = Math.round((Number(pages) || 1) * 520);
    const d = String(direction).toLowerCase();
    let deltaX = 0;
    let deltaY = 0;
    let arrow = "↓";
    if (d === "down" || d === "d") {
      deltaY = amt;
      arrow = "↓";
    } else if (d === "up" || d === "u") {
      deltaY = -amt;
      arrow = "↑";
    } else if (d === "right" || d === "r") {
      deltaX = amt;
      arrow = "→";
    } else if (d === "left" || d === "l") {
      deltaX = -amt;
      arrow = "←";
    } else {
      throw new TypeError(`Invalid scroll direction "${direction}"`);
    }

    await this.ensureCompositorAwake();

    const explicitBadge =
      options.showBadge !== undefined
        ? Boolean(options.showBadge)
        : options.badge != null && String(options.badge).trim() !== "";
    const badge = options.badge ?? `Scroll ${arrow}`;
    if (target != null) {
      await this.glideCursorTo({ x, y, rect, badge, showBadge: explicitBadge }, { showCursor: options.showCursor });
    }
    await this.showVirtualCursor(
      {
        x,
        y,
        rect,
        scrollDirection: d,
        effectOnly: target != null,
        ripple: Boolean(options.ripple),
        badge,
        showBadge: explicitBadge,
      },
      { showCursor: options.showCursor },
    );

    await this.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX,
      deltaY,
    });
    await sleep(60);
    if (this.isCursorCurrentlyVisible()) {
      await this.showVirtualCursor(
        { x, y, rect, effectOnly: true, badge, showBadge: explicitBadge },
        { showCursor: options.showCursor },
      );
    }
  }

  async drag(from, to, options = {}) {
    const resolveEndpoint = async (ep, label) => {
      if (Array.isArray(ep) && ep.length >= 2) {
        const x = Number(ep[0]);
        const y = Number(ep[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          throw new TypeError(`drag ${label} [x, y] must contain finite numbers`);
        }
        return { x, y, rect: null };
      }
      if (typeof ep === "number" || typeof ep === "string") {
        const prep = await this.evaluate(buildPrepareElementExpr(ep));
        if (!prep?.ok) {
          throw new Error(prep?.error || `Failed to locate drag ${label} ${JSON.stringify(ep)}`);
        }
        return { x: prep.x, y: prep.y, rect: prep.rect ?? null };
      }
      throw new TypeError(`drag ${label} must be [x, y], elementIndex (number), or selector (string)`);
    };
    const startEp = await resolveEndpoint(from, "from");
    const endEp = await resolveEndpoint(to, "to");
    const { x: fx, y: fy, rect: fRect } = startEp;
    const { x: tx, y: ty, rect: tRect } = endEp;
    const explicitBadge =
      options.showBadge !== undefined
        ? Boolean(options.showBadge)
        : options.badge != null && String(options.badge).trim() !== "";
    const badge = options.badge ?? "Drag";

    await this.ensureCompositorAwake();

    await this.glideCursorTo(
      { x: fx, y: fy, rect: fRect, badge, showBadge: explicitBadge },
      { showCursor: options.showCursor },
    );
    await this.showVirtualCursor(
      { x: fx, y: fy, rect: fRect, ripple: true, dragging: true, effectOnly: true, badge, showBadge: explicitBadge },
      { showCursor: options.showCursor },
    );
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: fx, y: fy });
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: fx,
      y: fy,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    const steps = 16;
    for (let s = 1; s <= steps; s++) {
      const rawT = s / steps;
      const t = rawT * rawT * (3 - 2 * rawT);
      const cx = fx + (tx - fx) * t;
      const cy = fy + (ty - fy) * t;
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: cx,
        y: cy,
        button: "left",
        buttons: 1,
      });
      await this.showVirtualCursor(
        { x: cx, y: cy, dragging: true, instant: true, badge, showBadge: explicitBadge },
        { showCursor: options.showCursor },
      );
      await sleep(10);
    }
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: tx,
      y: ty,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await this.showVirtualCursor(
      { x: tx, y: ty, rect: tRect, ripple: true, dragging: false, instant: true, badge, showBadge: explicitBadge },
      { showCursor: options.showCursor },
    );
    await sleep(40);
  }

  async _uploadViaDataTransfer(target, files, options = {}) {
    const uploadId = `up_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const CHUNK_CHARS = 262_144;
    await this.evaluate(buildInitUploadStagingExpr(uploadId));

    const metas = [];
    for (let i = 0; i < files.length; i++) {
      const fp = files[i];
      const stat = fs.statSync(fp);
      const buf = fs.readFileSync(fp);
      const b64 = buf.toString("base64");
      for (let off = 0; off < b64.length; off += CHUNK_CHARS) {
        const chunk = b64.slice(off, off + CHUNK_CHARS);
        await this.evaluate(buildAppendUploadChunkExpr(uploadId, i, chunk));
      }
      const mimeType = guessMimeType(fp);
      metas.push({
        name: path.basename(fp),
        type: mimeType,
        mime: mimeType,
        lastModified: Math.round(stat.mtimeMs || Date.now()),
      });
    }

    const commitRes = await this.evaluate(
      buildCommitDataTransferUploadExpr({
        uploadId,
        targetSpec: target,
        fileMetas: metas,
      }),
    );
    if (!commitRes?.ok) {
      throw new Error(commitRes?.error || `Tier-2 DataTransfer upload failed on target ${JSON.stringify(target)}`);
    }
    if (options.showCursor !== false && Number.isFinite(commitRes.x) && Number.isFinite(commitRes.y)) {
      await this.showVirtualCursor(
        { x: commitRes.x, y: commitRes.y, rect: commitRes.rect ?? null, ripple: true, effectOnly: true },
        { showCursor: options.showCursor },
      );
    }
    return {
      ok: true,
      tier: "datatransfer",
      mode: commitRes.mechanism ?? commitRes.mode,
      count: commitRes.fileCount ?? commitRes.count ?? files.length,
      files,
    };
  }

  /**
   * Two-Tier Bulletproof File Upload:
   * - Supports direct `<input type="file">` (`target`) AND button-triggered file choosers (`options.triggerTarget`).
   * - Tier 1: `DOM.setFileInputFiles` (or `Page.setInterceptFileChooserDialog` + `Page.fileChooserOpened`).
   * - Tier 2 (Zero-Config Fallback): Chunked base64 -> `new File(..., { type, lastModified })` inside `new DataTransfer()`,
   *   assigning `input.files = dt.files` + dispatching `input`/`change`, OR dispatching `dragenter`/`dragover`/`drop`
   *   with `DataTransfer` onto custom dropzones!
   */
  async uploadFiles(target, filePaths, options = {}) {
    const files = (Array.isArray(filePaths) ? filePaths : [filePaths]).map((f) => path.resolve(String(f)));
    if (files.length === 0) {
      throw new Error("uploadFiles requires at least one file path");
    }
    for (const f of files) {
      if (!fs.existsSync(f) || !fs.statSync(f).isFile()) {
        throw new Error(`Upload file does not exist or is not a file: ${f}`);
      }
    }

    const triggerTarget = options.triggerTarget ?? null;
    if (triggerTarget != null) {
      await this.send("Page.setInterceptFileChooserDialog", { enabled: true });
      let onChooserEvent = null;
      const chooserPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (onChooserEvent && typeof this.conn?.off === "function") {
            this.conn.off("cdpEvent", onChooserEvent);
          }
          reject(new Error(`Timed out waiting for file chooser after clicking ${JSON.stringify(triggerTarget)}`));
        }, options.timeoutMs ?? 6000);

        onChooserEvent = (ev) => {
          if (this._matchesTabEvent(ev) && ev.method === "Page.fileChooserOpened") {
            clearTimeout(timer);
            if (typeof this.conn?.off === "function") {
              this.conn.off("cdpEvent", onChooserEvent);
            }
            resolve(ev.params || {});
          }
        };
        if (typeof this.conn?.on === "function") {
          this.conn.on("cdpEvent", onChooserEvent);
        } else {
          clearTimeout(timer);
          reject(new Error("CDP connection does not support fileChooserOpened events"));
        }
      });

      try {
        await this.click(triggerTarget, { showCursor: options.showCursor });
        const chooser = await chooserPromise;
        if (chooser.backendNodeId != null && !options.preferDataTransfer) {
          try {
            await this.send("DOM.setFileInputFiles", {
              backendNodeId: chooser.backendNodeId,
              files,
            });
            return { ok: true, tier: "file_chooser_cdp", count: files.length, files };
          } catch (cdpErr) {
            if (!/Not allowed|file URLs|Invalid|Cannot/i.test(String(cdpErr?.message || cdpErr))) {
              throw cdpErr;
            }
          }
        }
        return await this._uploadViaDataTransfer(target ?? "input[type='file']", files, options);
      } finally {
        if (onChooserEvent && typeof this.conn?.off === "function") {
          this.conn.off("cdpEvent", onChooserEvent);
        }
        await this.send("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
      }
    }

    if (target == null) {
      throw new TypeError("uploadFiles requires element_index / selector or trigger_element_index / trigger_selector");
    }

    if (options.showCursor !== false) {
      const prep = await this.evaluate(buildPrepareElementExpr(target)).catch(() => null);
      if (prep?.ok) {
        await this.glideCursorTo({ x: prep.x, y: prep.y, rect: prep.rect }, { showCursor: options.showCursor });
      }
    }

    if (options.preferDataTransfer) {
      return await this._uploadViaDataTransfer(target, files, options);
    }

    const resolveExpr =
      typeof target === "number"
        ? `window.__agCuaMap?.get(${target})`
        : `(() => {
            const s = ${JSON.stringify(String(target))};
            try { return document.querySelector(s); } catch { return null; }
          })()`;
    const evalRes = await this.send("Runtime.evaluate", { expression: resolveExpr }).catch(() => null);
    const objectId = evalRes?.result?.objectId;

    if (objectId) {
      const isFileInput = await this.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function() { return this.tagName && this.tagName.toLowerCase() === 'input' && this.type === 'file'; }",
        returnByValue: true,
      })
        .then((r) => Boolean(r?.result?.value))
        .catch(() => false);

      if (isFileInput) {
        try {
          await this.send("DOM.setFileInputFiles", {
            objectId,
            files,
          });
          return { ok: true, tier: "cdp_dom", count: files.length, files };
        } catch (err) {
          if (!/Not allowed|file URLs|Node is not a file input|Cannot find|Invalid/i.test(String(err?.message || err))) {
            throw err;
          }
        }
      }
    }

    // Automatic Tier-2 zero-config fallback (works without "Allow access to file URLs" AND on custom dropzones!)
    return await this._uploadViaDataTransfer(target, files, options);
  }

  async listDownloads({ limit = 30 } = {}) {
    const cap = Math.max(1, Math.min(200, Number(limit) || 30));
    if (this.isExtensionTab && this.conn?.client) {
      const res = await this.conn.client.request("downloads.list", { limit: cap }, 5000);
      return res?.downloads || [];
    }
    const items = Array.from(this.conn.downloadsByGuid?.values() || []);
    return items.slice(-cap).reverse();
  }

  async waitForDownload({ clickTarget = null, url = null, timeoutMs = 30000, showCursor = true } = {}) {
    const before = await this.listDownloads({ limit: 50 }).catch(() => []);
    const baselineCompleteIds = new Set(before.filter((d) => d.state === "complete").map((d) => String(d.id)));
    const startedAfterMs = Date.now() - 250;

    let trackedId = null;
    let settledDownload = null;
    let eventResolve = null;

    const eventEmitter = this.isExtensionTab ? this.conn?.client : this.conn;
    const onDlEvent = () => {
      if (eventResolve) {
        const r = eventResolve;
        eventResolve = null;
        r();
      }
    };
    if (typeof eventEmitter?.on === "function") {
      eventEmitter.on("downloadEvent", onDlEvent);
    }

    try {
      if (url) {
        assertSafeBrowserUrl(url);
        if (this.isExtensionTab && this.conn?.client) {
          const dlRes = await this.conn.client.request("downloads.download", { url: String(url) }, 8000);
          if (dlRes?.downloadId != null) trackedId = String(dlRes.downloadId);
        } else {
          await this.evaluate(`(() => {
            const a = document.createElement("a");
            a.href = ${JSON.stringify(String(url))};
            a.download = "";
            document.body.appendChild(a);
            a.click();
            a.remove();
            return true;
          })()`);
        }
      } else if (clickTarget != null) {
        await this.click(clickTarget, { showCursor });
      }

      const deadline = Date.now() + Math.max(500, Number(timeoutMs) || 30000);
      while (Date.now() < deadline) {
        const current = await this.listDownloads({ limit: 40 }).catch(() => []);
        const candidate = current.find((d) => {
          const idStr = String(d.id);
          if (trackedId != null) return idStr === trackedId;
          if (baselineCompleteIds.has(idStr)) return false;
          if (d.startTime) {
            const parsedStart = Date.parse(d.startTime);
            if (Number.isFinite(parsedStart) && parsedStart < startedAfterMs - 2000) return false;
          }
          return true;
        });

        if (candidate) {
          trackedId = String(candidate.id);
          if (candidate.state === "complete") {
            settledDownload = candidate;
            break;
          }
          if (candidate.state === "interrupted") {
            throw new Error(`Download failed/interrupted: ${candidate.error || candidate.filename || candidate.url}`);
          }
        }

        await new Promise((resolve) => {
          const t = setTimeout(resolve, 200);
          eventResolve = () => {
            clearTimeout(t);
            resolve();
          };
        });
      }
    } finally {
      if (typeof eventEmitter?.off === "function") {
        eventEmitter.off("downloadEvent", onDlEvent);
      }
    }

    if (!settledDownload) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for download to complete`);
    }
    return {
      ok: true,
      download: settledDownload,
    };
  }

  getDialog() {
    return this.activeDialog ? { open: true, ...this.activeDialog } : { open: false, dialog: null };
  }

  async handleDialog({ accept = true, promptText } = {}) {
    const prev = this.activeDialog ? { ...this.activeDialog } : null;
    await this.send(
      "Page.handleJavaScriptDialog",
      {
        accept: Boolean(accept),
        ...(promptText !== undefined ? { promptText: String(promptText) } : {}),
      },
      5000,
    );
    this.activeDialog = null;
    await sleep(40);
    return {
      ok: true,
      handled: prev,
      accepted: Boolean(accept),
      ...(promptText !== undefined ? { promptText: String(promptText) } : {}),
    };
  }

  getConsoleLogs({ level = null, clear = false, limit = 200 } = {}) {
    const normLevel = level ? String(level).trim().toLowerCase() : null;
    const filtered = normLevel
      ? this.consoleLogs.filter((l) => String(l.level).toLowerCase() === normLevel)
      : [...this.consoleLogs];
    if (clear) {
      this.consoleLogs.length = 0;
    }
    const cap = Math.max(1, Math.min(RING_BUFFER_LIMIT, Number(limit) || 200));
    return {
      logs: filtered.slice(-cap),
      totalBuffered: this.consoleLogs.length,
    };
  }

  getNetworkRequests({ urlFilter = null, method = null, status = null, clear = false, limit = 200 } = {}) {
    const needle = urlFilter ? String(urlFilter).toLowerCase() : null;
    const normMethod = method ? String(method).toUpperCase() : null;
    const statusNum = status != null ? Number(status) : null;

    const filtered = this.networkRequests.filter((r) => {
      if (needle && !String(r.url || "").toLowerCase().includes(needle)) return false;
      if (normMethod && String(r.method || "").toUpperCase() !== normMethod) return false;
      if (statusNum != null && Number.isFinite(statusNum) && r.status !== statusNum) return false;
      return true;
    });

    if (clear) {
      this.networkRequests.length = 0;
      this.networkById.clear();
    }

    const cap = Math.max(1, Math.min(RING_BUFFER_LIMIT, Number(limit) || 200));
    return {
      requests: filtered.slice(-cap),
      totalBuffered: this.networkRequests.length,
    };
  }

  async getNetworkBody(requestId) {
    if (!requestId) {
      throw new TypeError("getNetworkBody requires 'requestId'");
    }
    const res = await this.send("Network.getResponseBody", { requestId: String(requestId) }, 8000);
    const entry = this.networkById.get(String(requestId)) || null;
    return {
      requestId: String(requestId),
      url: entry?.url || "",
      status: entry?.status ?? null,
      mimeType: entry?.mimeType || "",
      body: res?.body ?? "",
      base64Encoded: Boolean(res?.base64Encoded),
    };
  }

  async getCookies({ urls = null, domain = null, name = null } = {}) {
    let urlList = null;
    if (Array.isArray(urls) && urls.length > 0) {
      urlList = urls.map(String);
    } else if (typeof urls === "string" && urls.trim()) {
      urlList = [urls.trim()];
    } else {
      const meta = await this.getMetadata().catch(() => ({ url: this.cachedMeta.url }));
      if (meta?.url && /^https?:/i.test(meta.url)) {
        urlList = [meta.url];
      }
    }

    let cookies = [];
    if (this.isExtensionTab && !this.conn.targetSessions?.has(this.targetId) && this.conn?.client) {
      const res = await this.conn.client.request(
        "cookies.getAll",
        {
          ...(urlList?.[0] ? { url: urlList[0] } : {}),
          ...(domain ? { domain: String(domain) } : {}),
          ...(name ? { name: String(name) } : {}),
        },
        5000,
      );
      cookies = res?.cookies || [];
    } else {
      const res = await this.send("Network.getCookies", urlList ? { urls: urlList } : {});
      cookies = res?.cookies || [];
      if (domain) {
        const d = String(domain).toLowerCase().replace(/^\./, "");
        cookies = cookies.filter((c) => String(c.domain || "").toLowerCase().replace(/^\./, "").endsWith(d));
      }
      if (name) {
        cookies = cookies.filter((c) => c.name === String(name));
      }
    }
    return { cookies };
  }

  async setCookies(cookies = []) {
    const list = Array.isArray(cookies) ? cookies : [cookies];
    if (list.length === 0) return { ok: true, count: 0 };
    const meta = await this.getMetadata().catch(() => ({ url: this.cachedMeta.url }));
    const fallbackUrl = meta?.url && /^https?:/i.test(meta.url) ? meta.url : undefined;
    const normalized = list.map((c) => ({
      ...c,
      name: String(c.name),
      value: String(c.value ?? ""),
      ...(!c.url && !c.domain && fallbackUrl ? { url: fallbackUrl } : {}),
    }));
    await this.send("Network.setCookies", { cookies: normalized });
    return { ok: true, count: normalized.length };
  }

  async clearCookies({ url = null, domain = null, name = null, allBrowser = false } = {}) {
    if (allBrowser && !this.isExtensionTab) {
      await this.send("Network.clearBrowserCookies", {});
      return { ok: true, clearedAll: true };
    }
    const { cookies } = await this.getCookies({
      urls: url ? [String(url)] : null,
      domain,
      name,
    });
    let deletedCount = 0;
    for (const c of cookies) {
      await this.send("Network.deleteCookies", {
        name: c.name,
        ...(c.domain ? { domain: c.domain } : {}),
        ...(c.path ? { path: c.path } : {}),
        ...(url ? { url: String(url) } : {}),
      }).catch(() => {});
      deletedCount++;
    }
    return { ok: true, deletedCount };
  }

  async getStorage({ type = "local", key = null } = {}) {
    const storeExpr = String(type).toLowerCase() === "session" ? "window.sessionStorage" : "window.localStorage";
    return await this.evaluate(`(() => {
      const store = ${storeExpr};
      const k = ${JSON.stringify(key)};
      if (k != null) {
        return { type: ${JSON.stringify(type)}, key: k, value: store.getItem(String(k)) };
      }
      const entries = {};
      for (let i = 0; i < store.length; i++) {
        const itemKey = store.key(i);
        if (itemKey != null) entries[itemKey] = store.getItem(itemKey);
      }
      return { type: ${JSON.stringify(type)}, entries, count: Object.keys(entries).length };
    })()`);
  }

  async setStorage({ type = "local", entries = {}, clear = false, removeKeys = [] } = {}) {
    const storeExpr = String(type).toLowerCase() === "session" ? "window.sessionStorage" : "window.localStorage";
    return await this.evaluate(`(() => {
      const store = ${storeExpr};
      if (${Boolean(clear)}) {
        store.clear();
      }
      for (const rk of ${JSON.stringify(Array.isArray(removeKeys) ? removeKeys : [])}) {
        store.removeItem(String(rk));
      }
      const map = ${JSON.stringify(entries && typeof entries === "object" ? entries : {})};
      for (const [k, v] of Object.entries(map)) {
        if (v === null) store.removeItem(k);
        else store.setItem(k, String(v));
      }
      return { ok: true, type: ${JSON.stringify(type)}, count: store.length };
    })()`);
  }

  async claimInPlace(sessionId = this.sessionIdName) {
    if (!this.isExtensionTab || this.chromeTabId == null || !this.conn?.client) {
      return { ok: true, tabId: this.id, role: "claimed", localOnly: true };
    }
    const res = await this.conn.client.request("claimTab", {
      sessionId: sessionId || "default",
      tabId: this.chromeTabId,
    });
    this.cachedMeta.ownership = { sessionId: sessionId || "default", role: "claimed", createdByAgent: false };
    return res;
  }

  async markTab(status = "deliverable", { sessionId = this.sessionIdName, activate } = {}) {
    if (!this.isExtensionTab || this.chromeTabId == null || !this.conn?.client) {
      if (status === "handoff") {
        await this.detach().catch(() => {});
      }
      return { ok: true, tabId: this.id, status, localOnly: true };
    }
    if (status === "handoff" && this.conn.targetSessions?.has(this.targetId) && !this.activeDialog) {
      const sid = this.conn.targetSessions.get(this.targetId);
      if (sid) {
        await this.conn
          .send("Runtime.evaluate", { expression: buildRemoveBrowserCursorExpr(), returnByValue: true }, sid, 1000)
          .catch(() => {});
      }
    }
    const res = await this.conn.client.request("markTab", {
      sessionId: sessionId || "default",
      tabId: this.chromeTabId,
      status,
      ...(activate !== undefined ? { activate: Boolean(activate) } : {}),
    });
    this.cachedMeta.ownership = {
      ...(this.cachedMeta.ownership || {}),
      sessionId: sessionId || "default",
      role: status,
    };
    if (status === "handoff") {
      this._activeIndicatorInjected = false;
      this.cursorState.visible = false;
    }
    return res;
  }

  async markDeliverable(opts = {}) {
    return this.markTab("deliverable", opts);
  }

  async markHandoff(opts = {}) {
    return this.markTab("handoff", opts);
  }

  async markScratch(opts = {}) {
    return this.markTab("scratch", opts);
  }

  async _resolveFrameTarget(iframeSelector) {
    await this.send("DOM.enable", {}).catch(() => {});
    const frameEval = await this.send("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(String(iframeSelector))})`,
    });
    const objectId = frameEval?.result?.objectId;
    if (!objectId) {
      throw new Error(`Iframe selector ${JSON.stringify(iframeSelector)} not found in tab ${this.id}`);
    }

    const infoRes = await this.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() {
        const r = this.getBoundingClientRect();
        let sameOrigin = false;
        try { sameOrigin = Boolean(this.contentDocument && this.contentDocument.body); } catch { sameOrigin = false; }
        return {
          left: Math.round(r.left + (this.clientLeft || 0)),
          top: Math.round(r.top + (this.clientTop || 0)),
          width: Math.round(this.clientWidth || r.width || 0),
          height: Math.round(this.clientHeight || r.height || 0),
          src: this.src || this.getAttribute("src") || "",
          sameOrigin
        };
      }`,
      returnByValue: true,
    });
    const frameMeta = infoRes?.result?.value;
    if (!frameMeta) {
      throw new Error(`Could not inspect iframe geometry for ${JSON.stringify(iframeSelector)}`);
    }

    if (frameMeta.sameOrigin) {
      return { mode: "same_origin", frameMeta, childSessionId: null };
    }

    // Cross-origin OOPIF resolution via DOM.describeNode frameId or URL match
    let frameId = null;
    try {
      const desc = await this.send("DOM.describeNode", { objectId });
      frameId = desc?.node?.frameId || null;
    } catch {}

    let matched = null;
    for (const child of this.childFrames.values()) {
      if (frameId && child.targetId === frameId) {
        matched = child;
        break;
      }
    }
    if (!matched && frameMeta.src) {
      for (const child of this.childFrames.values()) {
        if (child.url === frameMeta.src || (child.url && frameMeta.src && child.url.startsWith(frameMeta.src))) {
          matched = child;
          break;
        }
      }
    }
    if (!matched && this.childFrames.size === 1) {
      matched = Array.from(this.childFrames.values())[0];
    }
    if (!matched) {
      throw new Error(
        `Cross-origin OOPIF target session not attached yet for ${JSON.stringify(iframeSelector)} (src="${frameMeta.src}")`,
      );
    }
    return { mode: "oopif", frameMeta, childSessionId: matched.sessionId };
  }

  /**
   * Playwright-compatible `frameLocator(iframeSelector)` supporting both same-origin iframes and cross-origin OOPIFs!
   */
  frameLocator(iframeSelector) {
    const self = this;

    const evalInFrame = async (expression) => {
      const resolved = await self._resolveFrameTarget(iframeSelector);
      const exprStr = typeof expression === "function" ? `(${expression.toString()})()` : String(expression);
      if (resolved.mode === "same_origin") {
        return {
          resolved,
          value: await self.evaluate(`(() => {
            const frameEl = document.querySelector(${JSON.stringify(String(iframeSelector))});
            if (!frameEl || !frameEl.contentWindow) throw new Error("Iframe detached");
            return frameEl.contentWindow.eval(${JSON.stringify(exprStr)});
          })()`),
        };
      }
      const res = await self.conn.send(
        "Runtime.evaluate",
        {
          expression: exprStr,
          returnByValue: true,
          awaitPromise: true,
        },
        resolved.childSessionId,
      );
      if (res.exceptionDetails) {
        throw new Error(
          res.exceptionDetails.exception?.description || res.exceptionDetails.text || "OOPIF evaluation failed",
        );
      }
      return { resolved, value: res.result?.value };
    };

    const resolveInnerCoords = async (innerTarget, { focus = false } = {}) => {
      const { resolved, value: prep } = await evalInFrame(buildPrepareElementExpr(innerTarget, { focus }));
      if (!prep?.ok) {
        throw new Error(prep?.error || `Failed to locate ${JSON.stringify(innerTarget)} inside iframe ${iframeSelector}`);
      }
      const topX = resolved.frameMeta.left + prep.x;
      const topY = resolved.frameMeta.top + prep.y;
      const topRect = prep.rect
        ? {
            x: resolved.frameMeta.left + prep.rect.x,
            y: resolved.frameMeta.top + prep.rect.y,
            width: prep.rect.width,
            height: prep.rect.height,
          }
        : null;
      return { x: topX, y: topY, rect: topRect };
    };

    return {
      async evaluate(expression) {
        const { value } = await evalInFrame(expression);
        return value;
      },
      async getAXState(opts = {}) {
        const { resolved, value: snap } = await evalInFrame(BUILD_AX_SNAPSHOT_EXPR(opts.maxElements ?? 400));
        const header = `Frame "${snap?.title || iframeSelector}" url="${snap?.url || resolved.frameMeta.src}" offset=(${resolved.frameMeta.left},${resolved.frameMeta.top}) size=${resolved.frameMeta.width}x${resolved.frameMeta.height}`;
        const fullTree = [header, ...(snap?.lines ?? [])].join("\n");
        return {
          stateText: fullTree,
          fullTree,
          offset: { x: resolved.frameMeta.left, y: resolved.frameMeta.top },
          elementCount: snap?.elementCount ?? 0,
        };
      },
      async click(innerTarget, opts = {}) {
        const pt = await resolveInnerCoords(innerTarget);
        return self.click([pt.x, pt.y], { ...opts, rect: pt.rect });
      },
      async hover(innerTarget, opts = {}) {
        const pt = await resolveInnerCoords(innerTarget);
        return self.hover([pt.x, pt.y], { ...opts, rect: pt.rect });
      },
      async setValue(innerTarget, value, opts = {}) {
        const { resolved, value: res } = await evalInFrame(buildSetValueExpr(innerTarget, value));
        if (!res?.ok) {
          throw new Error(res?.error || `Failed to setValue on ${JSON.stringify(innerTarget)} in ${iframeSelector}`);
        }
        if (opts.showCursor !== false && Number.isFinite(res.x) && Number.isFinite(res.y)) {
          await self.showVirtualCursor(
            {
              x: resolved.frameMeta.left + res.x,
              y: resolved.frameMeta.top + res.y,
              effectOnly: true,
              ripple: Boolean(opts.ripple),
            },
            { showCursor: opts.showCursor },
          );
        }
        return res;
      },
      async typeText(innerTarget, text, opts = {}) {
        const pt = await resolveInnerCoords(innerTarget, { focus: true });
        await self.glideCursorTo({ x: pt.x, y: pt.y, rect: pt.rect }, { showCursor: opts.showCursor });
        return self.typeText(null, text, opts);
      },
      locator(innerSelector) {
        const frameSelf = this;
        return {
          click: (opts) => frameSelf.click(innerSelector, opts),
          hover: (opts) => frameSelf.hover(innerSelector, opts),
          fill: (val, opts) => frameSelf.setValue(innerSelector, val, opts),
          type: (txt, opts) => frameSelf.typeText(innerSelector, txt, opts),
          textContent: () =>
            frameSelf.evaluate(`document.querySelector(${JSON.stringify(innerSelector)})?.textContent ?? null`),
          innerText: () =>
            frameSelf.evaluate(`document.querySelector(${JSON.stringify(innerSelector)})?.innerText ?? null`),
        };
      },
    };
  }

  async waitFor(selectorOrMs, timeoutMs = 8000) {
    if (typeof selectorOrMs === "number") {
      await sleep(Math.min(30000, Math.max(0, selectorOrMs)));
      return true;
    }
    const sel = String(selectorOrMs);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = await this.evaluate(`(() => {
        const s = ${JSON.stringify(sel)};
        if (s.startsWith("text=")) {
          const needle = s.slice(5).trim().toLowerCase();
          return (document.body?.innerText || "").toLowerCase().includes(needle);
        }
        return Boolean(document.querySelector(s));
      })()`).catch(() => false);
      if (found) return true;
      await sleep(100);
    }
    throw new Error(`Timed out waiting ${timeoutMs}ms for "${sel}"`);
  }

  /**
   * Playwright-compatible locator helper for batching selector operations inside cua_repl (`js`)
   */
  locator(selector) {
    const self = this;
    return {
      async click(opts) {
        return self.click(selector, opts);
      },
      async hover(opts) {
        return self.hover(selector, opts);
      },
      async fill(value, opts) {
        return self.setValue(selector, value, opts);
      },
      async setInputFiles(files, opts) {
        return self.uploadFiles(selector, files, opts);
      },
      async type(text, opts) {
        const prep = await self.evaluate(buildPrepareElementExpr(selector, { focus: true }));
        if (!prep?.ok) throw new Error(prep?.error || `No element for selector ${selector}`);
        await self.showVirtualCursor({ x: prep.x, y: prep.y, rect: prep.rect }, opts);
        return self.typeText(null, text, opts);
      },
      async press(key, opts) {
        const prep = await self.evaluate(buildPrepareElementExpr(selector, { focus: true }));
        if (!prep?.ok) throw new Error(prep?.error || `No element for selector ${selector}`);
        await self.showVirtualCursor({ x: prep.x, y: prep.y, rect: prep.rect }, opts);
        return self.pressKey(null, key, opts);
      },
      async textContent() {
        return self.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
      },
      async innerText() {
        return self.evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? null`);
      },
      async getAttribute(attr) {
        return self.evaluate(
          `document.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(attr)}) ?? null`,
        );
      },
      async count() {
        return self.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
      },
      async isVisible() {
        return self.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
        })()`);
      },
      async waitFor(opts = {}) {
        return self.waitFor(selector, opts.timeout ?? 8000);
      },
    };
  }
}

/**
 * Controllable macOS AppleEvents / JXA Browser Tab (Safari & non-CDP Chrome/Brave/Edge).
 * Uses the exact same ShadowRoot virtual cursor and indexed AX snapshot expressions as CDPTabController,
 * dispatching DOM pointer/mouse/keyboard/scroll events via AppleEvents JavaScript execution.
 */
export class BrowserFallbackTabController {
  constructor(cfg) {
    this.id = cfg.id;
    this.providerTabId = cfg.id;
    this.browserId = cfg.browserId;
    this.appName = cfg.appName;
    this.bundleId = cfg.bundleId ?? null;
    this.kind = cfg.kind ?? (cfg.browserId === "safari" ? "safari" : "chromium");
    this.windowIndex = Math.max(1, Number(cfg.windowIndex ?? 1));
    this.tabIndex = Math.max(1, Number(cfg.tabIndex ?? 1));
    this.diffTracker = cfg.diffTracker;
    this.getCursorConfig = cfg.getCursorConfig;
    this.jxaRunner = cfg.jxaRunner;
    this.getMacBridge = cfg.getMacBridge;
    this.onClosed = cfg.onClosed;
    this.controllableViaCDP = false;
    this.controlMode = "apple_events";
    this.cachedMeta = {
      title: cfg.title ?? "",
      url: cfg.url ?? "",
    };
    this.cursorState = {
      visible: false,
      x: null,
      y: null,
      badge: null,
      highlightedRect: null,
      updatedAt: 0,
    };
  }

  isCursorCurrentlyVisible() {
    if (!this.cursorState.visible) return false;
    const timeoutMs = Number(this.getCursorConfig?.()?.idleTimeoutMs ?? 8000);
    if (this.cursorState.updatedAt > 0 && Date.now() - this.cursorState.updatedAt > timeoutMs + 250) {
      this.cursorState.visible = false;
      return false;
    }
    return true;
  }

  buildTabLookupJxa() {
    return `
      const app = Application(${JSON.stringify(this.appName)});
      if (!app.running()) throw new Error(${JSON.stringify(`${this.appName} is not running`)});
      const wins = app.windows();
      const wIdx = ${this.windowIndex - 1};
      if (wIdx < 0 || wIdx >= wins.length) throw new Error("Window w${this.windowIndex} not found in ${this.appName}");
      const win = wins[wIdx];
      const wTabs = win.tabs();
      const tIdx = ${this.tabIndex - 1};
      if (tIdx < 0 || tIdx >= wTabs.length) throw new Error("Tab t${this.tabIndex} not found in ${this.appName} window w${this.windowIndex}");
      const tab = wTabs[tIdx];
    `;
  }

  async runJxa(jxaScript, opSpec = {}) {
    try {
      return await this.jxaRunner(jxaScript, {
        id: this.id,
        browserId: this.browserId,
        appName: this.appName,
        kind: this.kind,
        windowIndex: this.windowIndex,
        tabIndex: this.tabIndex,
        ...opSpec,
      });
    } catch (err) {
      const msg = String(err?.stderr || err?.message || err);
      if (/Allow JavaScript from Apple Events/i.test(msg)) {
        const menuHint =
          this.kind === "safari"
            ? "Safari → Settings → Advanced (enable web developer features) → Develop → Allow JavaScript from Apple Events"
            : `${this.appName} → View → Developer → Allow JavaScript from Apple Events`;
        throw new Error(
          `${this.appName} blocked AppleEvents JavaScript on ${this.id}. Enable "${menuHint}", or open a CDP tab with open_browser_tab.`,
        );
      }
      throw new Error(msg.trim());
    }
  }

  async getMetadata() {
    const jxa = `(() => {
      ${this.buildTabLookupJxa()}
      const title = ${this.kind === "safari" ? "tab.name()" : "tab.title()"};
      const url = tab.url();
      return JSON.stringify({ title: title || "", url: url || "" });
    })()`;
    const raw = await this.runJxa(jxa, { op: "meta" });
    const parsed = typeof raw === "string" && raw ? JSON.parse(raw) : raw ?? {};
    this.cachedMeta = {
      title: parsed.title ?? this.cachedMeta.title ?? "",
      url: parsed.url ?? this.cachedMeta.url ?? "",
    };
    return {
      id: this.id,
      providerTabId: this.id,
      browserId: this.browserId,
      controlMode: "apple_events",
      title: this.cachedMeta.title,
      url: this.cachedMeta.url,
    };
  }

  async evaluate(expression) {
    if (typeof expression === "function") {
      expression = `(${expression.toString()})()`;
    }
    const exprStr = String(expression);
    const wrappedPageJs = `(function() {
      try {
        const __val = (\n${exprStr}\n);
        return JSON.stringify({ __agEvalOk: true, value: __val === undefined ? null : __val });
      } catch (__err) {
        return JSON.stringify({
          __agEvalOk: false,
          error: String((__err && (__err.stack || __err.message)) || __err)
        });
      }
    })()`;
    const jxa = `(() => {
      ${this.buildTabLookupJxa()}
      const raw = ${
        this.kind === "safari"
          ? `app.doJavaScript(${JSON.stringify(wrappedPageJs)}, { in: tab })`
          : `tab.execute({ javascript: ${JSON.stringify(wrappedPageJs)} })`
      };
      return typeof raw === "string" ? raw : JSON.stringify({ __agEvalOk: true, value: raw ?? null });
    })()`;
    const raw = await this.runJxa(jxa, { op: "eval", expression: exprStr });
    const parsed = typeof raw === "string" && raw ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === "object" && "__agEvalOk" in parsed) {
      if (!parsed.__agEvalOk) {
        throw new Error(parsed.error || "JavaScript evaluation failed");
      }
      return parsed.value;
    }
    return parsed;
  }

  async showVirtualCursor(spec = {}, { showCursor = true } = {}) {
    const cfg = this.getCursorConfig?.() ?? { enabled: true, idleTimeoutMs: 8000 };
    if (showCursor === false || cfg.enabled === false) return null;
    try {
      const res = await this.evaluate(
        buildBrowserCursorOverlayExpr({
          ...spec,
          badge: null,
          showBadge: false,
          idleTimeoutMs: cfg.idleTimeoutMs,
          instant: cfg.glideEnabled === false ? true : Boolean(spec.instant),
        }),
      );
      if (res?.ok) {
        this.cursorState = {
          visible: true,
          x: res.x,
          y: res.y,
          badge: null,
          highlightedRect: res.highlightedRect ?? null,
          updatedAt: Date.now(),
        };
      }
      return res;
    } catch {
      return null;
    }
  }

  async glideCursorTo(spec = {}, { showCursor = true } = {}) {
    const res = await this.showVirtualCursor({ ...spec, ripple: false }, { showCursor });
    const glideMs = Number(res?.glideDurationMs ?? 0);
    if (glideMs > 0 && !res?.instant) {
      await sleep(Math.min(350, Math.max(0, Math.round(glideMs * 0.8))));
    }
    return res;
  }

  async hideCursor() {
    this.cursorState.visible = false;
    await this.evaluate(buildRemoveBrowserCursorExpr()).catch(() => null);
    return { ok: true, tabId: this.id, visible: false };
  }

  async getCursorState() {
    const domState = await this.evaluate(buildGetBrowserCursorStateExpr()).catch(() => ({ visible: false }));
    if (domState?.visible) {
      this.cursorState = {
        ...this.cursorState,
        visible: true,
        x: domState.x,
        y: domState.y,
        badge: null,
        highlightedRect: domState.highlightedRect,
      };
    } else {
      this.cursorState.visible = false;
    }
    return {
      tabId: this.id,
      browserId: this.browserId,
      controlMode: "apple_events",
      ...domState,
      badge: null,
    };
  }

  async waitForDomSettled(maxWaitMs = 1200) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      try {
        const state = await this.evaluate("document.readyState");
        if (state === "complete" || state === "interactive") break;
      } catch {}
      await sleep(80);
    }
    await sleep(40);
  }

  isPrivilegedNewTab(url) {
    const u = String(url ?? "").trim().toLowerCase();
    return (
      u === "" ||
      u.startsWith("favorites://") ||
      u.startsWith("safari-") ||
      u.startsWith("chrome://") ||
      u.startsWith("brave://") ||
      u.startsWith("edge://") ||
      u.startsWith("arc://")
    );
  }

  async getAXState(options = {}) {
    const meta = await this.getMetadata();
    const diffKey = `tab:${this.id}`;

    if (this.isPrivilegedNewTab(meta.url)) {
      const text = `Tab #${this.id} "${meta.title || "Start Page"}" url="${meta.url}"\n  (Browser internal page — call goto(url) to navigate to a website)`;
      const formatted = this.diffTracker.format(diffKey, text, options);
      return {
        stateText: formatted.text,
        fullTree: text,
        isDiff: formatted.isDiff,
        meta,
      };
    }

    await this.waitForDomSettled(900);
    const snap = (await this.evaluate(BUILD_AX_SNAPSHOT_EXPR(options.maxElements ?? 600))) ?? {
      title: meta.title,
      url: meta.url,
      viewport: { width: 1280, height: 800 },
      scroll: { x: 0, y: 0 },
      elementCount: 0,
      lines: [],
      captchaSignals: [],
    };
    const captcha = detectCaptchaChallenge(snap);
    const header = `Tab #${this.id} "${snap.title}" url="${snap.url}" viewport=${snap.viewport.width}x${snap.viewport.height} scroll=(${snap.scroll.x},${snap.scroll.y})`;
    const fullTree = [
      header,
      ...(snap.lines ?? []),
      ...(captcha.detected && captcha.banner ? [captcha.banner] : []),
    ].join("\n");
    const formatted = this.diffTracker.format(diffKey, fullTree, options);
    let stateText = formatted.text;
    if (captcha.detected && captcha.banner && !stateText.includes(captcha.banner)) {
      stateText = `${stateText}\n${captcha.banner}`;
    }

    return {
      stateText,
      fullTree,
      isDiff: formatted.isDiff,
      unchanged: formatted.unchanged,
      elementCount: snap.elementCount,
      captchaDetected: captcha.detected,
      ...(captcha.detected ? { captchaProviders: captcha.providers } : {}),
      ...(this.isCursorCurrentlyVisible()
        ? {
            cursor: {
              x: this.cursorState.x,
              y: this.cursorState.y,
              badge: null,
              highlightedRect: this.cursorState.highlightedRect,
            },
          }
        : {}),
      meta: {
        ...meta,
        title: snap.title,
        url: snap.url,
      },
    };
  }

  async getScreenshot({ markOnly = true, includeCursor = false } = {}) {
    if (markOnly) {
      this.diffTracker.markScreenshotOnly(`tab:${this.id}`);
    }
    const macBridge = this.getMacBridge?.();
    if (!macBridge) {
      throw new Error(
        `Background tab screenshots on AppleEvents tab ${this.id} require macBridge window capture or a CDP tab (open_browser_tab).`,
      );
    }
    let didHideOverlay = false;
    let didPrepCursor = false;
    if (!includeCursor) {
      const hideRes = await this.evaluate(buildSetBrowserCursorTemporarilyHiddenExpr(true)).catch(() => null);
      didHideOverlay = Boolean(hideRes?.wasPresent);
    } else {
      const prepRes = await this.evaluate(
        buildPrepareBrowserCursorForScreenshotExpr(true, { awaitFrame: false }),
      ).catch(() => null);
      didPrepCursor = Boolean(prepRes?.didPrep);
    }
    try {
      const wins = await macBridge.listWindows({ app: this.bundleId || this.appName, includeMinimized: true });
      const winList = Array.isArray(wins) ? wins : (wins?.windows ?? []);
      const targetWin = winList[this.windowIndex - 1] ?? winList[0];
      const targetWinId = targetWin?.id ?? targetWin?.windowId;
      if (!targetWinId) {
        throw new Error(`Could not locate macOS window for ${this.appName} (${this.id}) to capture screenshot`);
      }
      const shotRes = await macBridge.getWindowScreenshot({
        windowId: targetWinId,
        includeCursor: Boolean(includeCursor),
      });
      const base64 = shotRes?.screenshot?.base64 ?? shotRes?.screenshotBase64;
      if (!base64) {
        throw new Error(`Screenshot capture returned empty image for ${this.id}`);
      }
      const bytes = Buffer.from(base64, "base64");
      return {
        mimeType: shotRes?.screenshot?.mimeType || shotRes?.screenshotMimeType || "image/jpeg",
        base64,
        bytes: new Uint8Array(bytes),
        cursorComposited: Boolean(includeCursor),
      };
    } finally {
      if (didHideOverlay) {
        await this.evaluate(buildSetBrowserCursorTemporarilyHiddenExpr(false)).catch(() => {});
      } else if (didPrepCursor) {
        await this.evaluate(buildPrepareBrowserCursorForScreenshotExpr(false)).catch(() => {});
      }
    }
  }

  async getAXStateAndScreenshot(options = {}) {
    const ax = await this.getAXState(options);
    const shot = await this.getScreenshot({
      markOnly: false,
      includeCursor: Boolean(options.includeCursor),
    });
    return {
      stateText: ax.stateText,
      fullTree: ax.fullTree,
      screenshot: shot,
      ...(ax.cursor ? { cursor: ax.cursor } : {}),
      meta: ax.meta,
    };
  }

  async goto(url) {
    if (typeof url !== "string" || !url.trim()) {
      throw new TypeError("goto requires a non-empty URL string");
    }
    let normalized = url.trim();
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized)) {
      normalized = `https://${normalized}`;
    }
    assertSafeBrowserUrl(normalized);
    this.cursorState.visible = false;
    const jxa = `(() => {
      ${this.buildTabLookupJxa()}
      tab.url = ${JSON.stringify(normalized)};
      return JSON.stringify({ ok: true, url: ${JSON.stringify(normalized)} });
    })()`;
    await this.runJxa(jxa, { op: "goto", url: normalized });
    await sleep(120);
    await this.waitForDomSettled(3000);
  }

  async back() {
    this.cursorState.visible = false;
    await this.evaluate("window.history.back(); true;");
    await sleep(100);
    await this.waitForDomSettled(2500);
  }

  async forward() {
    this.cursorState.visible = false;
    await this.evaluate("window.history.forward(); true;");
    await sleep(100);
    await this.waitForDomSettled(2500);
  }

  async reload() {
    this.cursorState.visible = false;
    await this.evaluate("window.location.reload(); true;");
    await sleep(100);
    await this.waitForDomSettled(2500);
  }

  async close() {
    this.cursorState.visible = false;
    const jxa = `(() => {
      ${this.buildTabLookupJxa()}
      tab.close();
      return JSON.stringify({ ok: true });
    })()`;
    await this.runJxa(jxa, { op: "close" }).catch(() => {});
    this.diffTracker.reset(`tab:${this.id}`);
    this.onClosed?.(this.id);
  }

  async hover(target, options = {}) {
    let x, y;
    let rect = null;
    if (Array.isArray(target) && target.length === 2) {
      x = Number(target[0]);
      y = Number(target[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new TypeError("Coordinate hover target [x, y] must contain finite numbers");
      }
    } else if (typeof target === "number" || typeof target === "string") {
      const prep = await this.evaluate(buildPrepareElementExpr(target));
      if (!prep?.ok) {
        throw new Error(prep?.error || `Failed to locate hover target ${JSON.stringify(target)}`);
      }
      x = prep.x;
      y = prep.y;
      rect = prep.rect ?? null;
    } else {
      throw new TypeError("hover target must be an elementIndex (number), [x, y] coordinate array, or selector string");
    }

    const finalRect = options.rect ?? rect;
    const explicitBadge =
      options.showBadge !== undefined
        ? Boolean(options.showBadge)
        : options.badge != null && String(options.badge).trim() !== "";
    const badge = options.badge ?? options.defaultBadge ?? (options.dispatchMoveEvent === false ? "Move" : "Hover");
    if (options.dispatchMoveEvent !== false) {
      await this.glideCursorTo(
        { x, y, rect: finalRect, badge, showBadge: explicitBadge },
        { showCursor: options.showCursor },
      );
      if (options.ripple) {
        await this.showVirtualCursor(
          { x, y, rect: finalRect, badge, showBadge: explicitBadge, ripple: true, effectOnly: true },
          { showCursor: options.showCursor },
        );
      }
      await this.evaluate(`(() => {
        const el = document.elementFromPoint(${Number(x)}, ${Number(y)}) || document.body;
        if (!el) return false;
        const init = { bubbles: true, cancelable: true, clientX: ${Number(x)}, clientY: ${Number(y)}, view: window };
        if (typeof PointerEvent === "function") {
          el.dispatchEvent(new PointerEvent("pointerover", init));
          el.dispatchEvent(new PointerEvent("pointermove", init));
        }
        el.dispatchEvent(new MouseEvent("mouseover", init));
        el.dispatchEvent(new MouseEvent("mousemove", init));
        return true;
      })()`).catch(() => null);
    } else {
      await this.showVirtualCursor(
        { x, y, rect: finalRect, badge, showBadge: explicitBadge, ripple: Boolean(options.ripple) },
        { showCursor: options.showCursor },
      );
    }
    return {
      ok: true,
      x: Math.round(x),
      y: Math.round(y),
      ...(finalRect ? { rect: finalRect } : {}),
    };
  }

  async highlight(target, options = {}) {
    const explicitBadge =
      options.showBadge !== undefined
        ? Boolean(options.showBadge)
        : options.badge != null && String(options.badge).trim() !== "";
    return this.hover(target, {
      ...options,
      dispatchMoveEvent: Boolean(options.dispatchMoveEvent),
      defaultBadge: "Inspect",
      showBadge: explicitBadge,
    });
  }

  async click(target, options = {}) {
    let x, y;
    let rect = null;
    let targetSpec = null;
    if (Array.isArray(target) && target.length === 2) {
      x = Number(target[0]);
      y = Number(target[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new TypeError("Coordinate click target [x, y] must contain finite numbers");
      }
    } else if (typeof target === "number" || typeof target === "string") {
      targetSpec = target;
      const prep = await this.evaluate(buildPrepareElementExpr(target));
      if (!prep?.ok) {
        throw new Error(prep?.error || `Failed to locate target ${JSON.stringify(target)}`);
      }
      x = prep.x;
      y = prep.y;
      rect = prep.rect ?? null;
    } else {
      throw new TypeError("click target must be an elementIndex (number), [x, y] coordinate array, or selector string");
    }

    const rawBtn = String(options.mouseButton ?? "left").toLowerCase();
    const button =
      rawBtn === "right" || rawBtn === "r"
        ? "right"
        : rawBtn === "middle" || rawBtn === "m"
          ? "middle"
          : "left";
    const btnNum = button === "right" ? 2 : button === "middle" ? 1 : 0;
    const buttonsMask = button === "right" ? 2 : button === "middle" ? 4 : 1;
    const clickCount = Math.max(1, Math.min(5, Number(options.clickCount ?? 1)));
    const explicitBadge =
      options.showBadge !== undefined
        ? Boolean(options.showBadge)
        : options.badge != null && String(options.badge).trim() !== "";
    const badge =
      options.badge ??
      (button === "right"
        ? "Right Click"
        : button === "middle"
          ? "Middle Click"
          : clickCount === 2
            ? "Double Click"
            : clickCount >= 3
              ? "Triple Click"
              : "Click");

    const chord = options.key ? parseCDPKeyChord(options.key) : null;
    const mods = chord?.modifiers ?? 0;

    await this.glideCursorTo(
      { x, y, rect, button, badge, showBadge: explicitBadge },
      { showCursor: options.showCursor },
    );
    await this.showVirtualCursor(
      {
        x,
        y,
        rect,
        button,
        clickCount,
        ripple: options.ripple !== false,
        effectOnly: true,
        badge,
        showBadge: explicitBadge,
      },
      { showCursor: options.showCursor },
    );

    await this.evaluate(`(() => {
      let el = null;
      const spec = ${JSON.stringify(targetSpec)};
      if (typeof spec === "number" && window.__agCuaMap && window.__agCuaMap.has(spec)) {
        el = window.__agCuaMap.get(spec);
      } else if (typeof spec === "string" && !spec.startsWith("text=") && !spec.startsWith("role=")) {
        try { el = document.querySelector(spec); } catch {}
      }
      if (!el || !el.isConnected) {
        el = document.elementFromPoint(${Number(x)}, ${Number(y)}) || document.body;
      }
      if (!el) return { ok: false };
      const baseInit = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: ${Number(x)},
        clientY: ${Number(y)},
        button: ${btnNum},
        altKey: ${Boolean(mods & CDP_MODIFIER_BITS.Alt)},
        ctrlKey: ${Boolean(mods & CDP_MODIFIER_BITS.Control)},
        metaKey: ${Boolean(mods & CDP_MODIFIER_BITS.Meta)},
        shiftKey: ${Boolean(mods & CDP_MODIFIER_BITS.Shift)},
      };
      for (let i = 1; i <= ${clickCount}; i++) {
        const downInit = Object.assign({}, baseInit, { buttons: ${buttonsMask}, detail: i });
        const upInit = Object.assign({}, baseInit, { buttons: 0, detail: i });
        if (typeof PointerEvent === "function") el.dispatchEvent(new PointerEvent("pointerdown", downInit));
        el.dispatchEvent(new MouseEvent("mousedown", downInit));
        if (typeof el.focus === "function") el.focus({ preventScroll: true });
        if (typeof PointerEvent === "function") el.dispatchEvent(new PointerEvent("pointerup", upInit));
        el.dispatchEvent(new MouseEvent("mouseup", upInit));
        if (${btnNum} === 2) {
          el.dispatchEvent(new MouseEvent("contextmenu", upInit));
        } else if (${btnNum} === 0) {
          if (i === 1 && typeof el.click === "function" && ${mods === 0}) {
            el.click();
          } else {
            el.dispatchEvent(new MouseEvent("click", upInit));
          }
          if (i === 2) {
            el.dispatchEvent(new MouseEvent("dblclick", upInit));
          }
        }
      }
      return { ok: true };
    })()`);
    await sleep(45);
  }

  async setValue(elementIndex, value, options = {}) {
    const explicitBadge =
      options.showBadge !== undefined
        ? Boolean(options.showBadge)
        : options.badge != null && String(options.badge).trim() !== "";
    const badge = options.badge ?? "Set Value";
    if (elementIndex != null && options.showCursor !== false) {
      const prep = await this.evaluate(buildPrepareElementExpr(elementIndex)).catch(() => null);
      if (prep?.ok) {
        await this.glideCursorTo(
          { x: prep.x, y: prep.y, rect: prep.rect, badge, showBadge: explicitBadge },
          { showCursor: options.showCursor },
        );
      }
    }
    const res = await this.evaluate(buildSetValueExpr(elementIndex, value));
    if (!res?.ok) {
      throw new Error(res?.error || `Failed to setValue on element [${elementIndex}]`);
    }
    if (Number.isFinite(res.x) && Number.isFinite(res.y)) {
      await this.showVirtualCursor(
        {
          x: res.x,
          y: res.y,
          rect: res.rect,
          effectOnly: true,
          ripple: Boolean(options.ripple),
          badge,
          showBadge: explicitBadge,
        },
        { showCursor: options.showCursor },
      );
    }
  }

  async typeText(elementIndex, text, options = {}) {
    if (typeof text !== "string") {
      throw new TypeError("typeText requires a string 'text'");
    }
    const explicitBadge =
      options.showBadge !== undefined
        ? Boolean(options.showBadge)
        : options.badge != null && String(options.badge).trim() !== "";
    const badge = options.badge ?? "Type";
    if (elementIndex != null) {
      const prep = await this.evaluate(buildPrepareElementExpr(elementIndex, { focus: true }));
      if (!prep?.ok) {
        throw new Error(prep?.error || `Failed to focus element [${elementIndex}]`);
      }
      await this.glideCursorTo(
        { x: prep.x, y: prep.y, rect: prep.rect, badge, showBadge: explicitBadge },
        { showCursor: options.showCursor },
      );
    } else if (this.isCursorCurrentlyVisible()) {
      await this.showVirtualCursor(
        { badge, showBadge: explicitBadge, effectOnly: true },
        { showCursor: options.showCursor },
      );
    } else if (options.showCursor !== false) {
      const anchor = await this.evaluate(buildGetActiveElementAnchorExpr()).catch(() => null);
      if (anchor?.hasActiveElement && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)) {
        await this.glideCursorTo(
          { x: anchor.x, y: anchor.y, rect: anchor.rect, badge, showBadge: explicitBadge },
          { showCursor: options.showCursor },
        );
      }
    }
    const res = await this.evaluate(buildPasteExpr(elementIndex, text, "text"));
    if (!res?.ok) {
      throw new Error(res?.error || "typeText failed on AppleEvents tab");
    }
  }

  async pressKey(elementIndex, key, options = {}) {
    const clippedKey = String(key ?? "").length > 14 ? `${String(key).slice(0, 12)}..` : String(key ?? "");
    const explicitBadge =
      options.showBadge !== undefined
        ? Boolean(options.showBadge)
        : options.badge != null && String(options.badge).trim() !== "";
    const badge = options.badge ?? `Key: ${clippedKey}`;
    if (elementIndex != null) {
      const prep = await this.evaluate(buildPrepareElementExpr(elementIndex, { focus: true }));
      if (!prep?.ok) {
        throw new Error(prep?.error || `Failed to focus element [${elementIndex}]`);
      }
      await this.glideCursorTo(
        { x: prep.x, y: prep.y, rect: prep.rect, badge, showBadge: explicitBadge },
        { showCursor: options.showCursor },
      );
    } else if (this.isCursorCurrentlyVisible()) {
      await this.showVirtualCursor(
        { badge, showBadge: explicitBadge, effectOnly: true },
        { showCursor: options.showCursor },
      );
    }
    const spec = parseCDPKeyChord(key);
    const mods = spec.modifiers ?? 0;
    await this.evaluate(`(() => {
      const el = document.activeElement || document.body;
      if (!el) return false;
      const init = {
        key: ${JSON.stringify(spec.key)},
        code: ${JSON.stringify(spec.code)},
        keyCode: ${Number(spec.windowsVirtualKeyCode || 0)},
        which: ${Number(spec.windowsVirtualKeyCode || 0)},
        bubbles: true,
        cancelable: true,
        altKey: ${Boolean(mods & CDP_MODIFIER_BITS.Alt)},
        ctrlKey: ${Boolean(mods & CDP_MODIFIER_BITS.Control)},
        metaKey: ${Boolean(mods & CDP_MODIFIER_BITS.Meta)},
        shiftKey: ${Boolean(mods & CDP_MODIFIER_BITS.Shift)},
      };
      const notCancelled = el.dispatchEvent(new KeyboardEvent("keydown", init));
      if (notCancelled && ${JSON.stringify(spec.key)} === "Enter" && el.form && typeof el.form.requestSubmit === "function") {
        try { el.form.requestSubmit(); } catch {}
      }
      el.dispatchEvent(new KeyboardEvent("keyup", init));
      return true;
    })()`);
  }

  async paste(elementIndex, text, options = {}) {
    const explicitBadge =
      options.showBadge !== undefined
        ? Boolean(options.showBadge)
        : options.badge != null && String(options.badge).trim() !== "";
    const badge = options.badge ?? "Paste";
    if (elementIndex != null && options.showCursor !== false) {
      const prep = await this.evaluate(buildPrepareElementExpr(elementIndex)).catch(() => null);
      if (prep?.ok) {
        await this.glideCursorTo(
          { x: prep.x, y: prep.y, rect: prep.rect, badge, showBadge: explicitBadge },
          { showCursor: options.showCursor },
        );
      }
    }
    const res = await this.evaluate(buildPasteExpr(elementIndex, text, options.format ?? "text"));
    if (!res?.ok) {
      throw new Error(res?.error || "Paste into browser tab failed");
    }
    if (Number.isFinite(res.x) && Number.isFinite(res.y)) {
      await this.showVirtualCursor(
        {
          x: res.x,
          y: res.y,
          rect: res.rect,
          effectOnly: true,
          ripple: Boolean(options.ripple),
          badge,
          showBadge: explicitBadge,
        },
        { showCursor: options.showCursor },
      );
    }
  }

  async selectText(elementIndex, text, options = {}) {
    const explicitBadge =
      options.showBadge !== undefined
        ? Boolean(options.showBadge)
        : options.badge != null && String(options.badge).trim() !== "";
    const badge = options.badge ?? "Select";
    if (elementIndex != null && options.showCursor !== false) {
      const prep = await this.evaluate(buildPrepareElementExpr(elementIndex)).catch(() => null);
      if (prep?.ok) {
        await this.glideCursorTo(
          { x: prep.x, y: prep.y, rect: prep.rect, badge, showBadge: explicitBadge },
          { showCursor: options.showCursor },
        );
      }
    }
    const res = await this.evaluate(buildSelectTextExpr(elementIndex, text, options));
    if (!res?.ok) {
      throw new Error(res?.error || `selectText failed on element [${elementIndex}]`);
    }
    if (Number.isFinite(res.x) && Number.isFinite(res.y)) {
      await this.showVirtualCursor(
        {
          x: res.x,
          y: res.y,
          rect: res.rect,
          effectOnly: true,
          ripple: Boolean(options.ripple),
          badge,
          showBadge: explicitBadge,
        },
        { showCursor: options.showCursor },
      );
    }
  }

  async performSecondaryAction(elementIndex, action, options = {}) {
    const explicitBadge =
      options.showBadge !== undefined
        ? Boolean(options.showBadge)
        : options.badge != null && String(options.badge).trim() !== "";
    const badge = options.badge ?? String(action ?? "Action");
    if (elementIndex != null && options.showCursor !== false) {
      const prep = await this.evaluate(buildPrepareElementExpr(elementIndex)).catch(() => null);
      if (prep?.ok) {
        await this.glideCursorTo(
          { x: prep.x, y: prep.y, rect: prep.rect, button: "secondary", badge, showBadge: explicitBadge },
          { showCursor: options.showCursor },
        );
      }
    }
    const res = await this.evaluate(buildSecondaryActionExpr(elementIndex, action));
    if (!res?.ok) {
      throw new Error(res?.error || `performSecondaryAction('${action}') failed on element [${elementIndex}]`);
    }
    if (Number.isFinite(res.x) && Number.isFinite(res.y)) {
      await this.showVirtualCursor(
        {
          x: res.x,
          y: res.y,
          rect: res.rect,
          button: "secondary",
          ripple: options.ripple !== false,
          effectOnly: true,
          badge,
          showBadge: explicitBadge,
        },
        { showCursor: options.showCursor },
      );
    }
  }

  async scroll(target, direction = "down", pages = 1, options = {}) {
    let x = null;
    let y = null;
    let rect = null;
    if (Array.isArray(target) && target.length === 2) {
      x = Number(target[0]);
      y = Number(target[1]);
    } else if (typeof target === "number" || typeof target === "string") {
      const prep = await this.evaluate(buildPrepareElementExpr(target));
      if (prep?.ok) {
        x = prep.x;
        y = prep.y;
        rect = prep.rect ?? null;
      }
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      if (this.isCursorCurrentlyVisible() && Number.isFinite(this.cursorState.x) && Number.isFinite(this.cursorState.y)) {
        x = this.cursorState.x;
        y = this.cursorState.y;
      } else {
        const anchor = await this.evaluate(buildGetActiveElementAnchorExpr()).catch(() => null);
        x = anchor?.viewport?.width ? Math.round(anchor.viewport.width / 2) : 640;
        y = anchor?.viewport?.height ? Math.round(anchor.viewport.height / 2) : 400;
      }
    }
    const amt = Math.round((Number(pages) || 1) * 520);
    const d = String(direction).toLowerCase();
    let deltaX = 0;
    let deltaY = 0;
    let arrow = "↓";
    if (d === "down" || d === "d") {
      deltaY = amt;
      arrow = "↓";
    } else if (d === "up" || d === "u") {
      deltaY = -amt;
      arrow = "↑";
    } else if (d === "right" || d === "r") {
      deltaX = amt;
      arrow = "→";
    } else if (d === "left" || d === "l") {
      deltaX = -amt;
      arrow = "←";
    } else {
      throw new TypeError(`Invalid scroll direction "${direction}"`);
    }

    const explicitBadge =
      options.showBadge !== undefined
        ? Boolean(options.showBadge)
        : options.badge != null && String(options.badge).trim() !== "";
    const badge = options.badge ?? `Scroll ${arrow}`;
    if (target != null) {
      await this.glideCursorTo({ x, y, rect, badge, showBadge: explicitBadge }, { showCursor: options.showCursor });
    }
    await this.showVirtualCursor(
      {
        x,
        y,
        rect,
        scrollDirection: d,
        effectOnly: target != null,
        ripple: Boolean(options.ripple),
        badge,
        showBadge: explicitBadge,
      },
      { showCursor: options.showCursor },
    );

    await this.evaluate(`(() => {
      let el = document.elementFromPoint(${Number(x)}, ${Number(y)});
      while (el && el !== document.body && el !== document.documentElement) {
        const st = getComputedStyle(el);
        const canY = (${deltaY} !== 0) && /(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight;
        const canX = (${deltaX} !== 0) && /(auto|scroll)/.test(st.overflowX) && el.scrollWidth > el.clientWidth;
        if (canY || canX) {
          el.scrollBy(${deltaX}, ${deltaY});
          return true;
        }
        el = el.parentElement;
      }
      window.scrollBy(${deltaX}, ${deltaY});
      return true;
    })()`);
  }

  async drag(from, to, options = {}) {
    const resolveEndpoint = async (ep, label) => {
      if (Array.isArray(ep) && ep.length >= 2) {
        const x = Number(ep[0]);
        const y = Number(ep[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          throw new TypeError(`drag ${label} [x, y] must contain finite numbers`);
        }
        return { x, y, rect: null };
      }
      if (typeof ep === "number" || typeof ep === "string") {
        const prep = await this.evaluate(buildPrepareElementExpr(ep));
        if (!prep?.ok) {
          throw new Error(prep?.error || `Failed to locate drag ${label} ${JSON.stringify(ep)}`);
        }
        return { x: prep.x, y: prep.y, rect: prep.rect ?? null };
      }
      throw new TypeError(`drag ${label} must be [x, y], elementIndex (number), or selector (string)`);
    };
    const { x: fx, y: fy, rect: fRect } = await resolveEndpoint(from, "from");
    const { x: tx, y: ty, rect: tRect } = await resolveEndpoint(to, "to");
    const explicitBadge =
      options.showBadge !== undefined
        ? Boolean(options.showBadge)
        : options.badge != null && String(options.badge).trim() !== "";
    const badge = options.badge ?? "Drag";

    await this.glideCursorTo(
      { x: fx, y: fy, rect: fRect, badge, showBadge: explicitBadge },
      { showCursor: options.showCursor },
    );
    await this.showVirtualCursor(
      { x: fx, y: fy, rect: fRect, ripple: true, dragging: true, effectOnly: true, badge, showBadge: explicitBadge },
      { showCursor: options.showCursor },
    );
    const steps = 12;
    for (let s = 1; s <= steps; s++) {
      const rawT = s / steps;
      const t = rawT * rawT * (3 - 2 * rawT);
      const cx = fx + (tx - fx) * t;
      const cy = fy + (ty - fy) * t;
      await this.showVirtualCursor(
        { x: cx, y: cy, dragging: true, instant: true, badge, showBadge: explicitBadge },
        { showCursor: options.showCursor },
      );
      await sleep(10);
    }
    await this.evaluate(`(() => {
      const startEl = document.elementFromPoint(${fx}, ${fy}) || document.body;
      const endEl = document.elementFromPoint(${tx}, ${ty}) || document.body;
      if (startEl) {
        startEl.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: ${fx}, clientY: ${fy}, button: 0, buttons: 1 }));
      }
      if (endEl) {
        endEl.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true, clientX: ${tx}, clientY: ${ty}, button: 0, buttons: 1 }));
        endEl.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: ${tx}, clientY: ${ty}, button: 0, buttons: 0 }));
      }
      return true;
    })()`);
    await this.showVirtualCursor(
      { x: tx, y: ty, rect: tRect, ripple: true, dragging: false, instant: true, badge, showBadge: explicitBadge },
      { showCursor: options.showCursor },
    );
  }

  async uploadFiles() {
    throw new Error(`File input upload on ${this.id} requires a CDP browser tab (open_browser_tab).`);
  }

  async waitFor(selectorOrMs, timeoutMs = 8000) {
    if (typeof selectorOrMs === "number") {
      await sleep(Math.min(30000, Math.max(0, selectorOrMs)));
      return true;
    }
    const sel = String(selectorOrMs);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = await this.evaluate(`(() => {
        const s = ${JSON.stringify(sel)};
        if (s.startsWith("text=")) {
          const needle = s.slice(5).trim().toLowerCase();
          return (document.body?.innerText || "").toLowerCase().includes(needle);
        }
        return Boolean(document.querySelector(s));
      })()`).catch(() => false);
      if (found) return true;
      await sleep(120);
    }
    throw new Error(`Timed out waiting ${timeoutMs}ms for "${sel}"`);
  }

  locator(selector) {
    const self = this;
    return {
      async click(opts) {
        return self.click(selector, opts);
      },
      async hover(opts) {
        return self.hover(selector, opts);
      },
      async fill(value, opts) {
        return self.setValue(selector, value, opts);
      },
      async type(text, opts) {
        return self.typeText(selector, text, opts);
      },
      async press(key, opts) {
        return self.pressKey(selector, key, opts);
      },
      async textContent() {
        return self.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
      },
      async innerText() {
        return self.evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? null`);
      },
      async getAttribute(attr) {
        return self.evaluate(
          `document.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(attr)}) ?? null`,
        );
      },
      async count() {
        return self.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
      },
      async isVisible() {
        return self.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
        })()`);
      },
      async waitFor(opts = {}) {
        return self.waitFor(selector, opts.timeout ?? 8000);
      },
    };
  }
}

/**
 * Multi-Browser & Multi-Tab Manager
 */
export class BrowserManager {
  /**
   * @param {{
   *   diffTracker: import("./diff.mjs").AXDiffTracker,
   *   macBridge?: import("./mac-bridge.mjs").MacBridge,
   *   jxaRunner?: (script: string, opSpec?: any) => Promise<string>,
   *   extensionSockDir?: string
   * }} opts
   */
  constructor({ diffTracker, macBridge = null, jxaRunner = null, extensionSockDir = undefined }) {
    this.diffTracker = diffTracker;
    this.macBridge = macBridge;
    this.extensionBridge = new ExtensionBridgeManager(
      extensionSockDir ? { sockDir: extensionSockDir } : {},
    );
    this.jxaRunner =
      jxaRunner ??
      (async (script) => {
        const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", script], {
          timeout: 8000,
        });
        return stdout.trim();
      });
    /** @type {Map<string, CDPMultiplexConnection>} wsUrl -> conn */
    this.connections = new Map();
    /** @type {Map<string, CDPTabController>} tabId -> controller */
    this.tabs = new Map();
    /** @type {Map<string, BrowserFallbackTabController>} fallbackTabId -> controller */
    this.fallbackTabs = new Map();
    /** @type {Map<string, string>} targetId -> tabId */
    this.targetToTabId = new Map();
    this.nextTabSeq = 1;
    /** @type {Map<string, { port: number, httpEndpoint: string, wsUrl: string, proc: import("node:child_process").ChildProcess, visible: boolean }>} */
    this.managedBrowsers = new Map();
    this.cursorConfig = {
      enabled: true,
      idleTimeoutMs: 8000,
      glideEnabled: true,
    };
    /** @type {{ at: number, value: any[] } | null} */
    this.appleEventTabsCache = null;
    /** @type {Promise<any[]> | null} */
    this.appleEventTabsInflight = null;
  }

  setMacBridge(macBridge) {
    this.macBridge = macBridge;
  }

  getConnection(wsUrl) {
    let c = this.connections.get(wsUrl);
    if (!c) {
      c = new CDPMultiplexConnection(wsUrl);
      this.connections.set(wsUrl, c);
    }
    return c;
  }

  /**
   * Discover all active CDP HTTP endpoints (ports 9223, 9222, etc. + managed instances + CUA_CDP_URLS).
   */
  async discoverCDPEndpoints() {
    const candidates = new Set(DEFAULT_CDP_PORTS.map((p) => `http://127.0.0.1:${p}`));
    if (process.env.CUA_CDP_URLS) {
      for (const u of process.env.CUA_CDP_URLS.split(",")) {
        const trimmed = u.trim().replace(/\/+$/, "");
        if (trimmed) candidates.add(trimmed);
      }
    }
    for (const mb of this.managedBrowsers.values()) {
      candidates.add(mb.httpEndpoint);
    }

    const checks = Array.from(candidates).map(async (endpoint) => {
      try {
        const ver = await fetchJson(`${endpoint}/json/version`, 350);
        const list = await fetchJson(`${endpoint}/json/list`, 450).catch(() => []);
        const isManagedHeadless = this.managedBrowsers.get("iab-headless")?.httpEndpoint === endpoint;
        const isManagedVisible = this.managedBrowsers.get("iab-visible")?.httpEndpoint === endpoint;
        const portMatch = endpoint.match(/:(\d+)$/);
        const port = portMatch ? portMatch[1] : "cdp";
        const id = isManagedHeadless ? "iab" : isManagedVisible ? "iab-visible" : `cdp-${port}`;

        return {
          id,
          name: isManagedHeadless
            ? "In-App Headless Browser (Managed CDP)"
            : isManagedVisible
              ? "Managed Browser Window (CDP)"
              : `${ver.Browser || "Chromium"} (${endpoint})`,
          family: "chromium",
          type: isManagedHeadless || isManagedVisible ? "iab" : "cdp",
          httpEndpoint: endpoint,
          wsUrl: ver.webSocketDebuggerUrl,
          userAgent: ver["User-Agent"],
          pages: Array.isArray(list) ? list.filter((t) => t.type === "page") : [],
        };
      } catch {
        return null;
      }
    });

    const settled = await Promise.all(checks);
    return settled.filter(Boolean);
  }

  /**
   * Query open tabs in running macOS Safari / non-CDP Chrome / Brave / Edge / Arc without waking closed apps.
   * Uses bulk AppleEvent property arrays per window + short TTL/in-flight deduplication to avoid multi-second stalls.
   */
  async listMacOSAppleEventTabs({ forceRefresh = false } = {}) {
    if (!forceRefresh && this.appleEventTabsCache && Date.now() - this.appleEventTabsCache.at < 1500) {
      return this.appleEventTabsCache.value;
    }
    if (!forceRefresh && this.appleEventTabsInflight) {
      return this.appleEventTabsInflight;
    }

    const jxa = `
      const out = [];
      const candidates = [
        { id: "safari", appName: "Safari", kind: "safari" },
        { id: "chrome-app", appName: "Google Chrome", kind: "chromium" },
        { id: "brave-app", appName: "Brave Browser", kind: "chromium" },
        { id: "edge-app", appName: "Microsoft Edge", kind: "chromium" },
        { id: "arc-app", appName: "Arc", kind: "chromium" }
      ];
      for (const c of candidates) {
        try {
          const app = Application(c.appName);
          if (!app.running()) continue;
          const wins = app.windows();
          const tabs = [];
          for (let wi = 0; wi < wins.length; wi++) {
            const w = wins[wi];
            try {
              const urls = w.tabs.url();
              const titles = c.kind === "safari" ? w.tabs.name() : w.tabs.title();
              const count = Array.isArray(urls) ? urls.length : 0;
              for (let ti = 0; ti < count; ti++) {
                tabs.push({
                  id: c.id + ":w" + (wi + 1) + ":t" + (ti + 1),
                  windowIndex: wi + 1,
                  tabIndex: ti + 1,
                  title: (Array.isArray(titles) ? titles[ti] : "") || "",
                  url: urls[ti] || ""
                });
              }
            } catch (_bulkErr) {
              const wTabs = w.tabs();
              for (let ti = 0; ti < wTabs.length; ti++) {
                const t = wTabs[ti];
                tabs.push({
                  id: c.id + ":w" + (wi + 1) + ":t" + (ti + 1),
                  windowIndex: wi + 1,
                  tabIndex: ti + 1,
                  title: c.kind === "safari" ? t.name() : t.title(),
                  url: t.url()
                });
              }
            }
          }
          out.push({ id: c.id, name: c.appName, kind: c.kind, tabs });
        } catch (e) {}
      }
      JSON.stringify(out);
    `;

    const runPromise = (async () => {
      try {
        const stdout = await this.jxaRunner(jxa, { op: "list_tabs" });
        const parsed = JSON.parse(String(stdout || "").trim() || "[]");
        this.appleEventTabsCache = { at: Date.now(), value: parsed };
        return parsed;
      } catch {
        return [];
      } finally {
        if (this.appleEventTabsInflight === runPromise) {
          this.appleEventTabsInflight = null;
        }
      }
    })();

    this.appleEventTabsInflight = runPromise;
    return runPromise;
  }

  getOrRegisterExtensionTabController(extTab, bridgeRec, sessionIdName = "default") {
    const targetId = `${bridgeRec.browserId}:ext-tab-${extTab.tabId}`;
    const shortTargetAlias = `ext-tab-${extTab.tabId}`;
    const existingTabId = this.targetToTabId.get(targetId);
    if (existingTabId && this.tabs.has(existingTabId)) {
      const ctrl = this.tabs.get(existingTabId);
      ctrl.conn = bridgeRec.cdpConn;
      ctrl.cachedMeta = {
        title: extTab.title ?? ctrl.cachedMeta.title,
        url: extTab.url ?? ctrl.cachedMeta.url,
        tabGroup: extTab.tabGroup ?? ctrl.cachedMeta.tabGroup ?? null,
        groupId: extTab.groupId ?? ctrl.cachedMeta.groupId ?? -1,
        windowId: extTab.windowId ?? ctrl.cachedMeta.windowId ?? null,
        ownership: extTab.ownership ?? ctrl.cachedMeta.ownership ?? null,
      };
      return ctrl;
    }

    const tabId = `tab-${this.nextTabSeq++}`;
    const ctrl = new CDPTabController({
      id: tabId,
      targetId,
      browserId: bridgeRec.browserId,
      httpEndpoint: `unix://${bridgeRec.sockPath}`,
      conn: bridgeRec.cdpConn,
      diffTracker: this.diffTracker,
      getCursorConfig: () => this.cursorConfig,
      sessionIdName,
      title: extTab.title ?? "",
      url: extTab.url ?? "",
      tabGroup: extTab.tabGroup ?? null,
      groupId: extTab.groupId ?? -1,
      windowId: extTab.windowId ?? null,
      ownership: extTab.ownership ?? null,
      onClosed: (closedId) => {
        this.tabs.delete(closedId);
        this.targetToTabId.delete(targetId);
        if (this.targetToTabId.get(shortTargetAlias) === closedId) {
          this.targetToTabId.delete(shortTargetAlias);
        }
      },
    });
    this.tabs.set(tabId, ctrl);
    this.targetToTabId.set(targetId, tabId);
    if (!this.targetToTabId.has(shortTargetAlias)) {
      this.targetToTabId.set(shortTargetAlias, tabId);
    }
    return ctrl;
  }

  async discoverExtensionBrowsers() {
    const bridges = await this.extensionBridge.refresh();
    const out = [];
    for (const rec of bridges) {
      try {
        const res = await rec.client.request("listAllTabs", {}, 2500);
        const rawTabs = Array.isArray(res?.tabs) ? res.tabs : [];
        const liveTargetIds = new Set();
        const mappedTabs = rawTabs.map((t) => {
          const ctrl = this.getOrRegisterExtensionTabController(t, rec);
          liveTargetIds.add(ctrl.targetId);
          return {
            id: ctrl.id,
            providerTabId: ctrl.targetId,
            chromeTabId: t.tabId,
            windowId: t.windowId,
            active: Boolean(t.active),
            pinned: Boolean(t.pinned),
            groupId: t.groupId,
            tabGroup: t.tabGroup || null,
            ownership: t.ownership || null,
            attached: Boolean(t.attached),
            browserId: rec.browserId,
            title: t.title || "",
            url: t.url || "",
            controllable: true,
            controllableViaCDP: true,
            controlMode: "extension_cdp",
          };
        });

        // Prune stale controllers for tabs closed in this extension browser
        for (const [id, ctrl] of Array.from(this.tabs.entries())) {
          if (ctrl.browserId === rec.browserId && !liveTargetIds.has(ctrl.targetId)) {
            this.tabs.delete(id);
            this.targetToTabId.delete(ctrl.targetId);
          }
        }

        const brand = String(rec.client.info?.browserFamily || "chrome").toLowerCase();
        const browserName = rec.client.info?.browserName || "Chromium";
        out.push({
          id: rec.browserId,
          name: `${browserName} (Antigravity Extension)`,
          family: "chromium",
          brand,
          type: "extension",
          extensionId: rec.client.info?.extensionId || "cnipmpbdggdeocaigfifflifphanoiic",
          controlMode: "extension_cdp",
          controllableViaCDP: true,
          tabs: mappedTabs,
        });
      } catch {
        // Ignore bridge transient disconnect during refresh
      }
    }
    return out;
  }

  getOrRegisterFallbackTabController(tabInfo, kb) {
    const existing = this.fallbackTabs.get(tabInfo.id);
    if (existing) {
      existing.cachedMeta = {
        title: tabInfo.title ?? existing.cachedMeta.title,
        url: tabInfo.url ?? existing.cachedMeta.url,
      };
      return existing;
    }
    const match = /:w(\d+):t(\d+)$/.exec(tabInfo.id);
    const windowIndex = tabInfo.windowIndex ?? (match ? Number(match[1]) : 1);
    const tabIndex = tabInfo.tabIndex ?? (match ? Number(match[2]) : 1);
    const ctrl = new BrowserFallbackTabController({
      id: tabInfo.id,
      browserId: kb.key,
      appName: kb.name,
      bundleId: kb.bundleId,
      kind: kb.family === "webkit" ? "safari" : "chromium",
      windowIndex,
      tabIndex,
      title: tabInfo.title ?? "",
      url: tabInfo.url ?? "",
      diffTracker: this.diffTracker,
      getCursorConfig: () => this.cursorConfig,
      jxaRunner: this.jxaRunner,
      getMacBridge: () => this.macBridge,
      onClosed: (closedId) => {
        this.fallbackTabs.delete(closedId);
      },
    });
    this.fallbackTabs.set(tabInfo.id, ctrl);
    return ctrl;
  }

  /**
   * Ensure a managed CDP Chromium instance is running (supports headless `visible: false` or visible window `visible: true`).
   */
  async ensureManagedBrowser({ visible = false } = {}) {
    const key = visible ? "iab-visible" : "iab-headless";
    const existing = this.managedBrowsers.get(key);
    if (existing && existing.proc.exitCode === null) {
      try {
        const ver = await fetchJson(`${existing.httpEndpoint}/json/version`, 400);
        return { ...existing, wsUrl: ver.webSocketDebuggerUrl };
      } catch {
        this.managedBrowsers.delete(key);
      }
    }

    const installedChromium = KNOWN_MAC_BROWSERS.find(
      (b) => b.family === "chromium" && fs.existsSync(b.binPath),
    );
    if (!installedChromium) {
      throw new Error("No Chromium browser (Google Chrome / Brave / Edge / Arc) found in /Applications to launch managed CDP session");
    }

    const port = await getFreePort();
    const profilePath = path.join(PROFILES_DIR, key);
    fs.mkdirSync(profilePath, { recursive: true });

    const args = [
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${profilePath}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--window-size=1280,840",
    ];
    if (!visible) {
      args.push("--headless=new");
    }
    args.push("about:blank");

    const proc = spawn(installedChromium.binPath, args, {
      detached: false,
      stdio: "ignore",
    });

    const httpEndpoint = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 8000;
    let wsUrl = null;
    while (Date.now() < deadline) {
      try {
        const ver = await fetchJson(`${httpEndpoint}/json/version`, 350);
        if (ver?.webSocketDebuggerUrl) {
          wsUrl = ver.webSocketDebuggerUrl;
          break;
        }
      } catch {}
      await sleep(100);
    }

    if (!wsUrl) {
      try {
        proc.kill("SIGTERM");
      } catch {}
      throw new Error(`Managed browser (${installedChromium.name}) failed to expose CDP on port ${port}`);
    }

    const record = { port, httpEndpoint, wsUrl, proc, visible };
    this.managedBrowsers.set(key, record);
    proc.on("exit", () => {
      if (this.managedBrowsers.get(key) === record) {
        this.managedBrowsers.delete(key);
      }
    });
    return record;
  }

  getOrRegisterTabController(targetId, browserId, httpEndpoint, wsUrl) {
    const existingTabId = this.targetToTabId.get(targetId);
    if (existingTabId && this.tabs.has(existingTabId)) {
      return this.tabs.get(existingTabId);
    }
    const tabId = `tab-${this.nextTabSeq++}`;
    const conn = this.getConnection(wsUrl);
    const ctrl = new CDPTabController({
      id: tabId,
      targetId,
      browserId,
      httpEndpoint,
      conn,
      diffTracker: this.diffTracker,
      getCursorConfig: () => this.cursorConfig,
      onClosed: (closedId) => {
        this.tabs.delete(closedId);
        this.targetToTabId.delete(targetId);
      },
    });
    this.tabs.set(tabId, ctrl);
    this.targetToTabId.set(targetId, tabId);
    return ctrl;
  }

  matchesBrowserFilter(b, browserFilter) {
    if (!browserFilter) return true;
    const f = String(browserFilter).toLowerCase();
    return (
      String(b.id || "").toLowerCase() === f ||
      String(b.brand || "").toLowerCase() === f ||
      String(b.name || "").toLowerCase().includes(f) ||
      (f === "extension" && b.type === "extension") ||
      (f === "chrome" && b.family === "chromium")
    );
  }

  controllerMatchesBrowserFilter(ctrl, browserFilter) {
    if (!browserFilter) return true;
    const f = String(browserFilter).toLowerCase();
    const bid = String(ctrl.browserId || "").toLowerCase();
    if (bid === f || bid.includes(f)) return true;
    if (f === "extension" && ctrl.isExtensionTab) return true;
    if (ctrl.appName && String(ctrl.appName).toLowerCase().includes(f)) return true;
    const isChromium = ctrl instanceof CDPTabController || ctrl.kind === "chromium";
    if (isChromium && (f === "chrome" || f === "chromium" || f === "cdp")) return true;
    return false;
  }

  /**
   * Fast (~8ms) Extension + CDP-only tab refresh with zero macOS AppleEvent / osascript invocations.
   */
  async refreshCDPTabsOnly() {
    const [extBrowsers, cdpEndpoints] = await Promise.all([
      this.discoverExtensionBrowsers(),
      this.discoverCDPEndpoints(),
    ]);
    const rawCdp = cdpEndpoints.map((ep) => {
      const tabs = ep.pages.map((p) => {
        const ctrl = this.getOrRegisterTabController(p.id, ep.id, ep.httpEndpoint, ep.wsUrl);
        return {
          id: ctrl.id,
          providerTabId: p.id,
          browserId: ep.id,
          title: p.title || "",
          url: p.url || "",
          controllable: true,
          controllableViaCDP: true,
          controlMode: "cdp",
        };
      });
      return {
        id: ep.id,
        name: ep.name,
        family: ep.family,
        type: ep.type,
        httpEndpoint: ep.httpEndpoint,
        tabs,
      };
    });
    return [...extBrowsers, ...rawCdp];
  }

  /**
   * List all available browsers + their currently open tabs (Extension-First, then raw CDP, then AppleEvents fallback).
   * Never attaches `chrome.debugger` during listing, so Chrome/Brave's debugging banner never appears on `browser_list` or `get_state`.
   */
  async listBrowsersWithTabs({ forceRefresh = false } = {}) {
    const [extBrowsers, cdpEndpoints, aeBrowsers] = await Promise.all([
      this.discoverExtensionBrowsers(),
      this.discoverCDPEndpoints(),
      this.listMacOSAppleEventTabs({ forceRefresh }),
    ]);

    const result = [];
    const extensionCoveredKeys = new Set();

    // 1. Extension-First browsers (Brave, Chrome, Edge, Arc, Vivaldi, Opera)
    for (const eb of extBrowsers) {
      result.push(eb);
      if (eb.brand) {
        extensionCoveredKeys.add(eb.brand);
      }
      const lowerName = String(eb.name || "").toLowerCase();
      if (lowerName.includes("brave")) extensionCoveredKeys.add("brave");
      else if (lowerName.includes("edge")) extensionCoveredKeys.add("edge");
      else if (lowerName.includes("arc")) extensionCoveredKeys.add("arc");
      else if (lowerName.includes("chrome")) extensionCoveredKeys.add("chrome");
    }

    // 2. Raw CDP endpoints (ports 9223, 9222, managed iab)
    for (const ep of cdpEndpoints) {
      const tabs = ep.pages.map((p) => {
        const ctrl = this.getOrRegisterTabController(p.id, ep.id, ep.httpEndpoint, ep.wsUrl);
        return {
          id: ctrl.id,
          providerTabId: p.id,
          browserId: ep.id,
          title: p.title || "",
          url: p.url || "",
          controllable: true,
          controllableViaCDP: true,
          controlMode: "cdp",
        };
      });
      result.push({
        id: ep.id,
        name: ep.name,
        family: ep.family,
        type: ep.type,
        httpEndpoint: ep.httpEndpoint,
        tabs,
      });
    }

    // Always advertise "iab" (Codex's In-App/Headless Browser alias) even before first launch
    if (!result.some((b) => b.id === "iab")) {
      result.push({
        id: "iab",
        name: "Managed Background Browser (Auto-launches on first tab)",
        family: "chromium",
        type: "iab",
        tabs: [],
      });
    }

    // 3. Installed/running macOS browsers not superseded by Extension Bridge (plus Safari)
    const seenFallbackIds = new Set();
    const unpackedExtDir = path.join(PROJECT_ROOT, "extension");

    for (const kb of KNOWN_MAC_BROWSERS) {
      if (kb.family === "chromium" && extensionCoveredKeys.has(kb.key)) {
        // Superseded by live Antigravity Extension bridge!
        continue;
      }
      const ae = aeBrowsers.find((a) => a.name === kb.name);
      if (!ae && !fs.existsSync(kb.appPath) && kb.key !== "safari") continue;

      const cdpUrls = new Set(
        cdpEndpoints.flatMap((e) => e.pages.map((p) => p.url)).filter((u) => u && u !== "about:blank"),
      );
      const aeTabs = (ae?.tabs ?? []).filter((t) => !cdpUrls.has(t.url));
      for (const t of aeTabs) {
        seenFallbackIds.add(t.id);
        this.getOrRegisterFallbackTabController(t, kb);
      }
      if (kb.key === "safari" || aeTabs.length > 0) {
        const extScheme =
          kb.key === "brave" ? "brave://extensions" : kb.key === "edge" ? "edge://extensions" : "chrome://extensions";
        result.push({
          id: kb.key,
          name: kb.name,
          family: kb.family,
          type: "macos_app",
          bundleId: kb.bundleId,
          ...(kb.family === "chromium"
            ? {
                setupHint: `Load unpacked extension from "${unpackedExtDir}" in ${extScheme} (enable Developer mode -> Load unpacked) for zero-flag background CDP, Tab Groups, uploads, and downloads.`,
              }
            : {}),
          tabs: aeTabs.map((t) => ({
            ...t,
            providerTabId: t.id,
            browserId: kb.key,
            controllable: true,
            controllableViaCDP: false,
            controlMode: "apple_events",
          })),
        });
      }
    }
    for (const id of Array.from(this.fallbackTabs.keys())) {
      if (!seenFallbackIds.has(id)) {
        this.fallbackTabs.delete(id);
      }
    }

    return result;
  }

  async listTabs({ browser, forceRefresh = false } = {}) {
    const browsers = await this.listBrowsersWithTabs({ forceRefresh });
    const filtered = browser
      ? browsers.filter((b) => this.matchesBrowserFilter(b, browser))
      : browsers;
    return filtered.flatMap((b) => b.tabs);
  }

  async _resolveExtensionBridgeForCreate(browserId = "default", options = {}) {
    const norm = String(browserId || "default").trim().toLowerCase();
    if (norm === "iab" || norm === "headless" || norm === "managed" || norm === "safari" || norm.startsWith("cdp-")) {
      return null;
    }
    // If caller explicitly asked for headless background browser (`visible: false`) on `"default"`, use managed headless
    if (options.visible === false && norm === "default") {
      return null;
    }
    await this.extensionBridge.refresh();
    if (norm === "default" || norm === "extension") {
      return this.extensionBridge.getBridge();
    }
    return this.extensionBridge.getBridge(norm);
  }

  /**
   * Resolve which CDP endpoint to use for creating a tab.
   */
  async resolveCDPEndpointForCreate(browserId = "default", options = {}) {
    const norm = String(browserId || "default").trim().toLowerCase();
    const visible = options.visible;

    if (norm === "iab" || norm === "headless" || norm === "managed") {
      const mb = await this.ensureManagedBrowser({ visible: Boolean(visible) });
      return {
        browserId: visible ? "iab-visible" : "iab",
        httpEndpoint: mb.httpEndpoint,
        wsUrl: mb.wsUrl,
      };
    }

    const endpoints = await this.discoverCDPEndpoints();

    // Exact match on endpoint ID (e.g. "cdp-9223")
    const exact = endpoints.find((e) => e.id.toLowerCase() === norm);
    if (exact) {
      return { browserId: exact.id, httpEndpoint: exact.httpEndpoint, wsUrl: exact.wsUrl };
    }

    // If user requested "chrome", "brave", "cdp", or "default" and visible === false explicitly, use headless managed
    if (visible === false) {
      const mb = await this.ensureManagedBrowser({ visible: false });
      return { browserId: "iab", httpEndpoint: mb.httpEndpoint, wsUrl: mb.wsUrl };
    }

    // Prefer an already-running non-headless CDP browser (such as port 9223!)
    const liveCdp = endpoints.find((e) => e.type === "cdp") ?? endpoints[0];
    if (liveCdp) {
      return { browserId: liveCdp.id, httpEndpoint: liveCdp.httpEndpoint, wsUrl: liveCdp.wsUrl };
    }

    // No CDP browser running yet -> launch managed Chromium automatically!
    const mb = await this.ensureManagedBrowser({ visible: visible ?? true });
    return {
      browserId: mb.visible ? "iab-visible" : "iab",
      httpEndpoint: mb.httpEndpoint,
      wsUrl: mb.wsUrl,
    };
  }

  /**
   * Open a new controllable browser tab (in background Tab Group by default when using Extension Bridge).
   */
  async createTab(browserId = "default", url = "about:blank", options = {}) {
    let targetUrl = url && String(url).trim() ? String(url).trim() : "about:blank";
    if (targetUrl !== "about:blank" && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(targetUrl)) {
      targetUrl = `https://${targetUrl}`;
    }
    assertSafeBrowserUrl(targetUrl);

    const norm = String(browserId || "default").trim().toLowerCase();
    if (norm === "safari") {
      const createJxa = `(() => {
        const app = Application("Safari");
        app.includeStandardAdditions = true;
        if (!app.running()) app.launch();
        if (${Boolean(options.visible)}) app.activate();
        const wins = app.windows();
        let tabIndex = 1;
        if (wins.length === 0) {
          const doc = app.Document({ url: ${JSON.stringify(targetUrl)} });
          app.documents.push(doc);
        } else {
          const w = wins[0];
          const t = app.Tab({ url: ${JSON.stringify(targetUrl)} });
          w.tabs.push(t);
          tabIndex = w.tabs().length;
          if (${Boolean(options.visible)}) w.currentTab = t;
        }
        return JSON.stringify({ id: "safari:w1:t" + tabIndex });
      })()`;
      const out = await this.jxaRunner(createJxa, { op: "create_tab", browserId: "safari", url: targetUrl });
      const parsed = JSON.parse(String(out || "{}"));
      this.appleEventTabsCache = null;
      await sleep(150);
      return this.getTab(parsed.id || "safari:w1:t1", { forceRefresh: true });
    }

    // Prefer live Antigravity Extension Bridge (creates grouped background tab without stealing focus!)
    const extBridge = await this._resolveExtensionBridgeForCreate(browserId, options);
    if (extBridge) {
      const sessionId = options.sessionId || "default";
      const created = await extBridge.client.request(
        "createTab",
        {
          sessionId,
          url: targetUrl,
          ...(typeof options.windowId === "number" ? { windowId: options.windowId } : {}),
          active: Boolean(options.active),
          ...(options.groupTitle !== undefined ? { groupTitle: options.groupTitle } : {}),
          ...(options.groupColor !== undefined ? { groupColor: options.groupColor } : {}),
          ungroup: Boolean(options.ungroup),
        },
        8000,
      );
      const ctrl = this.getOrRegisterExtensionTabController(
        {
          tabId: created.tabId,
          windowId: created.windowId,
          groupId: created.groupId,
          tabGroup: created.tabGroup || null,
          title: created.title || "",
          url: created.url || targetUrl,
          ownership: { sessionId, role: "scratch", createdByAgent: true },
        },
        extBridge,
        sessionId,
      );
      if (targetUrl !== "about:blank") {
        // Wait for initial tab load via lightweight chrome.tabs.get without attaching chrome.debugger prematurely
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const info = await extBridge.client.request("getTab", { tabId: created.tabId }, 1500).catch(() => null);
          if (!info || info.status === "complete") break;
          await sleep(80);
        }
      }
      return ctrl;
    }

    const endpoint = await this.resolveCDPEndpointForCreate(browserId, options);
    const conn = this.getConnection(endpoint.wsUrl);
    const background = options.visible === true ? false : true;

    const { targetId } = await conn.send("Target.createTarget", {
      url: targetUrl,
      background,
    });

    const ctrl = this.getOrRegisterTabController(
      targetId,
      endpoint.browserId,
      endpoint.httpEndpoint,
      endpoint.wsUrl,
    );

    if (targetUrl !== "about:blank") {
      await sleep(100);
      await ctrl.waitForDomSettled(4000);
    }
    return ctrl;
  }

  resolveControllerById(tabId) {
    return this.tabs.get(tabId) ?? this.fallbackTabs.get(tabId) ?? null;
  }

  async _autoClaimIfUserExtensionTab(ctrl, sessionId = "default") {
    if (ctrl && ctrl.isExtensionTab && !ctrl.cachedMeta?.ownership) {
      await ctrl.claimInPlace(sessionId).catch(() => {});
    }
    return ctrl;
  }

  parseExtensionTabRef(rawRef) {
    const ref = String(rawRef ?? "").trim();
    if (/^\d+$/.test(ref)) {
      return { numericTabId: ref, browserHint: null };
    }
    let m = /^ext-tab-(\d+)$/i.exec(ref);
    if (m) {
      return { numericTabId: m[1], browserHint: null };
    }
    m = /^ext:(?:([a-z0-9_-]+):)?(\d+)$/i.exec(ref);
    if (m) {
      const hint = m[1] ? m[1].toLowerCase().replace(/^ext-/, "") : null;
      return { numericTabId: m[2], browserHint: hint };
    }
    m = /^ext-([a-z0-9_-]+):(?:ext-tab-)?(\d+)$/i.exec(ref);
    if (m) {
      return { numericTabId: m[2], browserHint: m[1].toLowerCase() };
    }
    return null;
  }

  /**
   * Bind an existing controllable tab by tabId ("tab-1", "safari:w1:t1"), providerTabId, chromeTabId, `{ url }`, or `{ mention }`.
   */
  async getTab(reference, options = {}) {
    const isStringRef = typeof reference === "string" || typeof reference === "number";
    const isObjectRef =
      reference != null &&
      typeof reference === "object" &&
      (typeof reference.url === "string" || typeof reference.mention === "string");

    if (!isStringRef && !isObjectRef) {
      throw new TypeError("getTab reference must be a tabId string, { url }, or { mention }");
    }

    const browserFilter = options.browser ? String(options.browser).toLowerCase() : null;
    const forceRefresh = Boolean(options.forceRefresh);
    const sessionId = options.sessionId || "default";
    const extRef = isStringRef ? this.parseExtensionTabRef(reference) : null;
    const effectiveFilter = browserFilter || extRef?.browserHint || null;

    // 1. O(1) in-memory fast path for known tabId or CDP targetId (0ms, zero HTTP/JXA)
    if (isStringRef && !forceRefresh) {
      const ref = String(reference).trim();
      const direct = this.resolveControllerById(ref);
      if (direct && this.controllerMatchesBrowserFilter(direct, effectiveFilter)) {
        return await this._autoClaimIfUserExtensionTab(direct, sessionId);
      }
      const mappedCandidates = [this.targetToTabId.get(ref)];
      if (extRef) {
        if (extRef.browserHint) {
          mappedCandidates.push(this.targetToTabId.get(`ext-${extRef.browserHint}:ext-tab-${extRef.numericTabId}`));
        }
        mappedCandidates.push(this.targetToTabId.get(`ext-tab-${extRef.numericTabId}`));
      }
      for (const mappedTabId of mappedCandidates) {
        if (!mappedTabId) continue;
        const byTarget = this.resolveControllerById(mappedTabId);
        if (byTarget && this.controllerMatchesBrowserFilter(byTarget, effectiveFilter)) {
          return await this._autoClaimIfUserExtensionTab(byTarget, sessionId);
        }
      }
      if (extRef) {
        for (const ctrl of this.tabs.values()) {
          if (
            ctrl.chromeTabId != null &&
            String(ctrl.chromeTabId) === extRef.numericTabId &&
            this.controllerMatchesBrowserFilter(ctrl, effectiveFilter)
          ) {
            return await this._autoClaimIfUserExtensionTab(ctrl, sessionId);
          }
        }
      }
      // 2. If not an AppleEvents ":wN:tM" ID, check live Extension + CDP endpoints (~8ms, zero osascript)
      if (!ref.includes(":w") && effectiveFilter !== "safari") {
        const cdpBrowsers = await this.refreshCDPTabsOnly();
        const candidateCdp = cdpBrowsers
          .filter((b) => this.matchesBrowserFilter(b, effectiveFilter))
          .flatMap((b) => b.tabs);
        const foundCdp = candidateCdp.find(
          (t) =>
            t.id === ref ||
            t.providerTabId === ref ||
            (extRef && t.chromeTabId != null && String(t.chromeTabId) === extRef.numericTabId),
        );
        if (foundCdp) {
          const resolved = this.resolveControllerById(foundCdp.id);
          if (resolved) return await this._autoClaimIfUserExtensionTab(resolved, sessionId);
        }
      }
    }

    // 3. Fast Extension/CDP-first resolution for { url } or { mention } (~8ms, zero osascript when CDP matches)
    if (isObjectRef && !forceRefresh && browserFilter !== "safari") {
      if (typeof reference.url === "string") {
        const needle = reference.url.trim();
        const cdpBrowsers = await this.refreshCDPTabsOnly();
        const fastCdpTabs = cdpBrowsers
          .filter((b) => this.matchesBrowserFilter(b, browserFilter))
          .flatMap((b) => b.tabs);
        const exact = fastCdpTabs.filter((t) => t.url === needle);
        const matches = exact.length > 0 ? exact : fastCdpTabs.filter((t) => t.url.includes(needle));
        if (matches.length > 1 && exact.length !== 1) {
          throw new Error(
            `Ambiguous URL lookup "${needle}" matched ${matches.length} tabs (${matches.map((m) => m.id).join(", ")}). Pass an explicit tab ID.`,
          );
        }
        if (matches.length >= 1) {
          const resolved = this.resolveControllerById((exact[0] ?? matches[0]).id);
          if (resolved) return await this._autoClaimIfUserExtensionTab(resolved, sessionId);
        }
      } else if (typeof reference.mention === "string") {
        const m = reference.mention;
        for (const ctrl of [...this.tabs.values(), ...this.fallbackTabs.values()]) {
          if (!this.controllerMatchesBrowserFilter(ctrl, browserFilter)) continue;
          if ((ctrl.targetId && m.includes(ctrl.targetId)) || m.includes(ctrl.id)) {
            return await this._autoClaimIfUserExtensionTab(ctrl, sessionId);
          }
        }
        const cdpBrowsers = await this.refreshCDPTabsOnly();
        const fastCdpTabs = cdpBrowsers
          .filter((b) => this.matchesBrowserFilter(b, browserFilter))
          .flatMap((b) => b.tabs);
        const found = fastCdpTabs.find((t) => (t.providerTabId && m.includes(t.providerTabId)) || m.includes(t.id));
        if (found) {
          const resolved = this.resolveControllerById(found.id);
          if (resolved) return await this._autoClaimIfUserExtensionTab(resolved, sessionId);
        }
      }
    }

    // 4. Full inventory fallback (Extension + CDP + macOS AppleEvent tabs)
    const browsers = await this.listBrowsersWithTabs({ forceRefresh });
    const candidateBrowsers = effectiveFilter
      ? browsers.filter((b) => this.matchesBrowserFilter(b, effectiveFilter))
      : browsers;

    // Order Extension/CDP tabs ahead of AppleEvents fallback tabs when resolving URLs
    const cdpTabs = candidateBrowsers.flatMap((b) => b.tabs).filter((t) => t.controllableViaCDP);
    const fallbackTabs = candidateBrowsers.flatMap((b) => b.tabs).filter((t) => !t.controllableViaCDP);
    const allTabs = [...cdpTabs, ...fallbackTabs];

    if (isStringRef) {
      const ref = String(reference).trim();
      const direct = this.resolveControllerById(ref);
      if (direct && this.controllerMatchesBrowserFilter(direct, effectiveFilter)) {
        return await this._autoClaimIfUserExtensionTab(direct, sessionId);
      }
      const byProvider = allTabs.find(
        (t) =>
          t.providerTabId === ref ||
          t.id === ref ||
          (extRef && t.chromeTabId != null && String(t.chromeTabId) === extRef.numericTabId),
      );
      if (byProvider) {
        const resolved = this.resolveControllerById(byProvider.id);
        if (resolved) return await this._autoClaimIfUserExtensionTab(resolved, sessionId);
      }
      throw new Error(
        `Controllable tab "${ref}" not found. Available tabs: ${allTabs.map((t) => `${t.id} (${t.url})`).join(", ") || "none"}`,
      );
    }

    if (typeof reference.url === "string") {
      const needle = reference.url.trim();
      const searchPool = cdpTabs.some((t) => t.url === needle || t.url.includes(needle)) ? cdpTabs : allTabs;
      const exact = searchPool.filter((t) => t.url === needle);
      const matches =
        exact.length > 0 ? exact : searchPool.filter((t) => t.url.includes(needle));
      if (matches.length === 0) {
        throw new Error(`No open controllable tab matching URL "${needle}"`);
      }
      if (matches.length > 1 && exact.length !== 1) {
        throw new Error(
          `Ambiguous URL lookup "${needle}" matched ${matches.length} tabs (${matches.map((m) => m.id).join(", ")}). Pass an explicit tab ID.`,
        );
      }
      const resolved = this.resolveControllerById((exact[0] ?? matches[0]).id);
      return await this._autoClaimIfUserExtensionTab(resolved, sessionId);
    }

    const m = reference.mention;
    const found = allTabs.find((t) => (t.providerTabId && m.includes(t.providerTabId)) || m.includes(t.id));
    if (found) {
      const resolved = this.resolveControllerById(found.id);
      return await this._autoClaimIfUserExtensionTab(resolved, sessionId);
    }
    throw new Error(`Could not resolve tab mention "${m}"`);
  }

  async _resolveNumericChromeTabIds(rawIds = [], bridgeQuery = null) {
    await this.discoverExtensionBrowsers();
    let bridge = this.extensionBridge.getBridge(bridgeQuery);
    const numericIds = [];

    const list = Array.isArray(rawIds) ? rawIds : [rawIds];
    for (const item of list) {
      if (typeof item === "number" && Number.isInteger(item)) {
        numericIds.push(item);
        continue;
      }
      const str = String(item ?? "").trim();
      if (!str) continue;
      if (/^\d+$/.test(str)) {
        numericIds.push(Number(str));
        continue;
      }
      const parsedExt = ExtensionCDPConnection.parseChromeTabId(str);
      if (parsedExt != null) {
        numericIds.push(parsedExt);
        continue;
      }
      const ctrl = this.resolveControllerById(str);
      if (ctrl && ctrl.chromeTabId != null) {
        numericIds.push(ctrl.chromeTabId);
        if (!bridge) bridge = this.extensionBridge.getBridge(ctrl.browserId);
        continue;
      }
      throw new Error(`Could not resolve extension Chrome tabId for "${str}". Pass a tabId from an extension browser.`);
    }

    if (!bridge) {
      bridge = this.extensionBridge.getBridge(bridgeQuery);
    }
    return { bridge, numericIds };
  }

  /**
   * Session, Tab Group, Ownership, History & Bookmarks management (`browser_manage` MCP tool & `cua_repl`).
   */
  async manage(action, params = {}) {
    const act = String(action || "status").trim().toLowerCase();
    const browserQuery = params.browserId ?? params.browser_id ?? null;

    if (act === "status") {
      const [extBrowsers, rawCdp] = await Promise.all([
        this.discoverExtensionBrowsers(),
        this.discoverCDPEndpoints(),
      ]);
      const unpackedDir = path.join(PROJECT_ROOT, "extension");
      const bridges = [];
      for (const rec of this.extensionBridge.getConnectedBrowsers()) {
        const groupsRes = await rec.client.request("listTabGroups", {}, 2000).catch(() => ({ groups: [] }));
        bridges.push({
          browserId: rec.browserId,
          sockPath: rec.sockPath,
          hostPid: rec.client.hostPid,
          info: rec.client.info,
          tabGroups: groupsRes.groups || [],
          openTabCount: extBrowsers.find((b) => b.id === rec.browserId)?.tabs?.length ?? 0,
        });
      }
      return {
        ok: true,
        extensionId: "cnipmpbdggdeocaigfifflifphanoiic",
        unpackedExtensionPath: unpackedDir,
        nativeHostName: "com.antigravity.browser_bridge",
        sockDir: this.extensionBridge.sockDir,
        connectedExtensionBrowsers: bridges,
        rawCdpEndpoints: rawCdp.map((e) => ({ id: e.id, name: e.name, httpEndpoint: e.httpEndpoint, tabCount: e.pages.length })),
        setupHint:
          bridges.length === 0
            ? `Open brave://extensions or chrome://extensions -> enable Developer mode -> Load unpacked -> select "${unpackedDir}".`
            : null,
      };
    }

    if (act === "finalize_session") {
      await this.extensionBridge.refresh();
      const targets = browserQuery
        ? [this.extensionBridge.getBridge(browserQuery)].filter(Boolean)
        : this.extensionBridge.getConnectedBrowsers();
      const sessionId = params.sessionId ?? params.session_id;
      const closeScratchTabs = params.closeScratchTabs ?? params.close_scratch_tabs ?? true;
      const detachAll = Boolean(params.detachAll ?? params.detach_all);

      const results = [];
      for (const rec of targets) {
        const r = await rec.client.request("finalizeSession", {
          sessionId,
          closeScratchTabs,
          detachAll,
        });
        results.push({ browserId: rec.browserId, ...r });
      }

      // Also detach any raw CDP tabs if detachAll or no extension targets
      let detachedRawCount = 0;
      for (const ctrl of this.tabs.values()) {
        if (!ctrl.isExtensionTab && ctrl.conn.targetSessions?.has(ctrl.targetId)) {
          await ctrl.detach().catch(() => {});
          detachedRawCount++;
        } else if (ctrl.isExtensionTab) {
          ctrl._activeIndicatorInjected = false;
          ctrl.cursorState.visible = false;
        }
      }
      await this.discoverExtensionBrowsers().catch(() => {});
      return {
        ok: true,
        results,
        detachedRawCdpTabs: detachedRawCount,
      };
    }

    await this.extensionBridge.refresh();
    const requireBridge = (resolvedBridge = null) => {
      const b = resolvedBridge || this.extensionBridge.getBridge(browserQuery);
      if (!b) {
        const unpackedDir = path.join(PROJECT_ROOT, "extension");
        throw new Error(
          `Action '${act}' requires the Antigravity Browser Extension bridge. Load unpacked extension from "${unpackedDir}" in brave://extensions or chrome://extensions.`,
        );
      }
      return b;
    };

    switch (act) {
      case "list_tab_groups": {
        const b = requireBridge();
        const windowId = params.windowId ?? params.window_id;
        return await b.client.request("listTabGroups", windowId != null ? { windowId: Number(windowId) } : {});
      }
      case "create_tab_group":
      case "group_tabs": {
        const rawTabIds = params.tabIds ?? params.tab_ids ?? (params.tabId ?? params.tab_id ? [params.tabId ?? params.tab_id] : []);
        const { bridge, numericIds } = await this._resolveNumericChromeTabIds(rawTabIds, browserQuery);
        const b = requireBridge(bridge);
        return await b.client.request("groupTabs", {
          tabIds: numericIds,
          title: params.title ?? params.name,
          color: params.color,
          ...(params.groupId != null || params.group_id != null
            ? { groupId: Number(params.groupId ?? params.group_id) }
            : {}),
          ...(params.windowId != null || params.window_id != null
            ? { windowId: Number(params.windowId ?? params.window_id) }
            : {}),
          ...(typeof params.collapsed === "boolean" ? { collapsed: params.collapsed } : {}),
        });
      }
      case "update_tab_group": {
        const b = requireBridge();
        return await b.client.request("updateTabGroup", {
          groupId: Number(params.groupId ?? params.group_id),
          title: params.title ?? params.name,
          color: params.color,
          ...(typeof params.collapsed === "boolean" ? { collapsed: params.collapsed } : {}),
        });
      }
      case "name_session": {
        const b = requireBridge();
        return await b.client.request("nameSession", {
          sessionId: params.sessionId ?? params.session_id ?? "default",
          name: params.name ?? params.title,
          color: params.color,
          ...(typeof params.collapsed === "boolean" ? { collapsed: params.collapsed } : {}),
        });
      }
      case "ungroup_tabs": {
        const rawTabIds = params.tabIds ?? params.tab_ids ?? (params.tabId ?? params.tab_id ? [params.tabId ?? params.tab_id] : []);
        const { bridge, numericIds } = await this._resolveNumericChromeTabIds(rawTabIds, browserQuery);
        const b = requireBridge(bridge);
        return await b.client.request("ungroupTabs", { tabIds: numericIds });
      }
      case "claim_tab": {
        const rawId = params.tabId ?? params.tab_id;
        const { bridge, numericIds } = await this._resolveNumericChromeTabIds([rawId], browserQuery);
        const b = requireBridge(bridge);
        if (numericIds.length === 0) throw new TypeError("claim_tab requires tab_id");
        return await b.client.request("claimTab", {
          sessionId: params.sessionId ?? params.session_id ?? "default",
          tabId: numericIds[0],
        });
      }
      case "mark_tab": {
        const rawId = params.tabId ?? params.tab_id;
        const status = params.status || "deliverable";
        const strRef = String(rawId ?? "").trim();
        const directCtrl = this.resolveControllerById(strRef);
        if (directCtrl && typeof directCtrl.markTab === "function") {
          return await directCtrl.markTab(status, {
            sessionId: params.sessionId ?? params.session_id ?? "default",
            activate: params.activate,
          });
        }
        const { bridge, numericIds } = await this._resolveNumericChromeTabIds([rawId], browserQuery);
        const b = requireBridge(bridge);
        if (numericIds.length === 0) throw new TypeError("mark_tab requires tab_id");
        return await b.client.request("markTab", {
          sessionId: params.sessionId ?? params.session_id ?? "default",
          tabId: numericIds[0],
          status,
          ...(params.activate !== undefined ? { activate: Boolean(params.activate) } : {}),
        });
      }
      case "search_history": {
        const b = requireBridge();
        return await b.client.request("history.search", {
          text: params.query ?? params.text ?? "",
          maxResults: params.maxResults ?? params.max_results ?? params.limit ?? 25,
          ...(params.startTime != null || params.start_time != null
            ? { startTime: Number(params.startTime ?? params.start_time) }
            : {}),
          ...(params.endTime != null || params.end_time != null
            ? { endTime: Number(params.endTime ?? params.end_time) }
            : {}),
        });
      }
      case "list_bookmarks": {
        const b = requireBridge();
        const q = params.query ?? params.text;
        if (q != null && String(q).trim() !== "") {
          return await b.client.request("bookmarks.search", { query: String(q) });
        }
        return await b.client.request("bookmarks.getRecent", {
          count: params.count ?? params.limit ?? 25,
        });
      }
      case "create_bookmark": {
        const b = requireBridge();
        return await b.client.request("bookmarks.create", {
          ...(params.parentId ?? params.parent_id ? { parentId: String(params.parentId ?? params.parent_id) } : {}),
          title: params.title ?? params.name ?? "",
          ...(params.url ? { url: String(params.url) } : {}),
        });
      }
      default:
        throw new Error(
          `Unsupported browser_manage action '${action}'. Supported actions: status, list_tab_groups, create_tab_group, group_tabs, update_tab_group, name_session, ungroup_tabs, claim_tab, mark_tab, finalize_session, search_history, list_bookmarks, create_bookmark`,
        );
    }
  }

  async configureCursor({ enabled, idleTimeoutMs, glideEnabled } = {}) {
    if (typeof enabled === "boolean") {
      this.cursorConfig.enabled = enabled;
      if (!enabled) {
        await this.clearAllCursors();
      }
    }
    if (typeof idleTimeoutMs === "number" && Number.isFinite(idleTimeoutMs)) {
      this.cursorConfig.idleTimeoutMs = Math.max(400, Math.min(30000, Math.round(idleTimeoutMs)));
    }
    if (typeof glideEnabled === "boolean") {
      this.cursorConfig.glideEnabled = glideEnabled;
    }
    return { ...this.cursorConfig };
  }

  async getCursorStates({ tabId } = {}) {
    if (tabId) {
      const tab = await this.getTab(tabId);
      const state = await tab.getCursorState();
      return {
        config: { ...this.cursorConfig },
        cursors: state.visible ? [state] : [],
        tabCursor: state,
      };
    }
    const activeFallbackTabs = Array.from(this.fallbackTabs.values()).filter((t) => t.isCursorCurrentlyVisible());
    const activeCdpTabs = Array.from(this.tabs.values()).filter(
      (t) => !t.isExtensionTab || t.conn.targetSessions?.has(t.targetId),
    );
    const states = await Promise.all(
      [...activeCdpTabs, ...activeFallbackTabs].map((t) =>
        t.getCursorState().catch(() => ({ tabId: t.id, visible: false, badge: null })),
      ),
    );
    return {
      config: { ...this.cursorConfig },
      cursors: states.filter((s) => s.visible),
    };
  }

  async clearAllCursors() {
    const activeFallbackTabs = Array.from(this.fallbackTabs.values()).filter(
      (t) => t.cursorState.visible || t.cursorState.updatedAt > 0,
    );
    const activeCdpTabs = Array.from(this.tabs.values()).filter(
      (t) => t.cursorState.visible || t.cursorState.updatedAt > 0,
    );
    await Promise.all(
      [...activeCdpTabs, ...activeFallbackTabs].map((t) =>
        t.hideCursor({ keepActiveIndicator: false }).catch(() => null),
      ),
    );
    return { ok: true };
  }

  closeAll() {
    for (const t of this.tabs.values()) {
      t.stopCompositorAwake?.({ sendStop: false });
    }
    this.extensionBridge.closeAll();
    for (const c of this.connections.values()) {
      c.close();
    }
    this.connections.clear();
    for (const mb of this.managedBrowsers.values()) {
      if (!mb.visible && mb.proc.exitCode === null) {
        try {
          mb.proc.kill("SIGTERM");
        } catch {}
      }
    }
    this.managedBrowsers.clear();
  }
}
