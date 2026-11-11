import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import vm from "node:vm";
import { AXDiffTracker } from "../src/diff.mjs";
import { MacBridge } from "../src/mac-bridge.mjs";
import { createComputerUseServer } from "../src/server.mjs";
import {
  BUILD_AX_SNAPSHOT_EXPR,
  buildBrowserCursorOverlayExpr,
  buildGetBrowserCursorStateExpr,
  buildPasteExpr,
  buildPrepareBrowserCursorForScreenshotExpr,
  buildSelectTextExpr,
  buildSetBrowserCursorTemporarilyHiddenExpr,
  buildRemoveBrowserCursorExpr,
} from "../src/browser-ax.mjs";

function parseJpegDimensions(buf) {
  assert.equal(buf[0], 0xff);
  assert.equal(buf[1], 0xd8);
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    while (i < buf.length && buf[i] === 0xff) i++;
    if (i >= buf.length) break;
    const marker = buf[i++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (i + 1 >= buf.length) break;
    const segLen = (buf[i] << 8) | buf[i + 1];
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      const height = (buf[i + 3] << 8) | buf[i + 4];
      const width = (buf[i + 5] << 8) | buf[i + 6];
      return { width, height };
    }
    i += segLen;
  }
  return null;
}

function parseHeaderGeometry(treeText) {
  const firstLine = treeText.split("\n")[0] || "";
  const sizeMatch = /size=(\d+)x(\d+)/.exec(firstLine);
  const screenMatch = /screen=@\((-?\d+),(-?\d+)\s+(\d+)x(\d+)\)/.exec(firstLine);
  return {
    size: sizeMatch ? { width: Number(sizeMatch[1]), height: Number(sizeMatch[2]) } : null,
    screen: screenMatch
      ? {
          x: Number(screenMatch[1]),
          y: Number(screenMatch[2]),
          width: Number(screenMatch[3]),
          height: Number(screenMatch[4]),
        }
      : null,
  };
}

function findFirstIndexedElementWithBounds(treeText) {
  for (const line of treeText.split("\n")) {
    const m = /^\s*\[(\d+)\]\s+(\S+).*@\((-?\d+),(-?\d+)\s+(\d+)x(\d+)\)/.exec(line);
    if (m) {
      const width = Number(m[5]);
      const height = Number(m[6]);
      if (width >= 8 && height >= 8) {
        return {
          index: Number(m[1]),
          role: m[2],
          x: Number(m[3]),
          y: Number(m[4]),
          width,
          height,
        };
      }
    }
  }
  return null;
}

