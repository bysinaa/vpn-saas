#!/bin/sh
set -eu

DATABASE_URL="${DATABASE_URL:-}"
BACKUP_FILE="${1:-}"

log() {
  echo "[postgres-restore] $1"
}

fail() {
  echo "[postgres-restore] ERROR: $1" >&2
  exit 1
}

if [ -z "$DATABASE_URL" ]; then
  fail "DATABASE_URL is required"
fi

if [ -z "$BACKUP_FILE" ]; then
  fail "Usage: scripts/postgres-restore.sh /path/to/backup.sql"
fi

if [ ! -f "$BACKUP_FILE" ]; then
  fail "Backup file not found: $BACKUP_FILE"
fi

log "Restoring database from $BACKUP_FILE"
psql "$DATABASE_URL" -f "$BACKUP_FILE"

log "Restore completed"