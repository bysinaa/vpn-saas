#!/usr/bin/env bash
# Correct the mount location and verify final health.
#
# src/database/database-manager.js is a plain .js file copied verbatim into
# dist/. Its require('../../cli/installer/postgres-detector') is correct from
# src/database/ (-> repo root/cli) but after compilation the file lives at
# dist/src/database/, so ../../ resolves to /app/dist -- meaning the module
# must be present at /app/dist/cli/installer/, not /app/cli/.
set -uo pipefail
cd /opt/tazaxy || exit 1

echo "== resolution target =="
echo "requiring file: /app/dist/src/database/database-manager.js"
echo "'../../cli/installer' therefore resolves to: /app/dist/cli/installer"

cat > docker-compose.override.yml <<'YAML'
# database-manager.js is copied verbatim into dist/, so its relative require
# of ../../cli/installer resolves to /app/dist/cli. Mount there, read-only.
services:
  app:
    volumes:
      - ./cli:/app/dist/cli:ro
YAML

docker compose up -d --force-recreate app >/dev/null 2>&1

echo "== waiting for health =="
for i in $(seq 1 15); do
  S=$(docker inspect tazaxy-app-1 -f '{{.State.Status}}/{{.State.Health.Status}}' 2>/dev/null)
  echo "  t+$((i*10))s $S"
  [ "$S" = "running/healthy" ] && break
  sleep 10
done

echo "== final state =="
docker inspect tazaxy-app-1 -f 'status={{.State.Status}} health={{.State.Health.Status}} restarts={{.RestartCount}}'

echo "== health endpoint =="
docker exec tazaxy-app-1 sh -c 'wget -qO- http://127.0.0.1:3000/health 2>/dev/null || echo NO_RESPONSE' 2>&1 | head -c 400
echo

echo "== module resolves now? =="
docker exec tazaxy-app-1 sh -c 'test -f /app/dist/cli/installer/postgres-detector.js && echo RESOLVED || echo MISSING' 2>&1

echo "== app log =="
docker logs --tail 30 tazaxy-app-1 2>&1 \
  | sed -E 's#(://[^:]+:)[^@]*(@)#\1***\2#' \
  | grep -viE '^\s+at |node:internal|^\s+./app/' | tail -10

echo "== containers =="
docker ps --format '{{.Names}}|{{.Status}}'

echo "== 3X-UI preserved =="
systemctl is-active x-ui
/usr/local/x-ui/x-ui setting -show 2>/dev/null | grep -Ei '^(port|webBasePath)'
ss -lntp 2>/dev/null | grep -cE ':(17342|2096) '
md5sum /etc/x-ui/x-ui.db
echo "== DONE =="
