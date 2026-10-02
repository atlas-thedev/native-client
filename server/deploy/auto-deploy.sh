#!/usr/bin/env bash
# Pull-based deploy for the Noctra API.
#
# Every few minutes (systemd timer) this checks whether `server/` changed on the
# main branch of the public client repo. If it did it
#   1. downloads that exact commit, 2. syntax-checks it, 3. backs up the running code,
#   4. swaps the code in (never touches data/, .env, node_modules/),
#   5. reloads pm2 and waits for /health, 6. rolls back automatically if it fails.
#
# No GitHub secrets or inbound SSH needed. Run by hand any time:  ./auto-deploy.sh [--force]
set -euo pipefail

REPO="${NOCTRA_REPO:-atlas-thedev/noctra-client}"
BRANCH="${NOCTRA_BRANCH:-main}"
APP="${NOCTRA_APP_DIR:-$HOME/noctra-server}"
PM2_NAME="${NOCTRA_PM2_NAME:-noctra-server}"
HEALTH="${NOCTRA_HEALTH_URL:-http://127.0.0.1:3418/health}"
STATE="$APP/.deploy"
KEEP_BACKUPS=5
PROTECTED=(data .env node_modules .deploy scripts package-lock.json)

mkdir -p "$STATE/backups"
exec 9>"$STATE/lock"
flock -n 9 || { echo "another deploy is running"; exit 0; }

log() { echo "[$(date -u +%FT%TZ)] $*"; }
FORCE=0; [ "${1:-}" = "--force" ] && FORCE=1

# 1. newest commit on the branch that touched server/
SHA="$(curl -fsS --max-time 20 -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/$REPO/commits?sha=$BRANCH&path=server&per_page=1" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);console.log(Array.isArray(a)&&a[0]?a[0].sha:"")})')"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { log "could not read the latest commit"; exit 0; }

LAST="$(cat "$STATE/deployed-sha" 2>/dev/null || true)"
FAILED="$(cat "$STATE/failed-sha" 2>/dev/null || true)"
if [ "$FORCE" = 0 ]; then
  [ "$SHA" = "$LAST" ] && exit 0
  [ "$SHA" = "$FAILED" ] && exit 0   # already tried and rolled back; wait for a new commit
fi
log "deploying $SHA (was ${LAST:-none})"

# 2. fetch + verify
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
curl -fsSL --max-time 120 "https://codeload.github.com/$REPO/tar.gz/$SHA" -o "$WORK/src.tgz"
mkdir "$WORK/src"; tar -xzf "$WORK/src.tgz" -C "$WORK/src" --strip-components=1 --wildcards '*/server'
NEW="$WORK/src/server"
[ -f "$NEW/index.js" ] && [ -f "$NEW/server.js" ] || { log "download has no server/"; exit 1; }
while IFS= read -r -d '' file; do node --check "$file" || { log "syntax error in $file"; echo "$SHA" > "$STATE/failed-sha"; exit 1; }; done \
  < <(find "$NEW" -name '*.js' -not -path '*/node_modules/*' -print0)

# 3. backup (code only)
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="$STATE/backups/$STAMP.tgz"
( cd "$APP" && tar -czf "$BACKUP" --exclude=./data --exclude=./node_modules --exclude=./.deploy --exclude='*.bak-*' . )
ls -1t "$STATE"/backups/*.tgz 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f

# 4. swap code in. Entries we deployed before but that are gone upstream are removed too.
is_protected() { local n; for n in "${PROTECTED[@]}"; do [ "$1" = "$n" ] && return 0; done; return 1; }
PKG_BEFORE="$(cat "$APP/package.json" 2>/dev/null | tr -d '\357\273\277' | sha256sum | cut -d' ' -f1)"
PREVIOUS="$STATE/entries.txt"; touch "$PREVIOUS"
CURRENT="$WORK/entries.txt"; : > "$CURRENT"
for path in "$NEW"/* "$NEW"/.[!.]*; do
  [ -e "$path" ] || continue
  name="$(basename "$path")"
  is_protected "$name" && continue
  echo "$name" >> "$CURRENT"
  rm -rf "$APP/$name"; cp -a "$path" "$APP/$name"
done
while IFS= read -r old; do
  [ -n "$old" ] && ! grep -qxF "$old" "$CURRENT" && ! is_protected "$old" && rm -rf "${APP:?}/$old"
done < "$PREVIOUS"
cp "$CURRENT" "$PREVIOUS"

# 5. dependencies only when package.json changed
PKG_AFTER="$(cat "$APP/package.json" | tr -d '\357\273\277' | sha256sum | cut -d' ' -f1)"
if [ "$PKG_BEFORE" != "$PKG_AFTER" ] || [ ! -d "$APP/node_modules" ]; then
  log "installing dependencies"
  ( cd "$APP" && npm install --omit=dev --no-audit --no-fund --loglevel=error )
fi

# 6. reload + health check, roll back on failure
rollback() {
  log "FAILED: $1 - rolling back to the previous code"
  echo "$SHA" > "$STATE/failed-sha"
  ( cd "$APP" && tar -xzf "$BACKUP" )
  pm2 reload "$PM2_NAME" --update-env >/dev/null 2>&1 || pm2 restart "$PM2_NAME" >/dev/null 2>&1 || true
  exit 1
}
pm2 reload "$PM2_NAME" --update-env >/dev/null 2>&1 || pm2 restart "$PM2_NAME" >/dev/null || rollback "pm2 reload"
ok=0
for _ in $(seq 1 30); do
  sleep 1
  if curl -fsS --max-time 3 "$HEALTH" >/dev/null 2>&1; then ok=1; break; fi
done
[ "$ok" = 1 ] || rollback "health check"
sleep 4
curl -fsS --max-time 3 "$HEALTH" >/dev/null 2>&1 || rollback "health check after settle"

echo "$SHA" > "$STATE/deployed-sha"; rm -f "$STATE/failed-sha"
# keep this script itself current (atomic rename: the running copy is unaffected)
if [ -f "$APP/deploy/auto-deploy.sh" ] && ! cmp -s "$APP/deploy/auto-deploy.sh" "$STATE/auto-deploy.sh"; then
  install -m 755 "$APP/deploy/auto-deploy.sh" "$STATE/auto-deploy.sh.new" && mv -f "$STATE/auto-deploy.sh.new" "$STATE/auto-deploy.sh"
fi
log "deployed $SHA"
