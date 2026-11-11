import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const MAX_FRAME_BYTES = 32 * 1024 * 1024;

function getDefaultSockDir() {
  return process.env.AG_BRIDGE_SOCK_DIR || "/tmp/antigravity-browser-bridge";
}

function encodeFrame(obj) {
  const payload = Buffer.from(JSON.stringify(obj), "utf8");
  if (payload.length > MAX_FRAME_BYTES) {
    throw new Error(`Extension bridge frame length ${payload.length} exceeds 32 MiB`);
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

class FrameReader {
  constructor(onFrame, onError) {
    this.buf = Buffer.alloc(0);
    this.onFrame = onFrame;
    this.onError = onError;
  }

  push(chunk) {
    if (!chunk || chunk.length === 0) return;
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (len > MAX_FRAME_BYTES) {
        this.buf = Buffer.alloc(0);
        this.onError?.(new Error(`Extension bridge inbound frame ${len} exceeds 32 MiB`));
        return;
      }
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      let msg;
      try {
        msg = JSON.parse(body.toString("utf8"));
      } catch (err) {
        this.onError?.(err);
        continue;
      }
      this.onFrame(msg);
    }
  }
}

/**
 * Persistent Unix Domain Socket Client connected to one running `antigravity-native-host.mjs` instance
 * (corresponding to one live Chromium/Brave/Chrome/Edge/Arc profile with the unpacked MV3 extension).
 */
export class ExtensionSocketClient extends EventEmitter {
  constructor(sockPath) {
    super();
    this.sockPath = sockPath;
    this.socket = null;
    this.connected = false;
    this.closed = false;
    this.nextId = 1;
    this.pending = new Map();
    this.info = null;
    this.hostPid = null;
    this.registeredExpressionKeys = new Set();
    this.downloadsById = new Map();
  }

  async connect(timeoutMs = 1500) {
    if (this.connected && this.socket && !this.socket.destroyed) return this;
    await new Promise((resolve, reject) => {
      const sock = net.createConnection(this.sockPath);
      const timer = setTimeout(() => {
        try {
          sock.destroy();
        } catch {}
        reject(new Error(`Timed out connecting to extension bridge socket ${this.sockPath}`));
      }, timeoutMs);

      const reader = new FrameReader(
        (msg) => this._handleMessage(msg),
        () => {
          try {
            sock.destroy();
          } catch {}
        },
      );

      sock.once("connect", () => {
        clearTimeout(timer);
        this.socket = sock;
        this.connected = true;
        resolve();
      });

      sock.on("data", (chunk) => reader.push(chunk));

      const onDisconnect = (err) => {
        clearTimeout(timer);
        const wasConnected = this.connected;
        this.connected = false;
        if (this.socket === sock) this.socket = null;
        const reason = err instanceof Error ? err : new Error("Extension bridge socket closed");
        for (const [, p] of this.pending.entries()) {
          clearTimeout(p.timer);
          p.reject(reason);
        }
        this.pending.clear();
        if (wasConnected) {
          this.emit("disconnected", reason);
        } else {
          reject(reason);
        }
      };

      sock.once("error", onDisconnect);
      sock.once("close", () => onDisconnect(new Error("Extension bridge socket closed")));
    });

    const info = await this.request("getInfo", {}, Math.min(2000, timeoutMs + 500));
    this.info = info;
    const m = /bridge-(\d+)\.sock$/.exec(path.basename(this.sockPath));
    if (m) this.hostPid = Number(m[1]);
    return this;
  }

  _handleMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.id !== undefined && msg.id !== null && !msg.method) {
      const entry = this.pending.get(String(msg.id));
      if (!entry) return;
      this.pending.delete(String(msg.id));
      clearTimeout(entry.timer);
      if (msg.error) {
        const err = new Error(msg.error.message || JSON.stringify(msg.error));
        err.code = msg.error.code;
        entry.reject(err);
      } else {
        entry.resolve(msg.result ?? {});
      }
      return;
    }

    if (msg.method === "bridgeHello" && msg.params) {
      this.info = { ...(this.info || {}), ...msg.params };
      if (msg.params.hostPid) this.hostPid = msg.params.hostPid;
      this.emit("hello", this.info);
      return;
    }

    if (msg.method === "downloadEvent" && msg.params) {
      this._recordDownloadEvent(msg.params);
      this.emit("downloadEvent", msg.params);
      return;
    }

    if (msg.method) {
      this.emit(msg.method, msg.params || {});
    }
  }

  _recordDownloadEvent(ev) {
    if (ev.event === "created" && ev.item && ev.item.id != null) {
      this.downloadsById.set(ev.item.id, { ...ev.item });
    } else if (ev.event === "changed" && ev.delta && ev.delta.id != null) {
      const prev = this.downloadsById.get(ev.delta.id) || { id: ev.delta.id };
      const next = { ...prev };
      for (const [k, v] of Object.entries(ev.delta)) {
        if (k === "id") continue;
        if (v && typeof v === "object" && "current" in v) {
          next[k] = v.current;
        }
      }
      this.downloadsById.set(ev.delta.id, next);
    }
  }

  request(method, params = {}, timeoutMs = 15000) {
    if (!this.connected || !this.socket || this.socket.destroyed) {
      return Promise.reject(new Error(`Extension bridge socket disconnected (${this.sockPath})`));
    }
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Extension RPC '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.write(
          encodeFrame({
            jsonrpc: "2.0",
            id,
            method,
            params,
          }),
        );
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async sendCdpWithCache({ tabId, targetId, sessionId, method, params = {} }, timeoutMs = 15000) {
    const canCache =
      method === "Runtime.evaluate" &&
      typeof params?.expression === "string" &&
      params.expression.length >= 1400;

    if (!canCache) {
      return await this.request("sendCdp", { tabId, targetId, sessionId, method, params }, timeoutMs);
    }

    const hashKey = `expr_${crypto.createHash("sha1").update(params.expression).digest("hex").slice(0, 20)}`;
    if (!this.registeredExpressionKeys.has(hashKey)) {
      await this.request("registerCachedExpression", { key: hashKey, expression: params.expression }, 5000);
      this.registeredExpressionKeys.add(hashKey);
    }

    const slimParams = { ...params };
    delete slimParams.expression;
    try {
      return await this.request(
        "sendCdp",
        {
          tabId,
          targetId,
          sessionId,
          method,
          params: slimParams,
          expressionCacheKey: hashKey,
        },
        timeoutMs,
      );
    } catch (err) {
      if (err?.code === -32004 || /cache miss/i.test(err?.message || "")) {
        this.registeredExpressionKeys.delete(hashKey);
        await this.request("registerCachedExpression", { key: hashKey, expression: params.expression }, 5000);
        this.registeredExpressionKeys.add(hashKey);
        return await this.request(
          "sendCdp",
          {
            tabId,
            targetId,
            sessionId,
            method,
            params: slimParams,
            expressionCacheKey: hashKey,
          },
          timeoutMs,
        );
      }
      throw err;
    }
  }

  close() {
    this.closed = true;
    this.connected = false;
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {}
      this.socket = null;
    }
  }
}

