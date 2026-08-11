#!/usr/bin/env bash
# Fix the generated SUPER_ADMIN_PASSWORD so it satisfies the env schema
# (minimum 8 characters). The installer's env generator produced a value
# that failed validation, crash-looping the app after the DB was fixed.
#
# Safety: backs up .env first; never prints the password value.
set -uo pipefail
cd /opt/tazaxy || exit 1

cp -a .env "/var/backups/env.before-adminpw.$(date +%Y%m%d-%H%M%S)"

CUR=$(grep -E '^SUPER_ADMIN_PASSWORD=' .env | cut -d= -f2-)
echo "current_length=${#CUR}"

# 20 chars: alphanumeric core + guaranteed upper/lower/digit/symbol
CORE=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16)
NEW="${CORE}Aa9_"

if grep -q '^SUPER_ADMIN_PASSWORD=' .env; then
  python3 - "$NEW" <<'PY'
import sys
new = sys.argv[1]
lines = open('/opt/tazaxy/.env').read().splitlines()
out = ['SUPER_ADMIN_PASSWORD=' + new if l.startswith('SUPER_ADMIN_PASSWORD=') else l for l in lines]
open('/opt/tazaxy/.env','w').write('\n'.join(out) + '\n')
PY
else
  printf 'SUPER_ADMIN_PASSWORD=%s\n' "$NEW" >> .env
fi

NEWLEN=$(grep -E '^SUPER_ADMIN_PASSWORD=' .env | cut -d= -f2- | tr -d '\n' | wc -c)
echo "new_length=$NEWLEN"
echo "password_saved=yes (value not printed)"
echo "retrieve with: grep SUPER_ADMIN_PASSWORD /opt/tazaxy/.env"

echo "== recreate app =="
docker compose up -d --force-recreate app >/dev/null 2>&1
sleep 45

echo "== state =="
docker inspect tazaxy-app-1 -f 'status={{.State.Status}} health={{.State.Health.Status}} restarts={{.RestartCount}}'

echo "== log tail =="
docker logs --tail 15 tazaxy-app-1 2>&1 \
  | sed -E 's#(://[^:]+:)[^@]*(@)#\1***\2#' \
  | grep -viE '^\s+at |node:internal' | tail -8

echo "== health endpoint =="
docker exec tazaxy-app-1 sh -c 'wget -qO- http://127.0.0.1:3000/health 2>/dev/null || true' 2>&1 | head -c 200
echo
echo "== DONE =="
