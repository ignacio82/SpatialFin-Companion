# AGENTS.md — SpatialFin Companion

This file is the source of truth for AI coding agents working on this project
(Claude Code, Codex, Gemini, and anything else). `CLAUDE.md` and `GEMINI.md`
exist only to redirect here. Read this whole document before making changes.

## What this project is

SpatialFin Companion is a Node.js + Express + SQLite service that runs in
Docker on the user's LAN. It is the control plane for the SpatialFin Android XR
client (<https://github.com/ignacio82/SpatialFin>): headset onboarding, config
sync, analytics, network shares, TV pairing, device logging.

End users install it by cloning this repo and running `docker compose up -d
--build` once. After that, updates roll out automatically — the container pulls
the newest released tag on every restart, and a daily in-process check restarts
the container when a new release is published. **Any change that ships in a
release reaches users within ~24 hours.** Treat releases as production.

## Repository layout

| File | Purpose |
| --- | --- |
| `index.js` | HTTP + WebSocket server, admin/headset APIs, analytics pipeline |
| `storage.js` | SQLite layer (config, devices, events, sessions, logs, backups) |
| `default-preferences.js` | Default headset preferences synced to clients |
| `network-shares.js`, `nfs-rpc.js`, `smb-probe.js`, `share-discovery.js`, `share-test-utils.js` | SMB / NFS discovery + validation |
| `tv-pairing.js` | TV receiver pairing helpers |
| `updater.js` | Daily GitHub release check; exits the process when a newer tag is found |
| `entrypoint.sh` | Pulls the newest release tag on boot, runs `npm ci` when `package-lock.json` changes, then execs node |
| `Dockerfile` | Clones the repo + checks out latest release tag at build time |
| `docker-compose.yaml` | Default deployment (host network, `restart: unless-stopped`) |
| `client/` | Dashboard source — React + Vite. `client/src/` for components/screens, `client/public/` for static assets. |
| `public/` | **Build output**, served by Express. Produced by `npm run build` from `client/`. Committed to git so the auto-update loop never has to run Vite. |
| `vite.config.js` | Vite config — outputs to `public/`, proxies `/api` to the API server in dev. |
| `test/` | Node test runner specs (`npm test`) |
| `data/` | User state — SQLite DB, backups, uploaded logs. Do not touch at runtime. |

## How the auto-update loop works

1. `docker compose up -d --build` builds the image. The Dockerfile
   `git clone`s this repo into `/app` and checks out the latest `v*` tag.
2. On every container start, `entrypoint.sh`:
   - `git fetch --tags` from `origin`
   - `git checkout` the newest `v*` tag
   - reruns `npm ci --omit=dev` if `package-lock.json`'s SHA-1 changed (cached
     under `/app/data/.updater/`)
   - `exec`s `node index.js`
3. Once running, `updater.js` calls
   `GET https://api.github.com/repos/ignacio82/SpatialFin-Companion/releases/latest`
   every 24 hours. If `tag_name` is newer than `package.json`'s `version`, it
   calls `process.exit(0)`. Docker's `restart: unless-stopped` restarts the
   container, and step 2 picks up the new tag.

The update path relies on **GitHub releases**, not pushes to `master`. A commit
on `master` without a release/tag does **not** reach end users.

## Publishing updates to end users (read every time)

**After pushing any code change to GitHub, always ask the user:**

> "Do you want this change to ship to existing installations now, or land on
> `master` only?"

- **Master-only** (`git push origin master`): the change is visible on GitHub
  but no running container ever pulls it. Use this for work-in-progress,
  experimental changes, or commits that should be bundled into the next
  release.
- **Release** (tag + GitHub release): every existing install will pull it
  within 24h. Use this once the change is ready for everyone.

Never tag or publish a release without explicit user approval in the current
turn.

### Release checklist (only when user approves)

1. Make sure `master` has the change and tests pass (`npm test`).
2. If the dashboard changed, **rebuild it**: `npm run build` and commit the
   resulting `public/` along with the source. Forgetting this step ships
   stale UI to every install.
