# Antigravity Codex Computer Control (`computer-use` MCP + Browser Extension + Plugin)

A **100% self-contained, zero-npm-dependency** macOS Desktop + Browser Computer-Use MCP server, **"Antigravity in Chrome"** MV3 Extension, and **First-Class Antigravity Plugin** built for **Google Antigravity** on MacBooks (Apple Silicon `M1`/`M2`/`M3`/`M4` & Intel).

It gives every Antigravity chat full control over **macOS apps, multi-window layouts, and live browser tabs (Brave, Chrome, Edge, Arc, Vivaldi, Opera, Safari)**—with **1:1 OpenAI Codex Computer Use (`@oai/cua`, `@oai/sky`, `cua_repl`) parity**, Chrome **Tab Groups**, **Two-Tier file uploads**, **downloads**, **DevTools console/network/cookie inspection**, and a sleek **`0.72x` pill-free fluid virtual cursor** that never hijacks your physical mouse pointer.

---

## Requirements

- **macOS 13.0+** (macOS 14.0 Sonoma+ recommended for `ScreenCaptureKit` background window pixel capture)
- **Google Antigravity** installed on your MacBook
- **Node.js `>= 22.0.0`** (uses built-in `WebSocket`, `fetch`, `node:net`, `node:vm`, and `node:test` — **zero `npm install` packages required!**)
  - Check with `node -v`. If missing or older than v22, run: `brew install node` (or `nvm install 22`).
- *(Optional)* **Xcode Command Line Tools** (`xcode-select --install`) if you want to recompile `native/MacCUAHelper.swift` from source. A prebuilt **Universal (`arm64` + `x86_64`)** binary is already included at `bin/mac-cua-helper`.

---

## Installation (Pick Option A or Option B)

### Option A — Zero-Terminal Setup (Ask Antigravity to Install It!)

Open **Antigravity** on your MacBook and paste this directly into a chat:

> Clone `https://github.com/Cassius-stack/antigravity-codex-computer-control.git` into `~/antigravity-codex-computer-control`, run `chmod +x install.sh && ./install.sh`, verify all 17 MCP tools pass, and tell me which macOS permissions and unpacked browser extension step to complete.

*(For AI Agents reading this repository: simply run `bash ./install.sh --no-prompt-permissions` inside the repository root. It automatically locates Node >= 22, builds or de-quarantines `bin/mac-cua-helper`, installs NativeMessagingHosts for Brave/Chrome/Edge/Arc/Vivaldi/Opera, installs the `antigravity-computer-use` plugin bundle into `~/.gemini/config/plugins/antigravity-computer-use/`, merges `"computer-use"` into `~/.gemini/config/mcp_config.json`, and verifies all 17 tools over stdio.)*

---

### Option B — 1-Command Terminal Install

1. Clone this repository anywhere permanent on your MacBook:
   ```bash
   git clone https://github.com/Cassius-stack/antigravity-codex-computer-control.git ~/antigravity-codex-computer-control
   cd ~/antigravity-codex-computer-control
   ```
2. Run the turnkey installer:
   ```bash
   chmod +x install.sh uninstall.sh
   ./install.sh
   ```

`./install.sh` automatically:
1. Removes any macOS Gatekeeper quarantine flags (if downloaded as a `.zip` or via AirDrop).
2. Locates your `node` (`>= 22`) binary across `PATH`, Homebrew (`/opt/homebrew/bin`), `nvm`, `fnm`, `volta`, `asdf`, and `mise`.
3. Rebuilds `bin/mac-cua-helper` natively if `swiftc` is installed (or uses the bundled Universal `arm64` + `x86_64` binary).
4. Generates the local `bin/antigravity-native-host` shim and installs `com.antigravity.browser_bridge.json` into `NativeMessagingHosts` for **Brave, Google Chrome, Chrome Canary, Chromium, Microsoft Edge, Arc, Vivaldi, and Opera**.
5. Installs/updates the **Antigravity Computer Control** plugin (`rules/AGENTS.md` + `computer-use` & `browser-control` skills) in `~/.gemini/config/plugins/antigravity-computer-use/`.
6. Registers `"computer-use"` inside `~/.gemini/config/mcp_config.json` (preserving any other MCP servers you already have) and verifies all **17 tools** over stdio.

---

## 15-Second "Antigravity in Chrome / Brave" Unpacked Extension Setup

No `--remote-debugging-port` flags or browser restarts required! To give Antigravity live zero-flag background CDP + **Tab Groups** control in Brave, Chrome, Edge, Arc, Vivaldi, or Opera:

