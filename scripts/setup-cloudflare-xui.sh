#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG=${CLOUDFLARED_CONFIG:-}
TUNNEL_NAME=tazaxy
PUBLIC_PANEL_URL=""
PUBLIC_SUB_URL=""

install_cloudflared() {
  command -v cloudflared >/dev/null && return
  command -v curl >/dev/null || {
    if command -v apt-get >/dev/null; then
      apt-get update
      DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates
    elif command -v dnf >/dev/null; then
      dnf install -y curl ca-certificates
    elif command -v yum >/dev/null; then
      yum install -y curl ca-certificates
    else
      echo 'curl is required and no supported package manager was found.' >&2
      exit 1
    fi
  }
  case "$(uname -m)" in
    x86_64|amd64) cloudflared_arch=amd64 ;;
    aarch64|arm64) cloudflared_arch=arm64 ;;
    armv7l|armv6l) cloudflared_arch=arm ;;
    i386|i686) cloudflared_arch=386 ;;
    *) echo "Unsupported CPU architecture for cloudflared: $(uname -m)" >&2; exit 1 ;;
  esac
  cloudflared_tmp=$(mktemp)
  echo "Installing cloudflared for $cloudflared_arch..."
  curl -fL --retry 3 -o "$cloudflared_tmp" \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$cloudflared_arch"
  install -m 0755 "$cloudflared_tmp" /usr/local/bin/cloudflared
  rm -f "$cloudflared_tmp"
  cloudflared --version
}

find_origin_certificate() {
  if [[ -n "${TUNNEL_ORIGIN_CERT:-}" && -f "$TUNNEL_ORIGIN_CERT" ]]; then
    printf '%s\n' "$TUNNEL_ORIGIN_CERT"
    return
  fi
  for candidate in /root/.cloudflared/cert.pem /etc/cloudflared/cert.pem /usr/local/etc/cloudflared/cert.pem; do
    if [[ -f "$candidate" ]]; then printf '%s\n' "$candidate"; return; fi
  done
}

while (($#)); do
  case "$1" in
    --panel-url) PUBLIC_PANEL_URL="$2"; shift 2 ;;
    --subscription-url) PUBLIC_SUB_URL="$2"; shift 2 ;;
    --tunnel) TUNNEL_NAME="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo 'Run this script as root.' >&2; exit 1; }
install_cloudflared
command -v node >/dev/null || { echo 'Node.js is required.' >&2; exit 1; }
command -v docker >/dev/null || { echo 'Docker is required.' >&2; exit 1; }

if [[ -z "$CONFIG" ]]; then
  CONFIG=$(pgrep -af '[c]loudflared.*tunnel' | sed -nE 's/.*--config[ =]([^ ]+).*/\1/p' | head -1 || true)
fi
if [[ -z "$CONFIG" ]]; then
  for candidate in /etc/cloudflared/config.yml /etc/cloudflared/config.yaml /root/.cloudflared/config.yml /root/.cloudflared/config.yaml; do
    if [[ -f "$candidate" ]]; then CONFIG=$candidate; break; fi
  done
fi
CONFIG=${CONFIG:-/etc/cloudflared/config.yml}

mapfile -t origins < <(cd "$ROOT" && node <<'NODE'
const { createXuiRuntimeDetector } = require('./cli/installer/xui-runtime-detector');
(async () => {
  const result = await createXuiRuntimeDetector().discover();
  const panel = result?.data?.panel;
  const sub = result?.data?.subscription;
  if (!panel?.url || !sub?.host || !sub?.port) throw new Error('Authoritative XUI panel/subscription origins were not discovered');
  const panelOrigin = new URL(panel.url);
  const panelPath = panelOrigin.pathname || '/';
  panelOrigin.pathname = '/';
  panelOrigin.search = '';
  panelOrigin.hash = '';
  console.log(panelOrigin.toString().replace(/\/$/, ''));
  console.log(`${sub.scheme || 'http'}://${sub.host}:${sub.port}`);
  console.log(panelPath.startsWith('/') ? panelPath : `/${panelPath}`);
})().catch((error) => { console.error(error.message); process.exit(1); });
NODE
)
PANEL_ORIGIN=${origins[0]:-}
SUB_ORIGIN=${origins[1]:-}
PANEL_PATH=${origins[2]:-/}
[[ -n "$PANEL_ORIGIN" && -n "$SUB_ORIGIN" ]] || { echo 'XUI origin discovery failed.' >&2; exit 1; }

