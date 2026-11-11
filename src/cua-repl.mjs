import fs from "node:fs/promises";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

/**
 * Extract top-level declared variable/function/class identifiers so they persist
 * onto globalThis across async REPL turns without breaking destructuring or re-declarations.
 * @param {string} code
 * @returns {string[]}
 */
export function extractTopLevelBindings(code) {
  const names = new Set();
  const len = code.length;
  let i = 0;
  let brace = 0;
  let paren = 0;
  let bracket = 0;

  const isIdentStart = (c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$";
  const isIdentChar = (c) => isIdentStart(c) || (c >= "0" && c <= "9");

  function skipWsAndComments() {
    while (i < len) {
      const ch = code[i];
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
        i++;
      } else if (ch === "/" && code[i + 1] === "/") {
        i += 2;
        while (i < len && code[i] !== "\n") i++;
      } else if (ch === "/" && code[i + 1] === "*") {
        i += 2;
        while (i < len && !(code[i] === "*" && code[i + 1] === "/")) i++;
        i += 2;
      } else {
        break;
      }
    }
  }

  function skipString(quote) {
    i++; // opening quote
    while (i < len) {
      if (code[i] === "\\") {
        i += 2;
        continue;
      }
      if (quote === "`" && code[i] === "$" && code[i + 1] === "{") {
        i += 2;
        let tplDepth = 1;
        while (i < len && tplDepth > 0) {
          if (code[i] === "'" || code[i] === '"' || code[i] === "`") {
            skipString(code[i]);
            continue;
          }
          if (code[i] === "{") tplDepth++;
          else if (code[i] === "}") tplDepth--;
          i++;
        }
        continue;
      }
      if (code[i] === quote) {
        i++;
        break;
      }
      i++;
    }
  }

  function readIdent() {
    const start = i;
    while (i < len && isIdentChar(code[i])) i++;
    return code.slice(start, i);
  }

  function skipBalanced(openChar, closeChar) {
    let d = 0;
    while (i < len) {
      const c = code[i];
      if (c === "'" || c === '"' || c === "`") {
        skipString(c);
        continue;
      }
      if (c === "/" && (code[i + 1] === "/" || code[i + 1] === "*")) {
        skipWsAndComments();
        continue;
      }
      if (c === openChar) d++;
      else if (c === closeChar) {
        d--;
        if (d === 0) {
          i++;
          return;
        }
      }
      i++;
    }
  }

  function parseBindingPattern() {
    skipWsAndComments();
    if (i >= len) return;
    if (code[i] === "." && code[i + 1] === "." && code[i + 2] === ".") {
      i += 3;
      skipWsAndComments();
    }
    if (isIdentStart(code[i])) {
      const id = readIdent();
      if (id) names.add(id);
    } else if (code[i] === "[") {
      i++; // '['
      while (i < len && code[i] !== "]") {
        skipWsAndComments();
        if (code[i] === ",") {
          i++;
          continue;
        }
        if (code[i] === "]") break;
        parseBindingPattern();
        skipWsAndComments();
        if (code[i] === "=") {
          i++;
          skipInitializerExpr([",", "]"]);
        }
        if (code[i] === ",") i++;
      }
      if (code[i] === "]") i++;
    } else if (code[i] === "{") {
      i++; // '{'
      while (i < len && code[i] !== "}") {
        skipWsAndComments();
        if (code[i] === "}") break;
        if (code[i] === "." && code[i + 1] === "." && code[i + 2] === ".") {
          i += 3;
          parseBindingPattern();
          skipWsAndComments();
          if (code[i] === ",") i++;
          continue;
        }
        if (code[i] === "[") {
          skipBalanced("[", "]");
          skipWsAndComments();
          if (code[i] === ":") {
            i++;
            parseBindingPattern();
          }
        } else if (isIdentStart(code[i])) {
          const keyOrVar = readIdent();
          skipWsAndComments();
          if (code[i] === ":") {
            i++;
            parseBindingPattern();
          } else {
            names.add(keyOrVar);
          }
        } else {
          i++;
        }
        skipWsAndComments();
        if (code[i] === "=") {
          i++;
          skipInitializerExpr([",", "}"]);
        }
        if (code[i] === ",") i++;
      }
      if (code[i] === "}") i++;
    }
  }

  function skipInitializerExpr(stopChars) {
    let dBrace = 0;
    let dParen = 0;
    let dBracket = 0;
    while (i < len) {
      const c = code[i];
      if (dBrace === 0 && dParen === 0 && dBracket === 0 && stopChars.includes(c)) {
        return;
      }
      if (c === "'" || c === '"' || c === "`") {
        skipString(c);
        continue;
      }
      if (c === "/" && (code[i + 1] === "/" || code[i + 1] === "*")) {
        skipWsAndComments();
        continue;
      }
      if (c === "{") dBrace++;
      else if (c === "}") dBrace = Math.max(0, dBrace - 1);
      else if (c === "(") dParen++;
      else if (c === ")") dParen = Math.max(0, dParen - 1);
      else if (c === "[") dBracket++;
      else if (c === "]") dBracket = Math.max(0, dBracket - 1);
      i++;
    }
  }

  function parseVariableDeclarationList() {
    while (i < len) {
      parseBindingPattern();
      skipWsAndComments();
      if (code[i] === "=") {
        i++;
        skipInitializerExpr([",", ";", "\n"]);
      }
      skipWsAndComments();
      if (code[i] === ",") {
        i++;
        continue;
      }
      break;
    }
  }

  while (i < len) {
    skipWsAndComments();
    if (i >= len) break;
    const ch = code[i];

    if (ch === "'" || ch === '"' || ch === "`") {
      skipString(ch);
      continue;
    }
    if (ch === "{") {
      brace++;
      i++;
      continue;
    }
    if (ch === "}") {
      brace = Math.max(0, brace - 1);
      i++;
      continue;
    }
    if (ch === "(") {
      paren++;
      i++;
      continue;
    }
    if (ch === ")") {
      paren = Math.max(0, paren - 1);
      i++;
      continue;
    }
    if (ch === "[") {
      bracket++;
      i++;
      continue;
    }
    if (ch === "]") {
      bracket = Math.max(0, bracket - 1);
      i++;
      continue;
    }

    if (brace === 0 && paren === 0 && bracket === 0 && isIdentStart(ch)) {
      const prevChar = i > 0 ? code[i - 1] : "";
      const word = readIdent();
      if (prevChar !== "." && (word === "let" || word === "const" || word === "var")) {
        // Ensure it's not `for (let ...)` — paren === 0 already guarantees we're outside `for (...)`!
        parseVariableDeclarationList();
        continue;
      }
      if (prevChar !== "." && word === "async") {
        const saved = i;
        skipWsAndComments();
        if (isIdentStart(code[i])) {
          const nextWord = readIdent();
          if (nextWord === "function") {
            skipWsAndComments();
            if (code[i] === "*") i++;
            skipWsAndComments();
            if (isIdentStart(code[i])) {
              names.add(readIdent());
            }
            continue;
          }
        }
        i = saved;
        continue;
      }
      if (prevChar !== "." && (word === "function" || word === "class")) {
        skipWsAndComments();
        if (word === "function" && code[i] === "*") {
          i++;
          skipWsAndComments();
        }
        if (isIdentStart(code[i])) {
          names.add(readIdent());
        }
        continue;
      }
      continue;
    }

    i++;
  }

  return Array.from(names);
}

