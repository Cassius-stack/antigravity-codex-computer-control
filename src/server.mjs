#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { AXDiffTracker } from "./diff.mjs";
import { MacBridge } from "./mac-bridge.mjs";
import { BrowserManager } from "./cdp-client.mjs";
import { CUAReplRuntime } from "./cua-repl.mjs";
import { MCPStdioServer } from "./protocol.mjs";

const SERVER_INSTRUCTIONS = `Unified Computer Use & Multi-Window/Multi-Browser MCP Server (Codex + Antigravity Extension Parity).

Core Capabilities & Best Practices:
1. Non-Intrusive Background Control:
   - Prefer element_index actions (from get_window_state / browser_tab_state) over raw (x, y) coordinates.
   - Element-indexed AX actions on macOS windows and CDP actions on browser tabs operate in the background without stealing the user's mouse cursor or focus.
   - Native paste automatically snapshots and restores the user's macOS clipboard (supports "text", "md", and "html"); browser paste dispatches ClipboardEvent directly in the tab without touching the OS clipboard.
2. Extension-First Browser Control & Tab Groups:
   - Live Chromium browsers (Brave, Chrome, Edge, Arc, Vivaldi, Opera) with the "Antigravity in Chrome" unpacked extension are controlled natively via Extension CDP without requiring --remote-debugging-port.
   - Agent-created tabs open in a dedicated color-coded Chrome Tab Group (default "Antigravity" in cyan; customize via group_title / group_color in browser_open_tab or browser_manage).
   - User tabs inspected or acted on are claimed in-place (never pulled into the agent group and never closed on finalize_session). Call browser_manage action="finalize_session" when done to close scratch tabs and detach debuggers cleanly.
   - If CAPTCHA / anti-bot protection appears ([HANDOFF REQUIRED: ...]), NEVER attempt to solve it — call browser_manage action="mark_tab" status="handoff" and ask the user.
3. Multi-Window & Multi-Tab One-Click Control:
   - Use manage_windows to tile, grid, quadrant-snap, cascade, move, resize, minimize, raise, or close multiple macOS windows in a single call.
   - Use browser_open_tab with urls: [...] to open multiple grouped background tabs simultaneously.
   - Use batch_execute or js (cua_repl) to control multiple macOS app windows AND multiple browser tabs in parallel in one single tool call.
4. Smart Accessibility Diffing & Rich DevTools Inspection:
   - Repeated get_window_state / browser_tab_state calls return compact line diffs so context stays clean. Pass disable_diff: true whenever you want the full tree.
   - browser_tab_action supports Two-Tier upload_files (including DataTransfer fallback & file-chooser interception), wait_for_download / list_downloads, non-blocking JS dialogs (get_dialog / handle_dialog), console logs, network requests/bodies, cookies, and localStorage/sessionStorage.
5. Daintier Pill-Free 1:1 Virtual Cursor & Unified Coordinates:
   - Every macOS window and browser tab displays a sleek 0.72x-scale click-through Codex AgentCursor (240Hz Velocity-Verlet Scoot & curved Bezier glide, FogCursorStyle sky-blue mist, daintier click ripples, drag trail, and element highlight frame — zero badge pill clutter).
   - AX element @(x,y WxH) bounds, isolated window screenshots, and window_action (x, y) share a unified 1:1 window-relative point space.
   - Screenshots omit the cursor and active-tab Take Over indicator by default; pass include_cursor: true to composite the live cursor.`;