/**
 * Drop-in CDP Connection adapter backed by `ExtensionSocketClient` (`chrome.debugger` 1.3).
 * Implements the exact `ensureTargetSession(targetId)` + `send(method, params, sessionId, timeoutMs)`
 * + EventEmitter (`cdpEvent`, `cdpDetached`) contract expected by `CDPTabController`!
 */
export class ExtensionCDPConnection extends EventEmitter {
  /**
   * @param {ExtensionSocketClient} client
   * @param {string} browserId
   */
  constructor(client, browserId) {
    super();
    this.client = client;
    this.browserId = browserId;
    this.isExtension = true;
    /** @type {Map<string, string>} targetId ("ext-tab-42") -> sessionId ("ext-session-42") */
    this.targetSessions = new Map();
    /** @type {Map<string, { tabId: number, childTargetId: string }>} childSessionId -> route */
    this.childSessions = new Map();

    this._onCdpEvent = (ev) => {
      const tabId = ev.tabId;
      const rootSessionId = tabId != null ? `ext-session-${tabId}` : null;
      const effectiveSessionId = ev.sessionId || rootSessionId;

      if (ev.method === "Target.attachedToTarget" && ev.params?.sessionId && ev.params?.targetInfo?.targetId) {
        this.childSessions.set(ev.params.sessionId, {
          tabId,
          childTargetId: ev.params.targetInfo.targetId,
        });
      } else if (ev.method === "Target.detachedFromTarget" && ev.params?.sessionId) {
        this.childSessions.delete(ev.params.sessionId);
      }

      if (ev.method === "Page.screencastFrame" && ev.params?.sessionId != null && tabId != null) {
        this.client
          .request("sendCdp", {
            tabId,
            method: "Page.screencastFrameAck",
            params: { sessionId: ev.params.sessionId },
          })
          .catch(() => {});
      }

      this.emit("cdpEvent", {
        tabId,
        targetId: ev.targetId || (tabId != null ? `${this.browserId}:ext-tab-${tabId}` : null),
        sessionId: effectiveSessionId,
        rootSessionId,
        method: ev.method,
        params: ev.params || {},
      });
    };

    this._onCdpDetached = (ev) => {
      if (ev.tabId != null) {
        this.targetSessions.delete(`ext-tab-${ev.tabId}`);
        this.targetSessions.delete(`${this.browserId}:ext-tab-${ev.tabId}`);
      }
      this.emit("cdpDetached", {
        tabId: ev.tabId ?? null,
        targetId: ev.targetId || (ev.tabId != null ? `${this.browserId}:ext-tab-${ev.tabId}` : null),
        sessionId: ev.tabId != null ? `ext-session-${ev.tabId}` : null,
        reason: ev.reason || "detached",
      });
    };

    this.client.on("cdpEvent", this._onCdpEvent);
    this.client.on("cdpDetached", this._onCdpDetached);
  }

