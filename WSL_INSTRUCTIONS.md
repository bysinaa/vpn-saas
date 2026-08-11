Run the installer from WSL (exact commands you can copy-paste)

Preconditions
- WSL is installed and you have a working WSL distro (for example "Ubuntu").
- You have a user with sudo privileges inside WSL.
- Prefer running on a disposable VM or non-production machine while you test.

Option A — Inspect then run (recommended)
1) Open your WSL shell (Ubuntu).
2) Update & install small prerequisites:
   sudo apt update && sudo apt upgrade -y
   sudo apt install -y curl git ca-certificates less
3) Download and inspect the installer (first 200 lines):
   curl -Ls https://raw.githubusercontent.com/bysinaa/tazaxy/main/scripts/install.sh -o /tmp/vpn-install.sh
   less /tmp/vpn-install.sh
   (Exit less with `q`.)
4) If you are satisfied, run the installer as root:
   sudo bash /tmp/vpn-install.sh
   or to pass through any environment overrides:
   sudo TAZAXY_BRANCH=main TAZAXY_INSTALL_DIR=/opt/tazaxy \
     TAZAXY_REPO_URL=https://github.com/bysinaa/tazaxy.git bash /tmp/vpn-install.sh

Option B — One-liner (executes remote script immediately)
- Copy-paste the following into your WSL shell:
  curl -Ls https://raw.githubusercontent.com/bysinaa/tazaxy/main/scripts/install.sh | sudo bash -s --

Safety notes:
- Option A (download + inspect) is safer because you can review the script before executing.
- The installer will install packages, clone/update /opt/tazaxy, build the CLI and invoke the interactive install flow. Run on a controlled host.
- If you want to run the installer without using sudo on the pipe (safer to avoid shell injection via sudo), first download the script as your user then run it with sudo (see Option A).

Optional: run directly from Windows PowerShell using WSL
- This runs the one-liner inside your default WSL distro:
  wsl -- bash -lc "curl -Ls https://raw.githubusercontent.com/bysinaa/tazaxy/main/scripts/install.sh | sudo bash -s --"
- If your distro name is different (e.g., Ubuntu-22.04), use:
  wsl -d Ubuntu-22.04 -- bash -lc "curl -Ls https://raw.githubusercontent.com/bysinaa/tazaxy/main/scripts/install.sh | sudo bash -s --"

Test / Development (no system-level changes)
- If you only want to run the CLI locally without changing system packages:
  git clone https://github.com/bysinaa/tazaxy.git
  cd tazaxy
  npm install
  npm run cli:build
  npm run cli:start -- help
- You can also run individual installer stages (for testing):
  node cli/installer/installer.js preflight
  node cli/installer/installer.js detect --insecure
  node cli/installer/installer.js confirm --base-url=http://localhost:2053
  node cli/installer/register-and-record.js

When you're ready, tell me which option you want me to prepare for you:
- "Provide the exact copy-paste one-liner for WSL" (I will post the single command)
- "Prepare a PowerShell command to run installer in WSL" (I will post the exact PowerShell command)
- "Generate a download+inspect script file in the repo so I can run it in WSL" (I will add the script file)