existing_panel=""
existing_sub=""
existing_panel_origin=""
existing_sub_origin=""
ADOPT_EXISTING=false
if [[ -f "$CONFIG" ]]; then
  mapfile -t existing_routes < <(node - "$ROOT" "$CONFIG" "$PANEL_ORIGIN" "$SUB_ORIGIN" <<'NODE'
const fs = require('fs');
const [root, config, panel, subscription] = process.argv.slice(2);
const { discoverRoutes } = require(root + '/cli/installer/cloudflare-tunnel');
const routes = discoverRoutes(fs.readFileSync(config, 'utf8'), panel, subscription);
console.log(routes.panelHostname || '');
console.log(routes.subscriptionHostname || '');
console.log(routes.panelService || '');
console.log(routes.subscriptionService || '');
NODE
  )
  existing_panel=${existing_routes[0]:-}
  existing_sub=${existing_routes[1]:-}
  existing_panel_origin=${existing_routes[2]:-}
  existing_sub_origin=${existing_routes[3]:-}
fi

PANEL_HOST=""
SUB_HOST=""
panel_default=""
sub_default=""
if [[ -n "$existing_panel" ]]; then panel_default="https://${existing_panel}${PANEL_PATH}"; fi
if [[ -n "$existing_sub" ]]; then sub_default="https://${existing_sub}"; fi
if [[ -z "$PUBLIC_PANEL_URL" ]]; then
  read -rp "Panel public URL${panel_default:+ [$panel_default]}: " input
  PUBLIC_PANEL_URL=${input:-$panel_default}
fi
if [[ -z "$PUBLIC_SUB_URL" ]]; then
  read -rp "Subscription public base URL${sub_default:+ [$sub_default]}: " input
  PUBLIC_SUB_URL=${input:-$sub_default}
fi
[[ -n "$PUBLIC_PANEL_URL" && -n "$PUBLIC_SUB_URL" ]] || { echo 'Both public URLs are required.' >&2; exit 1; }

public_endpoints=$(node - "$ROOT" "$PUBLIC_PANEL_URL" "$PUBLIC_SUB_URL" "$PANEL_PATH" <<'NODE'
const [root, panel, subscription, detectedPath] = process.argv.slice(2);
const { normalizePublicUrls } = require(root + '/cli/installer/cloudflare-tunnel');
const endpoints = normalizePublicUrls(panel, subscription, detectedPath);
console.log(endpoints.panelUrl);
console.log(endpoints.panelHostname);
console.log(endpoints.subscriptionBaseUrl);
console.log(endpoints.subscriptionHostname);
NODE
) || { echo 'Invalid public Panel or Subscription URL.' >&2; exit 1; }
mapfile -t public_values <<<"$public_endpoints"
PUBLIC_PANEL_URL=${public_values[0]}
PANEL_HOST=${public_values[1]}
PUBLIC_SUB_URL=${public_values[2]}
SUB_HOST=${public_values[3]}

if [[ "$PANEL_HOST" == "$existing_panel" && "$SUB_HOST" == "$existing_sub" ]]; then
  PANEL_ORIGIN=$existing_panel_origin
  SUB_ORIGIN=$existing_sub_origin
  ADOPT_EXISTING=true
fi

if [[ ! -f "$CONFIG" || "$ADOPT_EXISTING" == false ]]; then
  CERT=$(find_origin_certificate || true)
  if [[ -z "$CERT" ]]; then
    echo 'Cloudflare login is required once. Open the displayed URL and select the domain for these links.'
    cloudflared tunnel login
    CERT=$(find_origin_certificate || true)
  fi
  [[ -n "$CERT" ]] || { echo 'Cloudflare login did not create cert.pem.' >&2; exit 1; }
fi

