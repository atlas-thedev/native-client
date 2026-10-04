#!/usr/bin/env bash
#
# Build the latest Native release on the x86_64 VPS and pull artifacts back
# into ./release so the update server serves them.
#
#   bash scripts/build-release.sh                  # build current version
#   VERSION=0.2.0 bash scripts/build-release.sh    # bump version, then build
#
# VPS credentials: do NOT put them in this script. Provide them via env or an
# optional ~/.native-vps.env file (chmod 600), e.g.:
#   export VPS_HOST=1.2.3.4 VPS_USER=root VPS_PASS=hunter2 VPS_DIR=/root/native
#
set -euo pipefail

cd "$(dirname "$0")/.."

# --- config ---------------------------------------------------------------
VPS_HOST="${VPS_HOST:-}"
VPS_USER="${VPS_USER:-root}"
VPS_PASS="${VPS_PASS:-}"
VPS_DIR="${VPS_DIR:-/root/native}"
VERSION="${VERSION:-}"

# load optional credential file
if [[ -f "$HOME/.native-client.env" ]]; then
  set -a; source "$HOME/.native-client.env"; set +a
elif [[ -f "$HOME/.native-launcher.env" ]]; then
  set -a; source "$HOME/.native-launcher.env"; set +a
fi

if [[ -z "$VPS_HOST" ]]; then echo "error: VPS_HOST is not set" >&2; exit 1; fi
if [[ -z "$VPS_PASS" ]]; then echo "error: VPS_PASS is not set" >&2; exit 1; fi
if ! command -v sshpass >/dev/null; then
  echo "error: sshpass is required" >&2; exit 1
fi

SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=15"
SSH=(sshpass -p "$VPS_PASS" ssh $SSH_OPTS "$VPS_USER@$VPS_HOST")
SCP=(sshpass -p "$VPS_PASS" scp $SSH_OPTS)

# bump version in this repo before syncing (electron-builder reads package.json)
if [[ -n "$VERSION" ]]; then
  node -e "
    const fs=require('fs');
    const p=JSON.parse(fs.readFileSync('package.json','utf8'));
    p.version='$VERSION';
    fs.writeFileSync('package.json', JSON.stringify(p,null,2)+'\n');
  "
  echo "bumped version -> $VERSION"
fi

# --- 1. sync source to the VPS -------------------------------------------
echo "==> syncing source to $VPS_HOST:$VPS_DIR"
TMP=$(mktemp -d)
tar czf "$TMP/src.tgz" \
  --exclude='./node_modules' --exclude='./release' --exclude='./dist' \
  --exclude='./*.git*' .
"${SCP[@]}" "$TMP/src.tgz" "$VPS_USER@$VPS_HOST:/tmp/native-src.tgz"
"${SSH[@]}" "mkdir -p '$VPS_DIR' && tar xzf /tmp/native-src.tgz -C '$VPS_DIR'"

# --- 2. build on the VPS -------------------------------------------------
echo "==> building on the VPS (this takes several minutes)"
"${SSH[@]}" "VPS_DIR='$VPS_DIR' bash -s" <<'EOF'
set -euo pipefail
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
if ! command -v ar >/dev/null 2>&1; then
  sudo apt-get install -y binutils >/dev/null 2>&1 || true
fi
cd "$VPS_DIR"
npm install --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund
npm approve-scripts electron esbuild >/dev/null 2>&1 || true
if [[ ! -f node_modules/electron/dist/electron ]]; then
  npm rebuild electron esbuild >/dev/null 2>&1 || true
fi
node -e "require('esbuild')" 2>/dev/null || node node_modules/esbuild/install.js
npm run build
npx electron-builder --win nsis
npx electron-builder --win zip
npx electron-builder --linux
EOF
"${SSH[@]}" "VPS_DIR='$VPS_DIR' bash -s" <<'EOF'
set -euo pipefail
cd "$VPS_DIR/release"
tar czf /tmp/native-artifacts.tgz \
  latest.yml latest-linux.yml *.exe *.exe.blockmap *.zip *.AppImage *.deb 2>/dev/null || true
EOF
"${SCP[@]}" "$VPS_USER@$VPS_HOST:/tmp/native-artifacts.tgz" "$TMP/artifacts.tgz"
if [[ -f "$TMP/artifacts.tgz" ]]; then
  tar xzf "$TMP/artifacts.tgz" -C release
fi

# clean stale/partial artifacts from earlier ad-hoc builds
rm -f \
  release/"Native 0.1.0.exe" \
  release/Native-*-arm64-win.zip \
  release/latest-win.yml

echo "==> done. artifacts:"
ls -lh release/*.exe release/*.zip release/*.AppImage release/*.deb release/*.yml 2>/dev/null
rm -rf "$TMP"