/**
 * Persistent VM REPL implementing Codex's `cua`, `sky`, `agent`, and `nodeRepl` JavaScript APIs.
 */
export class CUAReplRuntime {
  /**
   * @param {{
   *   macBridge: import("./mac-bridge.mjs").MacBridge,
   *   browserManager: import("./cdp-client.mjs").BrowserManager,
   *   diffTracker: import("./diff.mjs").AXDiffTracker
   * }} deps
   */
  constructor({ macBridge, browserManager, diffTracker }) {
    this.macBridge = macBridge;
    this.browserManager = browserManager;
    this.diffTracker = diffTracker;
    this.activeCollector = null;
    this.context = null;
    this.initContext();
  }

  reset() {
    this.diffTracker.reset();
    this.initContext();
  }

  emitText(text) {
    if (this.activeCollector && text != null && String(text).length > 0) {
      this.activeCollector.push({ type: "text", text: String(text) });
    }
  }

  async emitImageInput(input) {
    if (!this.activeCollector || !input) return;
    if (input instanceof Uint8Array || Buffer.isBuffer(input)) {
      const b64 = Buffer.from(input).toString("base64");
      this.activeCollector.push({ type: "image", data: b64, mimeType: "image/jpeg" });
      return;
    }
    if (typeof input === "string") {
      if (input.startsWith("data:")) {
        const m = /^data:([^;,]+);base64,(.*)$/s.exec(input);
        if (m) {
          this.activeCollector.push({ type: "image", data: m[2], mimeType: m[1] });
          return;
        }
      }
      if (input.startsWith("file://")) {
        const bytes = await fs.readFile(fileURLToPath(input));
        const ext = input.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
        this.activeCollector.push({ type: "image", data: bytes.toString("base64"), mimeType: ext });
        return;
      }
    }
    if (typeof input === "object" && input.bytes) {
      const b64 = Buffer.from(input.bytes).toString("base64");
      this.activeCollector.push({
        type: "image",
        data: b64,
        mimeType: input.mimeType || "image/jpeg",
      });
    }
  }

