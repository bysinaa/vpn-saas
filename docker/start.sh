#!/bin/sh
set -eu

APP_ENTRYPOINT="dist/src/main.js"
MIGRATIONS_DIR="prisma/migrations"

log() {
  echo "[startup] $1"
}

fail() {
  echo "[startup] ERROR: $1" >&2
  exit 1
}

wait_for_postgres() {
  if [ -z "${DATABASE_URL:-}" ]; then
    fail "DATABASE_URL is required"
  fi

  log "Waiting for PostgreSQL to accept connections..."
  ATTEMPT=0
  until node -e "const { Client } = require('pg'); const client = new Client({ connectionString: process.env.DATABASE_URL }); client.connect().then(() => client.end()).then(() => process.exit(0)).catch(() => process.exit(1));"; do
    ATTEMPT=$((ATTEMPT + 1))
    if [ "$ATTEMPT" -ge 60 ]; then
      fail "PostgreSQL did not become ready in time"
    fi
    sleep 2
  done
  log "PostgreSQL is ready"
}

ensure_migrations_exist() {
  if [ ! -d "$MIGRATIONS_DIR" ]; then
    fail "No Prisma migrations directory found at $MIGRATIONS_DIR. Refusing to start with an inconsistent database."
  fi

  if ! find "$MIGRATIONS_DIR" -mindepth 1 -maxdepth 1 -type d | grep -q .; then
    fail "No Prisma migrations found in $MIGRATIONS_DIR. Run 'prisma migrate dev' and commit the migrations before deployment."
  fi
}

run_prisma_generate() {
  log "Running prisma generate..."
  npx prisma generate
}

run_prisma_migrate() {
  log "Running prisma migrate deploy..."
  npx prisma migrate deploy
}

should_seed() {
  [ "${DATABASE_SEED:-false}" = "true" ]
}

is_first_deploy() {
  node -e "const { PrismaClient } = require('@prisma/client'); const prisma = new PrismaClient(); prisma.user.count().then((count) => prisma.systemSetting.count().then((settings) => ({ count, settings }))).then(({ count, settings }) => prisma.\$disconnect().then(() => ({ count, settings }))).then(({ count, settings }) => process.exit(count === 0 && settings === 0 ? 0 : 1)).catch(async (err) => { try { await prisma.\$disconnect(); } catch {} console.error(err); process.exit(2); });"
}

run_optional_seed() {
  if ! should_seed; then
    log "DATABASE_SEED is not enabled; skipping seed"
    return
  fi

  if is_first_deploy; then
    log "First deployment detected; running Prisma seed..."
    npx prisma db seed
  else
    log "Seed requested but database is already initialized; skipping seed"
  fi
}

start_app() {
  if [ ! -f "$APP_ENTRYPOINT" ]; then
    fail "Unable to find application entrypoint at $APP_ENTRYPOINT"
  fi

  log "Starting application..."
  exec node "$APP_ENTRYPOINT"
}

wait_for_postgres
ensure_migrations_exist
run_prisma_generate
run_prisma_migrate
run_optional_seed
start_app