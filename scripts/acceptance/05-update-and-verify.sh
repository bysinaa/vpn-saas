#!/usr/bin/env bash
# Updates /opt/tazaxy from git the same way scripts/install.sh does, then
# verifies the CLI bundle and live panel discovery. Read-only towards 3X-UI.
set -uo pipefail

INSTALL_DIR=/opt/tazaxy
cd "$INSTALL_DIR" || exit 1

echo "=== 1. update from git ==="
git fetch --quiet origin
git reset --quiet --hard origin/main
git clean -qfdx -e node_modules
echo "commit=$(git rev-parse --short HEAD)"

echo
echo "=== 2. build CLI ==="
npm install --silent --no-audit --no-fund >/tmp/npm-install.log 2>&1 || {
  echo "npm install FAILED"; tail -5 /tmp/npm-install.log; exit 1; }
npm run cli:build 2>&1 | grep -E 'copied|error' || true

echo
echo "=== 3. tazaxy --version (acceptance item 8) ==="
OUT="$(tazaxy --version 2>/tmp/version.err)"
CODE=$?
echo "stdout=[$OUT]"
echo "stderr=[$(cat /tmp/version.err)]"
echo "exit=$CODE"
echo "lines=$(printf '%s' "$OUT" | wc -l)"

echo
echo "=== 4. installer regression suite on Linux ==="
npm run test:installer 2>&1 | grep -E '^. (tests|pass|fail) ' || true

echo
echo "=== 5. live 3X-UI discovery (read-only) ==="
node -e '
const { createXuiRuntimeDetector } = require("/opt/tazaxy/cli/dist-cli/installer/xui-runtime-detector.js");
(async () => {
  try {
    const detector = createXuiRuntimeDetector();
    const result = await detector.detect();
    const r = result.runtime || result.details || result;
    console.log("state=" + result.state);
    console.log("port=" + (r.port ?? "?"));
    console.log("basePath=" + (r.basePath ?? "?"));
    console.log("tls=" + (r.tls ?? r.https ?? "?"));
    console.log("subPort=" + (r.subscriptionPort ?? r.subPort ?? "?"));
    console.log("db=" + (r.dbPath ?? "?"));
    console.log("hasCreds=" + Boolean(r.username));
  } catch (e) {
    console.log("detector-error=" + e.message);
  }
})();
'

echo
echo "=== 6. panel untouched ==="
systemctl is-active x-ui
ss -ltnp 2>/dev/null | grep -E ':(17342|2096)\s' | awk '{print $4}'
md5sum /etc/x-ui/x-ui.db | cut -c1-16
