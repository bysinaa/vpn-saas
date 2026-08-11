#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG=/etc/cloudflared/config.yml
TUNNEL_NAME=tazaxy
DOMAIN=""
PANEL_SUB="panel"
SUB_SUB="sub"

while (($#)); do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --panel-subdomain) PANEL_SUB="$2"; shift 2 ;;
    --subscription-subdomain) SUB_SUB="$2"; shift 2 ;;
    --tunnel) TUNNEL_NAME="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo 'Run this script as root.' >&2; exit 1; }
command -v cloudflared >/dev/null || { echo 'cloudflared is not installed.' >&2; exit 1; }
command -v node >/dev/null || { echo 'Node.js is required.' >&2; exit 1; }
command -v docker >/dev/null || { echo 'Docker is required.' >&2; exit 1; }

[[ -n "$DOMAIN" ]] || read -rp 'Cloudflare base domain (example.com): ' DOMAIN
read -rp "Panel subdomain [$PANEL_SUB]: " input; PANEL_SUB=${input:-$PANEL_SUB}
read -rp "Subscription subdomain [$SUB_SUB]: " input; SUB_SUB=${input:-$SUB_SUB}
DOMAIN=${DOMAIN#https://}; DOMAIN=${DOMAIN#http://}; DOMAIN=${DOMAIN%/}
PANEL_HOST="${PANEL_SUB}.${DOMAIN}"
SUB_HOST="${SUB_SUB}.${DOMAIN}"

mapfile -t origins < <(cd "$ROOT" && node <<'NODE'
const { createXuiRuntimeDetector } = require('./cli/installer/xui-runtime-detector');
(async () => {
  const result = await createXuiRuntimeDetector().discover();
  const panel = result?.data?.panel;
  const sub = result?.data?.subscription;
  if (!panel?.url || !sub?.host || !sub?.port) throw new Error('Authoritative XUI panel/subscription origins were not discovered');
  console.log(panel.url);
  console.log(`${sub.scheme || 'http'}://${sub.host}:${sub.port}`);
})().catch((error) => { console.error(error.message); process.exit(1); });
NODE
)
PANEL_ORIGIN=${origins[0]:-}
SUB_ORIGIN=${origins[1]:-}
[[ -n "$PANEL_ORIGIN" && -n "$SUB_ORIGIN" ]] || { echo 'XUI origin discovery failed.' >&2; exit 1; }

mkdir -p /etc/cloudflared
if [[ ! -f "$CONFIG" ]]; then
  [[ -f /root/.cloudflared/cert.pem ]] || {
    echo 'Cloudflare authentication is required once. Complete the browser login, then rerun this script.'
    cloudflared tunnel login
  }
  tunnel_json=$(cloudflared tunnel list --output json)
  tunnel_id=$(node -e 'const rows=JSON.parse(process.argv[1]); const row=rows.find(x=>x.name===process.argv[2]); if(row) process.stdout.write(row.id)' "$tunnel_json" "$TUNNEL_NAME")
  if [[ -z "$tunnel_id" ]]; then
    cloudflared tunnel create "$TUNNEL_NAME"
    tunnel_json=$(cloudflared tunnel list --output json)
    tunnel_id=$(node -e 'const rows=JSON.parse(process.argv[1]); const row=rows.find(x=>x.name===process.argv[2]); if(row) process.stdout.write(row.id)' "$tunnel_json" "$TUNNEL_NAME")
  fi
  [[ -n "$tunnel_id" && -f "/root/.cloudflared/$tunnel_id.json" ]] || { echo 'Tunnel credential file was not created.' >&2; exit 1; }
  cat >"$CONFIG" <<EOF
tunnel: $tunnel_id
credentials-file: /root/.cloudflared/$tunnel_id.json

ingress:
  - service: http_status:404
EOF
  chmod 600 "$CONFIG"
else
  tunnel_id=$(awk '/^tunnel:/ { print $2; exit }' "$CONFIG")
  [[ -n "$tunnel_id" ]] || { echo "No tunnel id in $CONFIG" >&2; exit 1; }
fi

cloudflared tunnel route dns --overwrite-dns "$tunnel_id" "$PANEL_HOST"
cloudflared tunnel route dns --overwrite-dns "$tunnel_id" "$SUB_HOST"
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

public_json=$(node -e 'process.stdout.write(JSON.stringify({panelUrl:`https://${process.argv[1]}`,subscriptionBaseUrl:`https://${process.argv[2]}`}))' "$PANEL_HOST" "$SUB_HOST")
printf '%s' "$public_json" | (cd "$ROOT" && docker compose -p tazaxy exec -T app node dist/src/scripts/configure-xui-public-urls.js)
node - "$ROOT/.tazaxy/config.json" "$PANEL_HOST" "$SUB_HOST" <<'NODE'
const fs = require('fs');
const [file, panel, sub] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
config.cloudflare = { tunnel: true, panelUrl: `https://${panel}`, subscriptionBaseUrl: `https://${sub}`, updatedAt: new Date().toISOString() };
fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
NODE

curl -fsS --retry 10 --retry-delay 2 "https://$PANEL_HOST" >/dev/null
curl -fsS --retry 10 --retry-delay 2 "https://$SUB_HOST" >/dev/null || true
echo "Panel URL: https://$PANEL_HOST"
echo "Subscription base URL: https://$SUB_HOST"