test("Native macOS VirtualCursorManager: real WindowServer overlays, Space/z-order isolation, unconstrained y=10 menu-bar cursor, 1:1 JPEG dimensions, includeCursor screenshots, diff isolation, and error paths", async (t) => {
  const diffTracker = new AXDiffTracker();
  const bridge = new MacBridge({ diffTracker });

  t.after(async () => {
    try {
      await bridge.cursorControl({ action: "configure", enabled: true, idleTimeoutMs: 2600, glideEnabled: true });
      await bridge.cursorControl({ action: "clear_all" });
    } catch {}
    bridge.close();
  });

  const perms = await bridge.checkPermissions();
  assert.equal(perms.axTrusted, true, "Accessibility permission must be granted");

  const openWins = (await bridge.listWindows({ includeMinimized: false })).filter(
    (w) => w.bounds && w.bounds.width >= 160 && w.bounds.height >= 120,
  );
  assert.ok(openWins.length >= 1, "Expected at least one open desktop window for non-intrusive overlay testing");

  const onScreenWins = openWins.filter((w) => w.onScreen !== false);
  const offSpaceWin = openWins.find((w) => w.onScreen === false) ?? null;
  const winA = onScreenWins[0] ?? openWins[0];
  const winB = openWins.find((w) => w.id !== winA.id) ?? null;

  // 1. Verify unified 1:1 window-relative AX header & element coordinate space
  const stA = await bridge.getWindowState({ windowId: winA.id, disableDiff: true });
  const geom = parseHeaderGeometry(stA.fullTree);
  assert.ok(geom.size, `Expected size=WxH in header: ${stA.fullTree.split("\n")[0]}`);
  assert.ok(geom.screen, `Expected screen=@(x,y WxH) in header: ${stA.fullTree.split("\n")[0]}`);
  assert.ok(Math.abs(geom.size.width - Math.round(winA.bounds.width)) <= 2);
  assert.ok(Math.abs(geom.size.height - Math.round(winA.bounds.height)) <= 2);
  assert.ok(Math.abs(geom.screen.x - Math.round(winA.bounds.x)) <= 2);
  assert.ok(Math.abs(geom.screen.y - Math.round(winA.bounds.y)) <= 2);

  const elemA = findFirstIndexedElementWithBounds(stA.fullTree);
  if (elemA && winA.bounds.x > 40) {
    assert.ok(
      elemA.x >= -40 && elemA.x <= winA.bounds.width + 40,
      `Expected window-relative element X (${elemA.x}) within window width (${winA.bounds.width})`,
    );
  }

  // 2. Non-intrusively spawn virtual cursors + highlight boxes across windows + global top-edge cursor simultaneously
  const cursorCalls = [
    elemA
      ? bridge.cursorControl({
          action: "highlight",
          windowId: winA.id,
          elementIndex: elemA.index,
          badge: "Inspect A",
          ripple: true,
        })
      : bridge.cursorControl({
          action: "highlight",
          windowId: winA.id,
          x: 60,
          y: 50,
          width: 120,
          height: 36,
          badge: "Inspect A",
          ripple: true,
        }),
    // Global top-edge cursor inside the y=10 menu-bar band (verifies UnconstrainedOverlayWindow)
    bridge.cursorControl({
      action: "move",
      globalCoordinates: true,
      x: 240,
      y: 10,
      badge: "TopBar",
      ripple: true,
    }),
  ];

  if (winB) {
    cursorCalls.push(
      bridge.cursorControl({
        action: "move",
        windowId: winB.id,
        x: 95,
        y: 75,
        badge: "Target B",
        ripple: true,
      }),
    );
  }

  await Promise.all(cursorCalls);

  // Allow 60fps scoot glide to settle completely
  await new Promise((r) => setTimeout(r, 220));

  const fullCursorState = await bridge.cursorControl({ action: "get_state" });
  const cursorA = fullCursorState.cursors.find((c) => c.windowId === winA.id);
  assert.ok(cursorA, "Expected active virtual cursor state for winA");
  assert.equal(cursorA.visible, true);
  assert.ok(cursorA.opacity > 0.5, `Expected visible opacity > 0.5, got ${cursorA.opacity}`);
  assert.equal(cursorA.badge, null, "Cursor badge pill must be permanently suppressed even when badge is passed");
  assert.ok(cursorA.highlightedBounds != null, "Expected highlightedBounds on winA");
  assert.equal(cursorA.screenX, Math.round(winA.bounds.x + cursorA.x));
  assert.equal(cursorA.screenY, Math.round(winA.bounds.y + cursorA.y));

  const globalCursor = fullCursorState.cursors.find((c) => c.windowId === 0);
  assert.ok(globalCursor, "Expected active global cursor state (windowId=0)");
  assert.ok(Math.abs(globalCursor.screenY - 10) <= 2, `Expected global cursor screenY ~ 10, got ${globalCursor.screenY}`);

  if (winB) {
    const cursorB = fullCursorState.cursors.find((c) => c.windowId === winB.id);
    assert.ok(cursorB, "Expected simultaneous active virtual cursor state for winB");
    assert.equal(cursorB.visible, true);
    assert.ok(Math.abs(cursorB.x - 95) <= 2, `Expected winB cursor x ~ 95, got ${cursorB.x}`);
    assert.ok(Math.abs(cursorB.y - 75) <= 2, `Expected winB cursor y ~ 75, got ${cursorB.y}`);
    if (winB.onScreen === false) {
      assert.equal(cursorB.targetOnScreen, false, "Off-Space window cursor must report targetOnScreen=false");
    }
  }

  // Verify real on-screen AppKit NSWindow overlays reported by macOS WindowServer (CGWindowListCopyWindowInfo)
  const cursorOverlays = fullCursorState.onScreenOverlays.filter((o) => o.title === "Computer Use Cursor");
  const highlightOverlays = fullCursorState.onScreenOverlays.filter((o) => o.title === "Computer Use Highlight");
  const expectedOnScreenCursors = 1 + (winA.onScreen !== false ? 1 : 0) + (winB && winB.onScreen !== false ? 1 : 0);
  assert.equal(
    cursorOverlays.length,
    expectedOnScreenCursors,
    `Expected exactly ${expectedOnScreenCursors} on-screen 'Computer Use Cursor' NSWindows on active Space (no cross-Space bleed), got ${cursorOverlays.length}: ${JSON.stringify(cursorOverlays)}`,
  );

  // Verify UnconstrainedOverlayWindow allowed global hotspot at y=10 without menu-bar clamping
  const topBarOverlay = cursorOverlays.find(
    (o) => Math.abs(o.hotspotScreen.x - 240) <= 3 && Math.abs(o.hotspotScreen.y - 10) <= 3,
  );
  assert.ok(
    topBarOverlay,
    `Expected unconstrained WindowServer overlay hotspot at (240, 10) without menu-bar clamping; overlays=${JSON.stringify(cursorOverlays)}`,
  );

  if (winA.onScreen !== false) {
    assert.ok(
      highlightOverlays.length >= 1,
      `Expected >= 1 on-screen 'Computer Use Highlight' NSWindow on WindowServer, got ${highlightOverlays.length}`,
    );
    const matchingOverlay = cursorOverlays.find(
      (o) =>
        Math.abs(o.hotspotScreen.x - cursorA.screenX) <= 3 &&
        Math.abs(o.hotspotScreen.y - cursorA.screenY) <= 3,
    );
    assert.ok(
      matchingOverlay,
      `Expected WindowServer cursor hotspot near (${cursorA.screenX}, ${cursorA.screenY}); overlays=${JSON.stringify(cursorOverlays)}`,
    );
    assert.equal(matchingOverlay.bounds.width, 240);
    assert.equal(matchingOverlay.bounds.height, 240);
    // Window-bound overlays must sit at normal window layer (0), NOT statusBar layer (25), so they never bleed over covering foreground windows
    assert.equal(matchingOverlay.layer, 0, "Window-bound cursor overlay must match normal window layer (0)");
  }

  // If an off-Space window exists, verify its cursor still composites into its isolated screenshot despite not bleeding onto active Space
  if (offSpaceWin) {
    const offClean = await bridge.getWindowScreenshot({ windowId: offSpaceWin.id, includeCursor: false });
    const offWithCursor = await bridge.getWindowScreenshot({ windowId: offSpaceWin.id, includeCursor: true });
    assert.notEqual(
      offClean.screenshot.base64,
      offWithCursor.screenshot.base64,
      "Off-Space window screenshot with includeCursor=true must still composite its virtual cursor",
    );
  }

  // Verify badge pill stays permanently suppressed even when badge is explicitly passed on perform_action (hover)
  const customHover = await bridge.performAction({
    windowId: winA.id,
    action: "hover",
    x: 110,
    y: 75,
    dispatchMoveEvent: false,
    badge: "Custom Action Badge",
    ripple: true,
  });
  assert.equal(customHover.cursor?.badge, null);

  // 3. Rapid concurrent retargeting on the same window (verifies CloseEnough callback flushing & zero deadlock)
  await Promise.all([
    bridge.cursorControl({ action: "move", windowId: winA.id, x: 45, y: 45, badge: "Step 1" }),
    bridge.cursorControl({ action: "move", windowId: winA.id, x: 130, y: 85, badge: "Step 2" }),
    bridge.cursorControl({ action: "move", windowId: winA.id, x: 90, y: 65, badge: "Step 3" }),
  ]);
  await bridge.cursorControl({ action: "move", windowId: winA.id, x: 110, y: 75, badge: "Final", ripple: true });
  await new Promise((r) => setTimeout(r, 220));
  const afterRetarget = await bridge.cursorControl({ action: "get_state", windowId: winA.id });
  assert.equal(afterRetarget.cursors.length, 1);
  assert.ok(Math.abs(afterRetarget.cursors[0].x - 110) <= 2, `Expected x ~ 110, got ${afterRetarget.cursors[0].x}`);
  assert.ok(Math.abs(afterRetarget.cursors[0].y - 75) <= 2, `Expected y ~ 75, got ${afterRetarget.cursors[0].y}`);

  // 4. Screenshot compositing & exact 1:1 point-to-pixel JPEG dimensions
  const cleanShot = await bridge.getWindowScreenshot({ windowId: winA.id, includeCursor: false });
  const cursorShot = await bridge.getWindowScreenshot({ windowId: winA.id, includeCursor: true });
  const cleanBytes = Buffer.from(cleanShot.screenshot.base64, "base64");
  const cursorBytes = Buffer.from(cursorShot.screenshot.base64, "base64");
  const cleanDims = parseJpegDimensions(cleanBytes);
  const cursorDims = parseJpegDimensions(cursorBytes);
  assert.ok(cleanDims, "Expected SOF0/SOF2 dimensions in clean JPEG");
  assert.ok(cursorDims, "Expected SOF0/SOF2 dimensions in composited JPEG");
  const expectedW = Math.min(4096, Math.max(1, Math.round(winA.bounds.width)));
  const expectedH = Math.min(4096, Math.max(1, Math.round(winA.bounds.height)));
  assert.ok(
    Math.abs(cleanDims.width - expectedW) <= 2 && Math.abs(cleanDims.height - expectedH) <= 2,
    `Expected 1:1 JPEG dimensions (${expectedW}x${expectedH}), got (${cleanDims.width}x${cleanDims.height})`,
  );
  assert.deepEqual(cursorDims, cleanDims);
  assert.equal(cleanShot.screenshot.cursorComposited, false);
  assert.equal(cursorShot.screenshot.cursorComposited, true);
  assert.notEqual(
    cleanShot.screenshot.base64,
    cursorShot.screenshot.base64,
    "Screenshot with includeCursor=true must composite cursor graphics and differ from clean screenshot",
  );

  // 5. AXDiffTracker isolation: hiding cursor must NOT pollute AX tree diffing
  const baselineState = await bridge.getWindowState({ windowId: winA.id, disableDiff: true });
  assert.equal(baselineState.isDiff, false);
  await bridge.cursorControl({ action: "hide", windowId: winA.id });
  const postHideCursor = await bridge.cursorControl({ action: "get_state", windowId: winA.id });
  assert.equal(postHideCursor.cursors.length, 0, "Cursor for winA must be hidden immediately");

  const diffAfterHide = await bridge.getWindowState({ windowId: winA.id });
  assert.equal(diffAfterHide.isDiff, true);
  assert.equal(diffAfterHide.unchanged, true, "Hiding virtual cursor must not pollute AX diff state");

  // 6. Global configure (disable -> clear, re-enable) & clear_all
  const disabledCfg = await bridge.cursorControl({ action: "configure", enabled: false });
  assert.equal(disabledCfg.config.enabled, false);
  await bridge.cursorControl({ action: "move", windowId: winA.id, x: 80, y: 80 });
  const whileDisabled = await bridge.cursorControl({ action: "get_state" });
  assert.equal(whileDisabled.cursors.length, 0, "No cursors should spawn when enabled=false");
  assert.equal(whileDisabled.onScreenOverlays.length, 0, "Zero overlay NSWindows should be on screen when disabled");

  const reenabledCfg = await bridge.cursorControl({
    action: "configure",
    enabled: true,
    idleTimeoutMs: 2200,
    glideEnabled: true,
  });
  assert.equal(reenabledCfg.config.enabled, true);
  assert.equal(reenabledCfg.config.idleTimeoutMs, 2200);

  await bridge.cursorControl({ action: "move", windowId: winA.id, x: 70, y: 70 });
  const whileEnabled = await bridge.cursorControl({ action: "get_state", windowId: winA.id });
  assert.equal(whileEnabled.cursors.length, 1);

  await bridge.cursorControl({ action: "clear_all" });
  const afterClear = await bridge.cursorControl({ action: "get_state" });
  assert.equal(afterClear.cursors.length, 0);
  assert.equal(afterClear.onScreenOverlays.length, 0, "clear_all must remove all WindowServer overlay windows");

  // 7. Error & boundary cases on native cursor/hover RPCs
  await assert.rejects(
    () => bridge.cursorControl({ action: "nonexistent_cursor_op" }),
    /Unknown cursor_control action/i,
  );
  await assert.rejects(
    () => bridge.cursorControl({ action: "move", windowId: winA.id }),
    /requires elementIndex or \(x, y\)/i,
  );
  await assert.rejects(
    () => bridge.performAction({ windowId: winA.id, action: "hover" }),
    /hover requires either elementIndex or \(x, y\) coordinates/i,
  );
});

