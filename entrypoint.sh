#!/bin/sh
set -e

REPO_URL="${COMPANION_REPO_URL:-https://github.com/ignacio82/SpatialFin-Companion.git}"
UPDATE_REPO="${COMPANION_UPDATE_REPO:-ignacio82/SpatialFin-Companion}"
AUTO_UPDATE="${COMPANION_AUTO_UPDATE:-true}"
UPDATER_STATE_DIR="/app/data/.updater"
LOCK_HASH_FILE="$UPDATER_STATE_DIR/package-lock.sha1"

PUID=${PUID:-0}
PGID=${PGID:-0}

log() {
  printf '[entrypoint] %s\n' "$*"
}

resolve_latest_release_tag() {
  api_tag=$(
    UPDATE_REPO="$UPDATE_REPO" node -e '
      const https = require("https");
      const repo = process.env.UPDATE_REPO || "ignacio82/SpatialFin-Companion";
      const req = https.get(
        {
          host: "api.github.com",
          path: `/repos/${repo}/releases/latest`,
          headers: {
            "User-Agent": "SpatialFin-Companion-Updater",
            Accept: "application/vnd.github+json",
          },
          timeout: 10000,
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => { body += chunk; });
          res.on("end", () => {
            if (res.statusCode !== 200) return process.exit(0);
            try {
              const payload = JSON.parse(body);
              const tag = typeof payload.tag_name === "string" ? payload.tag_name.trim() : "";
              if (!payload.prerelease && !payload.draft && /^v\d+\.\d+\.\d+$/.test(tag)) {
                process.stdout.write(tag);
              }
            } catch (_) {}
          });
        }
      );
      req.on("timeout", () => req.destroy());
      req.on("error", () => {});
    ' 2>/dev/null || true
  )
  if [ -n "$api_tag" ] && git -C /app rev-parse --verify --quiet "refs/tags/$api_tag" >/dev/null 2>&1; then
    printf '%s' "$api_tag"
    return 0
  fi
  git -C /app tag --list --sort=-v:refname 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1 || true
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

  latest_tag=$(resolve_latest_release_tag)
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
