#!/bin/sh
set -e

REPO_URL="${COMPANION_REPO_URL:-https://github.com/ignacio82/SpatialFin-Companion.git}"
AUTO_UPDATE="${COMPANION_AUTO_UPDATE:-true}"
UPDATER_STATE_DIR="/app/data/.updater"
LOCK_HASH_FILE="$UPDATER_STATE_DIR/package-lock.sha1"

PUID=${PUID:-0}
PGID=${PGID:-0}

log() {
  printf '[entrypoint] %s\n' "$*"
}

pull_latest_release() {
  if [ "$AUTO_UPDATE" = "false" ]; then
    log "auto-update disabled (COMPANION_AUTO_UPDATE=false); skipping pull"
    return 0
  fi

  if [ ! -d /app/.git ]; then
    log "no .git directory in /app; skipping pull"
    return 0
  fi

  # Treat /app as a safe git directory regardless of how the container was built.
  git config --global --add safe.directory /app >/dev/null 2>&1 || true

  if ! git -C /app remote get-url origin >/dev/null 2>&1; then
    git -C /app remote add origin "$REPO_URL" || true
  fi

  log "fetching tags from $REPO_URL"
  if ! git -C /app fetch --tags --prune --quiet origin; then
    log "git fetch failed; continuing with current checkout"
    return 0
  fi

  latest_tag=$(git -C /app tag --list --sort=-v:refname 'v*' | head -n 1)
  if [ -z "$latest_tag" ]; then
    log "no release tags found; continuing with current checkout"
    return 0
  fi

  current_ref=$(git -C /app describe --tags --exact-match 2>/dev/null || git -C /app rev-parse --short HEAD)
  if [ "$current_ref" = "$latest_tag" ]; then
    log "already on $latest_tag"
    return 0
  fi

  log "checking out $latest_tag (was $current_ref)"
  if ! git -C /app -c advice.detachedHead=false checkout --quiet --force "$latest_tag"; then
    log "checkout failed; continuing with current version"
  fi
}

install_deps_if_needed() {
  if [ ! -f /app/package-lock.json ]; then
    return 0
  fi
  mkdir -p "$UPDATER_STATE_DIR"
  new_hash=$(sha1sum /app/package-lock.json | awk '{print $1}')
  old_hash=""
  if [ -f "$LOCK_HASH_FILE" ]; then
    old_hash=$(cat "$LOCK_HASH_FILE")
  fi
  if [ "$new_hash" != "$old_hash" ]; then
    log "package-lock.json changed; running npm ci --omit=dev"
    if (cd /app && npm ci --omit=dev); then
      printf '%s' "$new_hash" > "$LOCK_HASH_FILE"
    else
      log "npm ci failed; continuing with existing node_modules"
    fi
  fi
}

pull_latest_release
install_deps_if_needed

if [ "$PUID" -ne 0 ] && [ "$PGID" -ne 0 ]; then
  log "starting as UID $PUID GID $PGID"
  chown -R "$PUID:$PGID" /app/data 2>/dev/null || true
  exec gosu "$PUID:$PGID" node index.js
else
  exec node index.js
fi