test("Browser ShadowRoot Cursor Expressions: Trusted Types CSP safety (zero innerHTML), instant first-show glideEnabled=false, selector resolution, and AX tree exclusion", () => {
  const elementsById = new Map();
  let createdSvgCount = 0;
  const makeEl = (tag, namespaceURI = "http://www.w3.org/1999/xhtml") => {
    const classSet = new Set();
    if (namespaceURI === "http://www.w3.org/2000/svg") createdSvgCount++;
    const el = {
      nodeType: 1,
      namespaceURI,
      tagName: namespaceURI === "http://www.w3.org/2000/svg" ? String(tag) : String(tag).toUpperCase(),
      id: "",
      get className() {
        return Array.from(classSet).join(" ");
      },
      set className(val) {
        classSet.clear();
        for (const tk of String(val ?? "").split(/\s+/).filter(Boolean)) classSet.add(tk);
      },
      value: "",
      selectionStart: 0,
      selectionEnd: 0,
      classList: {
        add(...tokens) {
          for (const tk of tokens) classSet.add(tk);
        },
        remove(...tokens) {
          for (const tk of tokens) classSet.delete(tk);
        },
        contains(tk) {
          return classSet.has(tk);
        },
        toggle(tk, force) {
          const next = force === undefined ? !classSet.has(tk) : Boolean(force);
          if (next) classSet.add(tk);
          else classSet.delete(tk);
          return next;
        },
      },
      style: { cssText: "", opacity: "", transform: "", left: "", top: "", width: "", height: "", display: "" },
      dataset: {},
      attributes: new Map(),
      children: [],
      childNodes: [],
      textContent: "",
      shadowRoot: null,
      isConnected: true,
      focus() {
        sandbox.document.activeElement = this;
      },
      scrollIntoView() {},
      dispatchEvent() {
        return true;
      },
      setSelectionRange(s, e) {
        this.selectionStart = s;
        this.selectionEnd = e;
      },
      closest() {
        return null;
      },
      setAttribute(k, v) {
        this.attributes.set(k, String(v));
        if (k === "id") {
          this.id = String(v);
          elementsById.set(this.id, this);
        } else if (k === "class") {
          this.className = String(v);
        }
      },
      getAttribute(k) {
        return this.attributes.has(k) ? this.attributes.get(k) : null;
      },
      hasAttribute(k) {
        return this.attributes.has(k);
      },
      appendChild(child) {
        if (child && typeof child === "object") {
          child.parentElement = this;
          this.childNodes.push(child);
          if (child.nodeType === 1) {
            this.children.push(child);
          }
          if (child.id) elementsById.set(child.id, child);
        }
        return child;
      },
      append(...nodes) {
        for (const n of nodes) {
          this.appendChild(typeof n === "string" ? { nodeType: 3, tagName: "#TEXT", textContent: n } : n);
        }
      },
      remove() {
        this.isConnected = false;
        if (this.id) elementsById.delete(this.id);
        if (this.parentElement) {
          this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
          this.parentElement.childNodes = this.parentElement.childNodes.filter((c) => c !== this);
        }
      },
      attachShadow() {
        const sr = makeEl("shadow-root");
        this.shadowRoot = sr;
        return sr;
      },
      querySelector(sel) {
        for (const c of this.children) {
          if (sel.startsWith(".") && c.classList.contains(sel.slice(1))) return c;
          if (sel.startsWith("#") && c.id === sel.slice(1)) return c;
          if (c.tagName.toLowerCase() === sel.toLowerCase()) return c;
          const sub = c.querySelector?.(sel);
          if (sub) return sub;
        }
        return null;
      },
      querySelectorAll(sel) {
        const out = [];
        const walk = (node) => {
          for (const c of node.children || []) {
            if (
              (sel.startsWith("#") && c.id === sel.slice(1)) ||
              (sel.startsWith(".") && c.classList.contains(sel.slice(1))) ||
              sel.split(",").some((part) => part.trim().toLowerCase() === c.tagName.toLowerCase())
            ) {
              out.push(c);
            }
            walk(c);
          }
        };
        walk(this);
        return out;
      },
      getBoundingClientRect() {
        return this._rect || { left: 100, top: 80, width: 140, height: 36, right: 240, bottom: 116 };
      },
    };
    // Enforce strict Trusted Types CSP: ANY assignment to innerHTML throws TypeError!
    Object.defineProperty(el, "innerHTML", {
      get() {
        return "";
      },
      set() {
        throw new TypeError("Failed to set 'innerHTML': This document requires 'TrustedHTML' assignment.");
      },
    });
    return el;
  };

  const docEl = makeEl("html");
  const bodyEl = makeEl("body");
  const realBtn = makeEl("button");
  realBtn.setAttribute("id", "submit-btn");
  realBtn.innerText = "Submit Order";
  realBtn.textContent = "Submit Order";
  realBtn._rect = { left: 120, top: 200, width: 160, height: 40, right: 280, bottom: 240 };

  const notesInput = makeEl("textarea");
  notesInput.setAttribute("id", "notes");
  notesInput.value = "Hello World";
  notesInput._rect = { left: 120, top: 260, width: 240, height: 60, right: 360, bottom: 320 };

  bodyEl.appendChild(realBtn);
  bodyEl.appendChild(notesInput);
  docEl.appendChild(bodyEl);

  const timers = [];
  const sandbox = vm.createContext({
    window: null,
    Event: class Event {
      constructor(type, opts) {
        this.type = type;
        Object.assign(this, opts);
      }
    },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    document: {
      title: "Test Checkout",
      documentElement: docEl,
      body: bodyEl,
      activeElement: null,
      createElement: (t) => makeEl(t),
      createElementNS: (ns, t) => makeEl(t, ns),
      getElementById: (id) => elementsById.get(id) ?? null,
      querySelector: (sel) => docEl.querySelector(sel),
      querySelectorAll: (sel) => docEl.querySelectorAll(sel),
    },
    location: { href: "https://example.test/checkout" },
    innerWidth: 1280,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    CSS: { escape: (s) => String(s) },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1", cursor: "pointer" }),
    requestAnimationFrame: (fn) => fn(),
    setTimeout: (fn, ms) => {
      const id = timers.length + 1;
      timers.push({ id, fn, ms });
      return id;
    },
    clearTimeout: () => {},
  });
  sandbox.window = sandbox;

  // 1. First appearance with instant: true (glideEnabled: false) under strict Trusted Types CSP
  const instantFirstShow = vm.runInContext(
    buildBrowserCursorOverlayExpr({
      x: 310,
      y: 190,
      instant: true,
      badge: "Instant",
      idleTimeoutMs: 2600,
    }),
    sandbox,
  );
  assert.equal(instantFirstShow.ok, true);
  assert.equal(instantFirstShow.instant, true, "First-show with instant: true must stay instant");
  assert.equal(instantFirstShow.glideDurationMs, 0, "instant: true must report 0ms glideDurationMs");
  assert.ok(createdSvgCount >= 2, "SVG cursor pointer must be constructed via createElementNS without innerHTML");
  const cursorHost = elementsById.get("__ag_cua_cursor_host__");
  assert.equal(cursorHost.shadowRoot.querySelector(".ag-cursor").classList.contains("instant"), true);

  // 2. Subsequent glide to (200, 220) with highlight rect, ripple, scroll direction, and badge
  const showRes = vm.runInContext(
    buildBrowserCursorOverlayExpr({
      x: 200,
      y: 220,
      rect: { x: 120, y: 200, width: 160, height: 40 },
      button: "left",
      clickCount: 2,
      ripple: true,
      scrollDirection: "down",
      badge: "Click",
      idleTimeoutMs: 2600,
    }),
    sandbox,
  );
  assert.equal(showRes.ok, true);
  assert.equal(showRes.instant, false);
  assert.ok(showRes.glideDurationMs >= 70, `Expected non-zero glideDurationMs >= 70, got ${showRes.glideDurationMs}`);
  assert.equal(
    cursorHost.shadowRoot.querySelector(".ag-cursor").style.transitionDuration,
    `${showRes.glideDurationMs}ms`,
  );
  assert.equal(showRes.x, 200);
  assert.equal(showRes.y, 220);
  assert.equal(showRes.badge, null, "Browser cursor badge must be permanently null");
  assert.equal(cursorHost.shadowRoot.querySelector(".ag-badge"), null, "Zero .ag-badge elements may be rendered");
  assert.deepEqual(JSON.parse(JSON.stringify(showRes.highlightedRect)), { x: 120, y: 200, width: 160, height: 40 });

  // 3. Selector-based selectText (cursor_after) + Trusted-Types-safe HTML paste into #notes
  const selRes = vm.runInContext(
    buildSelectTextExpr("#notes", "Hello", { selectionType: "cursor_after" }),
    sandbox,
  );
  assert.equal(selRes.ok, true);
  assert.equal(notesInput.selectionStart, 5);
  assert.equal(notesInput.selectionEnd, 5);

  const pasteRes = vm.runInContext(
    buildPasteExpr("#notes", " <b>Trusted</b> &amp; Safe", "html"),
    sandbox,
  );
  assert.equal(pasteRes.ok, true);
  assert.equal(notesInput.value, "Hello Trusted & Safe World");

  // 4. Inspect live cursor state
  const state1 = vm.runInContext(buildGetBrowserCursorStateExpr(), sandbox);
  assert.equal(state1.visible, true);
  assert.equal(state1.x, 200);
  assert.equal(state1.y, 220);
  assert.equal(state1.badge, null);

  // 5. Verify BUILD_AX_SNAPSHOT_EXPR ignores #__ag_cua_cursor_host__ while indexing real elements
  const axSnap = vm.runInContext(BUILD_AX_SNAPSHOT_EXPR(), sandbox);
  const treeStr = axSnap.lines.join("\n");
  assert.match(treeStr, /\[1\] button "Submit Order"/);
  assert.doesNotMatch(treeStr, /__ag_cua_cursor_host__|Click/);

  // 6. Temporary hide/restore around clean screenshots & complete cursor removal
  const hideRes = vm.runInContext(buildSetBrowserCursorTemporarilyHiddenExpr(true), sandbox);
  assert.equal(hideRes.wasPresent, true);
  assert.equal(elementsById.get("__ag_cua_cursor_host__").style.display, "none");
  vm.runInContext(buildSetBrowserCursorTemporarilyHiddenExpr(false), sandbox);
  assert.equal(elementsById.get("__ag_cua_cursor_host__").style.display, "");

  const remRes = vm.runInContext(buildRemoveBrowserCursorExpr(), sandbox);
  assert.equal(remRes.ok, true);
  const stateAfterRemove = vm.runInContext(buildGetBrowserCursorStateExpr(), sandbox);
  assert.equal(stateAfterRemove.visible, false);
});

