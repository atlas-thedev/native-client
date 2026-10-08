#!/usr/bin/env bash
set -euo pipefail

API_HOST="api.nativelaunch.xyz"

if ! getent ahostsv4 "$API_HOST" >/dev/null; then
  echo "$API_HOST does not resolve yet. Add its proxied DNS record, wait for propagation, and run this script again." >&2
  exit 1
fi

sudo certbot --nginx --non-interactive --agree-tos --redirect \
  --register-unsafely-without-email \
  -d "$API_HOST"

sudo nginx -t
sudo systemctl reload nginx
curl --fail --silent --show-error "https://$API_HOST/health"
echo
