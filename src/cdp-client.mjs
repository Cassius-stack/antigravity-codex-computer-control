import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  BUILD_AX_SNAPSHOT_EXPR,
  buildBrowserCursorOverlayExpr,
  buildGetActiveElementAnchorExpr,
  buildGetBrowserCursorStateExpr,
  buildPasteExpr,
  buildPrepareBrowserCursorForScreenshotExpr,
  buildPrepareElementExpr,
  buildRemoveBrowserCursorExpr,
  buildSecondaryActionExpr,
  buildSelectTextExpr,
  buildSetBrowserCursorTemporarilyHiddenExpr,
  buildSetValueExpr,
} from "./browser-ax.mjs";
import { CDP_MODIFIER_BITS, parseCDPKeyChord } from "./keys.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PROFILES_DIR = path.join(PROJECT_ROOT, ".browser-profiles");

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
export class CDPMultiplexConnection {
  /**
   * @param {string} wsUrl
   */
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    /** @type {WebSocket | null} */
    this.ws = null;
    this.connecting = null;
    this.nextId = 1;
    /** @type {Map<number, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
    this.pending = new Map();
    /** @type {Map<string, string>} targetId -> sessionId */
    this.targetSessions = new Map();
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
        if (msg.method === "Target.detachedFromTarget" && msg.params?.sessionId) {
          for (const [tId, sId] of this.targetSessions.entries()) {
            if (sId === msg.params.sessionId) this.targetSessions.delete(tId);
          }
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
    await this.send("Page.enable", {}, sessionId).catch(() => {});
    await this.send("Runtime.enable", {}, sessionId).catch(() => {});
    await this.send("DOM.enable", {}, sessionId).catch(() => {});
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
 * Controllable CDP Browser Tab — implements full Codex Tab & Target interface + Playwright-style locator()
 */
export class CDPTabController {
  /**
   * @param {{
   *   id: string,
   *   targetId: string,
   *   browserId: string,
   *   httpEndpoint: string,
   *   conn: CDPMultiplexConnection,
   *   diffTracker: import("./diff.mjs").AXDiffTracker,
   *   onClosed?: (id: string) => void
   * }} cfg
   */
  constructor(cfg) {
    this.id = cfg.id;
    this.targetId = cfg.targetId;
    this.browserId = cfg.browserId;
    this.httpEndpoint = cfg.httpEndpoint;
    this.conn = cfg.conn;
    this.diffTracker = cfg.diffTracker;
    this.onClosed = cfg.onClosed;
    this.getCursorConfig = cfg.getCursorConfig;
    this.screencastActive = false;
    this.screencastTimer = null;
    this.cursorState = {
      visible: false,
      x: null,
      y: null,
      badge: null,
      highlightedRect: null,
      updatedAt: 0,
    };
  }

  async send(method, params = {}, timeoutMs = 15000) {
    try {
      const sessionId = await this.conn.ensureTargetSession(this.targetId);
      return await this.conn.send(method, params, sessionId, timeoutMs);
    } catch (err) {
      // Retry once if session detached (e.g. cross-process navigation)
      if (/Session with given id not found|No session|Target closed/i.test(err.message)) {
        this.conn.targetSessions.delete(this.targetId);
        this.screencastActive = false;
        const sessionId = await this.conn.ensureTargetSession(this.targetId);
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
    if (showCursor === false || cfg.enabled === false) return null;
    await this.ensureCompositorAwake();
    try {
      const res = await this.evaluate(
        buildBrowserCursorOverlayExpr({
          ...spec,
          idleTimeoutMs: cfg.idleTimeoutMs,
          instant: cfg.glideEnabled === false ? true : Boolean(spec.instant),
        }),
      );
      if (res?.ok) {
        this.cursorState = {
          visible: true,
          x: res.x,
          y: res.y,
          badge: res.badge ?? null,
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

  async hideCursor() {
    this.cursorState.visible = false;
    this.stopCompositorAwake();
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
        badge: domState.badge,
        highlightedRect: domState.highlightedRect,
      };
    } else {
      this.cursorState.visible = false;
    }
    return {
      tabId: this.id,
      browserId: this.browserId,
      ...domState,
    };
  }

  async getMetadata() {
    const { targetInfo } = await this.conn.send("Target.getTargetInfo", { targetId: this.targetId });
    return {
      id: this.id,
      providerTabId: this.targetId,
      browserId: this.browserId,
      title: targetInfo?.title ?? "",
      url: targetInfo?.url ?? "",
    };
  }

  async waitForDomSettled(maxWaitMs = 1500) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
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
    return u.startsWith("chrome://") || u.startsWith("brave://") || u.startsWith("edge://") || u.startsWith("devtools://");
  }

  /**
   * Capture indexed AX/DOM state with Codex-compatible diffing.
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

    await this.waitForDomSettled(1200);
    const evalRes = await this.send("Runtime.evaluate", {
      expression: BUILD_AX_SNAPSHOT_EXPR(options.maxElements ?? 600),
      returnByValue: true,
      awaitPromise: false,
    });

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
    };

    const header = `Tab #${this.id} "${snap.title}" url="${snap.url}" viewport=${snap.viewport.width}x${snap.viewport.height} scroll=(${snap.scroll.x},${snap.scroll.y})`;
    const fullTree = [header, ...(snap.lines ?? [])].join("\n");
    const formatted = this.diffTracker.format(diffKey, fullTree, options);

    return {
      stateText: formatted.text,
      fullTree,
      isDiff: formatted.isDiff,
      unchanged: formatted.unchanged,
      elementCount: snap.elementCount,
      ...(this.isCursorCurrentlyVisible()
        ? {
            cursor: {
              x: this.cursorState.x,
              y: this.cursorState.y,
              badge: this.cursorState.badge,
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
   * Hides the virtual cursor overlay by default so OCR stays unoccluded unless includeCursor: true is passed.
   */
  async getScreenshot({ markOnly = true, format = "jpeg", quality = 82, includeCursor = false } = {}) {
    if (markOnly) {
      this.diffTracker.markScreenshotOnly(`tab:${this.id}`);
    }
    const fmt = format === "png" ? "png" : "jpeg";
    let didHideOverlay = false;
    let didPrepCursor = false;
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
    const res = await this.send("Runtime.evaluate", {
      expression: String(expression),
      returnByValue: true,
      awaitPromise: true,
    });
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
    this.cursorState.visible = false;
    await this.send("Page.navigate", { url: normalized }, 20000);
    await sleep(120);
    await this.waitForDomSettled(4000);
  }

  async back() {
    const hist = await this.send("Page.getNavigationHistory");
    if (hist.currentIndex > 0) {
      const entry = hist.entries[hist.currentIndex - 1];
      this.cursorState.visible = false;
      await this.send("Page.navigateToHistoryEntry", { entryId: entry.id });
      await sleep(100);
      await this.waitForDomSettled(3000);
    }
  }

  async forward() {
    const hist = await this.send("Page.getNavigationHistory");
    if (hist.currentIndex < hist.entries.length - 1) {
      const entry = hist.entries[hist.currentIndex + 1];
      this.cursorState.visible = false;
      await this.send("Page.navigateToHistoryEntry", { entryId: entry.id });
      await sleep(100);
      await this.waitForDomSettled(3000);
    }
  }

  async reload() {
    this.cursorState.visible = false;
    await this.send("Page.reload", {});
    await sleep(100);
    await this.waitForDomSettled(3000);
  }

  async close() {
    this.cursorState.visible = false;
    this.stopCompositorAwake({ sendStop: false });
    await this.conn.send("Target.closeTarget", { targetId: this.targetId }).catch(() => {});
    this.conn.targetSessions.delete(this.targetId);
    this.diffTracker.reset(`tab:${this.id}`);
    this.onClosed?.(this.id);
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
    const explicitBadge =
      options.showBadge !== undefined
        ? Boolean(options.showBadge)
        : options.badge != null && String(options.badge).trim() !== "";
    const badge = options.badge ?? options.defaultBadge ?? (options.dispatchMoveEvent === false ? "Move" : "Hover");
    if (options.dispatchMoveEvent !== false) {
      await this.ensureCompositorAwake();
      await this.glideCursorTo(
        {
          x,
          y,
          rect: finalRect,
          badge,
          showBadge: explicitBadge,
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
          badge,
          showBadge: explicitBadge,
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
          badge,
          showBadge: explicitBadge,
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

    await this.ensureCompositorAwake();

    // Glide toward target (~80% CloseEnough threshold) before spawning click ripple + mousePressed
    await this.glideCursorTo(
      {
        x,
        y,
        rect,
        button,
        badge,
        showBadge: explicitBadge,
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
          badge,
          showBadge: explicitBadge,
        },
        { showCursor: options.showCursor },
      );

      for (let i = 1; i <= clickCount; i++) {
        await this.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x,
          y,
          button,
          buttons: buttonsMask,
          clickCount: i,
          modifiers,
        });
        if (durationMs > 0) {
          await sleep(Math.min(10000, durationMs));
        } else {
          await sleep(15);
        }
        await this.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x,
          y,
          button,
          buttons: 0,
          clickCount: i,
          modifiers,
        });
      }
    } finally {
      if (chordSpec) {
        await this.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: chordSpec.key,
          code: chordSpec.code,
          windowsVirtualKeyCode: chordSpec.windowsVirtualKeyCode,
          modifiers: 0,
        }).catch(() => {});
      }
    }

    // Brief settle in case click triggered navigation or UI update
    await sleep(60);
    if (isElementTarget && typeof targetSpec === "number") {
      await this.waitForDomSettled(800);
    }

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
        badge,
        showBadge: explicitBadge,
      },
      { showCursor: options.showCursor },
    );
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

