#!/bin/sh
set -eu

APP_ENTRYPOINT="dist/src/main.js"
MIGRATIONS_DIR="prisma/migrations"
SHARED_ENV_FILE="${SHARED_ENV_FILE:-/opt/shared/.env}"
POSTGRES_ENV_FILE="${POSTGRES_ENV_FILE:-/opt/postgres/.env}"
POSTGRES_COMPOSE_FILE="${POSTGRES_COMPOSE_FILE:-/opt/postgres/docker-compose.yml}"
VPN_DATABASE_NAME="${VPN_DATABASE_NAME:-tazaxy}"

log() {
  echo "[startup] $1"
}

fail() {
  echo "[startup] ERROR: $1" >&2
  exit 1
}

load_env_file() {
  FILE_PATH="$1"

  if [ ! -f "$FILE_PATH" ]; then
    return 0
  fi

  log "Loading env file: $FILE_PATH"

  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*)
        continue
        ;;
    esac

    key="$(printf '%s' "$line" | cut -d '=' -f 1)"
    value="$(printf '%s' "$line" | cut -d '=' -f 2-)"

    if [ -z "$key" ]; then
      continue
    fi

    eval "current_value=\${$key:-}"
    if [ -z "${current_value}" ]; then
      export "$key=$value"
    fi
  done < "$FILE_PATH"
}

build_database_url() {
  if [ -n "${DATABASE_URL:-}" ]; then
    return 0
  fi

  DB_HOST="${POSTGRES_HOST:-localhost}"
  DB_PORT="${POSTGRES_PORT:-5432}"
  DB_USER="${POSTGRES_USER:-postgres}"
  DB_PASSWORD="${POSTGRES_PASSWORD:-postgres}"
  DB_NAME="${VPN_DATABASE:-$VPN_DATABASE_NAME}"

  export DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}?schema=public"
}

can_connect_database_url() {
  if [ -z "${DATABASE_URL:-}" ]; then
    return 1
  fi

  node -e "
const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
client.connect()
  .then(() => client.end())
  .then(() => process.exit(0))
  .catch((err) => {
    const msg = err.message || String(err);
    const code = err.code || '';

    // Classify the error
    let category = 'unknown';
    if (code === 'ENOTFOUND' || /getaddrinfo|EAI_AGAIN|hostname/i.test(msg)) {
      category = 'DNS_FAILURE';
    } else if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || /connect ECONNREFUSED|connection refused/i.test(msg)) {
      category = 'TCP_FAILURE';
    } else if (code === 'ETIMEDOUT' || /timeout|timed out/i.test(msg)) {
      category = 'TCP_FAILURE';
    } else if (code === '28P01' || /password|authentication|auth failed|role.*does not exist/i.test(msg)) {
      category = 'AUTH_FAILURE';
    } else if (code === '3D000' || /database.*does not exist|database.*not found/i.test(msg)) {
      category = 'DATABASE_MISSING';
    } else if (code === '42501' || /permission|denied|not authorized/i.test(msg)) {
      category = 'PERMISSION_FAILURE';
    } else if (code === '28000' || /no pg_hba.conf|SSL|SSL connection/i.test(msg)) {
      category = 'SSL_MISMATCH';
    } else if (/terminating|connection terminated|server closed/i.test(msg)) {
      category = 'SERVER_CRASHED';
    }

    console.error('[startup] DB connection error:');
    console.error('  Category:  ' + category);
    console.error('  Code:      ' + (code || 'N/A'));
    console.error('  Message:   ' + msg);
    if (err.stack) console.error('  Stack:     ' + err.stack.split('\\n')[1]?.trim() || '');
    process.exit(1);
  });
"
}