mkdir -p /etc/cloudflared
if [[ ! -f "$CONFIG" ]]; then
  CERT=${CERT:-$(find_origin_certificate || true)}
  [[ -n "$CERT" ]] || { echo 'Cloudflare authentication is required before creating a tunnel.' >&2; exit 1; }
  tunnel_json=$(cloudflared tunnel --origincert "$CERT" list --output json)
  tunnel_id=$(node -e 'const rows=JSON.parse(process.argv[1]); const row=rows.find(x=>x.name===process.argv[2]); if(row) process.stdout.write(row.id)' "$tunnel_json" "$TUNNEL_NAME")
  if [[ -z "$tunnel_id" ]]; then
    cloudflared tunnel --origincert "$CERT" create "$TUNNEL_NAME"
    tunnel_json=$(cloudflared tunnel --origincert "$CERT" list --output json)
    tunnel_id=$(node -e 'const rows=JSON.parse(process.argv[1]); const row=rows.find(x=>x.name===process.argv[2]); if(row) process.stdout.write(row.id)' "$tunnel_json" "$TUNNEL_NAME")
  fi
  credentials_file=""
  for candidate in "$(dirname "$CERT")/$tunnel_id.json" "/root/.cloudflared/$tunnel_id.json" "/etc/cloudflared/$tunnel_id.json"; do
    if [[ -f "$candidate" ]]; then credentials_file=$candidate; break; fi
  done
  [[ -n "$tunnel_id" && -n "$credentials_file" ]] || { echo 'Tunnel credential file was not created.' >&2; exit 1; }
  cat >"$CONFIG" <<EOF
tunnel: $tunnel_id
credentials-file: $credentials_file

ingress:
  - service: http_status:404
EOF
  chmod 600 "$CONFIG"
else
  tunnel_id=$(awk '/^tunnel:/ { print $2; exit }' "$CONFIG")
  [[ -n "$tunnel_id" ]] || { echo "No tunnel id in $CONFIG" >&2; exit 1; }
fi

if [[ "$ADOPT_EXISTING" == false ]]; then
  CERT=${CERT:-$(find_origin_certificate || true)}
  [[ -n "$CERT" ]] || { echo 'Cloudflare authentication is required before creating DNS routes.' >&2; exit 1; }
  cloudflared tunnel --origincert "$CERT" route dns --overwrite-dns "$tunnel_id" "$PANEL_HOST"
  cloudflared tunnel --origincert "$CERT" route dns --overwrite-dns "$tunnel_id" "$SUB_HOST"
fi
node "$ROOT/cli/installer/cloudflare-tunnel.js" "$CONFIG" "$PANEL_HOST" "$PANEL_ORIGIN" "$SUB_HOST" "$SUB_ORIGIN" >/dev/null
cloudflared tunnel --config "$CONFIG.tazaxy-new" ingress validate
cp "$CONFIG" "$CONFIG.bak.$(date +%Y%m%d%H%M%S)"
mv "$CONFIG.tazaxy-new" "$CONFIG"

cat >/etc/systemd/system/cloudflared-tazaxy.service <<EOF
[Unit]
Description=TAZAXY Cloudflare Tunnel
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=$(command -v cloudflared) tunnel --config $CONFIG run $tunnel_id
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
mapfile -t old_pids < <(pgrep -f "cloudflared tunnel --config $CONFIG" || true)
systemctl daemon-reload
systemctl enable --now cloudflared-tazaxy.service
systemctl restart cloudflared-tazaxy.service
new_pid=$(systemctl show -p MainPID --value cloudflared-tazaxy.service)
for pid in "${old_pids[@]}"; do [[ "$pid" == "$new_pid" ]] || kill "$pid" 2>/dev/null || true; done

public_json=$(node -e 'process.stdout.write(JSON.stringify({panelUrl:process.argv[1],subscriptionBaseUrl:process.argv[2]}))' "$PUBLIC_PANEL_URL" "$PUBLIC_SUB_URL")
printf '%s' "$public_json" | (cd "$ROOT" && docker compose -p tazaxy exec -T app node dist/src/scripts/configure-xui-public-urls.js)
node - "$ROOT/.tazaxy/config.json" "$PUBLIC_PANEL_URL" "$PUBLIC_SUB_URL" <<'NODE'
const fs = require('fs');
const [file, panel, sub] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
config.cloudflare = { tunnel: true, panelUrl: panel, subscriptionBaseUrl: sub, updatedAt: new Date().toISOString() };
fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
NODE

curl -fsS --retry 10 --retry-delay 2 "$PUBLIC_PANEL_URL" >/dev/null
echo "Panel URL: $PUBLIC_PANEL_URL"
echo "Subscription base URL: $PUBLIC_SUB_URL"
