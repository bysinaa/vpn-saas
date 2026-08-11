#!/usr/bin/env bash
# Read-only: runs the shipped detector against the live 3X-UI panel.
echo "=== automatic 3X-UI discovery (from the installed bundle) ==="
node -e '
const { createXuiRuntimeDetector } = require("/opt/tazaxy/cli/dist-cli/installer/xui-runtime-detector.js");
(async () => {
  const detector = createXuiRuntimeDetector();
  const r = await detector.discover();
  console.log("state        = " + r.state);
  const d = r.data || {};
  for (const key of ["webPort","basePath","tls","scheme","subPort","subEnable","dbPath","username","url","version"]) {
    if (d[key] !== undefined) console.log(key.padEnd(12) + " = " + d[key]);
  }
  if (r.detail) console.log("detail       = " + r.detail);
  if (r.recovery) console.log("recovery     = " + r.recovery);
})().catch((e) => console.log("ERROR " + e.message));
'
echo
echo "=== telegram detector reachability (no token configured yet) ==="
node -e '
const m = require("/opt/tazaxy/cli/dist-cli/installer/telegram-detector.js");
const create = m.createTelegramDetector || m.createTelegramBotDetector;
(async () => {
  if (!create) { console.log("exports = " + Object.keys(m).join(",")); return; }
  const r = await create().discover();
  console.log("state    = " + r.state);
  if (r.detail) console.log("detail   = " + r.detail);
  if (r.recovery) console.log("recovery = " + r.recovery);
})().catch((e) => console.log("ERROR " + e.message));
'
