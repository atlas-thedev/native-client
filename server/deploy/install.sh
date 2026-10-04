#!/usr/bin/env bash
# One-time install on the VPS:  bash install.sh   (needs sudo)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="${NATIVE_APP_DIR:-$HOME/native-server}"
mkdir -p "$APP/.deploy"
install -m 755 "$HERE/auto-deploy.sh" "$APP/.deploy/auto-deploy.sh"
sudo install -m 644 "$HERE/native-deploy.service" /etc/systemd/system/native-deploy.service
sudo install -m 644 "$HERE/native-deploy.timer" /etc/systemd/system/native-deploy.timer
sudo systemctl daemon-reload
sudo systemctl enable --now native-deploy.timer
echo "Installed. Logs: journalctl -u native-deploy -n 50"
