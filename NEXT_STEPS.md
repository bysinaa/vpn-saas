Current status
- I tried to run bash scripts/install.sh here, but the environment lacks a working /bin/bash (WSL not available): the run failed with "execvpe(/bin/bash) failed: No such file or directory".
- That means I cannot run the repo's Linux installer from this Windows host.

What you can do locally (pick one)

1) Run the one-liner on a Linux host (recommended)
   - SSH to a Linux VPS or use a Linux VM / WSL shell, then run:
     bash <(curl -Ls https://raw.githubusercontent.com/bysinaa/vpn-saas/main/scripts/install.sh)
   - Runs as root. Inspect the script before running (see below).

2) Run safely from Windows (WSL) — recommended if you want to run locally on your PC
   - Install WSL (if not installed): open PowerShell as Administrator and run:
     wsl --install
   - Reboot, open your WSL distro (e.g., Ubuntu), then run the one-liner in the WSL shell:
     bash <(curl -Ls https://raw.githubusercontent.com/bysinaa/vpn-saas/main/scripts/install.sh)
   - Or clone repo in WSL and run:
     git clone https://github.com/bysinaa/vpn-saas.git
     cd vpn-saas
     bash scripts/install.sh

3) Inspect (and optionally run) the installer from PowerShell without piping remote code
   - Download the installer and review it first:
     Invoke-WebRequest -Uri "https://raw.githubusercontent.com/bysinaa/vpn-saas/main/scripts/install.sh" -OutFile .\install.sh
     notepad .\install.sh
   - If you have WSL installed, run it via wsl:
     wsl bash ./install.sh
   - If you have Git Bash installed, open Git Bash and run:
     bash ./install.sh

4) Test the CLI locally without full install (safer for development)
   - In a normal Windows or WSL shell at the repo root:
     npm install
     npm run cli:build
     npm run cli:start -- help
   - Or run the installer stages manually (already available):
     node cli/installer/installer.js preflight
     node cli/installer/installer.js detect --insecure
     node cli/installer/installer.js confirm --base-url=http://localhost:2053
     node cli/installer/register-and-record.js

PowerShell helpers (if you want a more explicit flow)
- Download & inspect then run in WSL:
  Invoke-WebRequest -Uri "https://raw.githubusercontent.com/bysinaa/vpn-saas/main/scripts/install.sh" -OutFile .\install.sh
  notepad .\install.sh
  wsl bash ./install.sh

Safety notes
- The one-liner runs system-level operations (installs packages, modifies system). Inspect the script before executing.
- Prefer running on a fresh or controlled host.
- If you want me to attempt the remote curl|bash one-liner here, I cannot on this Windows host because bash/WLS is not available. I will only run it after you confirm you want me to run it and only if the environment supports bash.

If you tell me which option you prefer (run on a remote Linux server, run via your WSL, run the simple local CLI install), I will provide the exact command and any additional small helper scripts to make it one-step for you.