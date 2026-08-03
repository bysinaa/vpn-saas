WSL install commands — copy/paste into your WSL shell (Ubuntu)

Recommended (inspect then run)
1) Download & inspect the installer:
   curl -Ls https://raw.githubusercontent.com/bysinaa/tazaxy/main/scripts/install.sh -o /tmp/vpn-install.sh
   less /tmp/vpn-install.sh
   (Press q to quit less)

2) If satisfied, run as root:
   sudo bash /tmp/vpn-install.sh

One-liner (executes remote script immediately)
- Run this if you trust the source and accept the risk:
  curl -Ls https://raw.githubusercontent.com/bysinaa/tazaxy/main/scripts/install.sh | sudo bash -s --

One-liner with environment overrides
- Example: run installer from branch "main" into /opt/tazaxy
  curl -Ls https://raw.githubusercontent.com/bysinaa/tazaxy/main/scripts/install.sh | sudo TAZAXY_BRANCH=main TAZAXY_INSTALL_DIR=/opt/tazaxy TAZAXY_REPO_URL=https://github.com/bysinaa/tazaxy.git bash -s --

Run from Windows PowerShell (invokes WSL)
- Uses default WSL distro:
  wsl -- bash -lc "curl -Ls https://raw.githubusercontent.com/bysinaa/tazaxy/main/scripts/install.sh | sudo bash -s --"
- If your distro is named (e.g., Ubuntu-22.04):
  wsl -d Ubuntu-22.04 -- bash -lc "curl -Ls https://raw.githubusercontent.com/bysinaa/tazaxy/main/scripts/install.sh | sudo bash -s --"

Safer approach: download then run (no remote pipe to sudo)
1) In WSL:
   curl -Ls https://raw.githubusercontent.com/bysinaa/tazaxy/main/scripts/install.sh -o ~/vpn-install.sh
   chmod +x ~/vpn-install.sh
   sudo ~/vpn-install.sh

Quick test (no system changes)
- If you want to try the CLI without running the system installer:
  git clone https://github.com/bysinaa/tazaxy.git
  cd tazaxy
  npm install
  npm run cli:build
  npm run cli:start -- help

Notes
- The installer will perform package installs, system changes and start services. Use a disposable VM for testing.
- Inspect the script before running (recommended).
- If you want, I can also:
  - Add a small script to the repo that wraps download+inspect+run and prompts for confirmation.
  - Provide a PowerShell one-liner customized to your WSL distribution name.