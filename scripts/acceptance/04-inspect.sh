#!/usr/bin/env bash
# Read-only inspection of the existing Tazaxy install before reinstalling.
echo "--- /opt/tazaxy ---"
if [ -d /opt/tazaxy/.git ]; then
  cd /opt/tazaxy || exit 0
  echo "remote=$(git config --get remote.origin.url)"
  echo "branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  echo "commit=$(git rev-parse --short HEAD 2>/dev/null)"
  echo "dirty=$(git status --porcelain | wc -l) file(s)"
else
  echo "no git checkout at /opt/tazaxy"
fi
echo "env=$([ -f /opt/tazaxy/.env ] && echo PRESENT || echo NONE)"
echo "state=$([ -f /opt/tazaxy/installer-state.json ] && echo PRESENT || echo NONE)"
echo "built_cli=$([ -f /opt/tazaxy/cli/dist-cli/index.js ] && echo PRESENT || echo NONE)"
echo "--- tazaxy launcher ---"
tazaxy --version 2>&1 | head -3; echo "version_exit=$?"
echo "--- docker (tazaxy-owned only) ---"
docker ps -a --format '{{.Names}}\t{{.Status}}' 2>/dev/null | grep -i tazaxy || echo "no tazaxy containers"
docker volume ls --format '{{.Name}}' 2>/dev/null | grep -i tazaxy || echo "no tazaxy volumes"
echo "--- telegram api reachability (specific endpoint shape) ---"
echo "getMe_with_dummy=$(curl -sS -m 20 -o /dev/null -w '%{http_code}' https://api.telegram.org/bot000:invalid/getMe 2>&1)"
