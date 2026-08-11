#!/usr/bin/env bash
# Provision Tazaxy's own PostgreSQL role/database, authorise ONLY the app
# subnet, and correct DATABASE_URL. Mirrors cli/installer/postgres-provisioner.js.
#
# Safety:
#   - backs up .env, pg_hba.conf and postgresql.conf before any change
#   - never drops any database; never touches the panel's `xui` database
#   - authorises exactly the tazaxy-network subnet, never 0.0.0.0/0
#   - keeps localhost in listen_addresses; never binds '*'
#   - idempotent: safe to re-run
set -uo pipefail

APP_DIR=/opt/tazaxy
DB_NAME=tazaxy
DB_USER=tazaxy
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="/var/backups/tazaxy-$STAMP"
mkdir -p "$BACKUP_DIR"

PGCONF=$(ls /etc/postgresql/*/main/postgresql.conf | head -1)
PGHBA=$(ls /etc/postgresql/*/main/pg_hba.conf | head -1)
SUBNET=$(docker network inspect tazaxy-network -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}')
GATEWAY=$(docker network inspect tazaxy-network -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}')

echo "subnet=$SUBNET gateway=$GATEWAY"
case "$SUBNET" in
  0.0.0.0/0|"") echo "FATAL: refusing subnet '$SUBNET'"; exit 1 ;;
esac

# ── backups ──
cp -a "$APP_DIR/.env" "$BACKUP_DIR/env.bak"
cp -a "$PGHBA" "$BACKUP_DIR/pg_hba.conf.bak"
cp -a "$PGCONF" "$BACKUP_DIR/postgresql.conf.bak"
echo "backups -> $BACKUP_DIR"

# ── role + database (never drop, never reuse the panel's) ──
DB_PASS=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
psqlq() { sudo -u postgres psql -v ON_ERROR_STOP=1 -tAc "$1" "${2:-postgres}"; }

if [ "$(psqlq "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER';")" = "1" ]; then
  psqlq "ALTER ROLE \"$DB_USER\" LOGIN PASSWORD '$DB_PASS';" >/dev/null
  echo "role: reused"
else
  psqlq "CREATE ROLE \"$DB_USER\" LOGIN PASSWORD '$DB_PASS';" >/dev/null
  echo "role: created"
fi

if [ "$(psqlq "SELECT 1 FROM pg_database WHERE datname='$DB_NAME';")" = "1" ]; then
  echo "database: reused (not recreated)"
else
  sudo -u postgres createdb -O "$DB_USER" "$DB_NAME" && echo "database: created"
fi
psqlq "GRANT ALL PRIVILEGES ON DATABASE \"$DB_NAME\" TO \"$DB_USER\";" >/dev/null
sudo -u postgres psql -d "$DB_NAME" -tAc "GRANT ALL ON SCHEMA public TO \"$DB_USER\";" >/dev/null

# ── pg_hba: scoped rule, inserted before broad rules ──
RULE="host    $DB_NAME    $DB_USER    $SUBNET    scram-sha-256"
if grep -qF "$RULE" "$PGHBA"; then
  echo "pg_hba: rule already present"
else
  LINE=$(grep -nE '^\s*(host|local)\s' "$PGHBA" | head -1 | cut -d: -f1)
  [ -z "$LINE" ] && LINE=$(($(wc -l < "$PGHBA") + 1))
  sed -i "${LINE}i # added by tazaxy installer (scoped to the app network)\n$RULE" "$PGHBA"
  echo "pg_hba: rule added at line $LINE"
fi

# ── listen_addresses: add gateway, keep localhost ──
CUR=$(grep -E "^\s*listen_addresses\s*=" "$PGCONF" | tail -1 | sed -E "s/.*=\s*'([^']*)'.*/\1/")
[ -z "$CUR" ] && CUR=localhost
NEW="$CUR"
echo "$CUR" | tr ',' '\n' | grep -qx " *$GATEWAY *" || NEW="$CUR,$GATEWAY"
if [ "$NEW" != "$CUR" ] || ! grep -qE "^\s*listen_addresses\s*=" "$PGCONF"; then
  sed -i -E "s|^\s*listen_addresses\s*=.*|# &   # superseded by tazaxy installer|" "$PGCONF"
  echo "listen_addresses = '$NEW'   # added by tazaxy installer" >> "$PGCONF"
  systemctl restart postgresql
  echo "listen_addresses -> '$NEW' (restarted)"
else
  echo "listen_addresses: already includes $GATEWAY"
fi

# ── correct DATABASE_URL (was pointing at the panel's own xui database) ──
NEW_URL="postgresql://$DB_USER:$DB_PASS@$GATEWAY:5432/$DB_NAME?schema=public"
if grep -q '^DATABASE_URL=' "$APP_DIR/.env"; then
  python3 - "$APP_DIR/.env" "$NEW_URL" <<'PY'
import sys
path, url = sys.argv[1], sys.argv[2]
out = []
for line in open(path).read().splitlines():
    if line.startswith('DATABASE_URL='):
        out.append('DATABASE_URL=' + url)
    elif line.startswith('POSTGRES_HOST='):
        out.append('POSTGRES_HOST=' + url.split('@')[1].split(':')[0])
    elif line.startswith('POSTGRES_USER='):
        out.append('POSTGRES_USER=tazaxy')
    elif line.startswith('POSTGRES_DB='):
        out.append('POSTGRES_DB=tazaxy')
    else:
        out.append(line)
open(path, 'w').write('\n'.join(out) + '\n')
PY
else
  echo "DATABASE_URL=$NEW_URL" >> "$APP_DIR/.env"
fi
grep -E '^(DATABASE_URL|POSTGRES_HOST|POSTGRES_USER)=' "$APP_DIR/.env" \
  | sed -E 's#(://[^:]+:)[^@]*(@)#\1***\2#'

# ── prove the app network can now authenticate ──
echo "== probe from tazaxy-network =="
docker run --rm --network tazaxy-network -e PGPASSWORD="$DB_PASS" postgres:16-alpine \
  psql -h "$GATEWAY" -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT 'AUTH_OK', current_database();" 2>&1 | tail -2

# ── confirm the panel is untouched ──
echo "== panel untouched =="
systemctl is-active x-ui
sudo -u postgres psql -tAc "SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY 1;" | tr '\n' ' '; echo
grep -c 'xui' "$PGHBA"
echo "BACKUP_DIR=$BACKUP_DIR"
echo "== DONE =="
