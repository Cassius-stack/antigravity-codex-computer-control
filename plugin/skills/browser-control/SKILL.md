---
name: browser-control
description: Control live Brave, Chrome, Edge, Arc, Vivaldi, Opera, Safari, and background Chromium tabs via the computer-use MCP server and Antigravity in Chrome extension — including Chrome Tab Groups, Two-Tier file uploads, file downloads, JS dialogs, iframes, console/network/cookie inspection, and CAPTCHA/Take-Over handoff.
---

# Browser Control & Antigravity Extension Playbook (`computer-use`)

Control the user's live Chromium browser (Brave, Chrome, Edge, Arc, Vivaldi, Opera) with **zero `--remote-debugging-port` flags**, organized **Tab Groups**, lazy debugger attachment, and full DevTools inspection.

## Browser Discovery & Modes (`browser_list`)

1. **`extension_cdp` (Preferred — "Antigravity in Chrome" unpacked Side Panel extension)**:
   - Full background CDP control over the user's live browser profile, cookies, and sessions.
   - **Docked Side Panel + Two-Way Bridge**: Clicking the **Antigravity in Chrome** toolbar icon (`Cmd+Shift+.`) opens a docked Chrome Side Panel Chat Bar alongside any webpage (powered by `agy acp --app-data-dir antigravity`). Chats started in the Chrome Side Panel sync directly into the **Antigravity Desktop App**, while Desktop App chats drive live browser tabs via this MCP bridge without cluttering Chrome's Side Panel chat list.
   - **Lazy debugger attach**: `browser_list` and `get_state` never trigger Chrome/Brave's debugging banner. A tab is attached only when inspected (`browser_tab_state`) or acted on (`browser_tab_action`).
   - If `browser_list` shows a `setupHint` on Brave/Chrome (`controlMode: "apple_events"`), tell the user the 15-second one-time step: open `brave://extensions` or `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the `extension/` folder shown in `setupHint`.
2. **`cdp` / `iab` (Raw CDP & Managed Background Chromium)**:
   - Pass `browser_id: "iab"` (or `visible: false`) to `browser_open_tab` when you want an isolated headless Chromium session without touching the user's browser window.
3. **`safari` (`browser_id: "safari"`)**:
   - Controlled via JXA/AppleEvents + macOS window fallback.

## Tab Groups, Ownership & Session Hygiene (`browser_open_tab` + `browser_manage`)

Follow strict tab hygiene whenever working in the user's live browser:

- **Open agent tabs in a color-coded Tab Group**:
  - `browser_open_tab({ urls: ["https://..."], group_title: "PR Review", group_color: "cyan" })` opens tabs in the background (`active: false` by default) inside the session's Chrome Tab Group without stealing focus.
  - Rename or recolor an active session group anytime with `browser_manage({ action: "name_session", name: "Flight Search", color: "blue" })`.
  - Organize messy user tabs (when asked!) via `browser_manage({ action: "group_tabs", tab_ids: [...], title: "Docs", color: "green", collapsed: true })`.
- **Respect user tabs (`claim_tab` in-place)**:
  - Inspecting or acting on an existing user tab automatically claims it **in-place** — it is **never** pulled into the agent's Tab Group and **never** closed by `finalize_session`.
- **Mark deliverables vs scratch tabs (`mark_tab`)**:
  - Agent-created tabs default to `"scratch"`. Keep tabs the user asked you to leave open by calling `browser_manage({ action: "mark_tab", tab_id, status: "deliverable" })` (or `await tab.markDeliverable()` in `js`).
- **Always clean up (`finalize_session`)**:
  - When finished, call `browser_manage({ action: "finalize_session" })` (or `await browser.finalize()` in `js`). This closes unmarked `"scratch"` tabs, keeps `"claimed"` / `"deliverable"` / `"handoff"` tabs intact, and detaches `chrome.debugger` so Chrome/Brave's debugging infobar disappears immediately!

## High-Power `browser_tab_action` Capabilities

- **DOM & Input**: `click`, `hover`, `move`, `set_value`, `type_text`, `press_key`, `paste` (`"text"` / `"md"` / `"html"` via synthetic `ClipboardEvent` without touching macOS clipboard), `select_text`, `scroll`, `drag`, `goto`, `back`, `forward`, `reload`, `evaluate`, `wait_for`.
- **Two-Tier File Uploads (`action: "upload_files"`)**:
  - Direct `<input type="file">`: `{ tab_id, action: "upload_files", element_index: 5, files: ["/abs/path/report.pdf"] }`.
  - Button-triggered file chooser: `{ tab_id, action: "upload_files", trigger_element_index: 8, files: ["/abs/path/avatar.png"] }`.
  - Custom drag-and-drop zones or restricted file URLs automatically fall back to Tier-2 chunked `DataTransfer` + `File` injection (`prefer_data_transfer: true` forces Tier-2).
- **Downloads (`wait_for_download` & `list_downloads`)**:
  - `{ tab_id, action: "wait_for_download", click_element_index: 14, timeout_ms: 30000 }` clicks and awaits completion across `http(s):`, `blob:`, and `data:` URLs, returning the saved path and byte size.
- **Non-Blocking JS Dialogs (`alert` / `confirm` / `prompt` / `beforeunload`)**:
  - Clicks that trigger dialogs return immediately without hanging, and `browser_tab_state` surfaces `[JS DIALOG OPEN: type="confirm" message="..."]` at the top of the snapshot.
  - Resolve with `{ tab_id, action: "handle_dialog", accept: true, prompt_text: "..." }`. `beforeunload` is auto-accepted on agent navigation/close.
- **DevTools Logs, Network, Cookies & Storage**:
  - Console & exceptions (500-entry ring buffer): `{ tab_id, action: "get_console_logs", level: "error" }`.
  - Network requests & bodies (500-entry ring buffer): `{ tab_id, action: "get_network_requests", url_filter: "/api/" }` → `{ tab_id, action: "get_network_body", request_id }`.
  - Cookies & Web Storage: `get_cookies`, `set_cookies`, `clear_cookies`, `get_storage` (`storage_type: "local" | "session"`), `set_storage`.
- **Same-Origin & Cross-Origin Iframes**:
  - Same-origin iframes are automatically indexed inline in `browser_tab_state` with accurate top-level viewport `@(x,y WxH)` coordinates.
  - For cross-origin OOPIFs in `js` (`cua_repl`), use `const frame = tab.frameLocator("iframe#checkout"); await frame.click("#pay");`.

## Safety, CAPTCHAs & User "Take Over"

- **Blocked Sensitive URLs**: Password managers (`chrome://settings/passwords`, `brave://settings/passwords`), payment settings, and sensitive local files (`file:///etc/*`, `~/.ssh/*`) are blocked by policy.
- **CAPTCHA / Anti-Bot Handoff**: If `browser_tab_state` outputs `[HANDOFF REQUIRED: Anti-bot/CAPTCHA challenge detected ...]`, **never** click, wait out, or attempt to solve it. Call `browser_manage({ action: "mark_tab", tab_id, status: "handoff" })` and ask the user to complete verification.
- **User Take Over**: If the user clicks **`[Antigravity · Take Over]`** in the tab corner or **`Cancel`** on the browser's debugging bar, the tab detaches immediately (`AGENT_TAB_DETACHED_BY_USER`). Respect the user's takeover and ask before re-attaching.
