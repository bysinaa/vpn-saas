#!/bin/sh
set -eu

BACKUP_DIR="${BACKUP_DIR:-/opt/backups/postgres}"
DATABASE_URL="${DATABASE_URL:-}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"

log() {
  echo "[postgres-backup] $1"
}

fail() {
  echo "[postgres-backup] ERROR: $1" >&2
  exit 1
}

if [ -z "$DATABASE_URL" ]; then
  fail "DATABASE_URL is required"
fi

mkdir -p "$BACKUP_DIR"

TIMESTAMP="$(date +%Y-%m-%d_%H-%M-%S)"
BACKUP_FILE="$BACKUP_DIR/vpn_saas_$TIMESTAMP.sql"

log "Creating backup at $BACKUP_FILE"
pg_dump "$DATABASE_URL" > "$BACKUP_FILE"

log "Pruning backups older than $RETENTION_DAYS days"
find "$BACKUP_DIR" -type f -name 'vpn_saas_*.sql' -mtime +"$RETENTION_DAYS" -delete

log "Backup completed"