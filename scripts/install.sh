#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${TAZAXY_REPO_URL:-https://github.com/bysinaa/vpn-saas.git}"
INSTALL_DIR="${TAZAXY_INSTALL_DIR:-/opt/tazaxy}"
BRANCH="${TAZAXY_BRANCH:-main}"

log() {
  printf '\n[%s] %s\n' "tazaxy-installer" "$1"
}

require_root() {
  if [ "${EUID:-$(id -u)}" -ne 0 ]; then
    echo "This installer must be run as root." >&2
    exit 1
  fi
}

detect_package_manager() {
  if command -v apt-get >/dev/null 2>&1; then
    echo "apt"
    return
  fi

  if command -v dnf >/dev/null 2>&1; then
    echo "dnf"
    return
  fi

  if command -v yum >/dev/null 2>&1; then
    echo "yum"
    return
  fi

  echo "unsupported"
}

install_base_dependencies() {
  local manager
  manager="$(detect_package_manager)"

  case "$manager" in
    apt)
      log "Installing Git, curl, and Node.js prerequisites with apt"
      apt-get update
      DEBIAN_FRONTEND=noninteractive apt-get install -y git curl ca-certificates build-essential
      if ! command -v node >/dev/null 2>&1; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
        DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
      fi
      ;;
    dnf)
      log "Installing Git, curl, and Node.js prerequisites with dnf"
      dnf install -y git curl ca-certificates gcc-c++ make
      if ! command -v node >/dev/null 2>&1; then
        dnf module enable -y nodejs:20 || true
        dnf install -y nodejs
      fi
      ;;
    yum)
      log "Installing Git, curl, and Node.js prerequisites with yum"
      yum install -y git curl ca-certificates gcc-c++ make
      if ! command -v node >/dev/null 2>&1; then
        curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
        yum install -y nodejs
      fi
      ;;
    *)
      echo "Unsupported Linux package manager. Install git, curl, and Node.js 20+ manually." >&2
      exit 1
      ;;
  esac
}

install_or_update_repo() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    log "Updating existing repository at $INSTALL_DIR"
    git -C "$INSTALL_DIR" fetch origin
    git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"
    git -C "$INSTALL_DIR" clean -fdx
    return
  fi

  log "Cloning repository into $INSTALL_DIR"
  rm -rf "$INSTALL_DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
}

build_cli() {
  # Verify the install directory and package.json exist before running npm.
  # npm must run in the directory that actually contains package.json,
  # otherwise it fails with a confusing ENOENT error.
  if [ ! -d "$INSTALL_DIR" ]; then
    echo "ERROR: install directory not found: $INSTALL_DIR" >&2
    echo "The repository was not cloned successfully." >&2
    echo "Expected repository: $REPO_URL" >&2
    exit 1
  fi

  if [ ! -f "$INSTALL_DIR/package.json" ]; then
    echo "ERROR: package.json not found in $INSTALL_DIR" >&2
    echo "This usually means the wrong repository was cloned." >&2
    echo "Expected repository: $REPO_URL (project name: vpn-saas)" >&2
    echo "Fix the TAZAXY_REPO_URL environment variable, remove $INSTALL_DIR, and re-run this installer." >&2
    exit 1
  fi

  log "Installing npm dependencies in $INSTALL_DIR"
  cd "$INSTALL_DIR" || {
    echo "ERROR: unable to enter install directory: $INSTALL_DIR" >&2
    exit 1
  }

  # Prefer a reproducible install when a lockfile is present
  if [ -f "$INSTALL_DIR/package-lock.json" ]; then
    npm ci
  else
    npm install
  fi

  log "Building Tazaxy CLI"
  if ! npm run cli:build; then
    echo "ERROR: CLI build failed (npm run cli:build). Cannot continue." >&2
    exit 1
  fi

  # Verify the compiled CLI entrypoint exists
  if [ ! -f "$INSTALL_DIR/cli/dist-cli/index.js" ]; then
    echo "ERROR: cli/dist-cli/index.js not found after build. Cannot continue." >&2
    exit 1
  fi

  log "CLI built successfully: $(node cli/dist-cli/index.js --version 2>/dev/null || echo 'OK')"
}

install_launcher() {
  log "Installing global tazaxy launcher"
  cat >/usr/local/bin/tazaxy <<EOF
#!/usr/bin/env bash
cd "$INSTALL_DIR"
exec node cli/dist-cli/index.js "\$@"
EOF
  chmod +x /usr/local/bin/tazaxy

  cat >/usr/local/bin/vpn-cli <<EOF
#!/usr/bin/env bash
exec /usr/local/bin/tazaxy "\$@"
EOF
  chmod +x /usr/local/bin/vpn-cli
}

run_cli_installer() {
  log "Starting interactive TAZAXY installation"
  cd "$INSTALL_DIR"
  node cli/dist-cli/index.js install "$@"
}

show_management_menu() {
  log "Opening TAZAXY management menu"
  cd "$INSTALL_DIR"
  node cli/dist-cli/index.js menu
}

uninstall_everything() {
  log "Uninstalling TAZAXY and cleaning up all files"

  # Stop and remove tazaxy containers
  if docker compose -f "$INSTALL_DIR/docker-compose.yml" ps >/dev/null 2>&1; then
    docker compose -f "$INSTALL_DIR/docker-compose.yml" down --remove-orphans
    log "Stopped and removed tazaxy containers"
  fi

  # Remove tazaxy named volumes
  if docker volume ls -q | grep -q "^tazaxy_"; then
    docker volume rm $(docker volume ls -q | grep "^tazaxy_")
    log "Removed tazaxy named volumes"
  fi

  # Remove tazaxy networks
  if docker network ls -q | grep -q "^tazaxy_"; then
    docker network rm $(docker network ls -q | grep "^tazaxy_")
    log "Removed tazaxy networks"
  fi

  # Remove installation directory
  if [ -d "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR"
    log "Removed installation directory: $INSTALL_DIR"
  fi

  # Remove launchers
  if [ -f /usr/local/bin/tazaxy ]; then
    rm -f /usr/local/bin/tazaxy
    log "Removed tazaxy launcher"
  fi

  if [ -f /usr/local/bin/vpn-cli ]; then
    rm -f /usr/local/bin/vpn-cli
    log "Removed vpn-cli launcher"
  fi

  # Optionally remove database and user
  if [ "${REMOVE_DB:-false}" = "true" ]; then
    log "Removing tazaxy database and user"
    psql -U postgres -c "DROP DATABASE IF EXISTS tazaxy;"
    psql -U postgres -c "DROP ROLE IF EXISTS vpn_user;"
    log "Removed tazaxy database and user"
  fi

  log "Uninstallation complete. System is clean."
}

main() {
  require_root
  install_base_dependencies
  install_or_update_repo
  build_cli
  install_launcher
  # If the user requested only 3X‑UI installation, skip the interactive installer
  if [[ "$@" == *"--install-3xui"* ]]; then
    log "Installing 3X‑UI runtime only (skipping interactive configuration)"
    node cli/dist-cli/index.js install3xui
  else
    run_cli_installer "$@"
    show_management_menu
  fi
}

main "$@"
