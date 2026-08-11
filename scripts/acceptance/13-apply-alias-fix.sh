#!/usr/bin/env bash
# Apply the alias fix on the server, rebuild the app image and verify health.
#
# Defect: src/modules/payments/gateways/default-zarinpal.gateway.ts resolved
# '@/common/proxy/proxy-http.service' inside a literal require(). TypeScript
# rewrites the '@/' alias in import statements but not inside require(), so the
# alias survived into dist/ and threw MODULE_NOT_FOUND at container start-up.
set -uo pipefail
cd /opt/tazaxy || exit 1

TARGET=src/modules/payments/gateways/default-zarinpal.gateway.ts
cp -a "$TARGET" "/var/backups/$(basename "$TARGET").bak.$(date +%Y%m%d-%H%M%S)"

echo "== before =="
grep -n "proxy-http.service" "$TARGET"

sed -i "s|require('@/common/proxy/proxy-http.service')|require('../../../common/proxy/proxy-http.service')|" "$TARGET"

echo "== after =="
grep -n "proxy-http.service" "$TARGET"

echo "== any aliased require() left anywhere in src? =="
grep -rn "require('@/" src/ 2>/dev/null | wc -l

echo "== rebuild app image =="
docker compose build app 2>&1 | tail -4

echo "== verify the alias is gone from the built image =="
docker run --rm --entrypoint sh tazaxy-app -c 'grep -c "@/common/proxy" /app/dist/src/modules/payments/gateways/default-zarinpal.gateway.js || echo 0'

echo "== restart =="
docker compose up -d --force-recreate app >/dev/null 2>&1
sleep 50

echo "== state =="
docker inspect tazaxy-app-1 -f 'status={{.State.Status}} health={{.State.Health.Status}} restarts={{.RestartCount}} exit={{.State.ExitCode}}'

echo "== log tail =="
docker logs --tail 20 tazaxy-app-1 2>&1 \
  | sed -E 's#(://[^:]+:)[^@]*(@)#\1***\2#' \
  | grep -viE '^\s+at |node:internal' | tail -8

echo "== health endpoint =="
docker exec tazaxy-app-1 sh -c 'wget -qO- http://127.0.0.1:3000/health 2>/dev/null || true' 2>&1 | head -c 250
echo

echo "== containers =="
docker ps --format '{{.Names}}|{{.Status}}'

echo "== 3X-UI untouched =="
systemctl is-active x-ui
/usr/local/x-ui/x-ui setting -show 2>/dev/null | grep -Ei '^(port|webBasePath)'
ss -lntp 2>/dev/null | grep -E ':(17342|2096) ' | tr -s ' ' | cut -d' ' -f4
md5sum /etc/x-ui/x-ui.db

echo "== tazaxy --version =="
tazaxy --version; echo "exit=$?"
echo "== DONE =="
