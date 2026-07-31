#!/usr/bin/env bash
# Helper script with the exact commands to run the remote installer in WSL.
# Copy this file into your WSL home and run:
#   chmod +x run-in-wsl.sh
#   ./run-in-wsl.sh
#
# The script presents two safe options:
#  1) Download + inspect + run (recommended)
#  2) One-liner that executes the remote script immediately (risky)

set -euo pipefail

INSTALLER_URL="https://raw.githubusercontent.com/bysinaa/vpn-saas/main/scripts/install.sh"
TMP="/tmp/vpn-install.sh"

echo "Installer helper for WSL"
echo
echo "Option 1 — download, inspect, then run (recommended):"
echo
echo "  curl -Ls \"$INSTALLER_URL\" -o \"$TMP\""
echo "  less \"$TMP\"    # Inspect: press q to quit"
echo "  sudo bash \"$TMP\""
echo
echo "Option 2 — one-liner (executes remote script immediately):"
echo
echo "  curl -Ls \"$INSTALLER_URL\" | sudo bash -s --"
echo
echo "If you prefer to run now, choose an option:"
echo "1) Download+inspect+run (recommended)"
echo "2) Run one-liner now (executes remote code)"
echo "q) Quit"

read -r -p "Select [1/2/q]: " choice
case "$choice" in
  1)
    echo "Downloading installer to $TMP..."
    curl -Ls "$INSTALLER_URL" -o "$TMP"
    echo "Opening $TMP in less. Inspect, then run with sudo when ready."
    less "$TMP"
    read -r -p "Run installer now (sudo bash $TMP) ? [y/N]: " yn
    if [[ "${yn,,}" == "y" ]]; then
      sudo bash "$TMP"
    else
      echo "Aborted by user. You can run: sudo bash $TMP"
    fi
    ;;
  2)
    read -r -p "This will execute remote code as root. Proceed? [y/N]: " yn
    if [[ "${yn,,}" == "y" ]]; then
      curl -Ls "$INSTALLER_URL" | sudo bash -s --
    else
      echo "Aborted by user."
    fi
    ;;
  *)
    echo "Quit."
    ;;
esac