diagnose_database_url() {
  if [ -z "${DATABASE_URL:-}" ]; then
    log "No DATABASE_URL set"
    return 1
  fi

  log "DATABASE_URL detected; validating connection"
  log "  URL: $(echo "$DATABASE_URL" | sed 's/:[^:@/]*@/:***@/')"

  # Parse the URL for diagnostics
  DB_HOST=$(echo "$DATABASE_URL" | sed -n 's/.*@\([^:]*\).*/\1/p' 2>/dev/null || echo '')
  DB_PORT=$(echo "$DATABASE_URL" | sed -n 's/.*:\([0-9]*\)\/.*/\1/p' 2>/dev/null || echo '5432')
  DB_NAME=$(echo "$DATABASE_URL" | sed -n 's/.*\/\([^?]*\).*/\1/p' 2>/dev/null || echo '')
  DB_USER=$(echo "$DATABASE_URL" | sed -n 's/.*\/\/\([^:]*\).*/\1/p' 2>/dev/null || echo '')

  log "  Host: $DB_HOST"
  log "  Port: $DB_PORT"
  log "  Database: $DB_NAME"
  log "  User: $DB_USER"

  # Step 1: DNS resolution check
  if [ -n "$DB_HOST" ] && [ "$DB_HOST" != "localhost" ] && [ "$DB_HOST" != "127.0.0.1" ]; then
    log "  Checking DNS resolution for $DB_HOST..."
    if ! nslookup "$DB_HOST" >/dev/null 2>&1 && ! getent hosts "$DB_HOST" >/dev/null 2>&1; then
      fail "DNS_FAILURE: Cannot resolve hostname '$DB_HOST'. Check your DATABASE_URL host or DNS configuration."
    fi
    log "  DNS resolution OK"
  fi

  # Step 2: TCP connectivity check
  log "  Checking TCP connectivity to $DB_HOST:$DB_PORT..."
  if ! node -e "const net = require('net'); const sock = net.createConnection({ host: '$DB_HOST', port: Number('$DB_PORT') }, () => { sock.end(); process.exit(0); }); sock.on('error', () => process.exit(1)); sock.setTimeout(5000, () => { sock.destroy(); process.exit(1); });" 2>/dev/null; then
    fail "TCP_FAILURE: Cannot connect to $DB_HOST:$DB_PORT. The PostgreSQL server is not running or not reachable. Check if the database container/service is up."
  fi
  log "  TCP connectivity OK"

  # Step 3: Full connection attempt with detailed error
  log "  Attempting PostgreSQL authentication..."
  if can_connect_database_url; then
    log "  Connected using existing DATABASE_URL"
    return 0
  fi

  # can_connect_database_url already printed the classified error
  fail "DATABASE_URL is set but connection failed (see error above). Fix the issue and restart."
}

can_connect_local_postgres() {
  DB_HOST="${POSTGRES_HOST:-localhost}"
  DB_PORT="${POSTGRES_PORT:-5432}"
  DB_USER="${POSTGRES_USER:-postgres}"
  DB_PASSWORD="${POSTGRES_PASSWORD:-postgres}"

  PGHOST="$DB_HOST" PGPORT="$DB_PORT" PGUSER="$DB_USER" PGPASSWORD="$DB_PASSWORD" PGDATABASE="postgres" \
  node -e "const { Client } = require('pg'); const client = new Client({ host: process.env.PGHOST, port: Number(process.env.PGPORT), user: process.env.PGUSER, password: process.env.PGPASSWORD, database: process.env.PGDATABASE }); client.connect().then(() => client.end()).then(() => process.exit(0)).catch(() => process.exit(1));"
}

create_database_if_missing() {
  DB_HOST="${POSTGRES_HOST:-localhost}"
  DB_PORT="${POSTGRES_PORT:-5432}"
  DB_USER="${POSTGRES_USER:-postgres}"
  DB_PASSWORD="${POSTGRES_PASSWORD:-postgres}"
  DB_NAME="${VPN_DATABASE:-$VPN_DATABASE_NAME}"

  log "Ensuring database exists: $DB_NAME"

  PGHOST="$DB_HOST" PGPORT="$DB_PORT" PGUSER="$DB_USER" PGPASSWORD="$DB_PASSWORD" TARGET_DB="$DB_NAME" \
  node -e "const { Client } = require('pg'); const dbName = process.env.TARGET_DB; const client = new Client({ host: process.env.PGHOST, port: Number(process.env.PGPORT), user: process.env.PGUSER, password: process.env.PGPASSWORD, database: 'postgres' }); client.connect().then(() => client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])).then((res) => { if (res.rows.length) return null; return client.query('CREATE DATABASE \"' + dbName.replace(/\"/g, '\"\"') + '\"'); }).then(() => client.end()).then(() => process.exit(0)).catch(async (err) => { console.error(err.message); try { await client.end(); } catch {} process.exit(1); });"
}

docker_available() {
  docker --version >/dev/null 2>&1
}

docker_postgres_running() {
  docker ps --format "{{.Names}}" 2>/dev/null | grep -E '^postgres$' >/dev/null 2>&1
}

install_docker_postgres() {
  if ! docker_available; then
    return 1
  fi

  if [ ! -f "$POSTGRES_COMPOSE_FILE" ]; then
    fail "Standalone postgres compose not found at $POSTGRES_COMPOSE_FILE"
  fi

  log "Creating external Docker volume postgres_data if missing"
  docker volume create postgres_data >/dev/null 2>&1 || true

  ENV_ARGS=""
  if [ -f "$POSTGRES_ENV_FILE" ]; then
    ENV_ARGS="--env-file $POSTGRES_ENV_FILE"
  fi

  log "Starting standalone PostgreSQL service"
  # shellcheck disable=SC2086
  docker compose -f "$POSTGRES_COMPOSE_FILE" $ENV_ARGS up -d

  POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
  POSTGRES_PORT="${POSTGRES_PORT:-5432}"
}

