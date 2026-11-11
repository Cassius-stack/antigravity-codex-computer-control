import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const HELPER_BIN = path.join(PROJECT_ROOT, "bin", "mac-cua-helper");
const HELPER_SRC = path.join(PROJECT_ROOT, "native", "MacCUAHelper.swift");

export class MacBridge {
  /**
   * @param {{ diffTracker: import("./diff.mjs").AXDiffTracker }} opts
   */
  constructor({ diffTracker }) {
    this.diffTracker = diffTracker;
    /** @type {import("node:child_process").ChildProcessWithoutNullStreams | null} */
    this.proc = null;
    this.nextId = 1;
    /** @type {Map<number, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
    this.pending = new Map();
    /** @type {Promise<void>} */
    this.pasteMutex = Promise.resolve();
  }

  ensureBinary() {
    let needsBuild = !fs.existsSync(HELPER_BIN);
    if (!needsBuild && fs.existsSync(HELPER_SRC)) {
      try {
        const srcMtime = fs.statSync(HELPER_SRC).mtimeMs;
        const binMtime = fs.statSync(HELPER_BIN).mtimeMs;
        if (srcMtime > binMtime + 1000) {
          const check = spawnSync("swiftc", ["--version"], { encoding: "utf8", timeout: 5000 });
          if (check.status === 0) {
            needsBuild = true;
          }
        }
      } catch {}
    }

    if (needsBuild) {
      fs.mkdirSync(path.dirname(HELPER_BIN), { recursive: true });
      const res = spawnSync(
        "swiftc",
        ["-O", "-swift-version", "5", "-parse-as-library", HELPER_SRC, "-o", HELPER_BIN],
        { encoding: "utf8", timeout: 90000 },
      );
      if (res.status !== 0 && !fs.existsSync(HELPER_BIN)) {
        throw new Error(
          `Failed to compile MacCUAHelper.swift: ${res.stderr || res.error?.message || "swiftc failed (install Xcode Command Line Tools via: xcode-select --install)"}`,
        );
      }
    }

    try {
      fs.chmodSync(HELPER_BIN, 0o755);
      spawnSync("xattr", ["-d", "com.apple.quarantine", HELPER_BIN], { timeout: 3000 });
    } catch {}
  }

  ensureProcess() {
    if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
      return this.proc;
    }
    this.ensureBinary();
    const child = spawn(HELPER_BIN, [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = child;

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      const id = msg.id;
      if (id == null) return;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      if (msg.ok) {
        entry.resolve(msg.result);
      } else {
        entry.reject(new Error(msg.error || "MacCUAHelper request failed"));
      }
    });

    const onExit = (errOrCode) => {
      if (this.proc === child) {
        this.proc = null;
      }
      const err =
        errOrCode instanceof Error
          ? errOrCode
          : new Error(`MacCUAHelper exited unexpectedly (code=${errOrCode})`);
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
    };

