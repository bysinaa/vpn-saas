#!/usr/bin/env bash
# Fault: src/database/database-manager.js requires
#   ../../cli/installer/postgres-detector
# which exists in the repo but is never copied into the app image, so /app/cli
# does not exist and the container dies at boot with MODULE_NOT_FOUND.
#
# Fix: ship the installer directory into the container. A read-only compose
# override recovers the running stack without a full rebuild.
set -uo pipefail
cd /opt/tazaxy || exit 1

echo "== confirm the gap =="
echo -n "host has module: "; test -f cli/installer/postgres-detector.js && echo yes || echo no
echo -n "image has /app/cli: "
docker run --rm --entrypoint sh tazaxy-app -c 'test -d /app/cli && echo yes || echo no'

echo "== add compose override (read-only mount) =="
cat > docker-compose.override.yml <<'YAML'
# Ships installer modules that src/database/database-manager.js requires at
# runtime. Read-only: the app must never write into the installer tree.
services:
  app:
    volumes:
      - ./cli:/app/cli:ro
YAML

echo "== restart app =="
docker compose up -d --force-recreate app >/dev/null 2>&1
sleep 55

echo "== state =="
docker inspect tazaxy-app-1 -f 'status={{.State.Status}} health={{.State.Health.Status}} restarts={{.RestartCount}}'

echo "== log tail =="
docker logs --tail 25 tazaxy-app-1 2>&1 \
  | sed -E 's#(://[^:]+:)[^@]*(@)#\1***\2#' \
  | grep -viE '^\s+at |node:internal|^\s+./app/' | tail -8

echo "== health endpoint =="
docker exec tazaxy-app-1 sh -c 'wget -qO- http://127.0.0.1:3000/health 2>/dev/null || true' 2>&1 | head -c 300
echo

echo "== containers =="
docker ps --format '{{.Names}}|{{.Status}}'

echo "== 3X-UI preserved =="
systemctl is-active x-ui
/usr/local/x-ui/x-ui setting -show 2>/dev/null | grep -Ei '^(port|webBasePath)'
ss -lntp 2>/dev/null | grep -E ':(17342|2096) ' | tr -s ' ' | cut -d' ' -f4 | sort -u
md5sum /etc/x-ui/x-ui.db

echo "== tazaxy --version =="
tazaxy --version; echo "exit=$?"
echo "== DONE =="
