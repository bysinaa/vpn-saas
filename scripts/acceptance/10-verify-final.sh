#!/usr/bin/env bash
# Final verification: prove the app network authenticates, migrations run,
# the app stops restart-looping, and 3X-UI is untouched.
set -uo pipefail
cd /opt/tazaxy || exit 1

GW=$(docker network inspect tazaxy-network -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}')
DB_PASS=$(grep -E '^DATABASE_URL=' .env | sed -E 's#.*://[^:]+:([^@]*)@.*#\1#')

echo "== 1. socket bound? =="
ss -lntp | grep 5432 | tr -s ' ' | cut -d' ' -f4

echo "== 2. authenticated probe from the app network =="
docker run --rm --network tazaxy-network -e PGPASSWORD="$DB_PASS" postgres:16-alpine \
  psql -h "$GW" -U tazaxy -d tazaxy -tAc "SELECT 'AUTH_OK', current_database(), current_user;" 2>&1 | tail -2

echo "== 3. restart the app from a clean slate =="
docker compose up -d --force-recreate app >/dev/null 2>&1
sleep 25

echo "== 4. container state (was: restarting, 283 restarts) =="
docker inspect tazaxy-app-1 -f 'status={{.State.Status}} restarts={{.RestartCount}} exit={{.State.ExitCode}}'

echo "== 5. startup + migration log =="
docker logs --tail 25 tazaxy-app-1 2>&1 \
  | sed -E 's#(://[^:]+:)[^@]*(@)#\1***\2#' \
  | grep -iE 'startup|migrat|prisma|listen|nest|error|OK' | tail -12

echo "== 6. health endpoint =="
curl -s -o /dev/null -w 'http=%{http_code}\n' -m 10 http://127.0.0.1:3000/health 2>&1 || echo "curl failed"

echo "== 7. all containers =="
docker ps -a --format '{{.Names}}|{{.Status}}' | head -6

echo "== 8. 3X-UI still healthy and unchanged =="
systemctl is-active x-ui
/usr/local/x-ui/x-ui setting -show 2>/dev/null | grep -Ei '^(port|webBasePath)'
ss -lntp 2>/dev/null | grep -E ':(17342|2096) ' | tr -s ' ' | cut -d' ' -f4
ls -l /etc/x-ui/x-ui.db | tr -s ' ' | cut -d' ' -f5-9

echo "== 9. tazaxy --version =="
tazaxy --version; echo "exit=$?"

echo "== DONE =="
