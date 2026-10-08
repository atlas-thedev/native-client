#!/usr/bin/env bash
set -euo pipefail

API_HOST="api.playnative.fun"
OLD_HOST="api.nativelaunch.xyz" # still served for older launchers and mods

if ! getent ahostsv4 "$API_HOST" >/dev/null; then
  echo "$API_HOST does not resolve yet. Add its proxied DNS record, wait for propagation, and run this script again." >&2
  exit 1
fi

sudo certbot --nginx --non-interactive --agree-tos --redirect \
  --register-unsafely-without-email \
  --cert-name "$API_HOST" -d "$API_HOST" -d "$OLD_HOST"

sudo nginx -t
sudo systemctl reload nginx
curl --fail --silent --show-error "https://$API_HOST/health"
echo
