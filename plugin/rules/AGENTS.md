# Antigravity Computer Control Routing Rules

Whenever a task involves inspecting, clicking, typing, pasting, dragging, scrolling, capturing screenshots, arranging windows, or automating **any macOS desktop application** or **live browser tab** (Brave, Chrome, Edge, Arc, Vivaldi, Opera, Safari, or background Chromium):

1. **Always use the `computer-use` MCP server tools** (`get_state`, `get_window_state`, `window_action`, `manage_windows`, `launch_app`, `browser_list`, `browser_open_tab`, `browser_tab_state`, `browser_tab_action`, `browser_manage`, `cursor_control`, `batch_execute`, `js`).
   - For lazy-loaded `computer-use` tools, read the schema under `<appDataDir>/mcp/computer-use/<tool>.json` first, then invoke via `call_mcp_tool(ServerName: "computer-use", ...)`.
2. **Load the matching skill before complex workflows**:
   - Read the `computer-use` skill (`skills/computer-use/SKILL.md`) for macOS apps, multi-window layouts, 1:1 coordinate vision, `batch_execute`, and persistent `js` (`cua_repl`) orchestration.
   - Read the `browser-control` skill (`skills/browser-control/SKILL.md`) for live Brave/Chrome Extension CDP control, color-coded Tab Groups, Two-Tier file uploads, downloads, JS dialogs, console/network/cookie inspection, and session cleanup.
3. **Never improvise brittle workarounds**:
   - Never shell out to raw `osascript`, `cliclick`, `screencapture`, or Python `pyautogui` to click UI controls or hijack the user's physical mouse cursor or system clipboard.
   - Prefer `element_index` (`[1]`, `[2]`, ...) from `get_window_state` / `browser_tab_state` for non-intrusive background control; use `[x, y]` coordinates when targeting canvas/custom controls in 1:1 window/viewport space.
4. **Respect browser ownership & safety handoff**:
   - Never close or regroup a user's personal tabs unless explicitly asked; `computer-use` claims existing tabs in-place and places agent-created tabs inside a dedicated Tab Group.
   - If `[HANDOFF REQUIRED: Anti-bot/CAPTCHA challenge detected ...]` appears or a login/2FA wall requires human input, **stop immediately** — never attempt to solve or bypass a CAPTCHA. Call `browser_manage(action: "mark_tab", tab_id: ..., status: "handoff")` and ask the user to complete it.
   - Call `browser_manage(action: "finalize_session")` when finished with browser research so unmarked scratch tabs close and Chrome/Brave's debugging banner detaches cleanly.