  wrapMacAppHandle(initialState) {
    const self = this;
    const windowId = initialState.windowId;
    const appId = initialState.app;

    return {
      windowId,
      app: appId,
      appName: initialState.appName,

      async getAXState(options = {}) {
        const st = await self.macBridge.getWindowState({
          windowId,
          app: appId,
          disableDiff: Boolean(options.disableDiffing),
          includeScreenshot: false,
        });
        if (options.emit !== false) {
          self.emitText(st.stateText);
        }
        return st.stateText;
      },

      async getScreenshot(options = {}) {
        const shotRes = await self.macBridge.getWindowScreenshot({
          windowId,
          app: appId,
          includeCursor: Boolean(options.includeCursor),
        });
        const bytes = new Uint8Array(Buffer.from(shotRes.screenshot.base64, "base64"));
        if (options.emit !== false) {
          self.activeCollector?.push({
            type: "image",
            data: shotRes.screenshot.base64,
            mimeType: shotRes.screenshot.mimeType || "image/jpeg",
          });
        }
        return bytes;
      },

      async getAXStateAndScreenshot(options = {}) {
        const st = await self.macBridge.getWindowState({
          windowId,
          app: appId,
          disableDiff: Boolean(options.disableDiffing),
          includeScreenshot: true,
          includeCursor: Boolean(options.includeCursor),
        });
        if (options.emit !== false) {
          self.emitText(st.stateText);
          if (st.screenshot) {
            self.activeCollector?.push({
              type: "image",
              data: st.screenshot.base64,
              mimeType: st.screenshot.mimeType || "image/jpeg",
            });
          }
        }
        const bytes = st.screenshot
          ? new Uint8Array(Buffer.from(st.screenshot.base64, "base64"))
          : undefined;
        return { state: st.stateText, screenshot: bytes };
      },

      async click(target, options = {}) {
        const params = {
          windowId,
          app: appId,
          action: "click",
          mouseButton: options.mouseButton ?? "left",
          clickCount: options.clickCount ?? 1,
          ...(options.key ? { key: options.key } : {}),
          ...(options.durationMs != null ? { durationMs: options.durationMs } : {}),
          ...(options.activateWindow != null ? { activateWindow: Boolean(options.activateWindow) } : {}),
          ...(options.globalCoordinates != null ? { globalCoordinates: Boolean(options.globalCoordinates) } : {}),
          ...(options.showCursor != null ? { showCursor: Boolean(options.showCursor) } : {}),
          ...(options.badge != null ? { badge: String(options.badge) } : {}),
          ...(options.ripple != null ? { ripple: Boolean(options.ripple) } : {}),
        };
        if (typeof target === "number") {
          params.elementIndex = target;
        } else if (Array.isArray(target) && target.length === 2) {
          params.x = Number(target[0]);
          params.y = Number(target[1]);
        } else {
          throw new TypeError("app.click target must be an elementIndex (number) or [x, y] Vec2");
        }
        await self.macBridge.performAction(params);
      },

      async hover(target, options = {}) {
        const params = {
          windowId,
          app: appId,
          action: "hover",
          ...(options.globalCoordinates != null ? { globalCoordinates: Boolean(options.globalCoordinates) } : {}),
          ...(options.showCursor != null ? { showCursor: Boolean(options.showCursor) } : {}),
          ...(options.dispatchMoveEvent != null ? { dispatchMoveEvent: Boolean(options.dispatchMoveEvent) } : {}),
          ...(options.badge != null ? { badge: String(options.badge) } : {}),
          ...(options.ripple != null ? { ripple: Boolean(options.ripple) } : {}),
        };
        if (typeof target === "number") {
          params.elementIndex = target;
        } else if (Array.isArray(target) && target.length === 2) {
          params.x = Number(target[0]);
          params.y = Number(target[1]);
        } else {
          throw new TypeError("app.hover target must be an elementIndex (number) or [x, y] Vec2");
        }
        return self.macBridge.performAction(params);
      },

      async moveCursor(target, options = {}) {
        const params = {
          windowId,
          action: "move",
          ...(options.globalCoordinates != null ? { globalCoordinates: Boolean(options.globalCoordinates) } : {}),
          ...(options.badge != null ? { badge: String(options.badge) } : {}),
          ...(options.ripple != null ? { ripple: Boolean(options.ripple) } : {}),
          ...(options.width != null ? { width: Number(options.width) } : {}),
          ...(options.height != null ? { height: Number(options.height) } : {}),
        };
        if (typeof target === "number") {
          params.elementIndex = target;
        } else if (Array.isArray(target) && target.length === 2) {
          params.x = Number(target[0]);
          params.y = Number(target[1]);
        } else {
          throw new TypeError("app.moveCursor target must be an elementIndex (number) or [x, y] Vec2");
        }
        return self.macBridge.cursorControl(params);
      },

      async highlight(target, options = {}) {
        const params = {
          windowId,
          action: "highlight",
          ...(options.globalCoordinates != null ? { globalCoordinates: Boolean(options.globalCoordinates) } : {}),
          ...(options.badge != null ? { badge: String(options.badge) } : {}),
          ...(options.ripple != null ? { ripple: Boolean(options.ripple) } : {}),
          ...(options.width != null ? { width: Number(options.width) } : {}),
          ...(options.height != null ? { height: Number(options.height) } : {}),
        };
        if (typeof target === "number") {
          params.elementIndex = target;
        } else if (Array.isArray(target) && target.length === 2) {
          params.x = Number(target[0]);
          params.y = Number(target[1]);
        } else {
          throw new TypeError("app.highlight target must be an elementIndex (number) or [x, y] Vec2");
        }
        return self.macBridge.cursorControl(params);
      },

      async hideCursor() {
        return self.macBridge.cursorControl({ action: "hide", windowId });
      },

      async getCursorState() {
        return self.macBridge.cursorControl({ action: "get_state", windowId });
      },

      async drag(from, to, options = {}) {
        const params = {
          windowId,
          app: appId,
          action: "drag",
          ...(options.globalCoordinates != null ? { globalCoordinates: Boolean(options.globalCoordinates) } : {}),
          ...(options.showCursor != null ? { showCursor: Boolean(options.showCursor) } : {}),
          ...(options.badge != null ? { badge: String(options.badge) } : {}),
        };
        if (typeof from === "number") {
          params.fromElementIndex = from;
        } else if (Array.isArray(from) && from.length === 2) {
          params.fromX = Number(from[0]);
          params.fromY = Number(from[1]);
        } else {
          throw new TypeError("app.drag 'from' must be an elementIndex or [fromX, fromY]");
        }
        if (typeof to === "number") {
          params.toElementIndex = to;
        } else if (Array.isArray(to) && to.length === 2) {
          params.toX = Number(to[0]);
          params.toY = Number(to[1]);
        } else {
          throw new TypeError("app.drag 'to' must be an elementIndex or [toX, toY]");
        }
        await self.macBridge.performAction(params);
      },

      async scroll(target, direction, distance = 1, options = {}) {
        const params = {
          windowId,
          app: appId,
          action: "scroll",
          direction,
          ...(options.globalCoordinates != null ? { globalCoordinates: Boolean(options.globalCoordinates) } : {}),
          ...(options.showCursor != null ? { showCursor: Boolean(options.showCursor) } : {}),
          ...(options.badge != null ? { badge: String(options.badge) } : {}),
        };
        if (typeof distance === "object" && distance?.pixels != null) {
          params.pixels = Number(distance.pixels);
        } else if (typeof distance === "number") {
          params.pages = distance;
        }
        if (typeof target === "number") {
          params.elementIndex = target;
        } else if (Array.isArray(target) && target.length === 2) {
          params.x = Number(target[0]);
          params.y = Number(target[1]);
        }
        await self.macBridge.performAction(params);
      },

      async selectText(elementIndex, text, options = {}) {
        await self.macBridge.performAction({
          windowId,
          app: appId,
          action: "select_text",
          elementIndex: Number(elementIndex),
          text: String(text),
          ...(options.prefix ? { prefix: options.prefix } : {}),
          ...(options.suffix ? { suffix: options.suffix } : {}),
          selectionType: options.selectionType ?? "text",
          ...(options.showCursor != null ? { showCursor: Boolean(options.showCursor) } : {}),
          ...(options.badge != null ? { badge: String(options.badge) } : {}),
        });
      },

      async setValue(elementIndex, value, options = {}) {
        await self.macBridge.performAction({
          windowId,
          app: appId,
          action: "set_value",
          elementIndex: Number(elementIndex),
          value: String(value),
          ...(options.showCursor != null ? { showCursor: Boolean(options.showCursor) } : {}),
          ...(options.badge != null ? { badge: String(options.badge) } : {}),
        });
      },

      async performSecondaryAction(elementIndex, action, options = {}) {
        await self.macBridge.performAction({
          windowId,
          app: appId,
          action: "perform_secondary_action",
          elementIndex: Number(elementIndex),
          secondaryAction: String(action),
          ...(options.showCursor != null ? { showCursor: Boolean(options.showCursor) } : {}),
          ...(options.badge != null ? { badge: String(options.badge) } : {}),
        });
      },

      async paste(text, options = {}) {
        await self.macBridge.performAction({
          windowId,
          app: appId,
          action: "paste",
          text: String(text),
          format: options.format ?? "text",
          ...(options.showCursor != null ? { showCursor: Boolean(options.showCursor) } : {}),
          ...(options.badge != null ? { badge: String(options.badge) } : {}),
        });
      },

      async pressKey(key, options = {}) {
        await self.macBridge.performAction({
          windowId,
          app: appId,
          action: "press_key",
          key: String(key),
          ...(options.durationMs != null ? { durationMs: options.durationMs } : {}),
          ...(options.showCursor != null ? { showCursor: Boolean(options.showCursor) } : {}),
          ...(options.badge != null ? { badge: String(options.badge) } : {}),
        });
      },

      async typeText(text, options = {}) {
        await self.macBridge.performAction({
          windowId,
          app: appId,
          action: "type_text",
          text: String(text),
          ...(options.showCursor != null ? { showCursor: Boolean(options.showCursor) } : {}),
          ...(options.badge != null ? { badge: String(options.badge) } : {}),
        });
      },

      // Window management extensions on App handle
      async setBounds({ x, y, width, height }) {
        await self.macBridge.manageWindows({
          operations: [{ windowId, action: "set_bounds", x, y, width, height }],
        });
      },
      async minimize() {
        await self.macBridge.manageWindows({ operations: [{ windowId, action: "minimize" }] });
      },
      async restore() {
        await self.macBridge.manageWindows({ operations: [{ windowId, action: "restore" }] });
      },
      async activate() {
        await self.macBridge.manageWindows({ operations: [{ windowId, action: "activate" }] });
      },
      async close() {
        await self.macBridge.manageWindows({ operations: [{ windowId, action: "close" }] });
      },
    };
  }

