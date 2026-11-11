---
name: computer-use
description: Control macOS desktop applications, multi-window layouts, 1:1 window-relative coordinate vision, and parallel multi-app/browser workflows via the computer-use MCP server (get_state, get_window_state, window_action, manage_windows, batch_execute, and persistent cua_repl js). Use whenever inspecting, clicking, typing, pasting, dragging, or tiling macOS windows.
---

# macOS Desktop & Multi-Window Computer Use (`computer-use`)

Drive any running or background macOS application with **zero physical mouse hijacking**, **automatic clipboard preservation**, **1:1 window-relative coordinates**, and a sleek `0.72x` pill-free Codex `AgentCursor`.

## Quick Tool Selection

| Goal | Best Tool | Why |
| :--- | :--- | :--- |
| Survey desktop, permissions, windows & browsers | `get_state` | Single snapshot of TCC permissions, displays, running apps, window IDs/bounds, and open browser tabs |
| Inspect a macOS window's UI controls | `get_window_state` | Returns indexed AX tree (`[1]`, `[2]`, ...) with `@(x,y WxH)` bounds + compact line diffs on repeat calls |
| Click / type / paste / scroll / drag in an app | `window_action` | Background AX dispatch by `element_index` or 1:1 window-relative `(x, y)` without stealing focus |
| Tile, snap, resize, or close multiple windows | `manage_windows` | Built-in `tile_left_right`, `tile_grid`, `quadrants`, `cascade`, `maximize`, `center`, halves, or batch ops |
| Run 2–10 actions across apps & tabs in 1 turn | `batch_execute` | Executes heterogeneous `window_action`, `manage_windows`, and `browser_*` steps in parallel or sequence |
| Stateful loops, conditionals, `Promise.all` | `js` (`cua_repl`) | Persistent async VM exposing `cua`, `sky`, `agent.browsers`, and `nodeRepl` across turns |

> **MCP Note**: `computer-use` tools are lazy-loaded. Read `<appDataDir>/mcp/computer-use/<tool>.json` once per tool to confirm arguments, then call via `call_mcp_tool` with `ServerName: "computer-use"`.

## Core Workflow

### 1. Inspect First (`element_index` > Raw Coordinates)
1. Call `get_window_state({ app: "Calculator" })` (auto-launches in the background if not running).
2. Read the indexed Accessibility tree:
   - Prefer `window_action({ window_id, action: "click", element_index: 12 })` whenever an element has an index `[N]`. It triggers `AXPress` / `AXSetAttributeValue` / `CGEventPostToPid` directly in the background without activating the window or moving the user's physical mouse.
   - Repeated state calls return compact diffs; pass `disable_diff: true` whenever you need the complete tree again.

### 2. Unified 1:1 Coordinate Mode (Canvas, Custom Controls, Vision)
Every coordinate in `computer-use` shares the **exact same 1:1 window-relative point origin** `(0, 0)` at the window's top-left corner:
- `get_window_state({ window_id, include_screenshot: true })` returns a 1:1 point-scaled JPEG where pixel `(x, y)` equals `window_action({ window_id, action: "click", x, y })`.
- Virtual cursors are hidden from screenshots by default so vision stays clean; pass `include_cursor: true` only when the user wants to see the rendered `AgentCursor` in the image.
- For custom canvas widgets that ignore Accessibility hit-testing, pass `coordinate_only: true` (and `activate_window: true` only if the app ignores background HID events).

### 3. Clipboard-Safe Paste & Keyboard Shortcuts
- **Rich Paste**: `window_action({ window_id, action: "paste", text: "# Heading\nBody", format: "md" })` (`"text"`, `"md"`, or `"html"`). Snapshots all `NSPasteboard` items beforehand and restores the user's clipboard immediately afterward.
- **Shortcuts & Keys**: `window_action({ window_id, action: "press_key", key: "cmd+s" })`, `"Return"`, `"Escape"`, `"ctrl+shift+p"`.

### 4. One-Turn Multi-App & Multi-Tab Execution

Prefer **one** `batch_execute` or `js` call over 5 sequential round-trips:

```javascript
// Execute via tool `js` (cua_repl) — top-level bindings persist across calls!
const [calc, notes] = await Promise.all([
  cua.getApp("Calculator", { emit: false }),
  cua.getApp("Notes", { emit: false }),
]);
await cua.tileWindows([calc.windowId, notes.windowId], "tile_left_right");
await calc.getAXState();
```

## Permissions Troubleshooting
If `permissions` reports `accessibility: false` or `screenCapture: false`:
1. Call `permissions({ request: true, prompt_accessibility: true })` to surface the macOS prompt.
2. Tell the user to enable **Antigravity** under **System Settings → Privacy & Security → Accessibility** (and **Screen & System Audio Recording** for live pixel screenshots, though vector `[AX Layout Preview]` works even without Screen Recording).
