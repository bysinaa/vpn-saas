How to run and test the project CLI locally (quick reference)

Goal
- Run the CLI shipped in this repo so you can inspect the interactive menu and test commands (help, install, panel, status, admin) without running the full system installer.

Notes
- The CLI is Node-based. You can run it from PowerShell or inside WSL.
- Building the CLI produces CLI JS under cli/dist-cli/index.js. There is also a TypeScript entry you can run via ts-node for fast iteration.

From project root (works in PowerShell or WSL)
1) Ensure node/npm are available
   node --version
   npm --version

2) Install dependencies (only once / when changed)
   npm install

3) Build the CLI (TypeScript -> JS)
   npm run cli:build
   (This runs tsc using cli/tsconfig.json and writes to cli/dist-cli/)

4) Run the CLI help (quick check)
   npm run cli:start -- help
   OR
   node cli/dist-cli/index.js --help

5) Example commands to try interactively
   # Open the menu
   npm run cli:start

   # Installer flow (non-destructive; it runs preflight/detect etc.)
   npm run cli:start -- install --help
   npm run cli:start -- install

   # Check platform status
   npm run cli:start -- status --verbose

   # Panel commands (discover / test local 3x-ui)
   npm run cli:start -- panel --discover --url http://localhost:2053 --user admin --pass secret
   npm run cli:start -- panel --test

   # Admin management
   npm run cli:start -- admin --list
   npm run cli:start -- admin --add 123456789

   # Direct node invocation (help)
   node cli/dist-cli/index.js help

6) Faster iteration during development (no build)
   # Run TypeScript entry directly with ts-node (you already have ts-node in devDependencies)
   npm run cli -- --help
   # or
   npm run cli:start -- help   # if you've already built the CLI

If you prefer to run everything from Windows PowerShell but invoke the WSL environment:
- Replace paths with WSL mount paths or use wsl -e bash -lc "cd /mnt/c/Users/TAZA/Desktop/tazaxy && npm install && npm run cli:build && npm run cli:start -- help"
  Example:
  wsl -- bash -lc "cd /mnt/c/Users/TAZA/Desktop/tazaxy && npm install && npm run cli:build && npm run cli:start -- help"

If you prefer to run entirely in WSL (recommended when testing installer flows)
- Open your WSL distro shell, cd to the repo (if on Windows filesystem: /mnt/c/Users/TAZA/Desktop/tazaxy)
- Run the same commands above (npm install, npm run cli:build, npm run cli:start -- help)

Troubleshooting
- "Cannot find module cli/dist-cli/index.js" — run npm run cli:build first.
- ts-node errors — ensure devDependencies installed (npm install).
- If network-based checks fail (detect/connect to 3x-ui), confirm target URLs and that Docker or services are running locally.

Quick smoke-test checklist
- [ ] npm install completed without errors
- [ ] npm run cli:build completed
- [ ] Run help: npm run cli:start -- help
- [ ] Run status: npm run cli:start -- status --verbose
- [ ] Run panel discover/test: npm run cli:start -- panel --discover --url http://localhost:2053 --user admin --pass secret

If you want, I can:
- Add small helper scripts:
  - scripts/run-cli-help.sh (bash) and scripts/run-cli-help.ps1 (PowerShell) that run the three commands (install deps, build, show help).
  - Or run any of the commands here and show the output (I can execute one command per your approval).