1. Open `brave://extensions` (or `chrome://extensions` / `edge://extensions`) in your browser.
2. Toggle **Developer mode** ON (top-right corner).
3. Click **Load unpacked** and select the **`extension/`** folder inside this repository (`~/antigravity-codex-computer-control/extension`).

The **Antigravity in Chrome** popup (`cnipmpbdggdeocaigfifflifphanoiic`) immediately connects to `com.antigravity.browser_bridge` over Native Messaging:
- **Zero premature banner**: `browser_list` and `get_state` never attach `chrome.debugger` until Antigravity actually inspects or acts on a tab.
- **Color-coded Tab Groups**: Agent-opened tabs automatically group under **Antigravity** (`cyan` by default, customizable via `group_title` / `group_color` or `browser_manage`), while your personal tabs are claimed in-place and never moved or closed!
- **One-Click Take Over & Detach**: Click **`[Antigravity · Take Over]`** in any active tab or **"Finish & Detach All"** in the toolbar popup to detach `chrome.debugger` immediately.

---

## Mandatory One-Time macOS Permissions (Takes 30 Seconds)

Because Antigravity spawns `computer-use` as a child process, macOS checks permissions against **Antigravity** itself:

1. Open **System Settings → Privacy & Security → Accessibility**
   - Toggle **Antigravity** (or **Antigravity IDE**) **ON**.
   - *(If it isn't listed yet, click `+` and select `/Applications/Antigravity.app`.)*
2. Open **System Settings → Privacy & Security → Screen & System Audio Recording**
   - Toggle **Antigravity** **ON**.
3. **Quit (`Cmd + Q`) and reopen Antigravity once** so macOS activates both permissions and loads the `computer-use` MCP server + `antigravity-computer-use` plugin globally across all your chats!

> **Tip:** Browser screenshots via CDP require **zero** Screen Recording permission, and macOS windows automatically fall back to a clean 1:1 vector Accessibility wireframe preview if Screen Recording is off.

---

## Try It Out in Antigravity!

Once you reopen Antigravity, open **any** chat and try one of these prompts:

- **Daintier Fluid Cursor + App Control:**
  > *"Open Calculator and compute `19 × 23` using `computer-use` so I can watch the virtual cursor glide."*
- **Tab Groups + Live Browser Research:**
  > *"Open Hacker News and GitHub Trending in a purple 'Morning Brief' Tab Group using `browser_open_tab`, summarize the top stories, and run `finalize_session` when done."*
- **One-Click Multi-Window Layout:**
  > *"Use `manage_windows` to tile Calculator and Notes side by side (`tile_left_right`)."*
- **DevTools Console & Network Inspection:**
  > *"Inspect my active localhost tab with `browser_tab_action` (`get_console_logs` and `get_network_requests`) and diagnose any failing API requests."*

---

## Manual `~/.gemini/config/mcp_config.json` Reference

If you ever want to inspect or configure `~/.gemini/config/mcp_config.json` by hand, `./install.sh` writes an entry structured like this:

```json
{
  "mcpServers": {
    "computer-use": {
      "args": [
        "/path/to/antigravity-codex-computer-control/src/server.mjs"
      ],
      "command": "/opt/homebrew/bin/node",
      "env": {
        "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
      },
      "disabled": false
    }
  }
}
```

---

## Key Capabilities & Architecture

### 1. Non-Intrusive Background macOS Control (`native/MacCUAHelper.swift`)
- Inspects any open or background macOS app's Accessibility (`AXUIElement`) hierarchy and assigns stable numeric element indices (`[1]`, `[2]`, ...).
- Executes `AXPress`, `AXConfirm`, `AXSetAttributeValue`, `AXSelectedTextRange`, secondary actions (`ShowMenu`, `Increment`, `Decrement`, `Expand`, `Collapse`), PID-targeted `CGEventPostToPid` typing/shortcuts, and pure `[x, y]` coordinate clicks/drags **without stealing your physical mouse cursor**.
- **Automatic Clipboard Preservation**: `paste` (`"text"`, `"md"`, `"html"`) snapshots all `NSPasteboard` items before pasting and restores your clipboard immediately afterward behind an async mutex.
- **Unified 1:1 Window-Relative Point Coordinates**: `get_window_state` element `@(x,y WxH)` bounds, 1:1 point-scaled `ScreenCaptureKit` screenshots, and `window_action(x, y)` all share the exact same coordinate space.

### 2. Daintier `0.72x` Pill-Free Fluid Virtual Cursor (`MacCUAHelper.swift` & `src/browser-ax.mjs`)
- **Sleek `0.72x` Silhouette & `FogCursorStyle` Aura**: Rounded cubic-Bezier `AgentCursor` (~16.5pt tall, tip anchored at exact `(0, 0)`) at `-44°` (`#000000` → `#0D0D11` body, ~`2.0pt` `#FFFFFF` border, `13.5pt` sky-blue radial mist, daintier concentric click ripples, comet drag trails, and zero mouse-pill clutter).
- **Dual-Regime Motion Planner**:
  - **Short hops (`≤ 196pt` — `Scoot`)**: Direct 2D spring `(response: 0.30s, damping: 0.85)` with directional velocity stretch and inertia tilt.
  - **Long flights (`> 196pt` — `Bezier`)**: Evaluates 20 cubic-Bezier arc candidates against screen/viewport margins, selects the lowest-curvature natural arc, rotates dynamically along the curve tangent, and settles back to `-44°` on arrival.

### 3. Extension-First Browser Parity (`extension/`, `bin/antigravity-native-host.mjs`, `src/cdp-client.mjs`)
- **Multiplexed Native Messaging Bridge**: `bin/antigravity-native-host.mjs` bridges Chrome's 4-byte uint32 LE stdio framing (`max 32 MiB`) to `/tmp/antigravity-browser-bridge/bridge-<pid>.sock` (`0700` dir, `0600` socket), letting multiple concurrent Antigravity MCP processes share live browser access cleanly.
- **Tab Groups & Ownership**: `createTab` groups agent tabs automatically; `claimTab` claims personal tabs in-place; `markTab` (`deliverable` | `handoff` | `scratch`) & `finalizeSession` close scratch tabs and detach debuggers when finished.
- **Two-Tier `upload_files`, Downloads, Non-Blocking Dialogs, Iframes & Ring Buffers**:
  - Direct `<input type="file">`, button-triggered `Page.fileChooserOpened` interception, AND automatic chunked base64 `DataTransfer` + `File` fallback for custom dropzones or restricted file URLs.
  - `wait_for_download` / `list_downloads` (`chrome.downloads` + CDP `Browser.setDownloadBehavior`), non-blocking `alert`/`confirm`/`prompt`/`beforeunload` handling, same-origin iframe coordinate offset accumulation + cross-origin OOPIF `tab.frameLocator(selector)`, 500-entry console & network ring buffers, cookies, and Web Storage.
- **Safety Policy & CAPTCHA Handoff (`src/safety-policy.mjs`)**: Blocks sensitive browser settings/local credentials and detects `Turnstile`, `reCAPTCHA`, and `hCaptcha` challenges (`[HANDOFF REQUIRED: ...]`).

---

## All 17 MCP Tools

| Tool | Description |
| --- | --- |
| `get_state` | Unified snapshot of permissions, displays, apps, open macOS windows, browser tabs, and active virtual cursors |
| `list_apps` | List running or installed macOS applications |
| `launch_app` | Launch one (`app`) or multiple (`apps`) macOS apps in background or foreground |
| `list_windows` | List open macOS windows with IDs, bounds, titles, and minimized/on-screen status |
| `manage_windows` | Multi-window tiling/layout presets & batch move/resize/minimize/raise/activate/close |
| `get_window_state` | Indexed AX tree (`[1]`, `[2]`, ...) + smart diffing + optional 1:1 window screenshot (`include_cursor` supported) |
| `window_action` | Action on any macOS window (`click`, `hover`, `move`, `set_value`, `type_text`, `press_key`, `paste`, `scroll`, `drag`, `select_text`, `perform_secondary_action`) |
| `browser_list` | List controllable/running browsers (Extension-First, raw CDP, `iab`, Safari/AppleEvents) and open tabs |
| `browser_open_tab` | Open one (`url`) or multiple (`urls`) tabs concurrently (with `group_title` / `group_color` Tab Groups) and return indexed AX state |
| `browser_tab_state` | Indexed DOM/AX tree + smart diffing + optional live CDP JPEG screenshot (`include_cursor` supported) |
| `browser_tab_action` | Browser tab action (`click`, `hover`, `move`, `set_value`, `type_text`, `press_key`, `paste`, `scroll`, `drag`, `select_text`, `perform_secondary_action`, `goto`, `back`, `forward`, `reload`, `close`, `evaluate`, `upload_files`, `wait_for_download`, `list_downloads`, `get_dialog`, `handle_dialog`, `get_console_logs`, `get_network_requests`, `get_network_body`, `get_cookies`, `set_cookies`, `clear_cookies`, `get_storage`, `set_storage`, `wait_for`) |
| `browser_manage` | Session & browser management (`status`, `list_tab_groups`, `create_tab_group`, `group_tabs`, `update_tab_group`, `name_session`, `ungroup_tabs`, `claim_tab`, `mark_tab`, `finalize_session`, `search_history`, `list_bookmarks`, `create_bookmark`) |
| `cursor_control` | Move, hover, highlight, inspect, hide, clear, or configure macOS & browser virtual cursors (`get_state`, `move`, `hover`, `highlight`, `hide`, `clear_all`, `configure`) |
| `batch_execute` | Run heterogeneous macOS window, layout, cursor, and browser operations concurrently in a single call |
| `js` | Persistent Codex-compatible `cua_repl` JavaScript VM (`cua`, `sky`, `agent`, `nodeRepl`) |
| `js_reset` | Reset the persistent `js` VM context and diff baselines |
| `permissions` | Check or trigger macOS Accessibility & Screen Recording permission prompts |

---

## Repository Structure

```text
computer-use-mcp/
├── install.sh                       # One-command macOS installer (MCP + NativeHost + Plugin)
├── uninstall.sh                     # Cleanly removes MCP entry, NativeMessagingHosts, and Plugin
├── package.json                     # Zero-dependency ESM package definition (Node >= 22)
├── bin/
│   ├── mac-cua-helper               # Prebuilt Universal (arm64 + x86_64) native macOS helper
│   └── antigravity-native-host.mjs  # Pure Node >= 22 Native Messaging <-> Unix socket multiplexer
├── extension/                       # Unpacked "Antigravity in Chrome" MV3 browser extension
│   ├── manifest.json                # MV3 manifest (deterministic ID cnipmpbdggdeocaigfifflifphanoiic)
│   ├── background.js                # Native Messaging JSON-RPC 2.0, Tab Groups & lazy CDP router
│   ├── offscreen.html / offscreen.js# 20s service-worker keepalive heartbeat
│   ├── popup.html / popup.css / .js # Live bridge status, Tab Group counter, Reconnect & Detach UI
│   └── icons/                       # 16 / 32 / 48 / 128px extension icons
├── plugin/                          # First-class Antigravity Plugin bundle (antigravity-computer-use)
│   ├── plugin.json                  # Antigravity plugin manifest
│   ├── assets/logo.png              # Plugin icon
│   ├── rules/AGENTS.md              # Always-on routing & browser safety rules
│   └── skills/                      # computer-use & browser-control playbooks
├── native/
│   └── MacCUAHelper.swift           # Native Swift AppKit/AXUIElement/CGEvent/ScreenCaptureKit/Cursor engine
├── scripts/
│   ├── build-native.mjs             # Universal (arm64 + x86_64) Swift builder + ad-hoc codesigner
│   └── setup-antigravity.mjs        # Atomic mcp_config, NativeMessagingHosts & plugin installer
├── src/
│   ├── server.mjs                   # MCP stdio server entrypoint & 17-tool router
│   ├── protocol.mjs                 # Zero-dependency JSON-RPC 2.0 MCP stdio transport
│   ├── mac-bridge.mjs               # Persistent JSON-lines bridge to bin/mac-cua-helper
│   ├── extension-bridge.mjs         # Unix socket client & ExtensionCDPConnection adapter
│   ├── cdp-client.mjs               # Extension-First + Multiplexed CDP + Safari/AppleEvents controller
│   ├── browser-ax.mjs               # DOM/Iframe AX indexer + 0.72x ShadowRoot cursor & Take Over UI
│   ├── safety-policy.mjs            # Sensitive URL blocker & Turnstile/reCAPTCHA/hCaptcha detector
│   ├── cua-repl.mjs                 # Persistent node:vm runtime (cua, sky, agent, nodeRepl)
│   ├── diff.mjs                     # Smart line-diff tracker for compact state updates
│   └── keys.mjs                     # macOS CGKeyCode & CDP key chord parser
└── test/
    ├── unit.test.mjs                # Fast unit & physics tests
    ├── native-mac.test.mjs          # Live AppKit multi-window AX & layout integration tests
    ├── cursor-and-mcp.test.mjs      # End-to-end MCP stdio, 0.72x pill-free cursor & precision tests
    ├── extension-and-codex-parity.test.mjs # Native host, Tab Groups, uploads/downloads/dialogs/OOPIF tests
    └── fixtures/                    # Background Cocoa test fixture app (source + universal bundle)
```

---

## Commands (Build, Check, Test, Uninstall)

```bash
# Verify MCP server & check macOS permissions without modifying config
npm run check

# Rebuild native Swift universal binary from source
npm run build:native

# Run full unit + live macOS + browser parity integration test suite
npm test

# Remove 'computer-use', NativeMessagingHosts, and plugin bundle
./uninstall.sh
```
