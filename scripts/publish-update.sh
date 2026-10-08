#!/usr/bin/env bash
#
# Publish the current ./release to the public update server AND to the
# website download/update dirs served by nginx on playnative.fun.
#
#   1. Update feed :8800  -> ./release          (electron-updater, public IP 80.225.195.237)
#   2. Website download   -> /home/native/native-website/downloads  (https://playnative.fun/downloads/)
#   3. Website update dir -> /home/native/native-website/updates    (https://playnative.fun/updates/)
#
# Versioned artifacts are copied with "no clobber". Update metadata is replaced
# on every publish so clients can discover the newly published version.
#
#   bash scripts/publish-update.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."

PUBLIC_URL="${PUBLIC_URL:-https://playnative.fun/updates}"
SERVICE="${SERVICE:-native-update}"
PUB_SITE="${PUB_SITE:-/home/native/native-website}"

echo "==> restarting update server ($SERVICE)"
if sudo systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
  sudo systemctl restart "$SERVICE"
else
  echo "   ($SERVICE systemd unit not found, starting it manually)"
  sudo nohup node update-server.js >> /tmp/native-update.log 2>&1 &
fi

sleep 2

echo "==> verifying update feed"
curl -fsS --max-time 5 http://127.0.0.1:8800/latest.yml -o /dev/null \
  && echo "   local : OK (127.0.0.1:8800)"

# --- sync artifacts to the website dirs (no-overwrite) ----------------------
echo "==> syncing artifacts to $PUB_SITE"
if [[ -d "$PUB_SITE" ]] && sudo test -w "$PUB_SITE"; then
  sudo install -d -o native -g native "$PUB_SITE/downloads" "$PUB_SITE/updates"

  # installer binaries -> downloads/
  for f in ./release/*.exe ./release/*.zip ./release/*.deb ./release/*.AppImage ./release/*.tar.*; do
    [[ -f "$f" ]] || continue
    base="$(basename "$f")"
    if ! sudo test -e "$PUB_SITE/downloads/$base"; then
      sudo cp -p "$f" "$PUB_SITE/downloads/"
      sudo chown native:native "$PUB_SITE/downloads/$base"
      echo "   + downloads/$base"
    fi
  done

  # immutable updater artifacts -> updates/
  for f in ./release/*.exe ./release/*.exe.blockmap ./release/*.AppImage; do
    [[ -f "$f" ]] || continue
    base="$(basename "$f")"
    if ! sudo test -e "$PUB_SITE/updates/$base"; then
      sudo cp -p "$f" "$PUB_SITE/updates/"
      sudo chown native:native "$PUB_SITE/updates/$base"
      echo "   + updates/$base"
    fi
  done

  # mutable feed metadata must always point at the newest immutable artifacts
  for f in ./release/latest*.yml; do
    [[ -f "$f" ]] || continue
    base="$(basename "$f")"
    sudo cp -p "$f" "$PUB_SITE/updates/$base.tmp"
    sudo chown native:native "$PUB_SITE/updates/$base.tmp"
    sudo mv -f "$PUB_SITE/updates/$base.tmp" "$PUB_SITE/updates/$base"
    echo "   ~ updates/$base"
  done
else
  echo "   (site dir $PUB_SITE not found - skipping website sync)"
fi

VERSION=$(sed -n 's/^[[:space:]]*version:[[:space:]]*//p' release/latest.yml | head -1)
echo "==> published version: ${VERSION:-unknown}"
echo "    public updater URL: $PUBLIC_URL/latest.yml"
echo "    site download:     https://playnative.fun/downloads/"
