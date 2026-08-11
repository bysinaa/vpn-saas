#!/usr/bin/env bash
# Characterise the remaining app-side failure:
#   Error: Cannot find module '@/common/proxy/proxy-http.service'
# Determine whether the source file exists, whether it was compiled into dist,
# and whether the runtime has any '@/' alias resolution configured.
set -uo pipefail
cd /opt/tazaxy || exit 1

echo "== deployed commit =="
git log --oneline -1 2>&1 | head -1

echo "== source file present on host? =="
ls src/common/proxy/ 2>&1 | head -5

echo "== compiled into image dist? =="
docker run --rm --entrypoint sh tazaxy-app -c 'ls /app/dist/src/common/proxy/ 2>&1 | head -5'

echo "== how many @/ requires survived compilation? =="
docker run --rm --entrypoint sh tazaxy-app -c 'grep -c "@/" /app/dist/src/modules/payments/gateways/default-zarinpal.gateway.js 2>&1'

echo "== is any alias resolver configured? =="
docker run --rm --entrypoint sh tazaxy-app -c 'grep -oE "_moduleAliases|module-alias|tsconfig-paths" /app/package.json | sort -u; echo "(none above = no resolver)"'

echo "== total files in dist still referencing @/ =="
docker run --rm --entrypoint sh tazaxy-app -c 'grep -rl "require(\"@/" /app/dist 2>/dev/null | wc -l'

echo "== DONE =="
