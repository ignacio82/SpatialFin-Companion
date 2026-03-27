# SpatialFin Companion

SpatialFin Companion is the local management and analytics hub for the **SpatialFin Android XR client**. It gives you a browser-based control plane for onboarding headsets, managing Jellyfin servers and users, pushing shared preferences, configuring network shares, collecting diagnostics, and now running a Jellystat-style analytics dashboard over your Jellyfin activity.

## Features

- QR-based headset onboarding with a per-instance setup token.
- Centralized Jellyfin server and user management.
- User verification that stores Jellyfin access tokens for sync and realtime analytics.
- Global preference sync for playback, language, voice assistant, diagnostics, and service integrations.
- Per-user language overrides for shared installations.
- SMB and NFS network share management.
- Seerr (Overseerr / Jellyseerr) settings and connectivity testing.
- TMDB and cloud AI key management.
- Config export/import from the dashboard.
- Optional admin password protection via `COMPANION_ADMIN_PASSWORD`.
- Sync history showing when headsets pulled config from the companion.
- SQLite-backed storage for config state, device records, events, logs, config snapshots, analytics sessions, and enriched media metadata.
- Remote SpatialFin logging:
  - Enable or disable headset logging from the companion.
  - View uploaded device logs in the dashboard.
  - Download per-device log archives from the browser.
- Analytics dashboard:
  - Overview metrics for sessions, watch time, completion rate, and content footprint.
  - Daily trend chart with session volume and watch time.
  - Top servers, users, libraries, and items.
  - Recent session inspection with event timelines.
  - Watch history with filtering and grouped watch events.
  - Per-user and per-item drilldowns.
- Automatic Jellyfin analytics collection:
  - Poll active `/Sessions` from verified Jellyfin users.
  - Maintain live websocket connections for lower-latency ingestion.
  - Close stale playback sessions when they disappear from Jellyfin.
  - Track realtime socket health from the admin dashboard.
- Metadata enrichment:
  - Persist enriched Jellyfin item metadata for analytics rows.
  - Show posters, overview text, runtime, year, ratings, genres, and series context in item/session drilldowns.
- Progressive Web App support for installing the dashboard on desktop or mobile.

## Docker Deployment

The included Compose file persists both configuration and uploaded device logs.

```bash
docker compose up -d --build
```

The dashboard is then available at:

```text
http://<your-server-ip>:1982
```

### Optional admin password

Set `COMPANION_ADMIN_PASSWORD` before starting the container if you want the dashboard locked behind a login screen.

Example:

```bash
COMPANION_ADMIN_PASSWORD='change-me' docker compose up -d --build
```

## Persistent Data

- `./data/companion.sqlite` stores companion config state, config snapshots, sync events, device metadata, uploaded logs, analytics sessions, event timelines, and enriched media item metadata.
- `./data/backups/` stores rolling SQLite backup copies created by the companion.
- `./config.json` is only used as a legacy migration source for older installs that still mounted config as a flat file.

If you remove `./data/`, you lose the active config database, event history, snapshots, uploaded logs, analytics history, and metadata cache.

## How It Works

1. Open the dashboard and configure your Jellyfin servers, verified users, and any network shares.
2. Adjust global settings such as language behavior, playback defaults, voice assistant options, Seerr, TMDB, OMDb, AI keys, and diagnostics.
3. Open SpatialFin on the headset and scan the QR code from the dashboard during onboarding, or from the in-app SpatialFin Companion settings later.
4. The headset syncs the companion config using the embedded setup token.
5. If companion logging is enabled, new log lines from SpatialFin are uploaded back to the companion and become visible in the `Device Logs` section.
6. Verified Jellyfin users allow the companion to collect active playback sessions automatically through polling and websocket subscriptions, enrich items with metadata, and render them in the analytics dashboard.

## Analytics

The companion now includes a substantial local analytics stack intended to cover the most useful Jellystat-style workflows on your own network.

What it does today:

