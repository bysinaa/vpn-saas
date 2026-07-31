#!/usr/bin/env bash
# Interactive smoke test for installer (bash / WSL / macOS)
#
# Usage: bash ./scripts/run-installer-smoke.sh
#
# This runs the same stages as the PowerShell script:
#  1) preflight
#  2) detect --insecure
#  3) confirm
#  4) register-and-record
#
# After each stage the script pauses so you can inspect installer-state.json.

set -euo pipefail

ROOT="$(pwd)"
STATE_FILE="$ROOT/installer-state.json"

run_step() {
  local desc="$1"
  shift
  echo
  echo "=== $desc ==="
  echo "Running: $*"
  if ! "$@"; then
    echo "Command failed with exit $?. Stopping." >&2
    exit 1
  fi
  echo "Exit code: $?"
  echo
  read -r -p "Press Enter to continue (or Ctrl+C to abort)..."
}

open_state_file() {
  if command -v code >/dev/null 2>&1; then
    code "$STATE_FILE" >/dev/null 2>&1 || true
  elif command -v less >/dev/null 2>&1; then
    less -FX "$STATE_FILE" || true
  else
    echo "installer-state.json available at: $STATE_FILE"
  fi
}

echo "Smoke test script — running from: $ROOT"
echo "Installer state file: $STATE_FILE"
echo

# 1) Preflight
run_step "Preflight checks" node cli/installer/installer.js preflight

# 2) Detect (use --insecure to ignore TLS certs for local self-signed)
run_step "Detect (probes)" node cli/installer/installer.js detect --insecure

# Open state for inspection
echo "Opening installer-state.json for inspection..."
open_state_file
read -r -p "Inspect the file, then press Enter to continue..."

# 3) Confirm (uses detected candidate from installer-state.json)
run_step "Confirm selected base URL" node cli/installer/installer.js confirm

# 4) Register & record (executes local registration and records output)
echo "Note: this step executes the local registration script (scripts/register-panel.cjs)."
read -r -p "Ready to run the registration step? Press Enter to proceed or Ctrl+C to abort..."
run_step "Register and record" node cli/installer/register-and-record.js

# Final inspection
echo "Opening installer-state.json for final inspection..."
open_state_file

echo
echo "Smoke test finished. Review installer-state.json for results (xui.probesResults, xui.confirmed, xui.registration, etc.)."