  wrapTabHandle(ctrl) {
    const self = this;
    return {
      get id() {
        return ctrl.id;
      },
      get browserId() {
        return ctrl.browserId;
      },

      async getAXState(options = {}) {
        const res = await ctrl.getAXState({ disableDiffing: Boolean(options.disableDiffing) });
        if (options.emit !== false) {
          self.emitText(res.stateText);
        }
        return res.stateText;
      },

      async getScreenshot(options = {}) {
        const shot = await ctrl.getScreenshot({
          markOnly: true,
          includeCursor: Boolean(options.includeCursor),
        });
        if (options.emit !== false) {
          self.activeCollector?.push({
            type: "image",
            data: shot.base64,
            mimeType: shot.mimeType,
          });
        }
        return shot.bytes;
      },

      async getAXStateAndScreenshot(options = {}) {
        const res = await ctrl.getAXStateAndScreenshot({
          disableDiffing: Boolean(options.disableDiffing),
          includeCursor: Boolean(options.includeCursor),
        });
        if (options.emit !== false) {
          self.emitText(res.stateText);
          self.activeCollector?.push({
            type: "image",
            data: res.screenshot.base64,
            mimeType: res.screenshot.mimeType,
          });
        }
        return { state: res.stateText, screenshot: res.screenshot.bytes };
      },

      click: (target, opts) => ctrl.click(target, opts),
      hover: (target, opts) => ctrl.hover(target, opts),
      moveCursor: (target, opts) =>
        ctrl.hover(target, { ...opts, dispatchMoveEvent: false, badge: opts?.badge ?? "Move" }),
      highlight: (target, opts) => ctrl.highlight(target, opts),
      hideCursor: () => ctrl.hideCursor(),
      getCursorState: () => ctrl.getCursorState(),
      drag: (from, to, opts) => ctrl.drag(from, to, opts),
      scroll: (target, dir, pages, opts) => ctrl.scroll(target, dir, pages, opts),
      selectText: (idx, text, opts) => ctrl.selectText(idx, text, opts),
      setValue: (idx, val, opts) => ctrl.setValue(idx, val, opts),
      performSecondaryAction: (idx, act, opts) => ctrl.performSecondaryAction(idx, act, opts),
      paste: (idx, text, opts) => ctrl.paste(idx, text, opts),
      pressKey: (idx, key, opts) => ctrl.pressKey(idx, key, opts),
      typeText: (idx, text, opts) => ctrl.typeText(idx, text, opts),
      goto: (url) => ctrl.goto(url),
      back: () => ctrl.back(),
      forward: () => ctrl.forward(),
      reload: () => ctrl.reload(),
      close: () => ctrl.close(),
      evaluate: (expr) => ctrl.evaluate(expr),
      locator: (sel) => ctrl.locator(sel),
      uploadFiles: (target, files) => ctrl.uploadFiles(target, files),
      waitFor: (selOrMs, timeout) => ctrl.waitFor(selOrMs, timeout),
      markDeliverable: async () => {},
      markHandoff: async () => {},
    };
  }

