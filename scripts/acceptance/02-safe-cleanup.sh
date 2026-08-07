#!/usr/bin/env bash
# Tazaxy-only safe cleanup for the acceptance reinstall.
#
# PRESERVES, by design:
#   - the existing 3X-UI installation (service, binary, /usr/local/x-ui)
#   - /etc/x-ui/x-ui.db and all panel settings (webPort 17342, base path, subPort 2096)
#   - /root/cert TLS material
#   - unrelated PostgreSQL databases and unrelated Docker resources
#
# REMOVES only Tazaxy-managed state, so the one-line installer starts clean.
set -u

BACKUP="/root/tazaxy-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP"
echo "backup dir: $BACKUP"

echo
echo "===== STAGE 1: BACKUP TAZAXY STATE ====="
for f in /opt/tazaxy/.env /opt/tazaxy/installer-state.json; do
  if [ -f "$f" ]; then cp -a "$f" "$BACKUP/" && echo "saved $f"; else echo "absent: $f"; fi
done

echo
echo "===== STAGE 2: RECORD PANEL FACTS (read-only) ====="
# Snapshot the panel config so we can prove afterwards that nothing changed.
if [ -f /etc/x-ui/x-ui.db ]; then
  sha256sum /etc/x-ui/x-ui.db | tee "$BACKUP/x-ui.db.sha256"
  python3 - "$BACKUP" <<'PY'
import sqlite3, sys, json
c = sqlite3.connect('file:/etc/x-ui/x-ui.db?mode=ro', uri=True)
out = {k: v for k, v in c.execute("select key,value from settings")}
out['_usernames'] = [u[0] for u in c.execute("select username from users")]
with open(sys.argv[1] + '/panel-settings-before.json', 'w') as fh:
    json.dump(out, fh, indent=2)
print("  webPort     =", out.get('webPort'))
print("  webBasePath =", out.get('webBasePath'))
print("  subPort     =", out.get('subPort'))
print("  subEnable   =", out.get('subEnable'))
print("  usernames   =", out['_usernames'])
PY
else
  echo "WARNING: /etc/x-ui/x-ui.db not found"
fi

echo
echo "===== STAGE 3: STOP TAZAXY CONTAINERS ONLY ====="
if [ -f /opt/tazaxy/docker-compose.yml ]; then
  (cd /opt/tazaxy && docker compose down --remove-orphans 2>&1) || true
else
  echo "no compose file; skipping compose down"
fi

echo
echo "===== STAGE 4: REMOVE TAZAXY-MANAGED RESOURCES ====="
rm -rf /opt/tazaxy && echo "removed /opt/tazaxy"
rm -f /usr/local/bin/tazaxy /usr/local/bin/vpn-cli && echo "removed launcher"
if [ -f /etc/systemd/system/tazaxy.service ]; then
  systemctl disable --now tazaxy 2>/dev/null || true
  rm -f /etc/systemd/system/tazaxy.service
  systemctl daemon-reload
  echo "removed tazaxy.service"
fi

# Containers / networks / volumes: Tazaxy-named or Tazaxy-labelled only.
for c in $(docker ps -aq --filter "name=tazaxy" --filter "name=vpn-saas" 2>/dev/null); do
  docker rm -f "$c" >/dev/null && echo "removed container $c"
done
for c in $(docker ps -aq --filter "label=com.tazaxy.managed=true" 2>/dev/null); do
  docker rm -f "$c" >/dev/null && echo "removed labelled container $c"
done
for n in $(docker network ls --format '{{.Name}}' 2>/dev/null | grep -E '^(tazaxy|vpn-saas)' || true); do
  docker network rm "$n" >/dev/null && echo "removed network $n"
done
for v in $(docker volume ls --format '{{.Name}}' 2>/dev/null | grep -E '^(tazaxy|vpn-saas)' || true); do
  docker volume rm "$v" >/dev/null && echo "removed volume $v"
done

echo
echo "===== STAGE 5: VERIFY PANEL UNTOUCHED ====="
echo "x-ui service : $(systemctl is-active x-ui 2>&1)"
echo "x-ui enabled : $(systemctl is-enabled x-ui 2>&1)"
echo "x-ui.db      : $(ls -la /etc/x-ui/x-ui.db 2>&1)"
echo "db checksum  : $(sha256sum /etc/x-ui/x-ui.db 2>&1)"
echo "expected     : $(cat "$BACKUP/x-ui.db.sha256" 2>/dev/null)"
echo "-- panel ports must still be listening --"
ss -tlnp 2>/dev/null | grep -E ':(17342|2096)' || echo "WARNING: panel ports not listening"
echo "-- TLS material --"
ls -la /root/cert/ip/ 2>&1 | head -5

echo
echo "===== STAGE 6: VERIFY TAZAXY GONE ====="
echo "/opt/tazaxy : $(ls -d /opt/tazaxy 2>&1 || echo removed)"
echo "launcher    : $(command -v tazaxy 2>&1 || echo removed)"
echo "containers  : $(docker ps -a --format '{{.Names}}' 2>&1 | tr '\n' ' ')"
echo "volumes     : $(docker volume ls --format '{{.Name}}' 2>&1 | tr '\n' ' ')"

echo
echo "BACKUP_DIR=$BACKUP"
echo "===== SAFE CLEANUP COMPLETE ====="
