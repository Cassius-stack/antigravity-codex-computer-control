#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

echo "============================================================"
echo "  Antigravity Computer-Use MCP — macOS Turnkey Installer"
echo "============================================================"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "❌ Error: This MCP server only runs on macOS."
  exit 1
fi

# Strip macOS Gatekeeper quarantine attributes if downloaded as a ZIP / AirDrop
xattr -dr com.apple.quarantine "$ROOT_DIR" 2>/dev/null || true

# Find a Node.js >= 22 binary across PATH, Homebrew, nvm, fnm, volta, asdf, mise
find_node22() {
  local candidates=()

  if command -v node >/dev/null 2>&1; then
    candidates+=("$(command -v node)")
  fi
  candidates+=(
    "/opt/homebrew/bin/node"
    "/usr/local/bin/node"
    "$HOME/.volta/bin/node"
    "$HOME/.asdf/shims/node"
    "$HOME/.local/share/mise/shims/node"
  )

  # Search nvm versions (newest first)
  if [[ -d "$HOME/.nvm/versions/node" ]]; then
    while IFS= read -r p; do
      candidates+=("$p")
    done < <(ls -1d "$HOME/.nvm/versions/node"/v*/bin/node 2>/dev/null | sort -rV || true)
  fi

  # Search fnm installations (newest first)
  if [[ -d "$HOME/Library/Application Support/fnm/node-versions" ]]; then
    while IFS= read -r p; do
      candidates+=("$p")
    done < <(ls -1d "$HOME/Library/Application Support/fnm/node-versions"/v*/installation/bin/node 2>/dev/null | sort -rV || true)
  fi

  for bin in "${candidates[@]}"; do
    if [[ -x "$bin" ]]; then
      local major
      major="$("$bin" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
      if [[ "$major" -ge 22 ]]; then
        echo "$bin"
        return 0
      fi
    fi
  done
  return 1
}

NODE_BIN="$(find_node22 || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "❌ Node.js >= 22.0.0 was not found on this MacBook."
  echo ""
  echo "Install Node 22+ with one of these commands, then re-run ./install.sh:"
  echo "  • Homebrew:  brew install node"
  echo "  • nvm:       nvm install 22"
  echo "  • Official:  https://nodejs.org/"
  exit 1
fi

echo "✅ Using Node.js: $NODE_BIN ($("$NODE_BIN" -v))"

# Compile native Swift helper if swiftc is installed; otherwise use bundled universal binary
if command -v swiftc >/dev/null 2>&1 && swiftc --version >/dev/null 2>&1; then
  echo "🔨 Building native macOS helper (MacCUAHelper.swift)..."
  "$NODE_BIN" "$ROOT_DIR/scripts/build-native.mjs"
elif [[ -x "$ROOT_DIR/bin/mac-cua-helper" ]]; then
  echo "✅ Using prebuilt universal binary: bin/mac-cua-helper"
  chmod +x "$ROOT_DIR/bin/mac-cua-helper"
else
  echo "❌ Neither 'swiftc' nor 'bin/mac-cua-helper' is available."
  echo "   Run: xcode-select --install"
  exit 1
fi

# Register into ~/.gemini/config/mcp_config.json and verify all 16 MCP tools
"$NODE_BIN" "$ROOT_DIR/scripts/setup-antigravity.mjs" "$@"