    child.on("error", onExit);
    child.on("exit", onExit);
    return child;
  }

  /**
   * @param {string} method
   * @param {Record<string, any>} [params]
   * @param {number} [timeoutMs]
   */
  request(method, params = {}, timeoutMs = 15000) {
    const child = this.ensureProcess();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MacCUAHelper '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  async checkPermissions() {
    return this.request("check_permissions", {});
  }

  async requestPermissions(opts = {}) {
    return this.request("request_permissions", opts);
  }

  async getDisplays() {
    const res = await this.request("get_displays", {});
    return res.displays ?? [];
  }

  async listApps({ runningOnly = false } = {}) {
    const res = await this.request("list_apps", { runningOnly });
    return res.apps ?? [];
  }

  async launchApp({ app, activate = false, timeoutMs = 8000 }) {
    if (typeof app !== "string" || !app.trim()) {
      throw new TypeError("launch_app requires a non-empty 'app' name, bundleId, or path");
    }
    return this.request("launch_app", { app: app.trim(), activate: Boolean(activate), timeoutMs }, timeoutMs + 3000);
  }

  async listWindows({ app, includeMinimized = true } = {}) {
    const res = await this.request("list_windows", {
      ...(app ? { app } : {}),
      includeMinimized: Boolean(includeMinimized),
    });
    return res.windows ?? [];
  }

  /**
   * Manage multiple windows in one shot: supports explicit per-window operations
   * AND automatic multi-window layout presets (`tile_left_right`, `tile_grid`, `quadrants`,
   * `cascade`, `maximize`, `center`, `left_half`, `right_half`, `top_half`, `bottom_half`).
   */
  async manageWindows({
    operations = [],
    layout,
    targets = [],
    displayIndex = 0,
    gap = 8,
    activate = false,
  } = {}) {
    const ops = Array.isArray(operations) ? [...operations] : [];

    if (layout) {
      const displays = await this.getDisplays();
      const display = displays[displayIndex] ?? displays[0];
      if (!display) {
        throw new Error("No active display found for window layout");
      }
      const vf = display.visibleFrame;

      // Resolve target windows if specified, or error clearly if empty
      let resolvedTargets = [];
      if (Array.isArray(targets) && targets.length > 0) {
        const allWins = await this.listWindows({ includeMinimized: true });
        for (const t of targets) {
          if (typeof t === "number") {
            const found = allWins.find((w) => w.id === t);
            if (found) resolvedTargets.push({ windowId: found.id });
            else resolvedTargets.push({ windowId: t });
          } else if (typeof t === "string") {
            resolvedTargets.push({ app: t });
          } else if (t && typeof t === "object") {
            resolvedTargets.push({
              ...(t.windowId != null ? { windowId: Number(t.windowId) } : {}),
              ...(t.app ? { app: String(t.app) } : {}),
              ...(t.windowTitle ? { windowTitle: String(t.windowTitle) } : {}),
            });
          }
        }
      }

      if (resolvedTargets.length === 0) {
        throw new TypeError(`Layout '${layout}' requires at least one target in 'targets' (window IDs or app names)`);
      }

      const g = Math.max(0, Number(gap) || 0);
      const boxes = computeLayoutBoxes(layout, resolvedTargets.length, vf, g);

      for (let i = 0; i < resolvedTargets.length; i++) {
        const b = boxes[i];
        ops.push({
          ...resolvedTargets[i],
          action: "set_bounds",
          x: b.x,
          y: b.y,
          width: b.width,
          height: b.height,
        });
        if (activate) {
          ops.push({
            ...resolvedTargets[i],
            action: "raise",
          });
        }
      }
    }

    if (ops.length === 0) {
      throw new TypeError("manage_windows requires a non-empty 'operations' array or a 'layout' with 'targets'");
    }

    const res = await this.request("manage_windows", { operations: ops });
    return res.results ?? [];
  }

  /**
   * Capture indexed AX accessibility tree (+ optional screenshot) for an app or window.
   */
  async getWindowState({
    windowId,
    app,
    windowTitle,
    autoLaunch = true,
    includeScreenshot = false,
    includeCursor = false,
    disableDiff = false,
    maxDepth = 28,
    maxElements = 600,
  } = {}) {
    const raw = await this.request(
      "get_window_state",
      {
        ...(windowId != null ? { windowId: Number(windowId) } : {}),
        ...(app ? { app: String(app) } : {}),
        ...(windowTitle ? { windowTitle: String(windowTitle) } : {}),
        autoLaunch: Boolean(autoLaunch),
        includeScreenshot: Boolean(includeScreenshot),
        includeCursor: Boolean(includeCursor),
        maxDepth,
        maxElements,
      },
      20000,
    );

    const diffKey = `mac:win:${raw.windowId}`;
    const formatted = this.diffTracker.format(diffKey, raw.tree, {
      disableDiffing: Boolean(disableDiff),
    });

    return {
      ...raw,
      fullTree: raw.tree,
      stateText: formatted.text,
      isDiff: formatted.isDiff,
      unchanged: formatted.unchanged,
    };
  }

  /**
   * Capture screenshot only for a window (marks AX diff tracker per Codex rule).
   */
  async getWindowScreenshot({ windowId, app, windowTitle, includeCursor = false, maxDepth = 28, maxElements = 600 } = {}) {
    const raw = await this.request(
      "get_window_state",
      {
        ...(windowId != null ? { windowId: Number(windowId) } : {}),
        ...(app ? { app: String(app) } : {}),
        ...(windowTitle ? { windowTitle: String(windowTitle) } : {}),
        autoLaunch: false,
        includeScreenshot: true,
        screenshotOnly: true,
        includeCursor: Boolean(includeCursor),
        maxDepth,
        maxElements,
        preserveElementCache: true,
      },
      20000,
    );
    this.diffTracker.markScreenshotOnly(`mac:win:${raw.windowId}`);
    if (!raw.screenshot) {
      throw new Error(`Failed to capture screenshot for window ${raw.windowId}`);
    }
    return {
      windowId: raw.windowId,
      window: raw.window,
      screenshot: raw.screenshot,
      ...(raw.cursor ? { cursor: raw.cursor } : {}),
    };
  }

  /**
   * Perform an input/AX action on a macOS app or specific window.
   */
  async performAction(params) {
    if (!params || typeof params !== "object") {
      throw new TypeError("performAction requires an options object");
    }
    const action = String(params.action ?? "").toLowerCase();
    if (!action) {
      throw new TypeError("performAction requires 'action'");
    }

    const execute = () => this.request("perform_action", params, 20000);

    if (action === "paste") {
      // Serialize clipboard operations so parallel batch pastes never clobber NSPasteboard
      const run = this.pasteMutex.then(execute, execute);
      this.pasteMutex = run.then(
        () => {},
        () => {},
      );
      return run;
    }

    return execute();
  }

  /**
   * Inspect, move, highlight, hide, clear, or configure per-window macOS virtual cursors.
   */
  async cursorControl(params = {}) {
    if (!params || typeof params !== "object") {
      throw new TypeError("cursorControl requires an options object");
    }
    return this.request("cursor_control", params, 15000);
  }

  close() {
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
  }
}