persist_database_url_to_project_env() {
  if [ -z "${DATABASE_URL:-}" ]; then
    return 0
  fi

  PROJECT_ENV_FILE="${PROJECT_ENV_FILE:-.env}"

  touch "$PROJECT_ENV_FILE"

  if grep -q '^DATABASE_URL=' "$PROJECT_ENV_FILE"; then
    TMP_FILE="${PROJECT_ENV_FILE}.tmp"
    sed "s|^DATABASE_URL=.*$|DATABASE_URL=${DATABASE_URL}|" "$PROJECT_ENV_FILE" > "$TMP_FILE"
    mv "$TMP_FILE" "$PROJECT_ENV_FILE"
  else
    printf '\nDATABASE_URL=%s\n' "$DATABASE_URL" >> "$PROJECT_ENV_FILE"
  fi

  log "Saved DATABASE_URL to $PROJECT_ENV_FILE"
}

detect_and_prepare_database() {
  load_env_file "$SHARED_ENV_FILE"
  load_env_file "$POSTGRES_ENV_FILE"
  load_env_file ".env"

  if diagnose_database_url; then
    return 0
  fi

  POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
  POSTGRES_PORT="${POSTGRES_PORT:-5432}"
  POSTGRES_USER="${POSTGRES_USER:-postgres}"
  POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-postgres}"
  VPN_DATABASE="${VPN_DATABASE:-$VPN_DATABASE_NAME}"

  log "No DATABASE_URL found; probing local PostgreSQL at ${POSTGRES_HOST}:${POSTGRES_PORT}"
  if can_connect_local_postgres; then
    create_database_if_missing
    build_database_url
    persist_database_url_to_project_env
    log "Using existing local PostgreSQL server"
    return 0
  fi

  log "Local PostgreSQL not reachable; checking Docker"
  if docker_available; then
    install_docker_postgres
    ATTEMPT=0
    until can_connect_local_postgres; do
      ATTEMPT=$((ATTEMPT + 1))
      if [ "$ATTEMPT" -ge 60 ]; then
        fail "Docker PostgreSQL did not become ready in time"
      fi
      sleep 2
    done

    create_database_if_missing
    build_database_url
    persist_database_url_to_project_env
    log "Standalone Docker PostgreSQL installed and configured"
    return 0
  fi

  fail "Neither DATABASE_URL, local PostgreSQL, nor Docker PostgreSQL is available. Install Docker or PostgreSQL."
}

wait_for_postgres() {
  if [ -z "${DATABASE_URL:-}" ]; then
    fail "DATABASE_URL is still not set after detection"
  fi

  log "Waiting for PostgreSQL to accept connections..."
  ATTEMPT=0
  until node -e "
const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
client.connect()
  .then(() => { console.log('[startup] PostgreSQL connection successful'); return client.end(); })
  .then(() => process.exit(0))
  .catch((err) => {
    const msg = err.message || String(err);
    const code = err.code || '';
    let category = 'unknown';
    if (code === 'ENOTFOUND' || /getaddrinfo|EAI_AGAIN|hostname/i.test(msg)) category = 'DNS_FAILURE';
    else if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || /connection refused/i.test(msg)) category = 'TCP_FAILURE';
    else if (code === 'ETIMEDOUT' || /timeout/i.test(msg)) category = 'TCP_FAILURE';
    else if (code === '28P01' || /password|authentication|auth failed/i.test(msg)) category = 'AUTH_FAILURE';
    else if (code === '3D000' || /database.*does not exist/i.test(msg)) category = 'DATABASE_MISSING';
    else if (code === '42501' || /permission|denied/i.test(msg)) category = 'PERMISSION_FAILURE';
    else if (code === '28000' || /SSL|pg_hba/i.test(msg)) category = 'SSL_MISMATCH';

    if (process.env.STARTUP_DEBUG) {
      console.error('[startup] PostgreSQL connection failed:');
      console.error('  Category: ' + category);
      console.error('  Code:     ' + (code || 'N/A'));
      console.error('  Message:  ' + msg);
    } else {
      console.error('[startup] PostgreSQL not ready (' + category + '): ' + msg.substring(0, 100));
    }
    process.exit(1);
  });
"; do
    ATTEMPT=$((ATTEMPT + 1))
    if [ "$ATTEMPT" -ge 60 ]; then
      fail "PostgreSQL did not become ready in time (60 attempts). Last error category logged above. Set STARTUP_DEBUG=1 for full details."
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
  node -e "const { PrismaClient } = require('@prisma/client'); const prisma = new PrismaClient(); prisma.user.count().then((count) => prisma.setting.count().catch(() => 0).then((settings) => ({ count, settings }))).then(({ count, settings }) => prisma.\$disconnect().then(() => ({ count, settings }))).then(({ count, settings }) => process.exit(count === 0 && settings === 0 ? 0 : 1)).catch(async (err) => { try { await prisma.\$disconnect(); } catch {} console.error(err); process.exit(2); });"
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

detect_and_prepare_database
wait_for_postgres
ensure_migrations_exist
run_prisma_generate
run_prisma_migrate
run_optional_seed
start_app