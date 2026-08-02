#!/usr/bin/env bash
# One-shot setup for the Oracle Cloud "Always Free" ARM Ubuntu instance.
#
# Usage:
#   sudo bash setup.sh <duckdns-subdomain>
# Example:
#   sudo bash setup.sh cwtool          -> serves https://cwtool.duckdns.org
#
# Prereqs:
#   - project files already at /opt/cwtool (with server.js)
#   - DuckDNS subdomain created and pointed at this server's public IP
#   - Oracle Cloud security list has ports 80 and 443 open (ingress)
set -euo pipefail

SUBDOMAIN="${1:?Usage: sudo bash setup.sh <duckdns-subdomain> (no .duckdns.org)}"
DOMAIN="${SUBDOMAIN}.duckdns.org"
APP_DIR=/opt/cwtool

echo "==> Verifying project at ${APP_DIR}"
if [ ! -f "${APP_DIR}/server.js" ]; then
  echo "ERROR: ${APP_DIR}/server.js not found. Copy the project there first, e.g.:"
  echo "  sudo mv ~/cwtool /opt/cwtool"
  exit 1
fi
cd "${APP_DIR}"

echo "==> Installing Node.js 22 LTS"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "==> Installing Caddy (automatic HTTPS)"
if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

echo "==> Installing npm dependencies"
npm install --omit=dev

echo "==> Installing systemd service"
sed "s|cwtool.duckdns.org|${DOMAIN}|g" "${APP_DIR}/deploy/cwtool.service" > /etc/systemd/system/cwtool.service
systemctl daemon-reload
systemctl enable --now cwtool

echo "==> Configuring Caddy"
sed "s|cwtool.duckdns.org|${DOMAIN}|g" "${APP_DIR}/deploy/Caddyfile" > /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl reload caddy || true

echo "==> Firewall (in addition to Oracle's security list)"
ufw allow 80/tcp >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true

echo ""
echo "DONE. Next steps:"
echo "  1. DuckDNS: create '${SUBDOMAIN}' and point it at THIS server's public IP."
echo "  2. Oracle console: Instance Details > Attached VNICs > security list — allow ingress TCP 80 and 443."
echo "  3. HTTPS will be live at:  https://${DOMAIN}"
echo "  4. Verify:  curl -s https://${DOMAIN}/api/health"
echo "  5. Logs:    journalctl -u cwtool -f"
