#!/usr/bin/env bash
# Read-only diagnosis of the live Tazaxy install. Changes nothing.
# Run:  ssh root@HOST 'bash -s' < scripts/acceptance/08-server-diagnose.sh
set -uo pipefail
cd /opt/tazaxy 2>/dev/null || { echo "FATAL: /opt/tazaxy missing"; exit 1; }

redact() { sed -E 's#(://[^:]+:)[^@]*(@)#\1***\2#g'; }

echo "== git =="
git rev-parse --short HEAD; git status --porcelain | head -5

echo "== DATABASE_URL (redacted) =="
grep -E '^DATABASE_URL=' .env | redact

echo "== POSTGRES_* =="
grep -E '^(POSTGRES_HOST|POSTGRES_PORT|POSTGRES_USER|VPN_DATABASE)=' .env

echo "== app container state =="
docker inspect tazaxy-app-1 -f 'status={{.State.Status}} restarts={{.RestartCount}} exit={{.State.ExitCode}}' 2>&1

echo "== app log (last 12, redacted) =="
docker logs --tail 12 tazaxy-app-1 2>&1 | redact

echo "== tazaxy-network =="
docker network inspect tazaxy-network \
  -f '{{range .IPAM.Config}}subnet={{.Subnet}} gateway={{.Gateway}}{{end}}' 2>&1

echo "== postgres listen/hba =="
PGCONF=$(ls /etc/postgresql/*/main/postgresql.conf 2>/dev/null | head -1)
PGHBA=$(ls /etc/postgresql/*/main/pg_hba.conf 2>/dev/null | head -1)
echo "conf=$PGCONF"
grep -E "^\s*listen_addresses" "$PGCONF" 2>/dev/null || echo "listen_addresses: (default = localhost)"
echo "hba host lines:"
grep -E "^host" "$PGHBA" 2>/dev/null | grep -vE "^#" | head -8

echo "== does the app network reach postgres today? =="
GW=$(docker network inspect tazaxy-network -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null)
echo "gateway=$GW"
docker run --rm --network tazaxy-network postgres:16-alpine \
  pg_isready -h "$GW" -p 5432 -t 5 2>&1 | tail -2

echo "== 3X-UI (must stay untouched) =="
systemctl is-active x-ui
/usr/local/x-ui/x-ui setting -show 2>/dev/null | grep -Ei '^(port|webBasePath|subPort|subJsonPort)' || true
ls -l /etc/x-ui/x-ui.db | awk '{print $5, $6, $7, $8, $9}'
echo "listening:"
ss -lntp 2>/dev/null | grep -E ':(17342|2096)\s' | tr -s ' ' | cut -d' ' -f4,6

echo "== DONE =="