  static parseChromeTabId(targetIdOrSessionId) {
    const m = /^(?:[a-z0-9_.-]+:)?ext-(?:tab|session)-(\d+)$/i.exec(String(targetIdOrSessionId || ""));
    return m ? Number(m[1]) : null;
  }

  async ensureTargetSession(targetId) {
    const existing = this.targetSessions.get(targetId);
    if (existing) return existing;

    const chromeTabId = ExtensionCDPConnection.parseChromeTabId(targetId);
    if (chromeTabId == null) {
      throw new Error(`Invalid extension targetId: ${targetId}`);
    }

    await this.client.request("attachDebugger", { tabId: chromeTabId }, 8000);
    const sessionId = `ext-session-${chromeTabId}`;
    this.targetSessions.set(targetId, sessionId);

    // Enable core CDP domains + Take Over binding + OOPIF auto-attach lazily on first attach
    await this.client.request("sendCdp", { tabId: chromeTabId, method: "Page.enable", params: {} }).catch(() => {});
    await this.client.request("sendCdp", { tabId: chromeTabId, method: "Runtime.enable", params: {} }).catch(() => {});
    await this.client.request("sendCdp", { tabId: chromeTabId, method: "DOM.enable", params: {} }).catch(() => {});
    await this.client.request("sendCdp", { tabId: chromeTabId, method: "Network.enable", params: {} }).catch(() => {});
    await this.client
      .request("sendCdp", {
        tabId: chromeTabId,
        method: "Runtime.addBinding",
        params: { name: "__agCuaControl" },
      })
      .catch(() => {});
    await this.client
      .request("sendCdp", {
        tabId: chromeTabId,
        method: "Target.setAutoAttach",
        params: {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
          filter: [{ type: "iframe", exclude: false }],
        },
      })
      .catch(() => {});

    return sessionId;
  }

  async send(method, params = {}, sessionId = undefined, timeoutMs = 15000) {
    const rootTabId = ExtensionCDPConnection.parseChromeTabId(sessionId);
    if (rootTabId != null) {
      return await this.client.sendCdpWithCache(
        {
          tabId: rootTabId,
          method,
          params,
        },
        timeoutMs,
      );
    }

    // Child OOPIF session routing
    if (sessionId && this.childSessions.has(sessionId)) {
      const child = this.childSessions.get(sessionId);
      return await this.client.sendCdpWithCache(
        {
          tabId: child.tabId,
          targetId: child.childTargetId,
          sessionId,
          method,
          params,
        },
        timeoutMs,
      );
    }

    // Browser-level or explicit targetId call
    if (params?.targetId) {
      const tid = ExtensionCDPConnection.parseChromeTabId(params.targetId);
      if (tid != null) {
        return await this.client.sendCdpWithCache({ tabId: tid, method, params }, timeoutMs);
      }
      return await this.client.sendCdpWithCache({ targetId: params.targetId, sessionId, method, params }, timeoutMs);
    }

    throw new Error(`ExtensionCDPConnection cannot route '${method}' without tab sessionId`);
  }

  async detachTab(chromeTabId) {
    this.targetSessions.delete(`ext-tab-${chromeTabId}`);
    return await this.client.request("detachDebugger", { tabId: chromeTabId }, 5000).catch(() => ({ ok: false }));
  }