3. Bump `version` in `package.json` following semver.
4. Commit: `git commit -am "Release vX.Y.Z"` (use the exact version).
5. Tag: `git tag -a vX.Y.Z -m "vX.Y.Z"`.
6. Push: `git push origin master && git push origin vX.Y.Z`.
7. Publish the GitHub release — this is what `releases/latest` returns:
   ```sh
   gh release create vX.Y.Z --title "vX.Y.Z" --notes "<changelog>"
   ```
   If `gh` is unavailable, use
   <https://github.com/ignacio82/SpatialFin-Companion/releases/new>.

If the tag is pushed but no release is published, `releases/latest` will not
return it and users will stay on the prior version. Always finish with step 6.

### Versioning rules of thumb

- **Patch (`1.0.1 → 1.0.2`)**: bug fixes, UI polish, docs, dependency bumps.
- **Minor (`1.0.x → 1.1.0`)**: new features, new API endpoints.
- **Major (`1.x.y → 2.0.0`)**: schema changes users can't auto-migrate, breaking
  config changes, breaking API changes to the headset contract.

## Local development

```bash
npm install
node index.js
```

- Tests: `npm test` (Node's built-in runner).
- To develop without the runtime updater tripping you up, run with
  `COMPANION_AUTO_UPDATE=false`.
- Dashboard is at `http://localhost:1982`.

### Dashboard build

The dashboard is React + Vite. Source lives in `client/`. The build output
lives in `public/` and is committed to git.

- `npm run dev` — Vite dev server at <http://localhost:5173> with `/api/*` proxied to `localhost:1982`.
- `npm run build` — produces `public/index.html` and `public/assets/*`.

**You must rebuild before tagging a release.** End users only ever load
`public/` — if it's stale, your code changes never reach them.

## Environment variables

| Name | Default | Purpose |
| --- | --- | --- |
| `PORT` | `1982` | HTTP port |
| `PUID` / `PGID` | `0` | Drop privileges for the node process |
| `COMPANION_ADMIN_PASSWORD` | unset | Optional admin login for the dashboard |
| `COMPANION_AUTO_UPDATE` | `true` | `false` disables both boot-time git pull and the daily release check |
| `COMPANION_REPO_URL` | `https://github.com/ignacio82/SpatialFin-Companion.git` | Git remote used by `entrypoint.sh` |
| `COMPANION_UPDATE_REPO` | `ignacio82/SpatialFin-Companion` | `owner/repo` hit by `updater.js` |
| `COMPANION_UPDATE_INTERVAL_MS` | `86400000` | Release-check interval (min 1h) |
| `ANALYTICS_SYNC_INTERVAL_MS` | `120000` | Jellyfin analytics poll interval (min 30s) |

## Engineering guardrails

- **Respect the auto-update path.** Anything merged + released is live on every
  user's LAN within a day. Don't release half-finished work.
- **Preserve `./data/`.** It holds the SQLite DB, rolling backups, uploaded
  logs. Use the `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN`
  patterns already in `storage.js` — there is no migration framework.
- **Never break `entrypoint.sh`.** If it crashes, every container enters a
  restart loop and self-healing stops.
- **Keep `/app/.git` valid at runtime.** The boot-time pull depends on it.
- **LAN threat model.** The service assumes a trusted LAN. Headset auth is the
  setup token; admin auth is optional password + session. Don't widen trust
  without discussion.
- **No backwards-compat cruft for your own recent changes.** Rename freely;
  don't leave `_deprecated` shims behind.
- **Never commit, push, tag, or release without explicit user approval in the
  current turn.** Approval for one push does not imply approval for the next.

## Pre-release checklist

- [ ] `npm test` passes.
- [ ] If the dashboard changed: `npm run build` succeeds and the new
      `public/index.html` + `public/assets/` are committed.
- [ ] `docker compose build` succeeds from a clean state.
- [ ] A fresh container boots cleanly against the new tag (no schema errors,
      no missing files, dashboard loads).
- [ ] `package.json` `version` matches the intended tag.
- [ ] README or AGENTS.md changes (if any) are in the release commit.

## Communication style

- Be terse. No emoji. No recap of the diff after showing it.
- Propose a plan before large refactors; don't silently restructure.
- Surface risky or hard-to-reverse actions before taking them (schema changes,
  force pushes, tag deletions, anything that touches `./data/` of an existing
  user).
