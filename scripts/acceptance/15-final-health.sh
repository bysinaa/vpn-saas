#!/usr/bin/env bash
# Final health verification after all five faults were fixed.
set -uo pipefail
cd /opt/tazaxy || exit 1

echo "== waiting for healthcheck to settle =="
for i in $(seq 1 12); do
  S=$(docker inspect tazaxy-app-1 -f '{{.State.Status}}/{{.State.Health.Status}}' 2>/dev/null)
  echo "  t+$((i*10))s $S"
  case "$S" in
    running/healthy) break ;;
  esac
  sleep 10
done

echo "== final state =="
docker inspect tazaxy-app-1 -f 'status={{.State.Status}} health={{.State.Health.Status}} restarts={{.RestartCount}}'

echo "== health endpoint =="
docker exec tazaxy-app-1 sh -c 'wget -qO- http://127.0.0.1:3000/health 2>/dev/null || echo NO_RESPONSE' 2>&1 | head -c 400
echo

echo "== last healthcheck output =="
docker inspect tazaxy-app-1 -f '{{range .State.Health.Log}}{{.ExitCode}} {{.Output}}{{end}}' 2>/dev/null | tail -c 300
echo

echo "== app log (no errors expected) =="
docker logs --tail 30 tazaxy-app-1 2>&1 \
  | sed -E 's#(://[^:]+:)[^@]*(@)#\1***\2#' \
  | grep -viE '^\s+at |node:internal' | tail -10

echo "== all containers =="
docker ps --format '{{.Names}}|{{.Status}}'

echo "== 3X-UI still intact =="
systemctl is-active x-ui
/usr/local/x-ui/x-ui setting -show 2>/dev/null | grep -Ei '^(port|webBasePath)'
md5sum /etc/x-ui/x-ui.db

echo "== tazaxy --version (must print version only, exit 0) =="
OUT=$(tazaxy --version 2>&1); RC=$?
echo "output=[$OUT] lines=$(printf '%s' "$OUT" | wc -l) exit=$RC"
echo "== DONE =="
