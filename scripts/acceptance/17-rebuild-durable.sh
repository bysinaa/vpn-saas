#!/usr/bin/env bash
# Replace the temporary compose override with the durable Dockerfile fix:
# the image itself now COPYs cli/installer into dist/cli/installer.
set -uo pipefail
cd /opt/tazaxy || exit 1

echo "== apply Dockerfile fix =="
if grep -q 'dist/cli/installer' Dockerfile; then
  echo "already present"
else
  # Insert the COPY immediately after the dist/ copy in the production stage.
  awk '
    /^COPY --from=builder .*\/app\/dist \.\/dist$/ {
      print
      print "# src/database/database-manager.js is copied verbatim into dist/, so its"
      print "# require(\"../../cli/installer/...\") resolves to dist/cli/installer."
      print "COPY --from=builder --chown=nestjs:nodejs /app/cli/installer ./dist/cli/installer"
      next
    }
    { print }
  ' Dockerfile > Dockerfile.new && mv Dockerfile.new Dockerfile
  echo "inserted"
fi
grep -n 'dist/cli/installer' Dockerfile | head -3

echo "== drop the temporary override =="
rm -f docker-compose.override.yml && echo "removed"

echo "== rebuild (no cache for the copy layers) =="
docker compose build app >/dev/null 2>&1 && echo "build ok" || echo "BUILD FAILED"

echo "== verify module is baked into the image =="
docker run --rm --entrypoint sh tazaxy-app -c \
  'test -f /app/dist/cli/installer/postgres-detector.js && echo BAKED_IN || echo MISSING'

echo "== recreate and wait for health =="
docker compose up -d --force-recreate app >/dev/null 2>&1
for i in $(seq 1 15); do
  S=$(docker inspect tazaxy-app-1 -f '{{.State.Status}}/{{.State.Health.Status}}' 2>/dev/null)
  echo "  t+$((i*10))s $S"
  [ "$S" = "running/healthy" ] && break
  sleep 10
done

echo "== final state =="
docker inspect tazaxy-app-1 -f 'status={{.State.Status}} health={{.State.Health.Status}} restarts={{.RestartCount}}'
echo -n "mounts (should be empty): "
docker inspect tazaxy-app-1 -f '{{range .Mounts}}{{.Destination}} {{end}}'; echo

echo "== health endpoint =="
docker exec tazaxy-app-1 sh -c 'wget -qO- http://127.0.0.1:3000/health 2>/dev/null || echo NO_RESPONSE' | head -c 200
echo

echo "== containers =="
docker ps --format '{{.Names}}|{{.Status}}'

echo "== 3X-UI untouched =="
systemctl is-active x-ui
/usr/local/x-ui/x-ui setting -show 2>/dev/null | grep -Ei '^(port|webBasePath)'
ss -lntp 2>/dev/null | grep -E ':(17342|2096) ' | tr -s ' ' | cut -d' ' -f4 | sort -u
md5sum /etc/x-ui/x-ui.db

echo "== tazaxy --version =="
OUT=$(tazaxy --version 2>&1); RC=$?
echo "output=[$OUT] exit=$RC"
echo "== DONE =="
