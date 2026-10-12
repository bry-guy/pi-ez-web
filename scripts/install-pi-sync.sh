#!/usr/bin/env bash
# Installs pi-sync's packages/pi-sync at the commit in PI_SYNC_COMMIT into
# node_modules/@bry-guy/pi-sync. PI_SYNC_SOURCE=<pi-sync checkout> links a local
# checkout instead, for developing both repositories together.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$root/node_modules/@bry-guy/pi-sync"
mkdir -p "$(dirname "$dest")"
rm -rf "$dest"

if [ -n "${PI_SYNC_SOURCE:-}" ]; then
  src="$(cd "$PI_SYNC_SOURCE/packages/pi-sync" && pwd)"
  [ -d "$src/node_modules" ] || npm ci --include=dev --ignore-scripts --no-audit --no-fund --prefix "$src"
  npm run build --prefix "$src" >/dev/null
  ln -s "$src" "$dest"
  echo "pi-sync linked from $src"
  exit 0
fi

sha="$(tr -d '[:space:]' < "$root/PI_SYNC_COMMIT")"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "PI_SYNC_COMMIT must be a 40-character commit" >&2; exit 1; }
cache="$root/.cache/pi-sync/$sha"
if [ ! -f "$cache/.built" ]; then
  rm -rf "$cache"; mkdir -p "$cache"
  curl -fsSL --proto '=https' --tlsv1.2 --max-time 120 "https://codeload.github.com/bry-guy/pi-sync/tar.gz/$sha" \
    | tar -xz -C "$cache" --strip-components=3 "pi-sync-$sha/packages/pi-sync"
  npm ci --include=dev --ignore-scripts --no-audit --no-fund --prefix "$cache"
  npm run build --prefix "$cache"
  touch "$cache/.built"
fi
mkdir -p "$dest"
cp -a "$cache/package.json" "$cache/dist" "$cache/src" "$cache/skills" "$cache/extensions" "$cache/README.md" "$dest/"
echo "$sha" > "$dest/PI_SYNC_COMMIT"
echo "pi-sync $sha installed"
