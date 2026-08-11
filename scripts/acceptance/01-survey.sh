#!/usr/bin/env bash
# Read-only survey of the acceptance host. Makes no changes.
set -u

echo "===== 1. HOST ====="
uname -a
echo "docker: $(docker --version 2>&1)"
echo "compose: $(docker compose version 2>&1 | head -1)"
echo "node: $(node --version 2>&1)"
echo "root: $(id -u)"

echo
echo "===== 2. 3X-UI SERVICE ====="
systemctl is-active x-ui 2>&1 || true
systemctl is-enabled x-ui 2>&1 || true
command -v x-ui >/dev/null 2>&1 && x-ui version 2>&1 | head -5 || echo "x-ui binary: not found"

echo
echo "===== 3. PANEL DATABASE ====="
ls -la /etc/x-ui/ 2>&1 || echo "/etc/x-ui: absent"

if [ -f /etc/x-ui/x-ui.db ]; then
  python3 - <<'PY' 2>&1
import sqlite3
try:
    c = sqlite3.connect('/etc/x-ui/x-ui.db')
    tables = [r[0] for r in c.execute("select name from sqlite_master where type='table'")]
    print("tables:", tables)
    for t in ('inbounds', 'users', 'client_traffics'):
        if t in tables:
            print(f"{t} rows:", c.execute(f"select count(*) from {t}").fetchone()[0])
    if 'inbounds' in tables:
        for r in c.execute("select id,remark,port,protocol,enable from inbounds"):
            print("  inbound:", r)
    if 'settings' in tables:
        keep = ('webPort', 'webBasePath', 'webCertFile', 'webKeyFile', 'subPort', 'subEnable', 'subURI')
        for k, v in c.execute("select key,value from settings"):
            if k in keep:
                print(f"  setting {k} = {v}")
except Exception as e:
    print("db read error:", e)
PY
else
  echo "x-ui.db: absent"
fi

echo
echo "===== 4. TAZAXY ====="
ls -d /opt/tazaxy 2>&1 || echo "/opt/tazaxy: absent"
command -v tazaxy >/dev/null 2>&1 && echo "launcher: $(command -v tazaxy)" || echo "launcher: absent"
ls -la /opt/tazaxy/.env 2>&1 || true
ls -la /opt/tazaxy/installer-state.json 2>&1 || true

echo
echo "===== 5. CONTAINERS ====="
docker ps -a --format '{{.Names}} | {{.Image}} | {{.Status}}' 2>&1 || echo "docker unavailable"

echo
echo "===== 6. VOLUMES / NETWORKS ====="
docker volume ls --format '{{.Name}}' 2>&1 || true
docker network ls --format '{{.Name}}' 2>&1 || true

echo
echo "===== 7. LISTENING PORTS ====="
ss -tlnp 2>/dev/null | awk 'NR==1 || /LISTEN/' || netstat -tlnp 2>/dev/null

echo
echo "===== 8. POSTGRES ====="
command -v psql >/dev/null 2>&1 && psql --version || echo "psql: not installed"
command -v pg_isready >/dev/null 2>&1 && pg_isready 2>&1 || echo "pg_isready: not installed"

echo
echo "===== SURVEY COMPLETE ====="