function computeLayoutBoxes(layout, count, vf, gap) {
  const x0 = vf.x + gap;
  const y0 = vf.y + gap;
  const availW = Math.max(200, vf.width - gap * 2);
  const availH = Math.max(150, vf.height - gap * 2);
  const mode = String(layout).toLowerCase();

  if (mode === "maximize" || mode === "fullscreen_visible") {
    return Array.from({ length: count }, () => ({ x: x0, y: y0, width: availW, height: availH }));
  }
  if (mode === "center") {
    const w = Math.round(availW * 0.72);
    const h = Math.round(availH * 0.78);
    const cx = Math.round(x0 + (availW - w) / 2);
    const cy = Math.round(y0 + (availH - h) / 2);
    return Array.from({ length: count }, () => ({ x: cx, y: cy, width: w, height: h }));
  }
  if (mode === "left_half") {
    const w = Math.floor((availW - gap) / 2);
    return Array.from({ length: count }, () => ({ x: x0, y: y0, width: w, height: availH }));
  }
  if (mode === "right_half") {
    const w = Math.floor((availW - gap) / 2);
    return Array.from({ length: count }, () => ({ x: x0 + w + gap, y: y0, width: w, height: availH }));
  }
  if (mode === "top_half") {
    const h = Math.floor((availH - gap) / 2);
    return Array.from({ length: count }, () => ({ x: x0, y: y0, width: availW, height: h }));
  }
  if (mode === "bottom_half") {
    const h = Math.floor((availH - gap) / 2);
    return Array.from({ length: count }, () => ({ x: x0, y: y0 + h + gap, width: availW, height: h }));
  }
  if (mode === "tile_left_right" || mode === "columns") {
    const cols = Math.max(1, count);
    const colW = Math.floor((availW - gap * (cols - 1)) / cols);
    return Array.from({ length: count }, (_, i) => ({
      x: x0 + i * (colW + gap),
      y: y0,
      width: colW,
      height: availH,
    }));
  }
  if (mode === "quadrants") {
    const halfW = Math.floor((availW - gap) / 2);
    const halfH = Math.floor((availH - gap) / 2);
    const slots = [
      { x: x0, y: y0, width: halfW, height: halfH },
      { x: x0 + halfW + gap, y: y0, width: halfW, height: halfH },
      { x: x0, y: y0 + halfH + gap, width: halfW, height: halfH },
      { x: x0 + halfW + gap, y: y0 + halfH + gap, width: halfW, height: halfH },
    ];
    return Array.from({ length: count }, (_, i) => slots[i % 4]);
  }
  if (mode === "cascade") {
    const step = 34;
    const w = Math.max(360, Math.round(availW * 0.65));
    const h = Math.max(280, Math.round(availH * 0.70));
    return Array.from({ length: count }, (_, i) => ({
      x: Math.min(x0 + i * step, x0 + availW - w),
      y: Math.min(y0 + i * step, y0 + availH - h),
      width: w,
      height: h,
    }));
  }
  if (mode === "tile_grid" || mode === "grid") {
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    const cellW = Math.floor((availW - gap * (cols - 1)) / cols);
    const cellH = Math.floor((availH - gap * (rows - 1)) / rows);
    return Array.from({ length: count }, (_, i) => {
      const r = Math.floor(i / cols);
      const c = i % cols;
      return {
        x: x0 + c * (cellW + gap),
        y: y0 + r * (cellH + gap),
        width: cellW,
        height: cellH,
      };
    });
  }

  throw new TypeError(
    `Unknown window layout '${layout}'. Supported: tile_left_right, tile_grid, quadrants, cascade, maximize, center, left_half, right_half, top_half, bottom_half`,
  );
}
