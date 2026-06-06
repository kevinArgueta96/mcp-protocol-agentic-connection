#!/usr/bin/env bash
#
# open-agent-bridge installer — build the CLI and expose `oab` /
# `open-agent-bridge` on your PATH, without publishing to npm.
#
# Usage (from a cloned repo):
#   bash bin/install.sh
#
set -euo pipefail

# Resolve repo root (this script lives in <repo>/bin/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

echo "▸ open-agent-bridge installer"
echo "  repo: $REPO_ROOT"
echo

if ! command -v pnpm >/dev/null 2>&1; then
  echo "✗ pnpm is required. Install it with:  npm install -g pnpm"
  exit 1
fi

echo "▸ Installing dependencies (pnpm install)…"
pnpm install

echo "▸ Building CLI + dashboard (pnpm run build:all)…"
pnpm run build:all

echo "▸ Linking globally (npm install -g .)…"
npm install -g .

echo
if command -v oab >/dev/null 2>&1; then
  echo "✓ Installed. \`oab\` is on your PATH."
  echo "  version: $(oab --version 2>/dev/null || echo '?')"
  echo
  echo "  Next:  cd /path/to/your/project && oab init"
else
  BIN_DIR="$(npm prefix -g)/bin"
  echo "⚠ Installed, but \`oab\` is not on your PATH yet."
  echo "  Add this line to your ~/.bashrc or ~/.zshrc, then restart your shell:"
  echo
  echo "    export PATH=\"$BIN_DIR:\$PATH\""
  echo
fi