  close() {
    this.client.off("cdpEvent", this._onCdpEvent);
    this.client.off("cdpDetached", this._onCdpDetached);
    this.targetSessions.clear();
    this.childSessions.clear();
  }
}

/**
 * Discovers and maintains persistent connections to all live `antigravity-native-host` Unix sockets
 * in `/tmp/antigravity-browser-bridge/*.sock` (supports Chrome, Brave, Edge, Arc, Vivaldi, Opera simultaneously).
 */
export class ExtensionBridgeManager extends EventEmitter {
  constructor({ sockDir } = {}) {
    super();
    this.sockDir = sockDir || getDefaultSockDir();
    /** @type {Map<string, { browserId: string, client: ExtensionSocketClient, cdpConn: ExtensionCDPConnection }>} */
    this.bridgesBySock = new Map();
    /** @type {Map<string, { browserId: string, client: ExtensionSocketClient, cdpConn: ExtensionCDPConnection }>} */
    this.bridgesById = new Map();
  }

  async refresh() {
    let entries = [];
    try {
      entries = fs.readdirSync(this.sockDir);
    } catch {
      return this.getConnectedBrowsers();
    }

    const sockPaths = entries
      .filter((n) => n.endsWith(".sock"))
      .map((n) => path.join(this.sockDir, n));

    await Promise.all(
      sockPaths.map(async (sp) => {
        const existing = this.bridgesBySock.get(sp);
        if (existing && existing.client.connected) return;
        if (existing) {
          this._removeEntry(sp);
        }
        const client = new ExtensionSocketClient(sp);
        try {
          await client.connect(1200);
          const family = String(client.info?.browserFamily || "chrome").toLowerCase();
          const pidSuffix = client.hostPid || path.basename(sp, ".sock").replace(/^bridge-/, "");
          // Clean deterministic browserId: e.g. "ext-brave" (or "ext-brave-<pid>" if multiple profiles of same browser run)
          const baseId = `ext-${family}`;
          const existingSameFamily = this.bridgesById.get(baseId);
          const browserId =
            existingSameFamily && existingSameFamily.client.connected ? `${baseId}-${pidSuffix}` : baseId;

          const cdpConn = new ExtensionCDPConnection(client, browserId);
          const record = { browserId, sockPath: sp, client, cdpConn };
          this.bridgesBySock.set(sp, record);
          this.bridgesById.set(browserId, record);

          client.once("disconnected", () => {
            this._removeEntry(sp);
            this.emit("bridgeDisconnected", { browserId, sockPath: sp });
          });

          this.emit("bridgeConnected", record);
        } catch {
          client.close();
          // Prune dead socket if connect was refused
          try {
            const m = /bridge-(\d+)\.sock$/.exec(path.basename(sp));
            if (m) {
              const pid = Number(m[1]);
              try {
                process.kill(pid, 0);
              } catch (ke) {
                if (ke && ke.code === "ESRCH") fs.unlinkSync(sp);
              }
            }
          } catch {}
        }
      }),
    );

    return this.getConnectedBrowsers();
  }

  _removeEntry(sockPath) {
    const rec = this.bridgesBySock.get(sockPath);
    if (!rec) return;
    this.bridgesBySock.delete(sockPath);
    if (this.bridgesById.get(rec.browserId) === rec) {
      this.bridgesById.delete(rec.browserId);
    }
    rec.cdpConn.close();
    rec.client.close();
  }

  getConnectedBrowsers() {
    const out = [];
    for (const rec of this.bridgesById.values()) {
      if (!rec.client.connected) continue;
      out.push(rec);
    }
    return out;
  }

  getBridge(browserIdOrQuery) {
    if (!browserIdOrQuery) {
      return this.getConnectedBrowsers()[0] || null;
    }
    const q = String(browserIdOrQuery).trim().toLowerCase();
    if (this.bridgesById.has(browserIdOrQuery)) {
      const exact = this.bridgesById.get(browserIdOrQuery);
      if (exact.client.connected) return exact;
    }
    for (const rec of this.getConnectedBrowsers()) {
      const fam = String(rec.client.info?.browserFamily || "").toLowerCase();
      const bName = String(rec.client.info?.browserName || "").toLowerCase();
      if (rec.browserId.toLowerCase() === q || fam === q || bName.includes(q) || q.includes(fam)) {
        return rec;
      }
    }
    return null;
  }

  closeAll() {
    for (const sp of Array.from(this.bridgesBySock.keys())) {
      this._removeEntry(sp);
    }
  }
}