test("MCP Server End-to-End: cursor_control, browser_tab_action (hover/move/drag/click/include_cursor), batch_execute, and cua_repl (js) cursor APIs", async (t) => {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const { mcp, macBridge, browserManager } = createComputerUseServer({
    input: clientToServer,
    output: serverToClient,
  });

  // Wire a realistic mock CDP session on browserManager so full browser + cursor flows run without external TCP sockets
  const mockTabDom = {
    url: "https://app.example.test/dashboard",
    title: "Dashboard",
    hoveredCount: 0,
    clickedCount: 0,
    dragEvents: [],
    mouseWheelEvents: [],
    inputValue: "",
    cursorHostVisible: false,
    cursorX: 0,
    cursorY: 0,
    cursorBadge: null,
    cursorRect: null,
    cursorTempHidden: false,
  };

  const fakeConn = {
    targetSessions: new Map([["target-mock-1", "session-mock-1"]]),
    async ensureTargetSession() {
      return "session-mock-1";
    },
    async send(method, params = {}) {
      if (method === "Target.getTargetInfo") {
        return {
          targetInfo: {
            targetId: "target-mock-1",
            title: mockTabDom.title,
            url: mockTabDom.url,
          },
        };
      }
      if (method === "Input.dispatchMouseEvent") {
        if (params.type === "mouseMoved") {
          mockTabDom.hoveredCount++;
          if (params.buttons === 1) mockTabDom.dragEvents.push([params.x, params.y]);
        } else if (params.type === "mousePressed") {
          mockTabDom.clickedCount++;
          mockTabDom.dragEvents = [[params.x, params.y]];
        } else if (params.type === "mouseReleased") {
          mockTabDom.dragEvents.push([params.x, params.y]);
        } else if (params.type === "mouseWheel") {
          mockTabDom.mouseWheelEvents.push({ deltaX: params.deltaX, deltaY: params.deltaY });
        }
        return {};
      }
      if (method === "Page.captureScreenshot") {
        // Emit distinct valid JPEG payloads depending on whether the cursor overlay is hidden or visible
        const markerByte = mockTabDom.cursorHostVisible && !mockTabDom.cursorTempHidden ? 0xfe : 0xe0;
        const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, markerByte, 0x00, 0x10, 0xff, 0xd9]);
        return { data: fakeJpeg.toString("base64") };
      }
      if (method === "Runtime.evaluate") {
        const expr = String(params.expression || "");
        if (expr === "document.readyState") {
          return { result: { value: "complete" } };
        }
        if (expr.includes("__ag_cua_cursor_host__") && expr.includes("wasPresent")) {
          if (expr.includes("const hide = true")) mockTabDom.cursorTempHidden = true;
          if (expr.includes("const hide = false")) mockTabDom.cursorTempHidden = false;
          return { result: { value: { ok: true, wasPresent: mockTabDom.cursorHostVisible } } };
        }
        if (expr.includes("delete window.__agCuaCursorCtrl")) {
          mockTabDom.cursorHostVisible = false;
          return { result: { value: { ok: true } } };
        }
        if (expr.includes("const spec =")) {
          const m = /const spec = (\{[\s\S]*?\});\n/.exec(expr);
          const spec = m ? JSON.parse(m[1]) : {};
          if (spec.cursorOnlyChrome) {
            return {
              result: {
                value: {
                  ok: true,
                  visible: mockTabDom.cursorHostVisible,
                  active: Boolean(spec.sessionChrome),
                  sessionChromeActive: Boolean(spec.sessionChrome),
                },
              },
            };
          }
          mockTabDom.cursorHostVisible = true;
          mockTabDom.cursorX = Math.round(spec.x ?? 0);
          mockTabDom.cursorY = Math.round(spec.y ?? 0);
          mockTabDom.cursorBadge = null;
          mockTabDom.cursorRect = spec.rect ?? null;
          return {
            result: {
              value: {
                ok: true,
                visible: true,
                x: mockTabDom.cursorX,
                y: mockTabDom.cursorY,
                badge: mockTabDom.cursorBadge,
                highlightedRect: mockTabDom.cursorRect,
              },
            },
          };
        }
        if (expr.includes("highlightedRect: ctrl.highlightedRect")) {
          return {
            result: {
              value: mockTabDom.cursorHostVisible
                ? {
                    visible: true,
                    x: mockTabDom.cursorX,
                    y: mockTabDom.cursorY,
                    badge: mockTabDom.cursorBadge,
                    highlightedRect: mockTabDom.cursorRect,
                  }
                : { visible: false },
            },
          };
        }
        if (expr.includes('Object.defineProperty(window, "__agCuaMap"')) {
          const lines = [
            `  [1] button "Run Analytics" @(180,140 160x40)`,
            `  [2] textbox "Query" value="${mockTabDom.inputValue}" @(180,210 260x36)`,
            `  [3] region "Chart Canvas" @(400,300 400x260)`,
          ];
          return {
            result: {
              value: {
                title: mockTabDom.title,
                url: mockTabDom.url,
                viewport: { width: 1280, height: 800 },
                scroll: { x: 0, y: 0 },
                lines,
                elementCount: 3,
              },
            },
          };
        }
        if (expr.includes("const { targetSpec, focus } =")) {
          const m = /const \{ targetSpec, focus \} = (\{[\s\S]*?\});\n/.exec(expr);
          const parsed = m ? JSON.parse(m[1]) : {};
          if (parsed.targetSpec === 1 || parsed.targetSpec === "#run-btn") {
            return {
              result: {
                value: { ok: true, x: 260, y: 160, rect: { x: 180, y: 140, width: 160, height: 40 }, tag: "BUTTON" },
              },
            };
          }
          if (parsed.targetSpec === 2) {
            return {
              result: {
                value: { ok: true, x: 310, y: 228, rect: { x: 180, y: 210, width: 260, height: 36 }, tag: "INPUT" },
              },
            };
          }
          if (parsed.targetSpec === 3) {
            return {
              result: {
                value: { ok: true, x: 600, y: 430, rect: { x: 400, y: 300, width: 400, height: 260 }, tag: "DIV" },
              },
            };
          }
          return { result: { value: { ok: false, error: "Element not found" } } };
        }
        if (expr.includes("const { targetSpec, value } =")) {
          const m = /const \{ targetSpec, value \} = (\{[\s\S]*?\});\n/.exec(expr);
          const parsed = m ? JSON.parse(m[1]) : {};
          mockTabDom.inputValue = String(parsed.value ?? "");
          return {
            result: {
              value: {
                ok: true,
                value: mockTabDom.inputValue,
                x: 310,
                y: 228,
                rect: { x: 180, y: 210, width: 260, height: 36 },
              },
            },
          };
        }
        return { result: { value: { ok: true } } };
      }
      return {};
    },
    close() {},
  };

  browserManager.connections.set("ws://mock-cdp/browser", fakeConn);
  const mockTabCtrl = browserManager.getOrRegisterTabController(
    "target-mock-1",
    "iab",
    "http://127.0.0.1:0",
    "ws://mock-cdp/browser",
  );
  browserManager.discoverCDPEndpoints = async () => [
    {
      id: "iab",
      name: "Mock CDP Browser",
      family: "chromium",
      type: "iab",
      httpEndpoint: "http://127.0.0.1:0",
      wsUrl: "ws://mock-cdp/browser",
      pages: [{ id: "target-mock-1", title: mockTabDom.title, url: mockTabDom.url }],
    },
  ];

  mcp.start();

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

  let nextRpcId = 1;
  function rpc(method, params = {}) {
    const id = nextRpcId++;
    return new Promise((resolve) => {
      responses.set(id, resolve);
      clientToServer.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  t.after(async () => {
    await macBridge.cursorControl({ action: "clear_all" }).catch(() => {});
    await mcp.shutdown();
  });

  // 1. Initialize & verify all 17 MCP tools including cursor_control and browser_manage
  const initRes = await rpc("initialize", { protocolVersion: "2024-11-05" });
  assert.equal(initRes.result.serverInfo.name, "computer-use");

  const listRes = await rpc("tools/list", {});
  const toolNames = listRes.result.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("cursor_control"), "cursor_control tool must be registered");
  assert.ok(toolNames.includes("browser_manage"), "browser_manage tool must be registered");
  assert.equal(toolNames.length, 17);

  // 2. Browser hover + click + set_value + drag + scroll with virtual cursor tracking
  const hoverCall = await rpc("tools/call", {
    name: "browser_tab_action",
    arguments: { tab_id: mockTabCtrl.id, action: "hover", element_index: 1 },
  });
  assert.ok(!hoverCall.result.isError, JSON.stringify(hoverCall.result));
  assert.match(hoverCall.result.content[0].text, /cursor @\(260,160\)/);
  assert.ok(mockTabDom.hoveredCount >= 1, "hover must dispatch CDP mouseMoved");

  const tabCursorRes = await rpc("tools/call", {
    name: "cursor_control",
    arguments: { action: "get_state", tab_id: mockTabCtrl.id },
  });
  const parsedTabCursor = JSON.parse(tabCursorRes.result.content[0].text);
  assert.equal(parsedTabCursor.tabCursor.visible, true);
  assert.equal(parsedTabCursor.tabCursor.x, 260);
  assert.equal(parsedTabCursor.tabCursor.y, 160);
  assert.equal(parsedTabCursor.tabCursor.badge, null);

  // Clean screenshot vs include_cursor screenshot on browser tab
  const cleanTabShot = await rpc("tools/call", {
    name: "browser_tab_state",
    arguments: { tab_id: mockTabCtrl.id, screenshot_only: true, include_cursor: false },
  });
  const cursorTabShot = await rpc("tools/call", {
    name: "browser_tab_state",
    arguments: { tab_id: mockTabCtrl.id, screenshot_only: true, include_cursor: true },
  });
  assert.notEqual(
    cleanTabShot.result.content[1].data,
    cursorTabShot.result.content[1].data,
    "Browser screenshot with include_cursor=true must preserve cursor overlay vs clean default",
  );

  // Element-indexed drag from [1] to [3]
  const dragCall = await rpc("tools/call", {
    name: "browser_tab_action",
    arguments: {
      tab_id: mockTabCtrl.id,
      action: "drag",
      from_element_index: 1,
      to_element_index: 3,
    },
  });
  assert.ok(!dragCall.result.isError, JSON.stringify(dragCall.result));
  assert.ok(mockTabDom.dragEvents.length >= 10, "drag must interpolate intermediate mouseMoved steps");
  assert.deepEqual(mockTabDom.dragEvents.at(-1), [600, 430]);

  // 3. Heterogeneous batch_execute across native macOS cursor + browser tab action in one call
  const openWins = await macBridge.listWindows({ includeMinimized: false });
  if (openWins.length >= 1) {
    const batchRes = await rpc("tools/call", {
      name: "batch_execute",
      arguments: {
        parallel: true,
        steps: [
          {
            kind: "cursor_control",
            action: "highlight",
            window_id: openWins[0].id,
            x: 80,
            y: 65,
            width: 100,
            height: 30,
            badge: "Batch Mac",
          },
          {
            kind: "browser_tab_action",
            tab_id: mockTabCtrl.id,
            action: "set_value",
            element_index: 2,
            value: "SELECT * FROM metrics",
          },
        ],
      },
    });
    assert.equal(batchRes.result.isError, false);
    assert.equal(mockTabDom.inputValue, "SELECT * FROM metrics");
  }

  // 4. Persistent cua_repl (`js`) cursor & multi-surface API test
  const replRes1 = await rpc("tools/call", {
    name: "js",
    arguments: {
      code: `
        const tab = await cua.getBrowserTab(${JSON.stringify(mockTabCtrl.id)}, { emit: false });
        await tab.hover(1, { badge: "REPL Hover" });
        const cs = await cua.cursor.getState();
        nodeRepl.emitMarkdown("Browser cursors active: " + cs.browser.cursors.length);
      `,
    },
  });
  assert.ok(!replRes1.result.isError, JSON.stringify(replRes1.result));
  assert.match(replRes1.result.content[0].text, /Browser cursors active: 1/);

  // Verify logging/setLevel JSON-RPC method
  const logLevelRes = await rpc("logging/setLevel", { level: "info" });
  assert.deepEqual(logLevelRes.result, {});

  // Verify cua.cursor.highlight with explicit (x, y, width, height) box rect in REPL
  const replBoxRes = await rpc("tools/call", {
    name: "js",
    arguments: {
      code: `
        await cua.cursor.highlight({
          tabId: ${JSON.stringify(mockTabCtrl.id)},
          x: 100,
          y: 120,
          width: 180,
          height: 44,
          badge: "REPL Box",
        });
        const st = await cua.cursor.getState({ tabId: ${JSON.stringify(mockTabCtrl.id)} });
        nodeRepl.emitMarkdown(JSON.stringify(st.tabCursor));
      `,
    },
  });
  assert.ok(!replBoxRes.result.isError, JSON.stringify(replBoxRes.result));
  const boxCursor = JSON.parse(replBoxRes.result.content[0].text);
  assert.equal(boxCursor.x, 190);
  assert.equal(boxCursor.y, 142);
  assert.deepEqual(boxCursor.highlightedRect, { x: 100, y: 120, width: 180, height: 44 });

  // Verify cursorState idle expiry prevents leaking stale cursor metadata in getAXState
  await browserManager.configureCursor({ idleTimeoutMs: 400 });
  mockTabCtrl.cursorState.updatedAt = Date.now() - 800;
  const axAfterExpiry = await mockTabCtrl.getAXState({ disableDiffing: true });
  assert.equal(axAfterExpiry.cursor, undefined, "Expired virtual cursor must not leak into getAXState()");
  await browserManager.configureCursor({ idleTimeoutMs: 2600 });

  // Clear all cursors globally via MCP tool
  const clearAllRes = await rpc("tools/call", {
    name: "cursor_control",
    arguments: { action: "clear_all" },
  });
  const clearParsed = JSON.parse(clearAllRes.result.content[0].text);
  assert.equal(clearParsed.ok, true);
  assert.equal(mockTabDom.cursorHostVisible, false);

  // 5. Explicit MCP tool error-path tests
  const badCursorAction = await rpc("tools/call", {
    name: "cursor_control",
    arguments: { action: "explode" },
  });
  assert.equal(badCursorAction.result.isError, true);
  assert.match(badCursorAction.result.content[0].text, /Unsupported cursor_control action/i);

  const missingTargetRes = await rpc("tools/call", {
    name: "cursor_control",
    arguments: { action: "move", x: 10, y: 20 },
  });
  assert.equal(missingTargetRes.result.isError, true);
  assert.match(missingTargetRes.result.content[0].text, /requires either a macOS window target/i);

  const nanClickRes = await rpc("tools/call", {
    name: "browser_tab_action",
    arguments: { tab_id: mockTabCtrl.id, action: "click" },
  });
  assert.equal(nanClickRes.result.isError, true);
});