  buildGlobals() {
    const self = this;

    const nodeRepl = {
      write(...args) {
        const formatted = args
          .map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 2)))
          .join(" ");
        self.emitText(formatted);
      },
      emitMarkdown(md) {
        self.emitText(String(md ?? ""));
      },
      async emitImage(img) {
        await self.emitImageInput(img);
      },
    };

    const cua = {
      computer: {
        target: "mac",
        async launch_app({ app, activate = false }) {
          await self.macBridge.launchApp({ app, activate });
        },
      },

      async launchApp(appOrOptions, options = {}) {
        if (typeof appOrOptions === "string") {
          return self.macBridge.launchApp({ app: appOrOptions, activate: Boolean(options.activate) });
        }
        if (appOrOptions && typeof appOrOptions === "object") {
          return self.macBridge.launchApp({
            app: appOrOptions.app,
            activate: Boolean(appOrOptions.activate),
          });
        }
        throw new TypeError("cua.launchApp requires an app string or { app, activate? }");
      },

      async getWindowState(options = {}) {
        const st = await self.macBridge.getWindowState(options);
        if (options.emit !== false) {
          self.emitText(st.stateText);
        }
        return st;
      },

      cursor: {
        async getState(options = {}) {
          if (options.tabId) {
            return self.browserManager.getCursorStates({ tabId: options.tabId });
          }
          if (options.windowId != null || options.app || options.windowTitle) {
            return self.macBridge.cursorControl({
              action: "get_state",
              ...(options.windowId != null ? { windowId: Number(options.windowId) } : {}),
              ...(options.app ? { app: String(options.app) } : {}),
              ...(options.windowTitle ? { windowTitle: String(options.windowTitle) } : {}),
            });
          }
          const [mac, browser] = await Promise.all([
            self.macBridge.cursorControl({ action: "get_state" }),
            self.browserManager.getCursorStates(),
          ]);
          return { mac, browser };
        },
        async configure(options = {}) {
          const [mac, browser] = await Promise.all([
            self.macBridge.cursorControl({ action: "configure", ...options }),
            self.browserManager.configureCursor(options),
          ]);
          return { mac: mac.config ?? mac, browser };
        },
        async clearAll() {
          const [mac, browser] = await Promise.all([
            self.macBridge.cursorControl({ action: "clear_all" }),
            self.browserManager.clearAllCursors(),
          ]);
          return { mac, browser };
        },
        async move(options = {}) {
          if (options.tabId) {
            const tab = await self.browserManager.getTab(options.tabId);
            const explicitRect =
              options.rect ??
              (options.x != null && options.y != null && options.width != null && options.height != null
                ? {
                    x: Number(options.x),
                    y: Number(options.y),
                    width: Number(options.width),
                    height: Number(options.height),
                  }
                : undefined);
            const target =
              options.elementIndex ??
              options.selector ??
              (explicitRect
                ? [explicitRect.x + explicitRect.width / 2, explicitRect.y + explicitRect.height / 2]
                : [Number(options.x), Number(options.y)]);
            return tab.hover(target, {
              ...(explicitRect ? { rect: explicitRect } : {}),
              dispatchMoveEvent: Boolean(options.dispatchMoveEvent),
              badge: options.badge ?? "Move",
              ripple: Boolean(options.ripple),
            });
          }
          return self.macBridge.cursorControl({ action: "move", ...options });
        },
        async highlight(options = {}) {
          if (options.tabId) {
            const tab = await self.browserManager.getTab(options.tabId);
            const explicitRect =
              options.rect ??
              (options.x != null && options.y != null && options.width != null && options.height != null
                ? {
                    x: Number(options.x),
                    y: Number(options.y),
                    width: Number(options.width),
                    height: Number(options.height),
                  }
                : undefined);
            const target =
              options.elementIndex ??
              options.selector ??
              (explicitRect
                ? [explicitRect.x + explicitRect.width / 2, explicitRect.y + explicitRect.height / 2]
                : [Number(options.x), Number(options.y)]);
            return tab.highlight(target, {
              ...options,
              ...(explicitRect ? { rect: explicitRect } : {}),
            });
          }
          return self.macBridge.cursorControl({ action: "highlight", ...options });
        },
        async hide(options = {}) {
          if (options.tabId) {
            const tab = await self.browserManager.getTab(options.tabId);
            return tab.hideCursor();
          }
          return self.macBridge.cursorControl({ action: "hide", ...options });
        },
      },

      async getState(options = {}) {
        const [apps, windows, browsers, permissions] = await Promise.all([
          self.macBridge.listApps({ runningOnly: true }).catch(() => []),
          self.macBridge.listWindows({ includeMinimized: true }).catch(() => []),
          self.browserManager.listBrowsersWithTabs().catch(() => []),
          self.macBridge.checkPermissions().catch(() => ({})),
        ]);
        const stateObj = { apps, windows, browsers, permissions };
        if (options.emit !== false) {
          self.emitText(JSON.stringify(stateObj, null, 2));
        }
        return stateObj;
      },

      async listApps(options = {}) {
        const apps = await self.macBridge.listApps({ runningOnly: Boolean(options.runningOnly) });
        if (options.emit !== false) {
          self.emitText(JSON.stringify(apps, null, 2));
        }
        return apps;
      },

      async listWindows(options = {}) {
        const wins = await self.macBridge.listWindows({
          app: options.app,
          includeMinimized: options.includeMinimized ?? true,
        });
        if (options.emit !== false) {
          self.emitText(JSON.stringify(wins, null, 2));
        }
        return wins;
      },

      async getApp(target, options = {}) {
        let params;
        if (typeof target === "string") {
          params = { app: target, autoLaunch: true };
        } else if (target && typeof target === "object") {
          params = {
            ...(target.windowId != null ? { windowId: Number(target.windowId) } : {}),
            ...(target.app ? { app: String(target.app) } : {}),
            ...(target.windowTitle ? { windowTitle: String(target.windowTitle) } : {}),
            autoLaunch: target.autoLaunch ?? true,
          };
        } else {
          throw new TypeError("cua.getApp requires an app string or { windowId, app?, windowTitle? }");
        }
        const st = await self.macBridge.getWindowState({
          ...params,
          disableDiff: false,
          includeScreenshot: false,
        });
        if (options.emit !== false) {
          self.emitText(st.stateText);
        }
        return self.wrapMacAppHandle(st);
      },

      async listBrowsers(options = {}) {
        const browsers = await self.browserManager.listBrowsersWithTabs();
        if (options.emit !== false) {
          self.emitText(JSON.stringify(browsers, null, 2));
        }
        return browsers;
      },

      async listTabs(options = {}) {
        const tabs = await self.browserManager.listTabs({ browser: options.browser });
        if (options.emit !== false) {
          self.emitText(JSON.stringify(tabs, null, 2));
        }
        return tabs;
      },

      async getBrowser(options = {}) {
        const browsers = await self.browserManager.listBrowsersWithTabs();
        let chosen = browsers[0];
        if (options.id) {
          chosen =
            browsers.find((b) => b.id.toLowerCase() === String(options.id).toLowerCase()) ??
            browsers[0];
        }
        const browserId = chosen?.id ?? "iab";
        return {
          browserId,
          async documentation() {
            return "Use cua.createBrowserTab(browserId, url, { visible }) or cua.getTab(tabId, { browser: browserId }).";
          },
          tabs: {
            list: () => self.browserManager.listTabs({ browser: browserId }),
            get: async (id) => self.wrapTabHandle(await self.browserManager.getTab(id, { browser: browserId })),
            new: async (url) => self.wrapTabHandle(await self.browserManager.createTab(browserId, url)),
          },
        };
      },

      async createBrowserTab(browserId, url = "about:blank", options = {}) {
        const ctrl = await self.browserManager.createTab(browserId, url, options);
        const handle = self.wrapTabHandle(ctrl);
        const ax = await ctrl.getAXState();
        if (options.emit !== false) {
          self.emitText(ax.stateText);
        }
        return handle;
      },

      async getTab(reference, options = {}) {
        const ctrl = await self.browserManager.getTab(reference, options);
        const handle = self.wrapTabHandle(ctrl);
        const ax = await ctrl.getAXState();
        if (options.emit !== false) {
          self.emitText(ax.stateText);
        }
        return handle;
      },

      async getBrowserTab(reference, options = {}) {
        return this.getTab(reference, options);
      },

      async manageWindows(opts) {
        return self.macBridge.manageWindows(opts);
      },

      async tileWindows(targets, layout = "tile_left_right", opts = {}) {
        return self.macBridge.manageWindows({
          targets,
          layout,
          ...opts,
        });
      },
    };

    // Full @oai/sky compatibility object
    const sky = {
      target: "mac",
      list_apps: () => self.macBridge.listApps({ runningOnly: false }),
      list_windows: (opts = {}) => self.macBridge.listWindows(opts),
      get_window: async ({ id, app }) => {
        const wins = await self.macBridge.listWindows({ app });
        const found = wins.find((w) => w.id === Number(id));
        if (!found) throw new Error(`Window ${id} not found`);
        return found;
      },
      launch_app: ({ app, activate = false }) => self.macBridge.launchApp({ app, activate }),
      activate_window: ({ window: win }) =>
        self.macBridge.manageWindows({
          operations: [{ windowId: Number(win?.id ?? win), action: "activate" }],
        }),
      get_app_state: async ({ app, disableDiff = false, includeScreenshot = false, includeCursor = false }) => {
        const st = await self.macBridge.getWindowState({
          app,
          disableDiff,
          includeScreenshot,
          includeCursor,
        });
        return {
          app: st.app,
          text: st.stateText,
          screenshot: st.screenshot
            ? { url: `data:${st.screenshot.mimeType};base64,${st.screenshot.base64}` }
            : null,
        };
      },
      get_window_state: async ({ window: win, include_screenshot = false, include_cursor = false, disableDiff = false }) => {
        const wid = typeof win === "number" ? win : Number(win?.id);
        const st = await self.macBridge.getWindowState({
          windowId: wid,
          app: win?.app,
          disableDiff,
          includeScreenshot: include_screenshot,
          includeCursor: include_cursor,
        });
        return {
          window: st.window,
          accessibility: { tree: st.stateText },
          screenshots: st.screenshot
            ? [
                {
                  id: `shot-${wid}`,
                  url: `data:${st.screenshot.mimeType};base64,${st.screenshot.base64}`,
                  width: st.screenshot.width,
                  height: st.screenshot.height,
                  zIndex: 0,
                },
              ]
            : [],
        };
      },
      click: (args) =>
        self.macBridge.performAction({
          ...(args.window?.id != null ? { windowId: Number(args.window.id) } : {}),
          ...(args.app ? { app: args.app } : {}),
          action: "click",
          ...(args.element_index != null ? { elementIndex: Number(args.element_index) } : {}),
          ...(args.x != null ? { x: Number(args.x) } : {}),
          ...(args.y != null ? { y: Number(args.y) } : {}),
          mouseButton: args.mouse_button ?? "left",
          clickCount: args.click_count ?? 1,
          ...(args.key ? { key: args.key } : {}),
          ...(args.duration != null ? { durationMs: Math.round(Number(args.duration) * 1000) } : {}),
        }),
      hover: (args) =>
        self.macBridge.performAction({
          ...(args.window?.id != null ? { windowId: Number(args.window.id) } : {}),
          ...(args.app ? { app: args.app } : {}),
          action: "hover",
          ...(args.element_index != null ? { elementIndex: Number(args.element_index) } : {}),
          ...(args.x != null ? { x: Number(args.x) } : {}),
          ...(args.y != null ? { y: Number(args.y) } : {}),
        }),
      move: (args) =>
        self.macBridge.performAction({
          ...(args.window?.id != null ? { windowId: Number(args.window.id) } : {}),
          ...(args.app ? { app: args.app } : {}),
          action: "move",
          ...(args.element_index != null ? { elementIndex: Number(args.element_index) } : {}),
          ...(args.x != null ? { x: Number(args.x) } : {}),
          ...(args.y != null ? { y: Number(args.y) } : {}),
        }),
      drag: (args) =>
        self.macBridge.performAction({
          ...(args.window?.id != null ? { windowId: Number(args.window.id) } : {}),
          ...(args.app ? { app: args.app } : {}),
          action: "drag",
          fromX: Number(args.from_x),
          fromY: Number(args.from_y),
          toX: Number(args.to_x),
          toY: Number(args.to_y),
        }),
      scroll: (args) =>
        self.macBridge.performAction({
          ...(args.window?.id != null ? { windowId: Number(args.window.id) } : {}),
          ...(args.app ? { app: args.app } : {}),
          action: "scroll",
          direction: args.direction ?? (args.scrollY < 0 ? "up" : "down"),
          ...(args.element_index != null ? { elementIndex: Number(args.element_index) } : {}),
          ...(args.pages != null ? { pages: Number(args.pages) } : {}),
          ...(args.x != null ? { x: Number(args.x) } : {}),
          ...(args.y != null ? { y: Number(args.y) } : {}),
        }),
      set_value: (args) =>
        self.macBridge.performAction({
          ...(args.window?.id != null ? { windowId: Number(args.window.id) } : {}),
          ...(args.app ? { app: args.app } : {}),
          action: "set_value",
          elementIndex: Number(args.element_index),
          value: String(args.value),
        }),
      select_text: (args) =>
        self.macBridge.performAction({
          ...(args.window?.id != null ? { windowId: Number(args.window.id) } : {}),
          ...(args.app ? { app: args.app } : {}),
          action: "select_text",
          elementIndex: Number(args.element_index),
          text: String(args.text),
          prefix: args.prefix,
          suffix: args.suffix,
          selectionType: args.selection_type ?? "text",
        }),
      perform_secondary_action: (args) =>
        self.macBridge.performAction({
          ...(args.window?.id != null ? { windowId: Number(args.window.id) } : {}),
          ...(args.app ? { app: args.app } : {}),
          action: "perform_secondary_action",
          elementIndex: Number(args.element_index),
          secondaryAction: String(args.action),
        }),
      paste: (args) =>
        self.macBridge.performAction({
          ...(args.window?.id != null ? { windowId: Number(args.window.id) } : {}),
          ...(args.app ? { app: args.app } : {}),
          action: "paste",
          text: String(args.text),
          format: args.format ?? "text",
        }),
      press_key: (args) =>
        self.macBridge.performAction({
          ...(args.window?.id != null ? { windowId: Number(args.window.id) } : {}),
          ...(args.app ? { app: args.app } : {}),
          action: "press_key",
          key: String(args.key),
          ...(args.duration != null ? { durationMs: Math.round(Number(args.duration) * 1000) } : {}),
        }),
      type_text: (args) =>
        self.macBridge.performAction({
          ...(args.window?.id != null ? { windowId: Number(args.window.id) } : {}),
          ...(args.app ? { app: args.app } : {}),
          action: "type_text",
          text: String(args.text),
        }),
    };

    const agent = {
      browsers: {
        list: () => self.browserManager.listBrowsersWithTabs(),
        get: (id) => cua.getBrowser({ id }),
        getDefault: () => cua.getBrowser({}),
      },
    };

    const replConsole = {
      log: (...a) => nodeRepl.write(...a),
      info: (...a) => nodeRepl.write(...a),
      warn: (...a) => nodeRepl.write(...a),
      error: (...a) => nodeRepl.write(...a),
    };

    return {
      cua,
      sky,
      agent,
      nodeRepl,
      console: replConsole,
      Buffer,
      URL,
      setTimeout,
      clearTimeout,
      fetch,
    };
  }

  initContext() {
    const globals = this.buildGlobals();
    this.context = vm.createContext(globals);
    this.context.globalThis = this.context;
  }

  /**
   * Execute async JavaScript inside the persistent REPL context.
   * @param {string} code
   * @param {number} [timeoutMs]
   */
  async execute(code, timeoutMs = 45000) {
    if (typeof code !== "string" || !code.trim()) {
      throw new TypeError("js requires a non-empty 'code' string");
    }

    const boundNames = extractTopLevelBindings(code);
    const persistStatements = boundNames
      .map((name) => `try { globalThis[${JSON.stringify(name)}] = ${name}; } catch {}`)
      .join("\n");

    const wrapped = `(async () => {\n  try {\n${code}\n  } finally {\n${persistStatements}\n  }\n})()`;

    const collector = [];
    this.activeCollector = collector;

    let timer;
    try {
      const script = new vm.Script(wrapped, { filename: "cua_repl.mjs" });
      const promise = script.runInContext(this.context);
      const returnValue = await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`cua_repl execution timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);

      if (returnValue !== undefined && collector.length === 0) {
        const serialized =
          typeof returnValue === "string" ? returnValue : JSON.stringify(returnValue, null, 2);
        if (serialized) {
          collector.push({ type: "text", text: serialized });
        }
      }
      if (collector.length === 0) {
        collector.push({ type: "text", text: "(Executed successfully)" });
      }
      return collector;
    } finally {
      if (timer) clearTimeout(timer);
      this.activeCollector = null;
    }
  }
}
