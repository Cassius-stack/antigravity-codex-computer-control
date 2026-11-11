# Antigravity Codex Computer Control (`computer-use` MCP)

A **100% self-contained, zero-npm-dependency** macOS Desktop + Browser Computer-Use MCP server built for **Google Antigravity** on MacBooks (Apple Silicon `M1`/`M2`/`M3`/`M4` & Intel).

It gives every Antigravity chat full control over **macOS apps, multi-window layouts, and browser tabs**—with **1:1 OpenAI Codex Computer Use (`@oai/cua`, `@oai/sky`, `cua_repl`) parity**, including Codex's signature **fluid curved-Bezier + Velocity-Verlet spring virtual cursor** without hijacking your physical mouse pointer.

---

## Requirements

- **macOS 13.0+** (macOS 14.0 Sonoma+ recommended for `ScreenCaptureKit` background window pixel capture)
- **Google Antigravity** installed on your MacBook
- **Node.js `>= 22.0.0`** (uses built-in `WebSocket`, `fetch`, `node:vm`, and `node:test` — **zero `npm install` packages required!**)
  - Check with `node -v`. If missing or older than v22, run: `brew install node` (or `nvm install 22`).
- *(Optional)* **Xcode Command Line Tools** (`xcode-select --install`) if you want to recompile `native/MacCUAHelper.swift` from source. A prebuilt **Universal (`arm64` + `x86_64`)** binary is already included at `bin/mac-cua-helper`.

---

## Installation (Pick Option A or Option B)

### Option A — Zero-Terminal Setup (Ask Antigravity to Install It!)

Open **Antigravity** on your MacBook and paste this directly into a chat:

> Clone `https://github.com/Cassius-stack/antigravity-codex-computer-control.git` into `~/antigravity-codex-computer-control`, run `chmod +x install.sh && ./install.sh`, verify all 16 MCP tools pass, and tell me which macOS permissions to toggle on.

*(For AI Agents reading this repository: simply run `bash ./install.sh --no-prompt-permissions` inside the repository root. It automatically locates Node >= 22, builds or de-quarantines `bin/mac-cua-helper`, safely merges `"computer-use"` into `~/.gemini/config/mcp_config.json` without touching existing MCP servers, and verifies all 16 tools over stdio.)*

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
4. Registers `"computer-use"` inside `~/.gemini/config/mcp_config.json` (preserving any other MCP servers you already have).
5. Boots the MCP server once over stdio to verify all **16 tools** and checks your macOS permissions.

---

## Mandatory One-Time macOS Permissions (Takes 30 Seconds)

Because Antigravity spawns `computer-use` as a child process, macOS checks permissions against **Antigravity** itself:

1. Open **System Settings → Privacy & Security → Accessibility**
   - Toggle **Antigravity** (or **Antigravity IDE**) **ON**.
   - *(If it isn't listed yet, click `+` and select `/Applications/Antigravity.app`.)*
2. Open **System Settings → Privacy & Security → Screen & System Audio Recording**
   - Toggle **Antigravity** **ON**.
3. **Quit (`Cmd + Q`) and reopen Antigravity once** so macOS activates both permissions and loads the `computer-use` MCP server globally across all your chats!

> **Tip:** Even before Screen Recording is enabled, `computer-use` automatically falls back to rendering a clean 1:1 vector Accessibility wireframe preview so window control still works.

---

## Try It Out in Antigravity!

Once you reopen Antigravity, open **any** chat and try one of these prompts:

- **Fluid Cursor + App Control:**
  > *"Open Calculator and compute `19 × 23` using `computer-use` so I can watch the virtual cursor glide."*
- **Pure Coordinate Vision Mode:**
  > *"Use pure `[x, y]` coordinates on Calculator to compute `84 × 7` and show me a screenshot with `include_cursor: true`."*
- **One-Click Multi-Window Layout:**
  > *"Use `manage_windows` to tile Calculator and Notes side by side (`tile_left_right`)."*
- **Background Browser Control:**
  > *"List my open browser tabs with `browser_list` or open `https://news.ycombinator.com` in a background tab and summarize the top 5 stories."*

---

## Manual `~/.gemini/config/mcp_config.json` Reference

If you ever want to inspect or configure `~/.gemini/config/mcp_config.json` by hand, `./install.sh` writes an entry structured like this (using your MacBook's actual `node` and repo paths):

```json
{
  "mcpServers": {
    "computer-use": {
      "args": [
        "/Users/<your-username>/computer-use-mcp/src/server.mjs"
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

*(Using the absolute path to `node` in `"command"` ensures Antigravity's macOS GUI app finds Node 22+ even if you manage Node via `nvm`, `fnm`, or Homebrew.)*

### Optional: Full Live CDP Browser Control (Chrome / Brave / Edge / Arc)

Out of the box, `computer-use` can control Safari and Chromium browsers via AppleEvents/JXA **and** can launch its own managed CDP browser session automatically. If you also want full multiplexed CDP control (live background screenshots, ShadowRoot cursor, network-free DOM snapshots) over your **main** daily Chrome/Brave browser, launch it with `--remote-debugging-port=9222` (or enable remote debugging in `chrome://inspect/#remote-debugging`). `computer-use` auto-discovers ports `9223`, `9222`, `9224`, `9229`, and `9333`.

---

## Key Capabilities & Architecture

### 1. Non-Intrusive Background macOS Control (`native/MacCUAHelper.swift`)
- Inspects any open or background macOS app's Accessibility (`AXUIElement`) hierarchy and assigns stable numeric element indices (`[1]`, `[2]`, ...).
- Executes `AXPress`, `AXConfirm`, `AXSetAttributeValue`, `AXSelectedTextRange`, secondary actions (`ShowMenu`, `Increment`, `Decrement`, `Expand`, `Collapse`), PID-targeted `CGEventPostToPid` typing/shortcuts, and pure `[x, y]` coordinate clicks/drags **without stealing your physical mouse cursor**.
- **Automatic Clipboard Preservation**: `paste` (`"text"`, `"md"`, `"html"`) snapshots all `NSPasteboard` items before pasting and restores your clipboard immediately afterward behind an async mutex.
- **Unified 1:1 Window-Relative Point Coordinates**: `get_window_state` element `@(x,y WxH)` bounds, 1:1 point-scaled `ScreenCaptureKit` screenshots, and `window_action(x, y)` all share the exact same coordinate space (across single or negative-origin multi-monitor setups).

### 2. 1:1 Codex Fluid Virtual Cursor (`MacCUAHelper.swift` & `src/browser-ax.mjs`)
- **Authentic Silhouette & `FogCursorStyle` Aura**: Rounded cubic-Bezier `AgentCursor` at `-44°` (`#000000` → `#0D0D11` body, `3.2pt` `#FFFFFF` border, sky-blue `#0B9EFF` → `#3EC0FF` → `#BCE9FC` speed-reactive luminous mist, concentric click ripples, comet drag trails, and optional frosted `badge` pills).
- **Dual-Regime Motion Planner**:
  - **Short hops (`≤ 196pt` — `Scoot`)**: Direct 2D spring `(response: 0.30s, damping: 0.85)` with directional velocity stretch and inertia tilt.
  - **Long flights (`> 196pt` — `Bezier`)**: Evaluates 20 cubic-Bezier arc candidates against screen/viewport margins, selects the lowest-curvature natural arc, rotates dynamically along the curve tangent, and settles back to `-44°` on arrival.
- **240Hz `VelocityVerletSimulation` & `CloseEnough` Handoff**: Chains consecutive actions smoothly while preserving live cursor velocity, renders inside click-through `NSWindow` overlays on macOS and Trusted-Types-safe `ShadowRoot` overlays in browser tabs, and stays hidden from screenshots by default unless `include_cursor: true` is passed.

### 3. Multi-Window Layouts, Multi-Browser CDP, Batch Execution & `cua_repl`
- **Multi-Window Layouts (`manage_windows`)**: `tile_left_right`, `tile_grid`, `quadrants`, `cascade`, `maximize`, `center`, `left_half`, `right_half`, `top_half`, `bottom_half`, plus batch move/resize/minimize/raise/close.
- **Multi-Browser Control (`src/cdp-client.mjs`)**: Multiplexed `Target.attachToTarget({ flatten: true })` WebSocket CDP controller + JXA/AppleEvents fallback for Chrome, Brave, Edge, Arc, and Safari.
- **Persistent JavaScript VM (`js`, `js_reset`)**: Codex-compatible `cua`, `sky`, `agent`, and `nodeRepl` async REPL (`Promise.all` across apps & tabs with persistent top-level bindings).

---

## All 16 MCP Tools

| Tool | Description |
| --- | --- |
| `get_state` | Unified snapshot of permissions, displays, apps, open macOS windows, browser tabs, and active virtual cursors |
| `list_apps` | List running or installed macOS applications |
| `launch_app` | Launch one (`app`) or multiple (`apps`) macOS apps in background or foreground |
| `list_windows` | List open macOS windows with IDs, bounds, titles, and minimized/on-screen status |
| `manage_windows` | Multi-window tiling/layout presets & batch move/resize/minimize/raise/activate/close |
| `get_window_state` | Indexed AX tree (`[1]`, `[2]`, ...) + smart diffing + optional 1:1 window screenshot (`include_cursor` supported) |
| `window_action` | Action on any macOS window (`click`, `hover`, `move`, `set_value`, `type_text`, `press_key`, `paste`, `scroll`, `drag`, `select_text`, `perform_secondary_action`) |
| `browser_list` | List controllable/running browsers and open tabs |
| `browser_open_tab` | Open one (`url`) or multiple (`urls`) tabs concurrently and return indexed AX state |
| `browser_tab_state` | Indexed DOM/AX tree + smart diffing + optional live CDP JPEG screenshot (`include_cursor` supported) |
| `browser_tab_action` | Browser tab action (`click`, `hover`, `move`, `set_value`, `type_text`, `press_key`, `paste`, `scroll`, `drag`, `select_text`, `perform_secondary_action`, `goto`, `back`, `forward`, `reload`, `close`, `evaluate`, `upload_files`, `wait_for`) |
| `cursor_control` | Move, hover, highlight, inspect, hide, clear, or configure macOS & browser virtual cursors (`get_state`, `move`, `hover`, `highlight`, `hide`, `clear_all`, `configure`) |
| `batch_execute` | Run heterogeneous macOS window, layout, cursor, and browser operations concurrently in a single call |
| `js` | Persistent Codex-compatible `cua_repl` JavaScript VM (`cua`, `sky`, `agent`, `nodeRepl`) |
| `js_reset` | Reset the persistent `js` VM context and diff baselines |
| `permissions` | Check or trigger macOS Accessibility & Screen Recording permission prompts |

---

## Repository Structure

```text
computer-use-mcp/
├── install.sh                   # One-command macOS installer & Antigravity MCP configurator
├── uninstall.sh                 # Cleanly removes 'computer-use' from ~/.gemini/config/mcp_config.json
├── package.json                 # Zero-dependency ESM package definition (Node >= 22)
├── bin/
│   └── mac-cua-helper           # Prebuilt Universal (arm64 + x86_64) native macOS helper
├── native/
│   └── MacCUAHelper.swift       # Native Swift AppKit/AXUIElement/CGEvent/ScreenCaptureKit/Cursor engine
├── scripts/
│   ├── build-native.mjs         # Universal (arm64 + x86_64) Swift builder + ad-hoc codesigner
│   └── setup-antigravity.mjs    # Atomic mcp_config.json updater & stdio MCP verifier
├── src/
│   ├── server.mjs               # MCP stdio server entrypoint & 16-tool router
│   ├── protocol.mjs             # Zero-dependency JSON-RPC 2.0 MCP stdio transport
│   ├── mac-bridge.mjs           # Persistent JSON-lines bridge to bin/mac-cua-helper
│   ├── cdp-client.mjs           # Multiplexed Chrome DevTools Protocol + Safari/Chromium controller
│   ├── browser-ax.mjs           # DOM AX indexer + ShadowRoot 1:1 Codex cursor & physics engine
│   ├── cua-repl.mjs             # Persistent node:vm runtime (cua, sky, agent, nodeRepl)
│   ├── diff.mjs                 # Smart line-diff tracker for compact state updates
│   └── keys.mjs                 # macOS CGKeyCode & CDP key chord parser
└── test/
    ├── unit.test.mjs            # Fast unit & physics tests
    ├── native-mac.test.mjs      # Live AppKit multi-window AX & layout integration tests
    ├── cursor-and-mcp.test.mjs  # End-to-end MCP stdio, virtual cursor, & coordinate precision tests
    └── fixtures/                # Background Cocoa test fixture app (source + universal bundle)
```

---

## Commands (Build, Check, Test, Uninstall)

```bash
# Verify MCP server & check macOS permissions without modifying config
npm run check

# Rebuild native Swift universal binary from source
npm run build:native

# Run full unit + live macOS integration test suite (requires Accessibility permission for Terminal/IDE)
npm test

# Remove 'computer-use' from ~/.gemini/config/mcp_config.json
./uninstall.sh
```

---

## Troubleshooting

- **`Node.js >= 22.0.0 was not found`**:
  Install Node 22+ via `brew install node` or `nvm install 22`, then re-run `./install.sh`.
- **`axTrusted: false` or actions fail to click UI elements**:
  Open **System Settings → Privacy & Security → Accessibility**, make sure **Antigravity** is toggled ON (if you updated Antigravity recently, toggle it OFF and back ON), then restart Antigravity.
- **Window screenshots show `[AX Layout Preview]` instead of live pixels**:
  Open **System Settings → Privacy & Security → Screen & System Audio Recording**, toggle **Antigravity** ON, and completely quit (`Cmd + Q`) + reopen Antigravity.