  async uploadFiles(target, filePaths) {
    const files = (Array.isArray(filePaths) ? filePaths : [filePaths]).map((f) => path.resolve(String(f)));
    for (const f of files) {
      if (!fs.existsSync(f)) {
        throw new Error(`Upload file does not exist: ${f}`);
      }
    }
    // Resolve Runtime.RemoteObjectId for target element, then call DOM.setFileInputFiles
    const expr =
      typeof target === "number"
        ? `window.__agCuaMap?.get(${target})`
        : `document.querySelector(${JSON.stringify(String(target))})`;
    const evalRes = await this.send("Runtime.evaluate", { expression: expr });
    const objectId = evalRes?.result?.objectId;
    if (!objectId) {
      throw new Error(`File input target ${JSON.stringify(target)} not found`);
    }
    await this.send("DOM.setFileInputFiles", {
      objectId,
      files,
    });
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
      async type(text, opts) {
        const prep = await self.evaluate(buildPrepareElementExpr(selector, { focus: true }));
        if (!prep?.ok) throw new Error(prep?.error || `No element for selector ${selector}`);
        await self.showVirtualCursor({ x: prep.x, y: prep.y, rect: prep.rect, badge: "Type" }, opts);
        return self.typeText(null, text, opts);
      },
      async press(key, opts) {
        const prep = await self.evaluate(buildPrepareElementExpr(selector, { focus: true }));
        if (!prep?.ok) throw new Error(prep?.error || `No element for selector ${selector}`);
        await self.showVirtualCursor({ x: prep.x, y: prep.y, rect: prep.rect, badge: `Key: ${key}` }, opts);
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
          idleTimeoutMs: cfg.idleTimeoutMs,
          instant: cfg.glideEnabled === false ? true : Boolean(spec.instant),
        }),
      );
      if (res?.ok) {
        this.cursorState = {
          visible: true,
          x: res.x,
          y: res.y,
          badge: res.badge ?? null,
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
        badge: domState.badge,
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
      u.startsWith("edge://")
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
    };
    const header = `Tab #${this.id} "${snap.title}" url="${snap.url}" viewport=${snap.viewport.width}x${snap.viewport.height} scroll=(${snap.scroll.x},${snap.scroll.y})`;
    const fullTree = [header, ...(snap.lines ?? [])].join("\n");
    const formatted = this.diffTracker.format(diffKey, fullTree, options);

    return {
      stateText: formatted.text,
      fullTree,
      isDiff: formatted.isDiff,
      unchanged: formatted.unchanged,
      elementCount: snap.elementCount,
      ...(this.isCursorCurrentlyVisible()
        ? {
            cursor: {
              x: this.cursorState.x,
              y: this.cursorState.y,
              badge: this.cursorState.badge,
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
   *   jxaRunner?: (script: string, opSpec?: any) => Promise<string>
   * }} opts
   */
  constructor({ diffTracker, macBridge = null, jxaRunner = null }) {
    this.diffTracker = diffTracker;
    this.macBridge = macBridge;
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
   * Query open tabs in running macOS Safari / non-CDP Chrome / Brave / Edge without waking closed apps.
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
        { id: "edge-app", appName: "Microsoft Edge", kind: "chromium" }
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
      String(b.name || "").toLowerCase().includes(f) ||
      (f === "chrome" && b.family === "chromium")
    );
  }

  controllerMatchesBrowserFilter(ctrl, browserFilter) {
    if (!browserFilter) return true;
    const f = String(browserFilter).toLowerCase();
    const bid = String(ctrl.browserId || "").toLowerCase();
    if (bid === f || bid.includes(f)) return true;
    if (ctrl.appName && String(ctrl.appName).toLowerCase().includes(f)) return true;
    const isChromium = ctrl instanceof CDPTabController || ctrl.kind === "chromium";
    if (isChromium && (f === "chrome" || f === "chromium" || f === "cdp")) return true;
    return false;
  }

  /**
   * Fast (~8ms) CDP-only tab refresh with zero macOS AppleEvent / osascript invocations.
   */
  async refreshCDPTabsOnly() {
    const cdpEndpoints = await this.discoverCDPEndpoints();
    return cdpEndpoints.map((ep) => {
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
  }

  /**
   * List all available browsers + their currently open tabs.
   */
  async listBrowsersWithTabs({ forceRefresh = false } = {}) {
    const [cdpEndpoints, aeBrowsers] = await Promise.all([
      this.discoverCDPEndpoints(),
      this.listMacOSAppleEventTabs({ forceRefresh }),
    ]);

    const result = [];

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

    // Include installed/running macOS browsers not already covered or Safari
    const seenFallbackIds = new Set();
    for (const kb of KNOWN_MAC_BROWSERS) {
      const ae = aeBrowsers.find((a) => a.name === kb.name);
      if (!ae && !fs.existsSync(kb.appPath) && kb.key !== "safari") continue;
      // Avoid duplicating open tabs if this Chromium instance IS the active CDP browser (check overlapping non-blank URLs)
      const cdpUrls = new Set(
        cdpEndpoints.flatMap((e) => e.pages.map((p) => p.url)).filter((u) => u && u !== "about:blank"),
      );
      const aeTabs = (ae?.tabs ?? []).filter((t) => !cdpUrls.has(t.url));
      for (const t of aeTabs) {
        seenFallbackIds.add(t.id);
        this.getOrRegisterFallbackTabController(t, kb);
      }
      if (kb.key === "safari" || aeTabs.length > 0) {
        result.push({
          id: kb.key,
          name: kb.name,
          family: kb.family,
          type: "macos_app",
          bundleId: kb.bundleId,
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
   * Open a new controllable browser tab (in background by default unless visible: true activates it).
   */
  async createTab(browserId = "default", url = "about:blank", options = {}) {
    let targetUrl = url && String(url).trim() ? String(url).trim() : "about:blank";
    if (targetUrl !== "about:blank" && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(targetUrl)) {
      targetUrl = `https://${targetUrl}`;
    }

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

  /**
   * Bind an existing controllable tab by tabId ("tab-1", "safari:w1:t1"), providerTabId, `{ url }`, or `{ mention }`.
   * Resolves known IDs in 0ms and active CDP tabs in ~8ms without invoking osascript JXA unless fallback is needed.
   */
  async getTab(reference, options = {}) {
    const isStringRef = typeof reference === "string";
    const isObjectRef =
      reference != null &&
      typeof reference === "object" &&
      (typeof reference.url === "string" || typeof reference.mention === "string");
    if (!isStringRef && !isObjectRef) {
      throw new TypeError("getTab reference must be a tabId string, { url }, or { mention }");
    }

    const browserFilter = options.browser ? String(options.browser).toLowerCase() : null;
    const forceRefresh = Boolean(options.forceRefresh);

    // 1. O(1) in-memory fast path for known tabId or CDP targetId (0ms, zero HTTP/JXA)
    if (isStringRef && !forceRefresh) {
      const ref = reference.trim();
      const direct = this.resolveControllerById(ref);
      if (direct && this.controllerMatchesBrowserFilter(direct, browserFilter)) {
        return direct;
      }
      const mappedTabId = this.targetToTabId.get(ref);
      if (mappedTabId) {
        const byTarget = this.resolveControllerById(mappedTabId);
        if (byTarget && this.controllerMatchesBrowserFilter(byTarget, browserFilter)) {
          return byTarget;
        }
      }
      // 2. If not an AppleEvents ":wN:tM" ID, check live CDP endpoints (~8ms, zero osascript)
      if (!ref.includes(":w") && browserFilter !== "safari") {
        const cdpBrowsers = await this.refreshCDPTabsOnly();
        const candidateCdp = cdpBrowsers
          .filter((b) => this.matchesBrowserFilter(b, browserFilter))
          .flatMap((b) => b.tabs);
        const foundCdp = candidateCdp.find((t) => t.id === ref || t.providerTabId === ref);
        if (foundCdp) {
          const resolved = this.resolveControllerById(foundCdp.id);
          if (resolved) return resolved;
        }
      }
    }

    // 3. Fast CDP-first resolution for { url } or { mention } (~8ms, zero osascript when CDP matches)
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
          if (resolved) return resolved;
        }
      } else if (typeof reference.mention === "string") {
        const m = reference.mention;
        for (const ctrl of [...this.tabs.values(), ...this.fallbackTabs.values()]) {
          if (!this.controllerMatchesBrowserFilter(ctrl, browserFilter)) continue;
          if ((ctrl.targetId && m.includes(ctrl.targetId)) || m.includes(ctrl.id)) {
            return ctrl;
          }
        }
        const cdpBrowsers = await this.refreshCDPTabsOnly();
        const fastCdpTabs = cdpBrowsers
          .filter((b) => this.matchesBrowserFilter(b, browserFilter))
          .flatMap((b) => b.tabs);
        const found = fastCdpTabs.find((t) => (t.providerTabId && m.includes(t.providerTabId)) || m.includes(t.id));
        if (found) {
          const resolved = this.resolveControllerById(found.id);
          if (resolved) return resolved;
        }
      }
    }

    // 4. Full inventory fallback (CDP + macOS AppleEvent tabs)
    const browsers = await this.listBrowsersWithTabs({ forceRefresh });
    const candidateBrowsers = browserFilter
      ? browsers.filter((b) => this.matchesBrowserFilter(b, browserFilter))
      : browsers;

    // Order CDP tabs ahead of AppleEvents fallback tabs when resolving URLs
    const cdpTabs = candidateBrowsers.flatMap((b) => b.tabs).filter((t) => t.controllableViaCDP);
    const fallbackTabs = candidateBrowsers.flatMap((b) => b.tabs).filter((t) => !t.controllableViaCDP);
    const allTabs = [...cdpTabs, ...fallbackTabs];

    if (isStringRef) {
      const ref = reference.trim();
      const direct = this.resolveControllerById(ref);
      if (direct && this.controllerMatchesBrowserFilter(direct, browserFilter)) return direct;
      const byProvider = allTabs.find((t) => t.providerTabId === ref || t.id === ref);
      if (byProvider) {
        const resolved = this.resolveControllerById(byProvider.id);
        if (resolved) return resolved;
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
      return this.resolveControllerById((exact[0] ?? matches[0]).id);
    }

    const m = reference.mention;
    const found = allTabs.find((t) => (t.providerTabId && m.includes(t.providerTabId)) || m.includes(t.id));
    if (found) return this.resolveControllerById(found.id);
    throw new Error(`Could not resolve tab mention "${m}"`);
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
    const states = await Promise.all(
      [...Array.from(this.tabs.values()), ...activeFallbackTabs].map((t) =>
        t.getCursorState().catch(() => ({ tabId: t.id, visible: false })),
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
    await Promise.all(
      [...Array.from(this.tabs.values()), ...activeFallbackTabs].map((t) => t.hideCursor().catch(() => null)),
    );
    return { ok: true };
  }

  closeAll() {
    for (const t of this.tabs.values()) {
      t.stopCompositorAwake?.({ sendStop: false });
    }
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
