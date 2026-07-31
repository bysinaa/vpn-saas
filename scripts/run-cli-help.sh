#!/usr/bin/env bash
# Helper to run a quick CLI smoke test in WSL / Linux
# Usage:
#   chmod +x scripts/run-cli-help.sh
#   ./scripts/run-cli-help.sh
#
# This will:
#  - check node/npm versions
#  - install dependencies (npm install)
#  - build the CLI (npm run cli:build)
#  - run the CLI help (npm run cli:start -- help)
# The script is safe for development use (does not run system installer).

set -euo pipefail

echo "Working directory: $(pwd)"
echo

# 1) Check node + npm
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found in PATH. Install Node.js (recommended >= 18) and retry." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm not found in PATH. Install npm and retry." >&2
  exit 1
fi

echo "Node: $(node --version)"
echo "npm:  $(npm --version)"
echo

# 2) Install dependencies
echo "Installing npm dependencies (this may take a moment)..."
npm install

# 3) Build CLI
echo "Building CLI (npm run cli:build)..."
npm run cli:build

# 4) Show CLI help
echo
echo "Running CLI help (npm run cli:start -- help)..."
npm run cli:start -- help

echo
echo "If the help output appeared above, the CLI build/run succeeded."
echo "Try interactive commands like: npm run cli:start -- install"