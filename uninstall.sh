#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

NODE_BIN="$(command -v node || echo "/opt/homebrew/bin/node")"
if [[ ! -x "$NODE_BIN" ]] && [[ -d "$HOME/.nvm/versions/node" ]]; then
  NODE_BIN="$(ls -1d "$HOME/.nvm/versions/node"/v*/bin/node 2>/dev/null | sort -rV | head -n 1)"
fi

"$NODE_BIN" "$ROOT_DIR/scripts/setup-antigravity.mjs" --uninstall "$@"
