One-line installer (recommended for Linux VPS)

Run as root on a Linux server (ssh root@host):

bash <(curl -Ls https://raw.githubusercontent.com/bysinaa/tazaxy/main/scripts/install.sh)

What this does
- curl -Ls: download the install script quietly, following redirects
- bash <(...): run the downloaded script in a subshell (no file left on disk)
- The script installs prerequisites, clones/updates the repo to /opt/tazaxy, installs deps, builds the CLI and runs the interactive install flow.

Safety tips (read before running)
1. Inspect the script first:
   curl -Ls https://raw.githubusercontent.com/bysinaa/tazaxy/main/scripts/install.sh | sed -n '1,200p'
   or open https://raw.githubusercontent.com/bysinaa/tazaxy/main/scripts/install.sh in your browser or editor.

2. Run on a fresh/controlled host. The script performs package installs and system changes.

3. Optional environment overrides (export before running):
   export TAZAXY_BRANCH=main
   export TAZAXY_INSTALL_DIR=/opt/tazaxy
   export TAZAXY_REPO_URL=https://github.com/bysinaa/tazaxy.git

Windows / PowerShell
- Use WSL (recommended) and run the bash one-liner.
- Or (PowerShell) inspect the script in the browser and follow manual steps. Avoid piping remote scripts to PowerShell without review.

How to run locally (non-root test / dev)
- Clone repo locally and run the installer steps manually:
  git clone https://github.com/bysinaa/tazaxy.git
  cd tazaxy
  bash scripts/install.sh
  (or run the CLI installer via npm as described in cli/README.md)

I saved this note to RUN_ONE_LINER.md. Open it or copy the one-liner above and run it on your target Linux host after inspection.