export function createComputerUseServer({
  input = process.stdin,
  output = process.stdout,
  macBridge: customMacBridge = null,
  browserManager: customBrowserManager = null,
  jxaRunner = null,
  extensionSockDir = null,
} = {}) {
  const diffTracker = new AXDiffTracker();
  const macBridge = customMacBridge ?? new MacBridge({ diffTracker });
  const browserManager =
    customBrowserManager ??
    new BrowserManager({ diffTracker, macBridge, jxaRunner, extensionSockDir });
  browserManager.setMacBridge?.(macBridge);
  const repl = new CUAReplRuntime({ macBridge, browserManager, diffTracker });

  async function runGetWindowState(args = {}) {
    const windowId = args.window_id ?? args.windowId;
    const app = args.app;
    const windowTitle = args.window_title ?? args.windowTitle;
    if (windowId == null && !app && !windowTitle) {
      throw new TypeError("get_window_state requires at least one of 'window_id', 'app', or 'window_title'");
    }
    const includeCursor = Boolean(args.include_cursor ?? args.includeCursor);

    if (args.screenshot_only ?? args.screenshotOnly) {
      const shotRes = await macBridge.getWindowScreenshot({
        windowId,
        app,
        windowTitle,
        includeCursor,
      });
      return {
        content: [
          {
            type: "text",
            text: `Captured screenshot for Window #${shotRes.windowId} (${shotRes.window?.title || shotRes.window?.app || ""})`,
          },
          {
            type: "image",
            data: shotRes.screenshot.base64,
            mimeType: shotRes.screenshot.mimeType || "image/jpeg",
          },
        ],
      };
    }

    const st = await macBridge.getWindowState({
      windowId,
      app,
      windowTitle,
      autoLaunch: args.auto_launch ?? args.autoLaunch ?? true,
      includeScreenshot: Boolean(args.include_screenshot ?? args.includeScreenshot),
      includeCursor,
      disableDiff: Boolean(args.disable_diff ?? args.disableDiff),
    });

    const content = [{ type: "text", text: st.stateText }];
    if (st.screenshot) {
      content.push({
        type: "image",
        data: st.screenshot.base64,
        mimeType: st.screenshot.mimeType || "image/jpeg",
      });
    }
    return { content };
  }

  async function runWindowAction(args = {}) {
    const windowId = args.window_id ?? args.windowId;
    const app = args.app;
    const windowTitle = args.window_title ?? args.windowTitle;
    if (windowId == null && !app && !windowTitle) {
      throw new TypeError("window_action requires at least one of 'window_id', 'app', or 'window_title'");
    }
    const action = String(args.action ?? "").trim().toLowerCase();
    if (!action) {
      throw new TypeError("window_action requires 'action'");
    }

    const payload = {
      ...(windowId != null ? { windowId: Number(windowId) } : {}),
      ...(app ? { app: String(app) } : {}),
      ...(windowTitle ? { windowTitle: String(windowTitle) } : {}),
      action,
      ...(args.element_index != null || args.elementIndex != null
        ? { elementIndex: Number(args.element_index ?? args.elementIndex) }
        : {}),
      ...(args.from_element_index != null || args.fromElementIndex != null
        ? { fromElementIndex: Number(args.from_element_index ?? args.fromElementIndex) }
        : {}),
      ...(args.to_element_index != null || args.toElementIndex != null
        ? { toElementIndex: Number(args.to_element_index ?? args.toElementIndex) }
        : {}),
      ...(args.x != null ? { x: Number(args.x) } : {}),
      ...(args.y != null ? { y: Number(args.y) } : {}),
      ...(args.from_x != null || args.fromX != null ? { fromX: Number(args.from_x ?? args.fromX) } : {}),
      ...(args.from_y != null || args.fromY != null ? { fromY: Number(args.from_y ?? args.fromY) } : {}),
      ...(args.to_x != null || args.toX != null ? { toX: Number(args.to_x ?? args.toX) } : {}),
      ...(args.to_y != null || args.toY != null ? { toY: Number(args.to_y ?? args.toY) } : {}),
      ...(args.mouse_button || args.mouseButton ? { mouseButton: args.mouse_button ?? args.mouseButton } : {}),
      ...(args.click_count != null || args.clickCount != null
        ? { clickCount: Number(args.click_count ?? args.clickCount) }
        : {}),
      ...(args.duration_ms != null || args.durationMs != null
        ? { durationMs: Number(args.duration_ms ?? args.durationMs) }
        : {}),
      ...(args.value !== undefined ? { value: String(args.value) } : {}),
      ...(args.text !== undefined ? { text: String(args.text) } : {}),
      ...(args.key ? { key: String(args.key) } : {}),
      ...(args.format ? { format: String(args.format) } : {}),
      ...(args.direction ? { direction: String(args.direction) } : {}),
      ...(args.pages != null ? { pages: Number(args.pages) } : {}),
      ...(args.prefix !== undefined ? { prefix: String(args.prefix) } : {}),
      ...(args.suffix !== undefined ? { suffix: String(args.suffix) } : {}),
      ...(args.selection_type || args.selectionType
        ? { selectionType: String(args.selection_type ?? args.selectionType) }
        : {}),
      ...(args.secondary_action || args.secondaryAction
        ? { secondaryAction: String(args.secondary_action ?? args.secondaryAction) }
        : {}),
      ...(args.activate_window != null ? { activateWindow: Boolean(args.activate_window) } : {}),
      ...(args.global_coordinates != null ? { globalCoordinates: Boolean(args.global_coordinates) } : {}),
      ...(args.coordinate_only != null || args.coordinateOnly != null
        ? { coordinateOnly: Boolean(args.coordinate_only ?? args.coordinateOnly) }
        : {}),
      ...(args.show_cursor != null || args.showCursor != null
        ? { showCursor: Boolean(args.show_cursor ?? args.showCursor) }
        : {}),
      ...(args.dispatch_move_event != null || args.dispatchMoveEvent != null
        ? { dispatchMoveEvent: Boolean(args.dispatch_move_event ?? args.dispatchMoveEvent) }
        : {}),
      ...(args.badge != null ? { badge: String(args.badge) } : {}),
      ...(args.ripple != null ? { ripple: Boolean(args.ripple) } : {}),
    };

    const actionRes = await macBridge.performAction(payload);
    const returnState = args.return_state ?? args.returnState ?? true;
    const includeScreenshot = Boolean(args.include_screenshot ?? args.includeScreenshot);
    const includeCursor = Boolean(args.include_cursor ?? args.includeCursor);

    const cursorNote =
      actionRes.cursor?.x != null && actionRes.cursor?.y != null
        ? ` [cursor @(${Math.round(actionRes.cursor.x)},${Math.round(actionRes.cursor.y)})]`
        : "";

    const content = [
      {
        type: "text",
        text: `Action '${action}' succeeded on Window #${actionRes.windowId ?? windowId ?? app}${actionRes.mechanism ? ` (${actionRes.mechanism})` : ""}${cursorNote}`,
      },
    ];

    if (returnState) {
      const st = await macBridge.getWindowState({
        windowId: actionRes.windowId ?? windowId,
        app,
        windowTitle,
        autoLaunch: false,
        includeScreenshot,
        includeCursor,
        disableDiff: false,
      });
      content.push({ type: "text", text: st.stateText });
      if (st.screenshot) {
        content.push({
          type: "image",
          data: st.screenshot.base64,
          mimeType: st.screenshot.mimeType || "image/jpeg",
        });
      }
    } else if (includeScreenshot) {
      const shotRes = await macBridge.getWindowScreenshot({
        windowId: actionRes.windowId ?? windowId,
        app,
        windowTitle,
        includeCursor,
      });
      content.push({
        type: "image",
        data: shotRes.screenshot.base64,
        mimeType: shotRes.screenshot.mimeType || "image/jpeg",
      });
    }

    return { content };
  }

  async function runManageWindows(args = {}) {
    const rawOps = Array.isArray(args.operations) ? args.operations : [];
    const normalizedOps = rawOps.map((op) => ({
      ...op,
      ...(op.window_id != null ? { windowId: Number(op.window_id) } : {}),
      ...(op.window_title != null ? { windowTitle: String(op.window_title) } : {}),
    }));

    const rawTargets = Array.isArray(args.targets) ? args.targets : [];
    const normalizedTargets = rawTargets.map((t) => {
      if (t && typeof t === "object" && !Array.isArray(t)) {
        return {
          ...t,
          ...(t.window_id != null ? { windowId: Number(t.window_id) } : {}),
          ...(t.window_title != null ? { windowTitle: String(t.window_title) } : {}),
        };
      }
      return t;
    });

    const results = await macBridge.manageWindows({
      operations: normalizedOps,
      layout: args.layout,
      targets: normalizedTargets,
      displayIndex: args.display_index ?? args.displayIndex ?? 0,
      gap: args.gap ?? 8,
      activate: Boolean(args.activate),
    });

    return { results };
  }

  async function runLaunchApp(args = {}) {
    const list = [];
    if (typeof args.app === "string" && args.app.trim()) {
      list.push(args.app.trim());
    }
    if (Array.isArray(args.apps)) {
      for (const a of args.apps) {
        if (typeof a === "string" && a.trim()) list.push(a.trim());
      }
    }
    if (list.length === 0) {
      throw new TypeError("launch_app requires 'app' (string) or 'apps' (non-empty string array)");
    }
    const activate = Boolean(args.activate);
    const launched = await Promise.all(list.map((app) => macBridge.launchApp({ app, activate })));
    return list.length === 1 ? launched[0] : { apps: launched };
  }

  async function resolveTabFromArgs(args = {}) {
    const tabId = args.tab_id ?? args.tabId;
    const act = String(args.action ?? "").trim().toLowerCase();
    const urlIsActionParam =
      act === "goto" || act === "wait_for_download" || act === "get_cookies" || act === "clear_cookies";
    const tabUrl = args.tab_url ?? args.tabUrl ?? (!urlIsActionParam ? args.url : undefined);
    const browser = args.browser_id ?? args.browserId;
    const sessionId = args.session_id ?? args.sessionId;
    if (tabId != null && String(tabId).trim() !== "") {
      return browserManager.getTab(String(tabId), { browser, sessionId });
    }
    if (tabUrl) {
      return browserManager.getTab({ url: String(tabUrl) }, { browser, sessionId });
    }
    throw new TypeError("Specify 'tab_id' (e.g. 'tab-1') or 'tab_url' to identify the target browser tab");
  }

  async function runBrowserOpenTab(args = {}) {
    const urls = [];
    if (Array.isArray(args.urls) && args.urls.length > 0) {
      for (const u of args.urls) {
        if (typeof u === "string" && u.trim()) urls.push(u.trim());
      }
    } else if (typeof args.url === "string" && args.url.trim()) {
      urls.push(args.url.trim());
    } else {
      urls.push("about:blank");
    }

    const browserId = args.browser_id ?? args.browserId ?? "default";
    const visible = args.visible;
    const returnState = args.return_state ?? args.returnState ?? true;
    const includeScreenshot = Boolean(args.include_screenshot ?? args.includeScreenshot);
    const includeCursor = Boolean(args.include_cursor ?? args.includeCursor);
    const groupTitle = args.group_title ?? args.groupTitle;
    const groupColor = args.group_color ?? args.groupColor;
    const sessionId = args.session_id ?? args.sessionId;
    const windowId = args.window_id ?? args.windowId;

    const createOpts = {
      ...(visible !== undefined ? { visible: Boolean(visible) } : {}),
      ...(args.active !== undefined ? { active: Boolean(args.active) } : {}),
      ...(windowId != null ? { windowId: Number(windowId) } : {}),
      ...(sessionId ? { sessionId: String(sessionId) } : {}),
      ...(groupTitle !== undefined ? { groupTitle: String(groupTitle) } : {}),
      ...(groupColor !== undefined ? { groupColor: String(groupColor) } : {}),
      ...(args.ungroup !== undefined ? { ungroup: Boolean(args.ungroup) } : {}),
    };

    const tabs = [];
    for (const u of urls) {
      tabs.push(await browserManager.createTab(browserId, u, createOpts));
    }

    const content = [];
    for (const ctrl of tabs) {
      if (returnState) {
        const ax = await ctrl.getAXState({ disableDiffing: true });
        content.push({
          type: "text",
          text: `Opened ${ctrl.id} in browser '${ctrl.browserId}':\n${ax.stateText}`,
        });
      } else {
        const meta = await ctrl.getMetadata();
        content.push({
          type: "text",
          text: JSON.stringify(meta, null, 2),
        });
      }
      if (includeScreenshot) {
        const shot = await ctrl.getScreenshot({ markOnly: !returnState, includeCursor });
        content.push({
          type: "image",
          data: shot.base64,
          mimeType: shot.mimeType,
        });
      }
    }
    return { content };
  }

  async function runBrowserTabState(args = {}) {
    const ctrl = await resolveTabFromArgs(args);
    const includeCursor = Boolean(args.include_cursor ?? args.includeCursor);
    if (args.screenshot_only ?? args.screenshotOnly) {
      const shot = await ctrl.getScreenshot({ markOnly: true, includeCursor });
      return {
        content: [
          { type: "text", text: `Captured screenshot for ${ctrl.id}` },
          { type: "image", data: shot.base64, mimeType: shot.mimeType },
        ],
      };
    }

    const ax = await ctrl.getAXState({
      disableDiffing: Boolean(args.disable_diff ?? args.disableDiff),
    });
    const content = [{ type: "text", text: ax.stateText }];
    if (args.include_screenshot ?? args.includeScreenshot) {
      const shot = await ctrl.getScreenshot({ markOnly: false, includeCursor });
      content.push({
        type: "image",
        data: shot.base64,
        mimeType: shot.mimeType,
      });
    }
    return { content };
  }

  async function runBrowserTabAction(args = {}) {
    const ctrl = await resolveTabFromArgs(args);
    const action = String(args.action ?? "").trim().toLowerCase();
    if (!action) {
      throw new TypeError("browser_tab_action requires 'action'");
    }

    const elIdx =
      args.element_index != null || args.elementIndex != null
        ? Number(args.element_index ?? args.elementIndex)
        : undefined;
    const selector = args.selector != null ? String(args.selector) : undefined;
    const showCursor =
      args.show_cursor != null || args.showCursor != null
        ? Boolean(args.show_cursor ?? args.showCursor)
        : true;
    const includeCursor = Boolean(args.include_cursor ?? args.includeCursor);
    const cursorExtra = {
      showCursor,
      ...(args.badge != null ? { badge: String(args.badge) } : {}),
      ...(args.ripple != null ? { ripple: Boolean(args.ripple) } : {}),
    };

    let actionSummary = `Executed '${action}' on ${ctrl.id}`;
    let defaultReturnState = true;

    switch (action) {
      case "click": {
        let target;
        if (elIdx != null) target = elIdx;
        else if (selector) target = selector;
        else if (args.x != null && args.y != null) target = [Number(args.x), Number(args.y)];
        else throw new TypeError("browser click requires 'element_index', 'selector', or ('x' and 'y')");

        await ctrl.click(target, {
          mouseButton: args.mouse_button ?? args.mouseButton ?? "left",
          clickCount: args.click_count ?? args.clickCount ?? 1,
          key: args.key,
          durationMs: args.duration_ms ?? args.durationMs,
          ...cursorExtra,
        });
        break;
      }

      case "hover":
      case "move": {
        let target;
        if (elIdx != null) target = elIdx;
        else if (selector) target = selector;
        else if (args.x != null && args.y != null) target = [Number(args.x), Number(args.y)];
        else throw new TypeError(`browser ${action} requires 'element_index', 'selector', or ('x' and 'y')`);

        const dispatchMove =
          args.dispatch_move_event != null || args.dispatchMoveEvent != null
            ? Boolean(args.dispatch_move_event ?? args.dispatchMoveEvent)
            : action === "hover";
        const res = await ctrl.hover(target, {
          showCursor,
          dispatchMoveEvent: dispatchMove,
          ...(args.badge != null ? { badge: String(args.badge) } : action === "move" ? { defaultBadge: "Move" } : {}),
          ripple: Boolean(args.ripple),
        });
        actionSummary = `Executed '${action}' on ${ctrl.id} [cursor @(${res.x},${res.y})]`;
        break;
      }

      case "set_value": {
        const target = elIdx ?? selector;
        if (target == null) throw new TypeError("set_value requires 'element_index' or 'selector'");
        if (args.value === undefined) throw new TypeError("set_value requires 'value'");
        await ctrl.setValue(target, String(args.value), cursorExtra);
        break;
      }

      case "type_text": {
        if (args.text === undefined) throw new TypeError("type_text requires 'text'");
        await ctrl.typeText(elIdx ?? selector ?? null, String(args.text), cursorExtra);
        break;
      }

      case "press_key": {
        if (!args.key) throw new TypeError("press_key requires 'key'");
        await ctrl.pressKey(elIdx ?? selector ?? null, String(args.key), {
          durationMs: args.duration_ms ?? args.durationMs,
          ...cursorExtra,
        });
        break;
      }

      case "paste": {
        if (args.text === undefined) throw new TypeError("paste requires 'text'");
        await ctrl.paste(elIdx ?? selector ?? null, String(args.text), {
          format: args.format ?? "text",
          ...cursorExtra,
        });
        break;
      }

      case "select_text": {
        const target = elIdx ?? selector;
        if (target == null) throw new TypeError("select_text requires 'element_index' or 'selector'");
        if (args.text === undefined) throw new TypeError("select_text requires 'text'");
        await ctrl.selectText(target, String(args.text), {
          prefix: args.prefix,
          suffix: args.suffix,
          selectionType: args.selection_type ?? args.selectionType ?? "text",
          ...cursorExtra,
        });
        break;
      }

      case "perform_secondary_action": {
        const target = elIdx ?? selector;
        if (target == null) throw new TypeError("perform_secondary_action requires 'element_index' or 'selector'");
        const sec = args.secondary_action ?? args.secondaryAction;
        if (!sec) throw new TypeError("perform_secondary_action requires 'secondary_action'");
        await ctrl.performSecondaryAction(target, String(sec), cursorExtra);
        break;
      }

      case "scroll": {
        let target = null;
        if (elIdx != null) target = elIdx;
        else if (selector) target = selector;
        else if (args.x != null && args.y != null) target = [Number(args.x), Number(args.y)];
        await ctrl.scroll(target, args.direction ?? "down", args.pages ?? 1, cursorExtra);
        break;
      }

      case "drag": {
        const fromEl = args.from_element_index ?? args.fromElementIndex;
        const toEl = args.to_element_index ?? args.toElementIndex;
        const fromSel = args.from_selector ?? args.fromSelector;
        const toSel = args.to_selector ?? args.toSelector;
        const fx = args.from_x ?? args.fromX;
        const fy = args.from_y ?? args.fromY;
        const tx = args.to_x ?? args.toX;
        const ty = args.to_y ?? args.toY;
        const fromTarget =
          fromEl != null
            ? Number(fromEl)
            : fromSel != null
              ? String(fromSel)
              : fx != null && fy != null
                ? [Number(fx), Number(fy)]
                : null;
        const toTarget =
          toEl != null
            ? Number(toEl)
            : toSel != null
              ? String(toSel)
              : tx != null && ty != null
                ? [Number(tx), Number(ty)]
                : null;
        if (fromTarget == null || toTarget == null) {
          throw new TypeError(
            "drag requires (from_x, from_y), from_element_index, or from_selector AND (to_x, to_y), to_element_index, or to_selector",
          );
        }
        await ctrl.drag(fromTarget, toTarget, cursorExtra);
        break;
      }

      case "goto": {
        if (!args.url) throw new TypeError("goto requires 'url'");
        await ctrl.goto(String(args.url));
        break;
      }

      case "back": {
        await ctrl.back();
        break;
      }

      case "forward": {
        await ctrl.forward();
        break;
      }

      case "reload": {
        await ctrl.reload();
        break;
      }

      case "close": {
        await ctrl.close();
        return {
          content: [{ type: "text", text: `Closed ${ctrl.id}` }],
        };
      }

      case "evaluate": {
        if (!args.expression) throw new TypeError("evaluate requires 'expression'");
        const val = await ctrl.evaluate(String(args.expression));
        actionSummary = `Evaluated JS on ${ctrl.id}: ${val === undefined ? "undefined" : JSON.stringify(val)}`;
        break;
      }

      case "upload_files": {
        const trigEl = args.trigger_element_index ?? args.triggerElementIndex;
        const trigSel = args.trigger_selector ?? args.triggerSelector;
        const triggerTarget =
          trigEl != null ? Number(trigEl) : trigSel != null ? String(trigSel) : null;
        const target = elIdx ?? selector ?? null;
        if (target == null && triggerTarget == null) {
          throw new TypeError(
            "upload_files requires 'element_index'/'selector' or 'trigger_element_index'/'trigger_selector'",
          );
        }
        if (!Array.isArray(args.files) || args.files.length === 0) {
          throw new TypeError("upload_files requires a non-empty 'files' array");
        }
        const upRes = await ctrl.uploadFiles(target, args.files, {
          triggerTarget,
          showCursor,
          preferDataTransfer: Boolean(args.prefer_data_transfer ?? args.preferDataTransfer),
          timeoutMs: args.timeout_ms ?? args.timeoutMs,
        });
        actionSummary = `Uploaded ${upRes?.count ?? args.files.length} file(s) on ${ctrl.id}${upRes?.tier ? ` (${upRes.tier})` : ""}`;
        break;
      }

      case "wait_for_download": {
        const clickEl = args.click_element_index ?? args.clickElementIndex ?? elIdx;
        const clickSel = args.click_selector ?? args.clickSelector ?? selector;
        const clickTarget =
          clickEl != null
            ? Number(clickEl)
            : clickSel != null
              ? String(clickSel)
              : args.x != null && args.y != null
                ? [Number(args.x), Number(args.y)]
                : null;
        const dlRes = await ctrl.waitForDownload({
          clickTarget,
          url: args.url ?? null,
          timeoutMs: Number(args.timeout_ms ?? args.timeoutMs ?? 30000),
          showCursor,
        });
        actionSummary = `Download complete on ${ctrl.id}: ${JSON.stringify(dlRes.download)}`;
        break;
      }

      case "list_downloads": {
        const downloads = await ctrl.listDownloads({ limit: args.limit ?? 30 });
        defaultReturnState = false;
        actionSummary = JSON.stringify({ downloads }, null, 2);
        break;
      }

      case "get_dialog": {
        const dlg = ctrl.getDialog();
        defaultReturnState = false;
        actionSummary = JSON.stringify(dlg, null, 2);
        break;
      }

      case "handle_dialog": {
        const dlgRes = await ctrl.handleDialog({
          accept: args.accept ?? true,
          promptText: args.prompt_text ?? args.promptText,
        });
        actionSummary = `Handled JS dialog on ${ctrl.id}: ${JSON.stringify(dlgRes)}`;
        break;
      }

      case "get_console_logs": {
        const logs = ctrl.getConsoleLogs({
          level: args.level ?? null,
          clear: Boolean(args.clear),
          limit: args.limit ?? 200,
        });
        defaultReturnState = false;
        actionSummary = JSON.stringify(logs, null, 2);
        break;
      }

      case "get_network_requests": {
        const net = ctrl.getNetworkRequests({
          urlFilter: args.url_filter ?? args.urlFilter ?? null,
          method: args.method ?? null,
          status: args.status ?? null,
          clear: Boolean(args.clear),
          limit: args.limit ?? 200,
        });
        defaultReturnState = false;
        actionSummary = JSON.stringify(net, null, 2);
        break;
      }

      case "get_network_body": {
        const reqId = args.request_id ?? args.requestId;
        if (!reqId) throw new TypeError("get_network_body requires 'request_id'");
        const bodyRes = await ctrl.getNetworkBody(String(reqId));
        defaultReturnState = false;
        actionSummary = JSON.stringify(bodyRes, null, 2);
        break;
      }

      case "get_cookies": {
        const cookieUrls = args.urls ?? (args.url ? [String(args.url)] : null);
        const ck = await ctrl.getCookies({
          urls: cookieUrls,
          domain: args.domain ?? null,
          name: args.name ?? null,
        });
        defaultReturnState = false;
        actionSummary = JSON.stringify(ck, null, 2);
        break;
      }

      case "set_cookies": {
        if (!args.cookies) throw new TypeError("set_cookies requires 'cookies'");
        const setRes = await ctrl.setCookies(args.cookies);
        defaultReturnState = false;
        actionSummary = JSON.stringify(setRes, null, 2);
        break;
      }

      case "clear_cookies": {
        const clrRes = await ctrl.clearCookies({
          url: args.url ?? null,
          domain: args.domain ?? null,
          name: args.name ?? null,
          allBrowser: Boolean(args.all_browser ?? args.allBrowser),
        });
        defaultReturnState = false;
        actionSummary = JSON.stringify(clrRes, null, 2);
        break;
      }

      case "get_storage": {
        const stType = args.storage_type ?? args.storageType ?? args.type ?? "local";
        const stRes = await ctrl.getStorage({
          type: stType,
          key: args.key ?? null,
        });
        defaultReturnState = false;
        actionSummary = JSON.stringify(stRes, null, 2);
        break;
      }

      case "set_storage": {
        const stType = args.storage_type ?? args.storageType ?? args.type ?? "local";
        const stRes = await ctrl.setStorage({
          type: stType,
          entries: args.entries ?? {},
          clear: Boolean(args.clear),
          removeKeys: args.remove_keys ?? args.removeKeys ?? [],
        });
        defaultReturnState = false;
        actionSummary = JSON.stringify(stRes, null, 2);
        break;
      }

      case "wait_for": {
        const cond = selector ?? (args.timeout_ms != null ? Number(args.timeout_ms) : 500);
        await ctrl.waitFor(cond, Number(args.timeout_ms ?? 8000));
        break;
      }

      default:
        throw new TypeError(
          `Unsupported browser_tab_action '${action}'. Supported: click, hover, move, set_value, type_text, press_key, paste, select_text, perform_secondary_action, scroll, drag, goto, back, forward, reload, close, evaluate, upload_files, wait_for_download, list_downloads, get_dialog, handle_dialog, get_console_logs, get_network_requests, get_network_body, get_cookies, set_cookies, clear_cookies, get_storage, set_storage, wait_for`,
        );
    }

    const content = [{ type: "text", text: actionSummary }];
    const returnState = args.return_state ?? args.returnState ?? defaultReturnState;
    const includeScreenshot = Boolean(args.include_screenshot ?? args.includeScreenshot);
    if (returnState) {
      const ax = await ctrl.getAXState({ disableDiffing: false });
      content.push({ type: "text", text: ax.stateText });
    }
    if (includeScreenshot) {
      const shot = await ctrl.getScreenshot({ markOnly: !returnState, includeCursor });
      content.push({
        type: "image",
        data: shot.base64,
        mimeType: shot.mimeType,
      });
    }

    return { content };
  }

  async function runCursorControl(args = {}) {
    const action = String(args.action ?? "get_state").trim().toLowerCase();
    const supported = new Set(["get_state", "move", "hover", "highlight", "hide", "clear_all", "configure"]);
    if (!supported.has(action)) {
      throw new TypeError(
        `Unsupported cursor_control action '${action}'. Supported: get_state, move, hover, highlight, hide, clear_all, configure`,
      );
    }

    const windowId = args.window_id ?? args.windowId;
    const app = args.app;
    const windowTitle = args.window_title ?? args.windowTitle;
    const hasMacTarget = windowId != null || Boolean(app) || Boolean(windowTitle);

    const tabId = args.tab_id ?? args.tabId;
    const tabUrl = args.tab_url ?? args.tabUrl;
    const hasTabTarget = Boolean(tabId) || Boolean(tabUrl);

    if (action === "configure") {
      const enabled = args.enabled;
      const idleTimeoutMs = args.idle_timeout_ms ?? args.idleTimeoutMs;
      const glideEnabled = args.glide_enabled ?? args.glideEnabled;
      const [macRes, browserRes] = await Promise.all([
        macBridge.cursorControl({
          action: "configure",
          ...(typeof enabled === "boolean" ? { enabled } : {}),
          ...(idleTimeoutMs != null ? { idleTimeoutMs: Number(idleTimeoutMs) } : {}),
          ...(typeof glideEnabled === "boolean" ? { glideEnabled } : {}),
        }),
        browserManager.configureCursor({
          ...(typeof enabled === "boolean" ? { enabled } : {}),
          ...(idleTimeoutMs != null ? { idleTimeoutMs: Number(idleTimeoutMs) } : {}),
          ...(typeof glideEnabled === "boolean" ? { glideEnabled } : {}),
        }),
      ]);
      return { ok: true, action: "configure", mac: macRes.config ?? macRes, browser: browserRes };
    }

    if (action === "clear_all") {
      const [macRes, browserRes] = await Promise.all([
        macBridge.cursorControl({ action: "clear_all" }),
        browserManager.clearAllCursors(),
      ]);
      return { ok: true, action: "clear_all", mac: macRes, browser: browserRes };
    }

    if (action === "get_state") {
      if (hasTabTarget && !hasMacTarget) {
        const ctrl = await resolveTabFromArgs(args);
        const tabCursor = await ctrl.getCursorState();
        return { ok: true, target: "browser_tab", tabCursor };
      }
      if (hasMacTarget && !hasTabTarget) {
        const macRes = await macBridge.cursorControl({
          action: "get_state",
          ...(windowId != null ? { windowId: Number(windowId) } : {}),
          ...(app ? { app: String(app) } : {}),
          ...(windowTitle ? { windowTitle: String(windowTitle) } : {}),
        });
        return { ok: true, target: "mac_window", ...macRes };
      }
      const [macRes, browserRes] = await Promise.all([
        macBridge.cursorControl({ action: "get_state" }),
        browserManager.getCursorStates(),
      ]);
      return { ok: true, mac: macRes, browser: browserRes };
    }

    if (hasTabTarget) {
      const ctrl = await resolveTabFromArgs(args);
      if (action === "hide") {
        return ctrl.hideCursor();
      }
      const elIdx =
        args.element_index != null || args.elementIndex != null
          ? Number(args.element_index ?? args.elementIndex)
          : undefined;
      const selector = args.selector != null ? String(args.selector) : undefined;
      let target;
      if (elIdx != null) target = elIdx;
      else if (selector) target = selector;
      else if (args.x != null && args.y != null) {
        const bx = Number(args.x);
        const by = Number(args.y);
        if (args.width != null && args.height != null) {
          target = [bx + Number(args.width) / 2, by + Number(args.height) / 2];
        } else {
          target = [bx, by];
        }
      } else {
        throw new TypeError(`cursor_control '${action}' on browser tab requires 'element_index', 'selector', or ('x' and 'y')`);
      }

      const explicitRect =
        args.x != null && args.y != null && args.width != null && args.height != null
          ? {
              x: Number(args.x),
              y: Number(args.y),
              width: Number(args.width),
              height: Number(args.height),
            }
          : undefined;

      if (action === "highlight") {
        return ctrl.highlight(target, {
          rect: explicitRect,
          ...(args.badge != null ? { badge: String(args.badge) } : {}),
          ripple: Boolean(args.ripple),
          dispatchMoveEvent: Boolean(args.dispatch_move_event ?? args.dispatchMoveEvent),
        });
      }
      return ctrl.hover(target, {
        rect: explicitRect,
        ...(args.badge != null ? { badge: String(args.badge) } : action === "move" ? { defaultBadge: "Move" } : {}),
        ripple: Boolean(args.ripple),
        dispatchMoveEvent:
          args.dispatch_move_event != null || args.dispatchMoveEvent != null
            ? Boolean(args.dispatch_move_event ?? args.dispatchMoveEvent)
            : action === "hover",
      });
    }

    const isGlobalMacCoords = Boolean(args.global_coordinates ?? args.globalCoordinates);
    if (hasMacTarget || isGlobalMacCoords) {
      return macBridge.cursorControl({
        action,
        ...(windowId != null ? { windowId: Number(windowId) } : {}),
        ...(app ? { app: String(app) } : {}),
        ...(windowTitle ? { windowTitle: String(windowTitle) } : {}),
        ...(args.element_index != null || args.elementIndex != null
          ? { elementIndex: Number(args.element_index ?? args.elementIndex) }
          : {}),
        ...(args.x != null ? { x: Number(args.x) } : {}),
        ...(args.y != null ? { y: Number(args.y) } : {}),
        ...(args.width != null ? { width: Number(args.width) } : {}),
        ...(args.height != null ? { height: Number(args.height) } : {}),
        ...(args.global_coordinates != null || args.globalCoordinates != null
          ? { globalCoordinates: isGlobalMacCoords }
          : {}),
        ...(args.badge != null ? { badge: String(args.badge) } : {}),
        ...(args.ripple != null ? { ripple: Boolean(args.ripple) } : {}),
        ...(args.dispatch_move_event != null || args.dispatchMoveEvent != null
          ? { dispatchMoveEvent: Boolean(args.dispatch_move_event ?? args.dispatchMoveEvent) }
          : {}),
      });
    }

    throw new TypeError(
      `cursor_control '${action}' requires either a macOS window target ('window_id', 'app', 'window_title', or 'global_coordinates: true') or a browser tab target ('tab_id' or 'tab_url')`,
    );
  }

  async function runBrowserManage(args = {}) {
    const action = String(args.action ?? "status").trim().toLowerCase();
    return browserManager.manage(action, args);
  }

  async function executeBatchStep(step, index) {
    if (!step || typeof step !== "object") {
      throw new TypeError(`Step #${index + 1} must be an object`);
    }
    const kind = String(step.kind ?? "").trim().toLowerCase();
    switch (kind) {
      case "window_action":
        return runWindowAction(step);
      case "get_window_state":
        return runGetWindowState(step);
      case "manage_windows": {
        const out = await runManageWindows(step);
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
      }
      case "launch_app": {
        const out = await runLaunchApp(step);
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
      }
      case "browser_open_tab":
        return runBrowserOpenTab(step);
      case "browser_tab_state":
        return runBrowserTabState(step);
      case "browser_tab_action":
        return runBrowserTabAction(step);
      case "browser_manage": {
        const out = await runBrowserManage(step);
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
      }
      case "cursor_control": {
        const out = await runCursorControl(step);
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
      }
      default:
        throw new TypeError(
          `Step #${index + 1} has unsupported kind '${step.kind}'. Supported kinds: window_action, get_window_state, manage_windows, launch_app, browser_open_tab, browser_tab_state, browser_tab_action, browser_manage, cursor_control`,
        );
    }
  }

  const tools = [
    {
      name: "get_state",
      description:
        "Inspect the unified desktop state in one call: macOS permissions, displays, running/installed apps, all open macOS windows with bounds & IDs, all browsers with their open tabs, and active virtual cursors.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          include_all_apps: {
            type: "boolean",
            description: "If true, include all installed /Applications bundles in addition to running apps (default false).",
          },
        },
      },
      handler: async (args) => {
        const [perms, apps, windows, browsers, macCursors, browserCursors] = await Promise.all([
          macBridge.checkPermissions(),
          macBridge.listApps({ runningOnly: !args?.include_all_apps }),
          macBridge.listWindows({ includeMinimized: true }),
          browserManager.listBrowsersWithTabs(),
          macBridge.cursorControl({ action: "get_state" }).catch(() => ({ cursors: [] })),
          browserManager.getCursorStates().catch(() => ({ cursors: [] })),
        ]);
        return {
          permissions: {
            accessibility: perms.axTrusted,
            screenCapture: perms.screenCaptureAccess,
          },
          displays: perms.displays,
          apps,
          windows,
          browsers,
          cursors: {
            mac: macCursors.cursors ?? [],
            browser: browserCursors.cursors ?? [],
          },
        };
      },
    },

    {
      name: "list_apps",
      description: "List macOS applications (running apps and/or installed /Applications bundles).",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          running_only: {
            type: "boolean",
            description: "If true, return only currently running applications.",
          },
        },
      },
      handler: async (args) => {
        const apps = await macBridge.listApps({ runningOnly: Boolean(args?.running_only) });
        return { apps };
      },
    },

    {
      name: "launch_app",
      description:
        "Launch one or multiple macOS applications by name, bundle ID, or .app path (launches in the background by default without stealing focus unless activate=true).",
      inputSchema: {
        type: "object",
        properties: {
          app: {
            type: "string",
            description: "Application name (e.g. 'Calculator', 'Notes'), bundle ID ('com.apple.Notes'), or path.",
          },
          apps: {
            type: "array",
            items: { type: "string" },
            description: "Multiple applications to launch in parallel in one call.",
          },
          activate: {
            type: "boolean",
            description: "Bring launched application(s) to foreground (default false).",
          },
        },
      },
      handler: runLaunchApp,
    },

    {
      name: "list_windows",
      description: "List open macOS windows with their window IDs, owning apps, titles, bounds, and minimized/on-screen status.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          app: {
            type: "string",
            description: "Optional filter by application name or bundle ID.",
          },
          include_minimized: {
            type: "boolean",
            description: "Include minimized windows (default true).",
          },
        },
      },
      handler: async (args) => {
        const windows = await macBridge.listWindows({
          app: args?.app,
          includeMinimized: args?.include_minimized ?? true,
        });
        return { windows };
      },
    },

    {
      name: "manage_windows",
      description:
        "Control and arrange multiple macOS windows in one click: apply automatic multi-window layouts (tile_left_right, tile_grid, quadrants, cascade, maximize, center, left_half, right_half, top_half, bottom_half) or batch explicit move/resize/minimize/unminimize/raise/activate/close operations.",
      inputSchema: {
        type: "object",
        properties: {
          layout: {
            type: "string",
            enum: [
              "tile_left_right",
              "tile_grid",
              "quadrants",
              "cascade",
              "maximize",
              "center",
              "left_half",
              "right_half",
              "top_half",
              "bottom_half",
            ],
            description: "Optional multi-window layout preset to apply to 'targets'.",
          },
          targets: {
            type: "array",
            items: {
              anyOf: [
                { type: "number" },
                { type: "string" },
                {
                  type: "object",
                  properties: {
                    window_id: { type: "number" },
                    app: { type: "string" },
                    window_title: { type: "string" },
                  },
                },
              ],
            },
            description: "Target window IDs (numbers), app names (strings), or { window_id, app, window_title } selectors for 'layout'.",
          },
          display_index: {
            type: "number",
            description: "Display index for layout preset (0 = primary display).",
          },
          gap: {
            type: "number",
            description: "Pixel gap between tiled windows (default 8).",
          },
          activate: {
            type: "boolean",
            description: "Raise arranged windows after applying layout (default false).",
          },
          operations: {
            type: "array",
            description: "Explicit per-window management operations to execute in batch.",
            items: {
              type: "object",
              required: ["action"],
              properties: {
                window_id: { type: "number" },
                app: { type: "string" },
                window_title: { type: "string" },
                action: {
                  type: "string",
                  enum: [
                    "set_bounds",
                    "move",
                    "resize",
                    "minimize",
                    "unminimize",
                    "raise",
                    "activate",
                    "close",
                    "hide_app",
                    "unhide_app",
                    "quit_app",
                  ],
                },
                x: { type: "number" },
                y: { type: "number" },
                width: { type: "number" },
                height: { type: "number" },
              },
            },
          },
        },
      },
      handler: runManageWindows,
    },

    {
      name: "get_window_state",
      description:
        "Capture the indexed Accessibility (AX) UI tree ([1], [2], ...) of any macOS window or application in the background with 1:1 window-relative @(x,y WxH) coordinates, smart diffing, and optional isolated window screenshot.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          window_id: { type: "number", description: "Target window ID from list_windows / get_state." },
          app: { type: "string", description: "Application name or bundle ID (auto-launches in background if auto_launch=true)." },
          window_title: { type: "string", description: "Optional substring match on window title." },
          auto_launch: { type: "boolean", description: "Auto-launch app in background if not running (default true)." },
          include_screenshot: { type: "boolean", description: "Include isolated 1:1 point JPEG screenshot of the window (default false)." },
          include_cursor: { type: "boolean", description: "When capturing a screenshot, composite the live virtual cursor and highlight overlay into the image (default false so screenshots stay clean)." },
          screenshot_only: { type: "boolean", description: "Return only the screenshot (resets AX diff baseline for next state call)." },
          disable_diff: { type: "boolean", description: "Force returning the full AX tree instead of a diff against previous state." },
        },
      },
      handler: runGetWindowState,
    },

    {
      name: "window_action",
      description:
        "Perform an action on a macOS window or app (click, hover, move, set_value, type_text, press_key, paste with automatic clipboard restore, scroll, drag, select_text, perform_secondary_action) with smooth 60fps virtual cursor feedback. Element-index actions operate in the background without moving the user's physical cursor.",
      inputSchema: {
        type: "object",
        required: ["action"],
        properties: {
          window_id: { type: "number", description: "Target window ID." },
          app: { type: "string", description: "Target app name or bundle ID." },
          window_title: { type: "string", description: "Optional window title substring." },
          action: {
            type: "string",
            enum: [
              "click",
              "hover",
              "move",
              "set_value",
              "type_text",
              "press_key",
              "paste",
              "scroll",
              "drag",
              "select_text",
              "perform_secondary_action",
            ],
          },
          element_index: { type: "number", description: "Element index [N] from get_window_state (preferred)." },
          from_element_index: { type: "number", description: "Optional drag start element index [N]." },
          to_element_index: { type: "number", description: "Optional drag destination element index [N]." },
          x: { type: "number", description: "Window-relative X coordinate (matches 1:1 window screenshot & AX @(x,y))." },
          y: { type: "number", description: "Window-relative Y coordinate (matches 1:1 window screenshot & AX @(x,y))." },
          from_x: { type: "number", description: "Drag start window-relative X." },
          from_y: { type: "number", description: "Drag start window-relative Y." },
          to_x: { type: "number", description: "Drag end window-relative X." },
          to_y: { type: "number", description: "Drag end window-relative Y." },
          global_coordinates: { type: "boolean", description: "Interpret (x, y) / drag / scroll coordinates as global screen points instead of window-relative points (default false)." },
          coordinate_only: { type: "boolean", description: "Force pure CGEvent coordinate dispatch on (x, y) click without Accessibility hit-test fallback (default false)." },
          activate_window: { type: "boolean", description: "Activate target window before coordinate HID events (default false)." },
          show_cursor: { type: "boolean", description: "Animate the per-window virtual cursor & highlight overlay for this action (default true)." },
          dispatch_move_event: { type: "boolean", description: "For hover/move, post a background mouseMoved event to the app PID (default true)." },
          badge: { type: "string", description: "Optional custom pill label next to the virtual cursor." },
          ripple: { type: "boolean", description: "Emit click-style ripple ring on hover/move (default false)." },
          mouse_button: { type: "string", enum: ["left", "right", "middle"] },
          click_count: { type: "number" },
          duration_ms: { type: "number", description: "Hold duration in milliseconds." },
          value: { type: "string", description: "Value string for set_value." },
          text: { type: "string", description: "Text for type_text, paste, or select_text." },
          key: { type: "string", description: "Key or chord (e.g. 'Return', 'cmd+s', 'ctrl+shift+p') for press_key or modified click." },
          format: { type: "string", enum: ["text", "md", "html"], description: "Paste format (default 'text')." },
          direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Scroll direction." },
          pages: { type: "number", description: "Scroll distance in pages (default 1)." },
          prefix: { type: "string", description: "Disambiguating prefix for select_text." },
          suffix: { type: "string", description: "Disambiguating suffix for select_text." },
          selection_type: { type: "string", enum: ["text", "cursor_before", "cursor_after"] },
          secondary_action: { type: "string", description: "AX action name (e.g. 'ShowMenu', 'Increment', 'Decrement', 'Expand', 'Collapse')." },
          return_state: { type: "boolean", description: "Automatically return updated AX state diff after action (default true)." },
          include_screenshot: { type: "boolean", description: "Include updated window screenshot (default false)." },
          include_cursor: { type: "boolean", description: "Include virtual cursor overlay in returned screenshot (default false)." },
        },
      },
      handler: runWindowAction,
    },

    {
      name: "browser_list",
      description: "List all available browsers (live CDP browsers, managed background 'iab' Chromium, Safari/Chrome/Brave/Edge) and their open tabs.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          browser_id: {
            type: "string",
            description: "Optional filter by browser ID or name.",
          },
        },
      },
      handler: async (args) => {
        const browsers = await browserManager.listBrowsersWithTabs({ forceRefresh: true });
        if (args?.browser_id) {
          const q = String(args.browser_id).toLowerCase();
          return {
            browsers: browsers.filter(
              (b) => b.id.toLowerCase() === q || b.name.toLowerCase().includes(q),
            ),
          };
        }
        return { browsers };
      },
    },

    {
      name: "browser_open_tab",
      description:
        "Open one or multiple controllable browser tabs in the background (uses live Antigravity Extension Chrome Tab Group when connected, or auto-connects to CDP / auto-launches Chromium, or opens Safari tabs when browser_id='safari') and return their indexed DOM/AX trees.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to open in a new tab." },
          urls: {
            type: "array",
            items: { type: "string" },
            description: "Multiple URLs to open concurrently in separate tabs in one call.",
          },
          browser_id: {
            type: "string",
            description:
              "Target browser ('default' prefers live Antigravity Extension browser, then CDP, then managed Chromium; 'brave'/'chrome'/'edge'/'arc' targets that browser; 'iab' forces background managed browser; 'safari' opens in Safari).",
          },
          visible: {
            type: "boolean",
            description: "If false on 'default'/'iab', runs in headless background browser; if true, opens in a visible browser window.",
          },
          active: {
            type: "boolean",
            description: "When opening in an extension browser, bring the new tab to the foreground (default false so the user's active tab is undisturbed).",
          },
          window_id: {
            type: "number",
            description: "Optional Chrome windowId to open the tab inside.",
          },
          session_id: {
            type: "string",
            description: "Logical session ID for grouping agent-created tabs (default 'default').",
          },
          group_title: {
            type: "string",
            description: "Tab Group title for newly created extension tabs (default 'Antigravity').",
          },
          group_color: {
            type: "string",
            enum: ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"],
            description: "Tab Group color for newly created extension tabs (default 'cyan').",
          },
          ungroup: {
            type: "boolean",
            description: "If true, do not place the newly created extension tab into a Tab Group.",
          },
          return_state: { type: "boolean", description: "Return initial indexed AX state for each opened tab (default true)." },
          include_screenshot: { type: "boolean", description: "Include initial live CDP JPEG screenshot(s) (default false)." },
          include_cursor: { type: "boolean", description: "Composite in-tab virtual cursor overlay in screenshot (default false)." },
        },
      },
      handler: runBrowserOpenTab,
    },

    {
      name: "browser_tab_state",
      description:
        "Inspect a browser tab's indexed DOM/Accessibility tree ([1], [2], ...) and/or capture a live background JPEG screenshot via CDP (works even when minimized or occluded, with zero Screen Recording permission required).",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          tab_id: { type: "string", description: "Tab ID (e.g. 'tab-1' or 'safari:w1:t1') from browser_list / browser_open_tab." },
          tab_url: { type: "string", description: "Alternative: match an open controllable tab by URL." },
          browser_id: { type: "string", description: "Optional browser filter when matching by tab_url." },
          include_screenshot: { type: "boolean", description: "Include live CDP JPEG screenshot (default false)." },
          include_cursor: { type: "boolean", description: "Keep the in-tab virtual cursor & highlight visible in the captured screenshot (default false so screenshots stay clean)." },
          screenshot_only: { type: "boolean", description: "Return only the screenshot (resets AX diff baseline)." },
          disable_diff: { type: "boolean", description: "Return the full DOM/AX tree instead of a diff." },
        },
      },
      handler: runBrowserTabState,
    },

    {
      name: "browser_tab_action",
      description:
        "Operate any browser tab in the background via Extension CDP, raw CDP, or AppleEvents without stealing focus (with live 0.72x in-tab virtual cursor, click ripples, and element highlight): click, hover, move, set_value, type_text, press_key, paste (text/md/html without touching OS clipboard), select_text, perform_secondary_action, scroll, drag, goto, back, forward, reload, close, evaluate, upload_files (Two-Tier CDP + DataTransfer fallback), wait_for_download, list_downloads, get_dialog, handle_dialog, get_console_logs, get_network_requests, get_network_body, get_cookies, set_cookies, clear_cookies, get_storage, set_storage, wait_for.",
      inputSchema: {
        type: "object",
        required: ["action"],
        properties: {
          tab_id: { type: "string", description: "Tab ID (e.g. 'tab-1' or 'safari:w1:t1')." },
          tab_url: { type: "string", description: "Alternative: match an open tab by URL." },
          browser_id: { type: "string", description: "Optional browser filter when matching by tab_url." },
          action: {
            type: "string",
            enum: [
              "click",
              "hover",
              "move",
              "set_value",
              "type_text",
              "press_key",
              "paste",
              "select_text",
              "perform_secondary_action",
              "scroll",
              "drag",
              "goto",
              "back",
              "forward",
              "reload",
              "close",
              "evaluate",
              "upload_files",
              "wait_for_download",
              "list_downloads",
              "get_dialog",
              "handle_dialog",
              "get_console_logs",
              "get_network_requests",
              "get_network_body",
              "get_cookies",
              "set_cookies",
              "clear_cookies",
              "get_storage",
              "set_storage",
              "wait_for",
            ],
          },
          element_index: { type: "number", description: "Element index [N] from browser_tab_state." },
          from_element_index: { type: "number", description: "Optional drag start element index [N]." },
          to_element_index: { type: "number", description: "Optional drag destination element index [N]." },
          trigger_element_index: { type: "number", description: "For upload_files: button element index [N] that opens a file chooser dialog." },
          click_element_index: { type: "number", description: "For wait_for_download: element index [N] to click to start the download." },
          selector: { type: "string", description: "CSS selector, 'text=...', or 'role=...' target." },
          from_selector: { type: "string", description: "Optional drag start selector." },
          to_selector: { type: "string", description: "Optional drag destination selector." },
          trigger_selector: { type: "string", description: "For upload_files: CSS/text selector of button that opens a file chooser dialog." },
          click_selector: { type: "string", description: "For wait_for_download: CSS/text selector to click to start the download." },
          x: { type: "number", description: "Viewport X coordinate." },
          y: { type: "number", description: "Viewport Y coordinate." },
          from_x: { type: "number" },
          from_y: { type: "number" },
          to_x: { type: "number" },
          to_y: { type: "number" },
          show_cursor: { type: "boolean", description: "Animate the in-tab virtual cursor & highlight overlay for this action (default true)." },
          dispatch_move_event: { type: "boolean", description: "For hover/move, dispatch mouseMoved event (default true for hover, false for move)." },
          ripple: { type: "boolean", description: "Emit click-style ripple ring on hover/move (default false)." },
          mouse_button: { type: "string", enum: ["left", "right", "middle"] },
          click_count: { type: "number" },
          duration_ms: { type: "number" },
          value: { type: "string", description: "Value for set_value." },
          text: { type: "string", description: "Text for type_text, paste, or select_text." },
          key: { type: "string", description: "Key or chord (e.g. 'Return', 'super+k', 'Tab')." },
          format: { type: "string", enum: ["text", "md", "html"] },
          direction: { type: "string", enum: ["up", "down", "left", "right"] },
          pages: { type: "number" },
          prefix: { type: "string" },
          suffix: { type: "string" },
          selection_type: { type: "string", enum: ["text", "cursor_before", "cursor_after"] },
          secondary_action: { type: "string", description: "Secondary action ('ShowMenu', 'Expand', 'Collapse', 'Increment', 'Decrement')." },
          url: { type: "string", description: "Target URL for action='goto', 'wait_for_download', 'get_cookies', or 'clear_cookies'." },
          urls: { type: "array", items: { type: "string" }, description: "URLs filter for action='get_cookies'." },
          expression: { type: "string", description: "JavaScript expression for action='evaluate'." },
          files: { type: "array", items: { type: "string" }, description: "Local file paths for action='upload_files'." },
          prefer_data_transfer: { type: "boolean", description: "For upload_files: force Tier-2 in-page DataTransfer File construction." },
          accept: { type: "boolean", description: "For handle_dialog: true to accept/OK, false to dismiss/Cancel (default true)." },
          prompt_text: { type: "string", description: "For handle_dialog: text to enter into window.prompt()." },
          level: { type: "string", description: "For get_console_logs: optional level filter ('log', 'warn', 'error', 'info', 'debug')." },
          url_filter: { type: "string", description: "For get_network_requests: case-insensitive URL substring filter." },
          method: { type: "string", description: "For get_network_requests: HTTP method filter (e.g. 'GET', 'POST')." },
          status: { type: "number", description: "For get_network_requests: HTTP status code filter (e.g. 200, 500)." },
          request_id: { type: "string", description: "For get_network_body: requestId from get_network_requests." },
          domain: { type: "string", description: "Cookie domain filter for get_cookies / clear_cookies." },
          name: { type: "string", description: "Cookie name filter for get_cookies / clear_cookies." },
          cookies: {
            type: "array",
            description: "Cookies array ({ name, value, url?, domain?, path?, secure?, httpOnly?, sameSite?, expires? }) for set_cookies.",
            items: { type: "object", additionalProperties: true },
          },
          all_browser: { type: "boolean", description: "For clear_cookies on non-extension CDP browsers: clear all browser cookies." },
          storage_type: { type: "string", enum: ["local", "session"], description: "For get_storage / set_storage: 'local' or 'session' (default 'local')." },
          key: { type: "string", description: "Key chord for press_key/click, OR single storage key for get_storage." },
          entries: { type: "object", additionalProperties: true, description: "Key-value map to write for set_storage." },
          remove_keys: { type: "array", items: { type: "string" }, description: "Keys to remove for set_storage." },
          clear: { type: "boolean", description: "Clear buffer/storage for get_console_logs, get_network_requests, or set_storage." },
          limit: { type: "number", description: "Max entries to return for list_downloads, get_console_logs, or get_network_requests." },
          timeout_ms: { type: "number", description: "Timeout in ms for wait_for, upload_files, or wait_for_download." },
          return_state: { type: "boolean", description: "Automatically return updated AX state diff after action (default true for mutations, false for inspection queries)." },
          include_screenshot: { type: "boolean", description: "Include updated live screenshot (default false)." },
          include_cursor: { type: "boolean", description: "Include virtual cursor overlay in returned screenshot (default false)." },
        },
      },
      handler: runBrowserTabAction,
    },

    {
      name: "browser_manage",
      description:
        "Manage browser sessions, Chrome Tab Groups, tab ownership/lifecycle, history, and bookmarks via the Antigravity Browser Extension bridge: status, list_tab_groups, create_tab_group, group_tabs, update_tab_group, name_session, ungroup_tabs, claim_tab (in-place without moving user's tab), mark_tab ('deliverable' | 'handoff' | 'scratch'), finalize_session (closes scratch tabs + detaches debuggers so Chrome/Brave banner vanishes), search_history, list_bookmarks, create_bookmark.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "status",
              "list_tab_groups",
              "create_tab_group",
              "group_tabs",
              "update_tab_group",
              "name_session",
              "ungroup_tabs",
              "claim_tab",
              "mark_tab",
              "finalize_session",
              "search_history",
              "list_bookmarks",
              "create_bookmark",
            ],
            description: "Browser management operation (default 'status').",
          },
          browser_id: { type: "string", description: "Optional target extension browser ID or brand (e.g. 'brave', 'chrome', 'ext-brave')." },
          session_id: { type: "string", description: "Agent session ID (default 'default')." },
          tab_id: { type: "string", description: "Single tab ID (e.g. 'tab-1' or numeric Chrome tabId) for claim_tab / mark_tab / group_tabs." },
          tab_ids: {
            type: "array",
            items: { anyOf: [{ type: "string" }, { type: "number" }] },
            description: "Tab IDs (e.g. ['tab-1', 'tab-2'] or Chrome tabIds) for create_tab_group / group_tabs / ungroup_tabs.",
          },
          group_id: { type: "number", description: "Existing Chrome Tab Group ID for group_tabs or update_tab_group." },
          window_id: { type: "number", description: "Optional Chrome windowId filter/target." },
          title: { type: "string", description: "Title for Tab Group or bookmark." },
          name: { type: "string", description: "Session / Tab Group name for name_session or group_tabs." },
          color: {
            type: "string",
            enum: ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"],
            description: "Tab Group color.",
          },
          collapsed: { type: "boolean", description: "Collapse or expand the Tab Group." },
          status: {
            type: "string",
            enum: ["deliverable", "handoff", "scratch"],
            description: "Tab lifecycle status for action='mark_tab'.",
          },
          activate: { type: "boolean", description: "For mark_tab status='handoff': focus the tab for the user (default true on handoff)." },
          close_scratch_tabs: { type: "boolean", description: "For finalize_session: close unmarked agent-created scratch tabs (default true)." },
          detach_all: { type: "boolean", description: "For finalize_session: detach chrome.debugger from all attached tabs across sessions." },
          query: { type: "string", description: "Search query for search_history or list_bookmarks." },
          url: { type: "string", description: "Bookmark URL for create_bookmark." },
          parent_id: { type: "string", description: "Optional parent bookmark folder ID for create_bookmark." },
          max_results: { type: "number", description: "Max results for search_history (default 25)." },
          count: { type: "number", description: "Max recent bookmarks for list_bookmarks when query is omitted (default 25)." },
        },
      },
      handler: runBrowserManage,
    },

    {
      name: "cursor_control",
      description:
        "Inspect, move, hover, highlight, hide, clear, or configure the Codex-style visual cursor & element bounding-box overlays across macOS windows (native 60fps AppKit overlay windows) and browser tabs (ShadowRoot CSS overlays).",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["get_state", "move", "hover", "highlight", "hide", "clear_all", "configure"],
            description: "Cursor operation (default 'get_state').",
          },
          window_id: { type: "number", description: "Target macOS window ID." },
          app: { type: "string", description: "Target macOS application name or bundle ID." },
          window_title: { type: "string", description: "Target macOS window title substring." },
          tab_id: { type: "string", description: "Target browser tab ID (e.g. 'tab-1')." },
          tab_url: { type: "string", description: "Target browser tab URL match." },
          element_index: { type: "number", description: "Target AX/DOM element index [N] to glide to or highlight." },
          selector: { type: "string", description: "CSS or 'text=...' selector when targeting a browser tab." },
          x: { type: "number", description: "Window-relative (or viewport) X coordinate." },
          y: { type: "number", description: "Window-relative (or viewport) Y coordinate." },
          width: { type: "number", description: "Optional highlight box width when specifying (x, y)." },
          height: { type: "number", description: "Optional highlight box height when specifying (x, y)." },
          global_coordinates: { type: "boolean", description: "Interpret macOS (x, y) as global screen coordinates instead of window-relative." },
          badge: { type: "string", description: "Optional frosted pill badge label next to the cursor (e.g. 'Inspect', 'Click', 'Target')." },
          ripple: { type: "boolean", description: "Emit an expanding concentric ripple ring at the target." },
          dispatch_move_event: { type: "boolean", description: "Also post a background mouseMoved event to the target window/tab." },
          enabled: { type: "boolean", description: "For action='configure': enable or disable virtual cursor overlays globally." },
          idle_timeout_ms: { type: "number", description: "For action='configure': idle auto-fade timeout in milliseconds (400–30000, default 8000)." },
          glide_enabled: { type: "boolean", description: "For action='configure': enable smooth cursor glide animations vs instant jumps." },
        },
      },
      handler: runCursorControl,
    },

    {
      name: "batch_execute",
      description:
        "Execute multiple operations across ANY combination of macOS windows, window layouts, app launches, virtual cursors, and multiple browser tabs in ONE single click/call (parallel by default).",
      inputSchema: {
        type: "object",
        required: ["steps"],
        properties: {
          parallel: {
            type: "boolean",
            description: "Run all steps concurrently via Promise.allSettled (default true). Set false for strict sequential order.",
          },
          stop_on_error: {
            type: "boolean",
            description: "When parallel=false, stop remaining steps if a step fails (default false).",
          },
          steps: {
            type: "array",
            description:
              "Heterogeneous steps to execute. Each item specifies 'kind' ('window_action', 'get_window_state', 'manage_windows', 'launch_app', 'browser_open_tab', 'browser_tab_state', 'browser_tab_action', 'browser_manage', 'cursor_control') plus that tool's parameters.",
            items: {
              type: "object",
              required: ["kind"],
              properties: {
                kind: {
                  type: "string",
                  enum: [
                    "window_action",
                    "get_window_state",
                    "manage_windows",
                    "launch_app",
                    "browser_open_tab",
                    "browser_tab_state",
                    "browser_tab_action",
                    "browser_manage",
                    "cursor_control",
                  ],
                },
              },
              additionalProperties: true,
            },
          },
        },
      },
      handler: async (args) => {
        const steps = args?.steps;
        if (!Array.isArray(steps) || steps.length === 0) {
          throw new TypeError("batch_execute requires a non-empty 'steps' array");
        }
        const parallel = args?.parallel ?? true;
        const stopOnError = Boolean(args?.stop_on_error);
        const combinedContent = [];
        let errorCount = 0;

        if (parallel) {
          const settled = await Promise.allSettled(steps.map((step, i) => executeBatchStep(step, i)));
          settled.forEach((res, i) => {
            if (res.status === "fulfilled") {
              combinedContent.push({ type: "text", text: `--- [Step ${i + 1}: ${steps[i]?.kind} OK] ---` });
              for (const item of res.value.content ?? []) {
                combinedContent.push(item);
              }
            } else {
              errorCount++;
              combinedContent.push({
                type: "text",
                text: `--- [Step ${i + 1}: ${steps[i]?.kind} ERROR] ---\n${res.reason?.message || String(res.reason)}`,
              });
            }
          });
        } else {
          for (let i = 0; i < steps.length; i++) {
            try {
              const val = await executeBatchStep(steps[i], i);
              combinedContent.push({ type: "text", text: `--- [Step ${i + 1}: ${steps[i]?.kind} OK] ---` });
              for (const item of val.content ?? []) {
                combinedContent.push(item);
              }
            } catch (err) {
              errorCount++;
              combinedContent.push({
                type: "text",
                text: `--- [Step ${i + 1}: ${steps[i]?.kind} ERROR] ---\n${err?.message || String(err)}`,
              });
              if (stopOnError) break;
            }
          }
        }

        return {
          isError: errorCount === steps.length,
          content: combinedContent,
        };
      },
    },

    {
      name: "js",
      description:
        "Codex-identical persistent JavaScript REPL (cua_repl). Top-level bindings persist across calls. Exposes `cua` (getState, getApp, launchApp, getWindowState, manageWindows, createBrowserTab, getBrowserTab, getBrowser, cursor), `sky` (Sky macOS Window & Desktop APIs), `agent.browsers`, and `nodeRepl` (emitImage, emitMarkdown, write). Ideal for complex multi-window & multi-tab workflows with Promise.all.",
      inputSchema: {
        type: "object",
        required: ["code"],
        properties: {
          code: {
            type: "string",
            description: "Top-level async JavaScript statements to run in the persistent cua_repl context.",
          },
          timeout_ms: {
            type: "number",
            description: "Execution timeout in milliseconds (default 45000).",
          },
        },
      },
      handler: async (args) => {
        const blocks = await repl.execute(args?.code, args?.timeout_ms ?? 45000);
        return { content: blocks };
      },
    },

    {
      name: "js_reset",
      description: "Reset the persistent JavaScript REPL context (`js`) and clear cached Accessibility diff baselines.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async () => {
        repl.reset();
        return "Reset cua_repl JavaScript VM context and diff baselines.";
      },
    },

    {
      name: "permissions",
      description: "Check or request macOS Accessibility and Screen Recording TCC permissions.",
      inputSchema: {
        type: "object",
        properties: {
          request: {
            type: "boolean",
            description: "If true, trigger macOS system permission prompt(s) for missing permissions.",
          },
          prompt_accessibility: {
            type: "boolean",
            description: "Prompt for Accessibility access when request=true (default true).",
          },
          prompt_screen_capture: {
            type: "boolean",
            description: "Prompt for Screen Recording access when request=true (default false).",
          },
        },
      },
      handler: async (args) => {
        if (args?.request) {
          return macBridge.requestPermissions({
            promptAX: args.prompt_accessibility ?? true,
            promptScreenCapture: args.prompt_screen_capture ?? false,
          });
        }
        return macBridge.checkPermissions();
      },
    },
  ];

  const mcp = new MCPStdioServer({
    name: "computer-use",
    version: "2.0.0",
    instructions: SERVER_INSTRUCTIONS,
    tools,
    input,
    output,
    onClose: async () => {
      macBridge.close();
      browserManager.closeAll();
    },
  });

  return { mcp, macBridge, browserManager, repl, diffTracker };
}

// Run stdio server when invoked directly as an executable/script
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    const realEntry = fs.realpathSync(process.argv[1]);
    const realSelf = fs.realpathSync(new URL(import.meta.url));
    return realEntry === realSelf;
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
})();

if (isMain) {
  const { mcp } = createComputerUseServer();
  const cleanExit = () => {
    void mcp.shutdown().finally(() => process.exit(0));
  };
  process.on("SIGINT", cleanExit);
  process.on("SIGTERM", cleanExit);
  mcp.start();
}