- Accepts authenticated playback session updates on `POST /api/v1/analytics/sessions`.
- Polls verified Jellyfin servers for active playback sessions.
- Opens Jellyfin websocket connections per verified server/user pair for realtime updates.
- Stores normalized playback sessions plus an append-only event timeline for each playback session.
- Groups repeated snapshots into watch-history events and closes stale sessions automatically.
- Enriches item analytics with Jellyfin metadata such as posters, overview text, runtime, year, ratings, genres, and series information.
- Exposes admin APIs and dashboard views for:
  - overview metrics
  - recent sessions
  - top servers, users, libraries, and items
  - watch history
  - trends
  - per-user and per-item drilldowns
  - realtime socket diagnostics

Example ingest payload:

```json
{
  "sessions": [
    {
      "playbackSessionId": "beam-headset:user-1:item-42:2026-03-22T15:14:00Z",
      "deviceId": "beam-headset",
      "serverId": "server-1",
      "serverName": "Jellyfin",
      "userId": "user-1",
      "username": "ignacio",
      "itemId": "item-42",
      "itemName": "Blade Runner 2049",
      "itemType": "Movie",
      "libraryId": "movies",
      "libraryName": "Movies",
      "clientName": "SpatialFin XR",
      "playbackMethod": "DirectPlay",
      "startedAt": "2026-03-22T15:14:00Z",
      "lastSeenAt": "2026-03-22T15:44:00Z",
      "playDurationMs": 1800000,
      "positionTicks": 10800000000,
      "runtimeTicks": 10800000000,
      "completed": true,
      "eventType": "stop",
      "eventDetails": {
        "reason": "playback-ended"
      }
    }
  ]
}
```

Notes:

- These endpoints use the same `X-Setup-Token` trust model as headset config sync.
- Jellyfin polling remains the correctness fallback even when websocket ingestion is enabled.
- The dashboard now includes a realtime analytics UI, not just backend groundwork.

Useful admin analytics endpoints:

- `GET /api/admin/analytics/overview`
- `GET /api/admin/analytics/sessions`
- `GET /api/admin/analytics/sessions/:playbackSessionId`
- `GET /api/admin/analytics/users`
- `GET /api/admin/analytics/libraries`
- `GET /api/admin/analytics/servers`
- `GET /api/admin/analytics/items`
- `GET /api/admin/analytics/history`
- `GET /api/admin/analytics/trends`
- `GET /api/admin/analytics/realtime-status`
- `POST /api/admin/analytics/sync-now`

## Device Logging

The companion can now act as a lightweight log receiver for SpatialFin headsets.

- Turn on `Enable Companion Logging` in `Global Settings -> Diagnostics`.
- Save the settings and let the headset sync with the companion.
- New log lines generated by SpatialFin are uploaded to the companion.
- Open `Device Logs` in the dashboard to inspect recent entries.
- Use `Download Logs` to export a text file for a specific headset.

Notes:

- Logging only uploads new lines produced after logging is enabled on the headset.
- Existing local log files already written on the headset are not backfilled automatically.
- The headset still keeps its own local log file behavior; the companion adds centralized viewing and download.

## Realtime Analytics Notes

- Realtime Jellyfin websocket subscriptions use verified user access tokens already saved in the companion config.
- Different Jellyfin versions can vary in websocket payload shape and permission behavior, so the companion treats websocket traffic as a low-latency ingestion path and keeps HTTP polling as a fallback.
- The analytics dashboard exposes per-socket health so you can see whether a connection is live, reconnecting, or failing.

## Security Notes

- The companion is intended to run on your local network.
- Public headset sync endpoints require the current `setup_token`.
- Admin routes can be protected with `COMPANION_ADMIN_PASSWORD`.
- Rotating the setup token invalidates existing headset sync tokens until the headset is re-paired or updated with the new token.

## Development

Install dependencies and run the app directly:

```bash
npm install
node index.js
```

## Related Project

SpatialFin Companion works with the main SpatialFin app:

- SpatialFin app: `https://github.com/ignacio82/SpatialFin`

---

SpatialFin is a third-party client and is not affiliated with the official Jellyfin project.
