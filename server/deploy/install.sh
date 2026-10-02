#!/usr/bin/env bash
# One-time install on the VPS:  bash install.sh   (needs sudo)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="${NOCTRA_APP_DIR:-$HOME/noctra-server}"
mkdir -p "$APP/.deploy"
install -m 755 "$HERE/auto-deploy.sh" "$APP/.deploy/auto-deploy.sh"
sudo install -m 644 "$HERE/noctra-deploy.service" /etc/systemd/system/noctra-deploy.service
sudo install -m 644 "$HERE/noctra-deploy.timer" /etc/systemd/system/noctra-deploy.timer
sudo systemctl daemon-reload
sudo systemctl enable --now noctra-deploy.timer
echo "Installed. Logs: journalctl -u noctra-deploy -n 50"
