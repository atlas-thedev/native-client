#!/usr/bin/env bash
#
# Post-build release helper (local publish flow, mirrors the v3.9.x layout).
#
# electron-builder emits space-named artifacts ("Native Client-*") and yml feeds
# that reference them. This script, for the current package.json version:
#   1. makes URL-safe hyphenated copies ("Native-Client-*"),
#   2. rewrites latest.yml / latest-linux.yml to point at the hyphenated names,
#   3. uploads to every target repo both the space-named originals (GitHub stores
#      them as "Native.Client-*") and the hyphenated copies plus the two ymls,
#      producing the established 12-asset set per release.
#
# Requires: gh (authed, repo scope). Drafts must already exist (ensure-release.js).
#
#   bash scripts/mirror-release-assets.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"
REPOS=(ohllama0909-alt/native-client ohllama0909-alt/native-launcher)
REL=release

echo "==> version ${VERSION} (${TAG})"

# 1. find artifacts for this version
shopt -s nullglob
mapfile -t ARTIFACTS < <(ls "$REL"/*"${VERSION}"* 2>/dev/null | grep -v '\.tmp$' | sort -u)
if [[ ${#ARTIFACTS[@]} -eq 0 ]]; then
  echo "error: no artifacts for ${VERSION} in ${REL}/" >&2
  exit 1
fi

for f in "${ARTIFACTS[@]}"; do
  base="$(basename "$f")"
  if [[ "$base" == *"Native Client-"* ]]; then
    hy="${base//Native Client-/Native-Client-}"
    if [[ ! -f "$REL/$hy" ]]; then
      cp -p "$f" "$REL/$hy"
      echo "   + $hy"
    fi
  fi
done

# 2. rewrite yml feeds to reference the hyphenated names (bytes unchanged -> sha/size stay)
for y in latest.yml latest-linux.yml; do
  [[ -f "$REL/$y" ]] || continue
  node -e '
    const fs=require("fs"); const p=process.argv[1];
    let t=fs.readFileSync(p,"utf8");
    t=t.replace(/Native Client-/g,"Native-Client-").replace(/Native%20Client-/g,"Native-Client-");
    fs.writeFileSync(p,t);
  ' "$REL/$y"
  echo "   ~ $y -> hyphenated refs"
done

# 3. build the upload list: versioned binaries + ymls
UPLOADS=()
for f in "$REL"/*"${VERSION}"*; do
  [[ -f "$f" ]] || continue
  [[ "$f" == *.tmp ]] && continue
  UPLOADS+=("$f")
done
for y in latest.yml latest-linux.yml; do
  [[ -f "$REL/$y" ]] && UPLOADS+=("$REL/$y")
done

echo "==> uploading ${#UPLOADS[@]} assets to ${#REPOS[@]} repos"
for repo in "${REPOS[@]}"; do
  echo "   -> $repo"
  gh release upload "$TAG" "${UPLOADS[@]}" --repo "$repo" --clobber
done
echo "==> mirror complete"