test("Safari / AppleEvents BrowserFallbackTabController End-to-End: JXA doJavaScript discovery, ShadowRoot cursor, click, select_text, paste, and permission error hint", async (t) => {
  // Build an in-memory VM DOM representing Safari tab safari:w1:t1
  const elementsById = new Map();
  let clickedReadMore = 0;
  const makeSafariEl = (tag, namespaceURI = "http://www.w3.org/1999/xhtml") => {
    const classSet = new Set();
    const el = {
      nodeType: 1,
      namespaceURI,
      tagName: namespaceURI === "http://www.w3.org/2000/svg" ? String(tag) : String(tag).toUpperCase(),
      id: "",
      get className() {
        return [...classSet].join(" ");
      },
      set className(val) {
        classSet.clear();
        for (const tk of String(val ?? "").split(/\s+/).filter(Boolean)) classSet.add(tk);
      },
      value: "",
      selectionStart: 0,
      selectionEnd: 0,
      classList: {
        add(...tokens) {
          for (const tk of tokens) classSet.add(tk);
        },
        remove(...tokens) {
          for (const tk of tokens) classSet.delete(tk);
        },
        contains(tk) {
          return classSet.has(tk);
        },
        toggle(tk, force) {
          const next = force === undefined ? !classSet.has(tk) : Boolean(force);
          if (next) classSet.add(tk);
          else classSet.delete(tk);
          return next;
        },
      },
      style: { cssText: "", opacity: "", transform: "", left: "", top: "", width: "", height: "", display: "" },
      dataset: {},
      attributes: new Map(),
      children: [],
      childNodes: [],
      textContent: "",
      shadowRoot: null,
      isConnected: true,
      focus() {
        safariSandbox.document.activeElement = this;
      },
      click() {
        if (this.id === "read-more") clickedReadMore++;
      },
      scrollIntoView() {},
      dispatchEvent() {
        return true;
      },
      setSelectionRange(s, e) {
        this.selectionStart = s;
        this.selectionEnd = e;
      },
      closest() {
        return null;
      },
      setAttribute(k, v) {
        this.attributes.set(k, String(v));
        if (k === "id") {
          this.id = String(v);
          elementsById.set(this.id, this);
        } else if (k === "class") {
          this.className = String(v);
        }
      },
      getAttribute(k) {
        return this.attributes.has(k) ? this.attributes.get(k) : null;
      },
      hasAttribute(k) {
        return this.attributes.has(k);
      },
      appendChild(child) {
        if (child && typeof child === "object") {
          child.parentElement = this;
          this.childNodes.push(child);
          if (child.nodeType === 1) this.children.push(child);
          if (child.id) elementsById.set(child.id, child);
        }
        return child;
      },
      append(...nodes) {
        for (const n of nodes) {
          this.appendChild(typeof n === "string" ? { nodeType: 3, tagName: "#TEXT", textContent: n } : n);
        }
      },
      remove() {
        this.isConnected = false;
        if (this.id) elementsById.delete(this.id);
        if (this.parentElement) {
          this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
          this.parentElement.childNodes = this.parentElement.childNodes.filter((c) => c !== this);
        }
      },
      attachShadow() {
        const sr = makeSafariEl("shadow-root");
        this.shadowRoot = sr;
        return sr;
      },
      querySelector(sel) {
        for (const c of this.children) {
          if (sel.startsWith(".") && c.classList.contains(sel.slice(1))) return c;
          if (sel.startsWith("#") && c.id === sel.slice(1)) return c;
          if (c.tagName.toLowerCase() === sel.toLowerCase()) return c;
          const sub = c.querySelector?.(sel);
          if (sub) return sub;
        }
        return null;
      },
      querySelectorAll(sel) {
        const out = [];
        const walk = (node) => {
          for (const c of node.children || []) {
            if (
              (sel.startsWith("#") && c.id === sel.slice(1)) ||
              (sel.startsWith(".") && c.classList.contains(sel.slice(1))) ||
              sel.split(",").some((part) => part.trim().toLowerCase() === c.tagName.toLowerCase())
            ) {
              out.push(c);
            }
            walk(c);
          }
        };
        walk(this);
        return out;
      },
      getBoundingClientRect() {
        return this._rect || { left: 60, top: 80, width: 120, height: 34, right: 180, bottom: 114 };
      },
    };
    return el;
  };

  const docEl = makeSafariEl("html");
  const bodyEl = makeSafariEl("body");
  const btnEl = makeSafariEl("button");
  btnEl.setAttribute("id", "read-more");
  btnEl.innerText = "Read More";
  btnEl.textContent = "Read More";
  btnEl._rect = { left: 100, top: 140, width: 140, height: 38, right: 240, bottom: 178 };

  const editorEl = makeSafariEl("textarea");
  editorEl.setAttribute("id", "safari-notes");
  editorEl.value = "Draft:";
  editorEl._rect = { left: 100, top: 210, width: 260, height: 70, right: 360, bottom: 280 };

  bodyEl.appendChild(btnEl);
  bodyEl.appendChild(editorEl);
  docEl.appendChild(bodyEl);

  let safariTabUrl = "https://docs.example.test/safari-guide";
  let safariTabTitle = "Safari Guide";
  let blockAppleEventsJs = false;
  const capturedJxaScripts = [];

  const safariSandbox = vm.createContext({
    window: null,
    Event: class Event {
      constructor(type, opts) {
        this.type = type;
        Object.assign(this, opts);
      }
    },
    MouseEvent: class MouseEvent {
      constructor(type, opts) {
        this.type = type;
        Object.assign(this, opts);
      }
    },
    PointerEvent: class PointerEvent {
      constructor(type, opts) {
        this.type = type;
        Object.assign(this, opts);
      }
    },
    KeyboardEvent: class KeyboardEvent {
      constructor(type, opts) {
        this.type = type;
        Object.assign(this, opts);
      }
    },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    document: {
      readyState: "complete",
      title: safariTabTitle,
      documentElement: docEl,
      body: bodyEl,
      activeElement: null,
      createElement: (tag) => makeSafariEl(tag),
      createElementNS: (ns, tag) => makeSafariEl(tag, ns),
      getElementById: (id) => elementsById.get(id) ?? null,
      elementFromPoint: () => btnEl,
      querySelector: (sel) => docEl.querySelector(sel),
      querySelectorAll: (sel) => docEl.querySelectorAll(sel),
    },
    location: { href: safariTabUrl, reload() {} },
    history: { back() {}, forward() {} },
    innerWidth: 1200,
    innerHeight: 760,
    scrollX: 0,
    scrollY: 0,
    scrollBy() {},
    CSS: { escape: (s) => String(s) },
    getComputedStyle: () => ({
      display: "block",
      visibility: "visible",
      opacity: "1",
      cursor: "pointer",
      overflowX: "visible",
      overflowY: "visible",
    }),
    requestAnimationFrame: (fn) => fn(),
    setTimeout: () => 1,
    clearTimeout: () => {},
  });
  safariSandbox.window = safariSandbox;

  const mockJxaRunner = async (jxaScript, opSpec = {}) => {
    capturedJxaScripts.push(jxaScript);
    if (opSpec.op === "list_tabs") {
      return JSON.stringify([
        {
          id: "safari",
          name: "Safari",
          kind: "safari",
          tabs: [{ id: "safari:w1:t1", windowIndex: 1, tabIndex: 1, title: safariTabTitle, url: safariTabUrl }],
        },
      ]);
    }
    if (opSpec.op === "meta") {
      assert.match(jxaScript, /Application\("Safari"\)/);
      return JSON.stringify({ title: safariTabTitle, url: safariTabUrl });
    }
    if (opSpec.op === "goto") {
      safariTabUrl = opSpec.url;
      safariSandbox.location.href = safariTabUrl;
      return JSON.stringify({ ok: true, url: safariTabUrl });
    }
    if (opSpec.op === "eval") {
      assert.match(jxaScript, /app\.doJavaScript\(/);
      if (blockAppleEventsJs) {
        throw new Error("Safari got an error: You must enable 'Allow JavaScript from Apple Events' in the Develop menu");
      }
      const val = vm.runInContext(opSpec.expression, safariSandbox);
      return JSON.stringify({ __agEvalOk: true, value: val === undefined ? null : val });
    }
    return JSON.stringify({ ok: true });
  };

  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const { mcp, browserManager } = createComputerUseServer({
    input: clientToServer,
    output: serverToClient,
    jxaRunner: mockJxaRunner,
  });
  browserManager.discoverCDPEndpoints = async () => [];
  mcp.start();

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
  function rpc(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve) => {
      responses.set(id, resolve);
      clientToServer.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  t.after(async () => {
    await mcp.shutdown();
  });

  await rpc("initialize", { protocolVersion: "2024-11-05" });

  // 1. browser_list discovers Safari fallback tab as controllable via apple_events
  const listBrowsersRes = await rpc("tools/call", {
    name: "browser_list",
    arguments: { browser_id: "safari" },
  });
  const safariInfo = JSON.parse(listBrowsersRes.result.content[0].text).browsers[0];
  assert.equal(safariInfo.id, "safari");
  assert.equal(safariInfo.tabs[0].id, "safari:w1:t1");
  assert.equal(safariInfo.tabs[0].controllable, true);
  assert.equal(safariInfo.tabs[0].controlMode, "apple_events");

  // 2. browser_tab_state inspects Safari DOM via AppleEvents doJavaScript
  const tabStateRes = await rpc("tools/call", {
    name: "browser_tab_state",
    arguments: { tab_id: "safari:w1:t1" },
  });
  assert.equal(tabStateRes.result.isError, undefined);
  assert.match(tabStateRes.result.content[0].text, /\[1\] button "Read More"/);
  assert.match(tabStateRes.result.content[0].text, /\[2\] textbox/);

  // 3. Click element [1] on Safari tab with custom cursor badge & verify ShadowRoot cursor
  const clickRes = await rpc("tools/call", {
    name: "browser_tab_action",
    arguments: {
      tab_id: "safari:w1:t1",
      action: "click",
      element_index: 1,
      badge: "Safari Click",
    },
  });
  assert.ok(!clickRes.result.isError, JSON.stringify(clickRes.result));
  assert.equal(clickedReadMore, 1);

  const safariCursorRes = await rpc("tools/call", {
    name: "cursor_control",
    arguments: { action: "get_state", tab_id: "safari:w1:t1" },
  });
  const safariCursor = JSON.parse(safariCursorRes.result.content[0].text).tabCursor;
  assert.equal(safariCursor.visible, true);
  assert.equal(safariCursor.controlMode, "apple_events");
  assert.equal(safariCursor.badge, null);
  assert.equal(safariCursor.x, 170);
  assert.equal(safariCursor.y, 159);

  // 4. Selector-based select_text (cursor_after) + HTML paste on Safari tab
  const selectRes = await rpc("tools/call", {
    name: "browser_tab_action",
    arguments: {
      tab_id: "safari:w1:t1",
      action: "select_text",
      selector: "#safari-notes",
      text: "Draft:",
      selection_type: "cursor_after",
    },
  });
  assert.ok(!selectRes.result.isError, JSON.stringify(selectRes.result));

  const pasteRes = await rpc("tools/call", {
    name: "browser_tab_action",
    arguments: {
      tab_id: "safari:w1:t1",
      action: "paste",
      selector: "#safari-notes",
      text: " <b>Ready</b>",
      format: "html",
    },
  });
  assert.ok(!pasteRes.result.isError, JSON.stringify(pasteRes.result));
  assert.equal(editorEl.value, "Draft: Ready");

  // 5. Clear all cursors clears Safari fallback tab cursor too
  await rpc("tools/call", { name: "cursor_control", arguments: { action: "clear_all" } });
  const afterClearRes = await rpc("tools/call", {
    name: "cursor_control",
    arguments: { action: "get_state", tab_id: "safari:w1:t1" },
  });
  assert.equal(JSON.parse(afterClearRes.result.content[0].text).tabCursor.visible, false);

  // 6. Verify actionable error hint if Safari "Allow JavaScript from Apple Events" is disabled
  blockAppleEventsJs = true;
  const blockedRes = await rpc("tools/call", {
    name: "browser_tab_state",
    arguments: { tab_id: "safari:w1:t1", disable_diff: true },
  });
  assert.equal(blockedRes.result.isError, true);
  assert.match(blockedRes.result.content[0].text, /Allow JavaScript from Apple Events/);
});

test("Codex Browser ShadowRoot Appearance & Physics: AgentCursor Bezier SVG, FogCursorStyle glow, clean no-pill default, curved Bezier vs scoot rAF trajectory, and momentum-preserving press spring", () => {
  const elementsById = new Map();
  const makeEl = (tag, namespaceURI = "http://www.w3.org/1999/xhtml") => {
    const classSet = new Set();
    const el = {
      nodeType: 1,
      namespaceURI,
      tagName: namespaceURI === "http://www.w3.org/2000/svg" ? String(tag) : String(tag).toUpperCase(),
      id: "",
      get className() {
        return Array.from(classSet).join(" ");
      },
      set className(val) {
        classSet.clear();
        for (const tk of String(val ?? "").split(/\s+/).filter(Boolean)) classSet.add(tk);
      },
      style: { cssText: "", opacity: "", transform: "", left: "", top: "", width: "", height: "", display: "", filter: "" },
      attributes: new Map(),
      children: [],
      childNodes: [],
      textContent: "",
      shadowRoot: null,
      isConnected: true,
      classList: {
        add(...tks) { for (const tk of tks) classSet.add(tk); },
        remove(...tks) { for (const tk of tks) classSet.delete(tk); },
        contains(tk) { return classSet.has(tk); },
        toggle(tk, force) {
          const next = force === undefined ? !classSet.has(tk) : Boolean(force);
          if (next) classSet.add(tk);
          else classSet.delete(tk);
          return next;
        },
      },
      setAttribute(k, v) {
        this.attributes.set(k, String(v));
        if (k === "id") {
          this.id = String(v);
          elementsById.set(this.id, this);
        } else if (k === "class") {
          this.className = String(v);
        }
      },
      getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; },
      appendChild(child) {
        if (child && typeof child === "object") {
          child.parentElement = this;
          this.childNodes.push(child);
          if (child.nodeType === 1) this.children.push(child);
          if (child.id) elementsById.set(child.id, child);
        }
        return child;
      },
      remove() {
        this.isConnected = false;
        if (this.id) elementsById.delete(this.id);
      },
      attachShadow() {
        const sr = makeEl("shadow-root");
        this.shadowRoot = sr;
        return sr;
      },
      querySelector(sel) {
        for (const c of this.children) {
          if (sel.startsWith(".") && c.classList.contains(sel.slice(1))) return c;
          if (sel.startsWith("#") && c.id === sel.slice(1)) return c;
          if (c.tagName.toLowerCase() === sel.toLowerCase()) return c;
          const sub = c.querySelector?.(sel);
          if (sub) return sub;
        }
        return null;
      },
      querySelectorAll(sel) {
        const out = [];
        const walk = (node) => {
          for (const c of node.children || []) {
            if (sel.startsWith(".") && c.classList.contains(sel.slice(1))) out.push(c);
            walk(c);
          }
        };
        walk(this);
        return out;
      },
    };
    Object.defineProperty(el, "innerHTML", {
      set() { throw new TypeError("TrustedHTML required"); },
    });
    return el;
  };

  const docEl = makeEl("html");
  let nowMs = 1000;
  let rafQueue = [];
  const sandbox = vm.createContext({
    window: null,
    performance: { now: () => nowMs },
    document: {
      documentElement: docEl,
      createElement: (t) => makeEl(t),
      createElementNS: (ns, t) => makeEl(t, ns),
      getElementById: (id) => elementsById.get(id) ?? null,
    },
    innerWidth: 1280,
    innerHeight: 800,
    requestAnimationFrame: (cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    },
    cancelAnimationFrame: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
  });
  sandbox.window = sandbox;

  const stepFrames = (count, dtMs = 1000 / 120) => {
    const samples = [];
    for (let i = 0; i < count; i++) {
      nowMs += dtMs;
      const batch = rafQueue.splice(0, rafQueue.length);
      for (const fn of batch) fn(nowMs);
      samples.push(vm.runInContext(buildGetBrowserCursorStateExpr(), sandbox));
    }
    return samples;
  };

  // 1. Spawn initial cursor cleanly with showBadge: false (Codex default aesthetic: no text pill)
  vm.runInContext(
    buildBrowserCursorOverlayExpr({
      x: 100,
      y: 140,
      instant: true,
      badge: "Click",
      showBadge: false,
    }),
    sandbox,
  );
  const host = elementsById.get("__ag_cua_cursor_host__");
  const sr = host.shadowRoot;
  const geomGroup = sr.querySelector(".ag-pointer-geom");
  assert.ok(geomGroup, "Expected daintier .ag-pointer-geom SVG group");
  assert.equal(geomGroup.getAttribute("transform"), "scale(0.72)", "AgentCursor must render at daintier 0.72x scale");
  const svgPath = sr.querySelector("path");
  assert.ok(svgPath, "Expected SVG <path> inside Codex AgentCursor");
  assert.match(svgPath.getAttribute("d"), /^M -2\.691 1\.684 C -1\.613 -0\.414/, "Must render exact Codex AgentCursor rounded cubic Bezier silhouette");
  assert.equal(svgPath.getAttribute("stroke"), "#FFFFFF");
  assert.equal(svgPath.getAttribute("stroke-width"), "2.78", "2.78 * 0.72 = ~2.00pt sleek white border");
  const styleEl = sr.querySelector("style");
  assert.match(styleEl.textContent, /rgba\(11,\s*158,\s*255/, "FogCursorStyle .ag-glow must render authentic sky-blue luminous mist");
  assert.match(styleEl.textContent, /width:\s*27px;\s*height:\s*27px/, "FogCursorStyle .ag-glow must use 13.5pt radius (27px diameter)");
  assert.match(styleEl.textContent, /width:\s*38px;\s*height:\s*38px[\s\S]*?border:\s*1\.6px solid/, "Click ripple .ag-ripple must use daintier 38px / 1.6px border");
  assert.ok(sr.querySelector(".ag-glow"), "Must render Codex FogCursorStyle ambient glow layer");
  assert.equal(sr.querySelector(".ag-badge"), null, "Zero .ag-badge pill elements may exist in ShadowRoot");

  // 2. Short move <= 196px uses Scoot mode; long move > 196px uses curved Bezier mode
  const scootRes = vm.runInContext(
    buildBrowserCursorOverlayExpr({ x: 210, y: 190, showBadge: false }),
    sandbox,
  );
  assert.equal(scootRes.mode, "scoot");
  stepFrames(45);

  const bezierTarget = { x: 860, y: 580 };
  const bezierStart = vm.runInContext(buildGetBrowserCursorStateExpr(), sandbox);
  const bezierRes = vm.runInContext(
    buildBrowserCursorOverlayExpr({ x: bezierTarget.x, y: bezierTarget.y, showBadge: false }),
    sandbox,
  );
  assert.equal(bezierRes.mode, "bezier");

  // Advance 18 frames at 120Hz (150ms mid-flight) -> verify curved arc & dynamic tangent rotation
  const midSamples = stepFrames(18);
  const mid = midSamples[midSamples.length - 1];
  const dx = bezierTarget.x - bezierStart.liveX;
  const dy = bezierTarget.y - bezierStart.liveY;
  const maxChordPerp = Math.max(
    ...midSamples.map((s) => Math.abs((s.liveX - bezierStart.liveX) * dy - (s.liveY - bezierStart.liveY) * dx) / Math.hypot(dx, dy)),
  );
  assert.ok(maxChordPerp > 8, `Expected mid-flight curved Bezier deviation > 8px, got ${maxChordPerp}`);
  assert.notEqual(mid.rotation, 316, "Mid-flight Bezier cursor must dynamically rotate along curve tangent");

  // 3. Trigger momentum-preserving click effect (effectOnly: true) before complete stop (CloseEnough handoff)
  const effectRes = vm.runInContext(
    buildBrowserCursorOverlayExpr({
      x: bezierTarget.x,
      y: bezierTarget.y,
      effectOnly: true,
      ripple: true,
      badge: "Explicit Pill",
      showBadge: true,
    }),
    sandbox,
  );
  assert.equal(effectRes.badge, null, "Cursor badge must remain null even when badge & showBadge=true are passed");
  assert.equal(sr.querySelector(".ag-badge"), null, "Cursor pill must never be rendered even when showBadge=true");

  const pressSamples = stepFrames(6);
  const minPressScale = Math.min(...pressSamples.map((s) => s.pressScale));
  assert.ok(minPressScale < 0.92, `Expected Codex 0.70 press spring compression (< 0.92), got ${minPressScale}`);

  // Deterministic screenshot preparation snaps animated cursor cleanly onto exact target with resting 316deg angle
  const snapShot = vm.runInContext(buildPrepareBrowserCursorForScreenshotExpr(true, { awaitFrame: false }), sandbox);
  assert.equal(snapShot.ok, true);
  assert.equal(snapShot.didPrep, true);
  const settledState = vm.runInContext(buildGetBrowserCursorStateExpr(), sandbox);
  assert.equal(settledState.visible, true);
  assert.equal(settledState.liveX, bezierTarget.x);
  assert.equal(settledState.liveY, bezierTarget.y);
  assert.equal(settledState.rotation, 316);
});

test("Native macOS Pure [x, y] Coordinate-Only Precision & Codex Cursor Aesthetics: 1:1 click/drag without element_index, >196pt Bezier glide, and clean default badge", async (t) => {
  const diffTracker = new AXDiffTracker();
  const bridge = new MacBridge({ diffTracker });
  const tmpSwiftPath = path.join(os.tmpdir(), `ag_codex_coord_${ process.pid }_${ Date.now() }.swift`);

  const swiftFixture = `
import Cocoa

class TrackView: NSView {
    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    var dragStart: NSPoint? = nil
    override func mouseDown(with event: NSEvent) {
        dragStart = convert(event.locationInWindow, from: nil)
    }
    override func mouseUp(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        if let ds = dragStart, hypot(p.x - ds.x, p.y - ds.y) > 15 {
            print("EVENT_DRAG from=(\\(Int(ds.x.rounded())),\\(Int(ds.y.rounded()))) to=(\\(Int(p.x.rounded())),\\(Int(p.y.rounded())))")
            fflush(stdout)
        }
    }
}

final class CoordFixtureDelegate: NSObject, NSApplicationDelegate {
    var win: NSWindow!
    @objc func tapA() { print("BTN_A_FIRED"); fflush(stdout) }
    @objc func tapB() { print("BTN_B_FIRED"); fflush(stdout) }

    func applicationDidFinishLaunching(_ notification: Notification) {
        win = NSWindow(contentRect: NSRect(x: 120, y: 140, width: 520, height: 340), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        win.title = "CodexCoordPrecisionTarget"
        let root = TrackView(frame: NSRect(x: 0, y: 0, width: 520, height: 340))
        let btnA = NSButton(title: "CoordBtnA", target: self, action: #selector(tapA))
        btnA.frame = NSRect(x: 30, y: 40, width: 120, height: 32)
        let btnB = NSButton(title: "CoordBtnB", target: self, action: #selector(tapB))
        btnB.frame = NSRect(x: 360, y: 240, width: 120, height: 32)
        root.addSubview(btnA)
        root.addSubview(btnB)
        win.contentView = root
        win.orderFrontRegardless()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            print("READY wid=\\(self.win.windowNumber) pid=\\(ProcessInfo.processInfo.processIdentifier)")
            fflush(stdout)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 18.0) { exit(0) }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = CoordFixtureDelegate()
app.delegate = delegate
withExtendedLifetime(delegate) { app.run() }
`;

  fs.writeFileSync(tmpSwiftPath, swiftFixture, "utf8");
  const child = spawn("/usr/bin/swift", [tmpSwiftPath]);
  let stdoutLog = "";

  t.after(async () => {
    try { child.kill("SIGTERM"); } catch {}
    try { fs.unlinkSync(tmpSwiftPath); } catch {}
    try { await bridge.cursorControl({ action: "clear_all" }); } catch {}
    bridge.close();
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for Swift coordinate fixture: ${stdoutLog}`)), 8000);
    child.stdout.on("data", (d) => {
      stdoutLog += d.toString("utf8");
      if (stdoutLog.includes("READY")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => {
      if (!stdoutLog.includes("READY")) {
        clearTimeout(timer);
        reject(new Error(`Fixture exited early (${code}): ${stdoutLog}`));
      }
    });
  });

  const wid = Number(/READY wid=(\d+)/.exec(stdoutLog)[1]);
  const wins = await bridge.listWindows({ includeMinimized: true });
  const targetWin = wins.find((w) => w.id === wid);
  assert.ok(targetWin, `Expected CodexCoordPrecisionTarget wid=${wid} in listWindows`);
  const titlebarH = targetWin.bounds.height - 340;

  // 1. Pure coordinate-only click on BtnA (no elementIndex, no badge -> clean null badge)
  const clickA = await bridge.performAction({
    windowId: wid,
    action: "click",
    x: 90,
    y: titlebarH + 56,
    coordinateOnly: true,
  });
  assert.equal(clickA.ok, true);
  assert.equal(clickA.mechanism, "coordinate");
  assert.equal(clickA.cursor.badge, null, "Codex native cursor must omit text pill by default when badge is not passed");

  // 2. Long (>196pt) curved Bezier coordinate-only click on BtnB (~385pt diagonal)
  const clickB = await bridge.performAction({
    windowId: wid,
    action: "click",
    x: 420,
    y: titlebarH + 256,
    coordinateOnly: true,
  });
  assert.equal(clickB.ok, true);
  assert.equal(clickB.mechanism, "coordinate");
  assert.equal(clickB.cursor.badge, null);

  // 3. Passing an explicit badge still suppresses the pill permanently (badge === null)
  const explicitHover = await bridge.performAction({
    windowId: wid,
    action: "hover",
    x: 260,
    y: titlebarH + 120,
    badge: "Explicit Coord Badge",
  });
  assert.equal(explicitHover.cursor.badge, null, "Native cursor pill must remain permanently suppressed even when badge is passed");

  // 3.5. Pure [x, y] move (no elementIndex, no coordinateOnly flag) & natural [x, y] click without coordinateOnly
  const moveOnlyRes = await bridge.performAction({
    windowId: wid,
    action: "move",
    x: 90,
    y: titlebarH + 56,
  });
  assert.equal(moveOnlyRes.ok, true);
  assert.equal(moveOnlyRes.cursor.badge, null, "Default move must also omit text pill when badge is omitted");

  const naturalCoordClick = await bridge.performAction({
    windowId: wid,
    action: "click",
    x: 420,
    y: titlebarH + 256,
  });
  assert.equal(naturalCoordClick.ok, true);
  assert.equal(naturalCoordClick.cursor.badge, null);

  // 4. Pure coordinate-only drag (fromX, fromY -> toX, toY) with 1:1 point precision
  const dragRes = await bridge.performAction({
    windowId: wid,
    action: "drag",
    fromX: 80,
    fromY: titlebarH + 180,
    toX: 320,
    toY: titlebarH + 180,
    steps: 14,
  });
  assert.equal(dragRes.ok, true);

  await new Promise((r) => setTimeout(r, 250));
  assert.match(stdoutLog, /BTN_A_FIRED/, "Pure [x, y] coordinate-only click must fire CoordBtnA");
  assert.match(stdoutLog, /BTN_B_FIRED/, "Long >196pt Bezier pure [x, y] coordinate-only click must fire CoordBtnB");
  assert.match(stdoutLog, /EVENT_DRAG from=\(80,180\) to=\(320,180\)/, "Pure [x, y] coordinate-only drag must land with 1:1 point accuracy");
});
