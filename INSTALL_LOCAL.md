Local installation & testing guide — Run the installer CLI locally

Prerequisites
- Node.js (recommended >=18). Verify: node --version
- npm: npm --version
- Docker (if you plan to run containers): docker --version
- Docker Compose plugin or docker-compose: docker compose version
- On Windows: WSL2 recommended for best compatibility; install openssl if you need TLS diagnostics.
- Ensure you have a terminal (PowerShell, cmd.exe, or WSL bash) and you run commands from the project root (where package.json is).

Overview
This repository includes a small installer CLI under cli/installer that performs:
1. preflight — environment checks and writes installer-state.json
2. detect — probes for 3x-ui/xui panel endpoints
3. confirm — persist chosen base URL into installer-state.json
4. register (local) — run the local registration script (scripts/register-panel.cjs)
5. register-remote — POST panel info to a remote SaaS endpoint

Common workflow (run these from project root)
1) Preflight checks
   node cli/installer/installer.js preflight
   - Writes installer-state.json with system checks and warnings.

2) Detect (auto-probe; use --insecure to ignore TLS verification)
   node cli/installer/installer.js detect --insecure
   - Probes likely URLs and writes results to installer-state.json (xui.probesResults).

3) Confirm the detected URL (or pass --base-url)
   node cli/installer/installer.js confirm
   or
   node cli/installer/installer.js confirm --base-url=http://host:2053
   - Persists state.xui.confirmed.baseUrl in installer-state.json.

4) Local registration (executes scripts/register-panel.cjs and records output)
   node cli/installer/installer.js register
   - This will use installer-state.json -> xui.confirmed.baseUrl. If you want the wrapper that always records raw output, you can run:
   node cli/installer/register-and-record.js

5) Remote SaaS registration (requires a SaaS URL)
   node cli/installer/installer.js register-remote --saas-url=https://saas.example/api/panels/register [--insecure]
   or set env: SAAS_REGISTRATION_URL and run:
   node cli/installer/installer.js register-remote

Inspect results
- Open installer-state.json to review all recorded state:
  - xui.probesResults — probe attempts & responses
  - xui.selected — chosen candidate
  - xui.confirmed.baseUrl — confirmed URL
  - xui.registration — registration raw output, parsed data
  - xui.remoteRegistration — result of SaaS registration (if run)

Windows notes / tips
- PowerShell and cmd handle command chaining differently. Run commands one at a time.
- Some diagnostics (openssl, uname, timedatectl) are limited on Windows; use WSL2 for best parity with Linux.
- If Docker tools are missing, install Docker Desktop and enable WSL2 backend.

Troubleshooting
- "No confirmed base URL found" — run detect then confirm, or pass --base-url to confirm.
- TLS certificate errors — use --insecure for quick testing (not for production).
- Missing docker/docker-compose — installer marks these as fatal; install docker to proceed.
- Registration script errors — open installer-state.json -> xui.registration.rawOutput to debug the script output.

Example: Full smoke test (the sequence I ran)
1) node cli/installer/installer.js preflight
2) node cli/installer/installer.js detect --insecure
3) node cli/installer/installer.js confirm
4) node cli/installer/register-and-record.js

Run these commands in an interactive terminal to observe output live.

If you want, I can:
- Create a short PowerShell or bash script that runs the full smoke test step-by-step and pauses between stages for manual inspection.
- Or, create a small README section in cli/README.md and open it in the editor.

Checklist for your local test
- [ ] Ensure prerequisites installed (node, npm, docker if needed)
- [ ] Open a terminal in project root
- [ ] Run preflight
- [ ] Run detect --insecure (or with --base-url)
- [ ] Confirm base URL
- [ ] Run register or register-and-record
- [ ] Inspect installer-state.json and verify recorded results