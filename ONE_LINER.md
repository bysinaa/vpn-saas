Copy-paste one-liner to run inside WSL (Ubuntu)

Unsafe-but-common one-liner (executes remote script immediately):
curl -Ls https://raw.githubusercontent.com/bysinaa/vpn-saas/main/scripts/install.sh | sudo bash -s --

One-liner with environment overrides:
curl -Ls https://raw.githubusercontent.com/bysinaa/vpn-saas/main/scripts/install.sh | sudo VPN_SAAS_BRANCH=main VPN_SAAS_INSTALL_DIR=/opt/vpn-saas VPN_SAAS_REPO_URL=https://github.com/bysinaa/vpn-saas.git bash -s --

Safer: download, inspect, then run
curl -Ls https://raw.githubusercontent.com/bysinaa/vpn-saas/main/scripts/install.sh -o /tmp/vpn-install.sh
less /tmp/vpn-install.sh    # inspect
sudo bash /tmp/vpn-install.sh

Notes / Safety
- The one-liner runs system-level operations as root. Inspect the script before running whenever possible.
- Prefer Option "download + inspect + run" for safety.
- Run inside your WSL shell (Ubuntu). Example:
  1) Open WSL (Ubuntu)
  2) Paste the chosen command
  3) Follow prompts shown by the installer

If you want, I can:
- Create a small wrapper in the repo that downloads the script and prompts you before running (I can add it as scripts/run-in-wsl.sh — already added).
- Provide the exact PowerShell command to invoke WSL and run the one-liner from Windows.