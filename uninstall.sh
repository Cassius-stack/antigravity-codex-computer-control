#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

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
  if [[ -d "$HOME/.nvm/versions/node" ]]; then
    while IFS= read -r p; do
      candidates+=("$p")
    done < <(ls -1d "$HOME/.nvm/versions/node"/v*/bin/node 2>/dev/null | sort -rV || true)
  fi
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

NODE_BIN="$(find_node22 || command -v node || echo "/opt/homebrew/bin/node")"
"$NODE_BIN" "$ROOT_DIR/scripts/setup-antigravity.mjs" --uninstall "$@"
