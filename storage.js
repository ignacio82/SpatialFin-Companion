const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_MAX_LOG_ENTRIES_PER_DEVICE = 5000;
const DEFAULT_MAX_LOG_MESSAGE_LENGTH = 4000;

function createStorage(options) {
  const {
    rootDir,
    defaultPreferences,
    maxLogEntriesPerDevice = DEFAULT_MAX_LOG_ENTRIES_PER_DEVICE,
    maxLogMessageLength = DEFAULT_MAX_LOG_MESSAGE_LENGTH,
    watchEventThresholdMs = 60 * 60 * 1000
  } = options;

  const dataDir = path.join(rootDir, 'data');
  const dbFile = path.join(dataDir, 'companion.sqlite');
  const legacyConfigFile = path.join(rootDir, 'config.json');
  const legacyDeviceLogsFile = path.join(dataDir, 'device-logs.json');

  ensureDir(dataDir);

  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  initSchema();
  const statements = {
    getState: db.prepare('SELECT value FROM app_state WHERE key = ?'),
    upsertState: db.prepare(`
      INSERT INTO app_state (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `),
    insertSnapshot: db.prepare(`
      INSERT INTO config_snapshots (created_at, reason, config_json)
      VALUES (?, ?, ?)
    `),
    insertEvent: db.prepare(`
      INSERT INTO events (type, created_at, ip, user_agent, details_json)
      VALUES (?, ?, ?, ?, ?)
    `),
    syncEvents: db.prepare(`
      SELECT id, created_at, ip, user_agent, details_json
      FROM events
      WHERE type = 'device_sync_pull'
      ORDER BY id DESC
      LIMIT ?
    `),
    upsertDevice: db.prepare(`
      INSERT INTO devices (
        device_id, device_name, model, manufacturer, app_version, android_version,
        session_id, first_seen_at, last_seen_at, latest_entry_at, entry_count, last_ip
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        device_name = excluded.device_name,
        model = excluded.model,
        manufacturer = excluded.manufacturer,
        app_version = excluded.app_version,
        android_version = excluded.android_version,
        session_id = excluded.session_id,
        last_seen_at = excluded.last_seen_at,
        latest_entry_at = excluded.latest_entry_at,
        entry_count = excluded.entry_count,
        last_ip = excluded.last_ip
    `),
    insertDeviceLog: db.prepare(`
      INSERT INTO device_logs (device_id, timestamp, received_at, level, tag, message, stack)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    deleteOldDeviceLogs: db.prepare(`
      DELETE FROM device_logs
      WHERE id IN (
        SELECT id
        FROM device_logs
        WHERE device_id = ?
        ORDER BY id ASC
        LIMIT ?
      )
    `),
    countDeviceLogs: db.prepare('SELECT COUNT(*) AS count FROM device_logs WHERE device_id = ?'),
    getDevice: db.prepare(`
      SELECT
        device_id AS deviceId,
        device_name AS deviceName,
        model,
        manufacturer,
        app_version AS appVersion,
        android_version AS androidVersion,
        session_id AS sessionId,
        first_seen_at AS firstSeenAt,
        last_seen_at AS lastSeenAt,
        latest_entry_at AS latestEntryAt,
        entry_count AS entryCount,
        last_ip AS lastIp
      FROM devices
      WHERE device_id = ?
    `),
    getDevices: db.prepare(`
      SELECT
        device_id AS deviceId,
        device_name AS deviceName,
        model,
        manufacturer,
        app_version AS appVersion,
        android_version AS androidVersion,
        session_id AS sessionId,
        first_seen_at AS firstSeenAt,
        last_seen_at AS lastSeenAt,
        latest_entry_at AS latestEntryAt,
        entry_count AS entryCount,
        last_ip AS lastIp
      FROM devices
      ORDER BY latest_entry_at DESC, last_seen_at DESC, device_name ASC
    `),
    clearDeviceLogs: db.prepare('DELETE FROM device_logs WHERE device_id = ?'),
    resetDeviceLogCount: db.prepare('UPDATE devices SET entry_count = 0, latest_entry_at = NULL WHERE device_id = ?'),
    createSession: db.prepare('INSERT INTO admin_sessions (token, created_at) VALUES (?, ?)'),
    getSession: db.prepare('SELECT token FROM admin_sessions WHERE token = ?'),
    getSnapshots: db.prepare('SELECT id, created_at, reason FROM config_snapshots ORDER BY id DESC LIMIT 50'),
    getSnapshotById: db.prepare('SELECT config_json FROM config_snapshots WHERE id = ?'),
    getDeviceLogs: db.prepare(`
      SELECT timestamp, received_at AS receivedAt, level, tag, message, stack
      FROM device_logs
      WHERE device_id = ?
      ORDER BY id DESC
      LIMIT ?
    `),
    upsertPlaybackSession: db.prepare(`
      INSERT INTO playback_sessions (
        playback_session_id, device_id, session_id, server_id, server_name,
        user_id, username, item_id, item_name, item_type, library_id, library_name,
        client_name, playback_method, started_at, ended_at, last_seen_at,
        play_duration_ms, position_ticks, runtime_ticks, completed, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(playback_session_id) DO UPDATE SET
        device_id = excluded.device_id,
        session_id = excluded.session_id,
        server_id = excluded.server_id,
        server_name = excluded.server_name,
        user_id = excluded.user_id,
        username = excluded.username,
        item_id = excluded.item_id,
        item_name = excluded.item_name,
        item_type = excluded.item_type,
        library_id = excluded.library_id,
        library_name = excluded.library_name,
        client_name = excluded.client_name,
        playback_method = excluded.playback_method,
        started_at = CASE
          WHEN playback_sessions.started_at IS NULL THEN excluded.started_at
          WHEN excluded.started_at IS NULL THEN playback_sessions.started_at
          WHEN excluded.started_at < playback_sessions.started_at THEN excluded.started_at
          ELSE playback_sessions.started_at
        END,
        ended_at = excluded.ended_at,
        last_seen_at = excluded.last_seen_at,
        play_duration_ms = excluded.play_duration_ms,
        position_ticks = excluded.position_ticks,
        runtime_ticks = excluded.runtime_ticks,
        completed = excluded.completed,
        raw_json = excluded.raw_json
    `),
    insertPlaybackSessionEvent: db.prepare(`
      INSERT INTO playback_session_events (
        playback_session_id, event_type, created_at, position_ticks, details_json
      ) VALUES (?, ?, ?, ?, ?)
    `),
    upsertMediaItemMetadata: db.prepare(`
      INSERT INTO media_item_metadata (
        server_id, item_id, item_name, item_type, series_name, season_name,
        production_year, premiere_date, official_rating, community_rating,
        runtime_ticks, primary_image_tag, backdrop_image_tag, overview,
        genres_json, image_blur_hash, last_refreshed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id, item_id) DO UPDATE SET
        item_name = excluded.item_name,
        item_type = excluded.item_type,
        series_name = excluded.series_name,
        season_name = excluded.season_name,
        production_year = excluded.production_year,
        premiere_date = excluded.premiere_date,
        official_rating = excluded.official_rating,
        community_rating = excluded.community_rating,
        runtime_ticks = excluded.runtime_ticks,
        primary_image_tag = excluded.primary_image_tag,
        backdrop_image_tag = excluded.backdrop_image_tag,
        overview = excluded.overview,
        genres_json = excluded.genres_json,
        image_blur_hash = excluded.image_blur_hash,
        last_refreshed_at = excluded.last_refreshed_at
    `),
    getMediaItemMetadataByServerAndItem: db.prepare(`
      SELECT
        server_id AS serverId,
        item_id AS itemId,
        item_name AS itemName,
        item_type AS itemType,
        series_name AS seriesName,
        season_name AS seasonName,
        production_year AS productionYear,
        premiere_date AS premiereDate,
        official_rating AS officialRating,
        community_rating AS communityRating,
        runtime_ticks AS runtimeTicks,
        primary_image_tag AS primaryImageTag,
        backdrop_image_tag AS backdropImageTag,
        overview,
        genres_json AS genresJson,
        image_blur_hash AS imageBlurHash,
        last_refreshed_at AS lastRefreshedAt
      FROM media_item_metadata
      WHERE server_id = ? AND item_id = ?
    `),
    getLatestMediaItemMetadataByItem: db.prepare(`
      SELECT
        server_id AS serverId,
        item_id AS itemId,
        item_name AS itemName,
        item_type AS itemType,
        series_name AS seriesName,
        season_name AS seasonName,
        production_year AS productionYear,
        premiere_date AS premiereDate,
        official_rating AS officialRating,
        community_rating AS communityRating,
        runtime_ticks AS runtimeTicks,
        primary_image_tag AS primaryImageTag,
        backdrop_image_tag AS backdropImageTag,
        overview,
        genres_json AS genresJson,
        image_blur_hash AS imageBlurHash,
        last_refreshed_at AS lastRefreshedAt
      FROM media_item_metadata
      WHERE item_id = ?
      ORDER BY last_refreshed_at DESC
      LIMIT 1
    `),
    countPlaybackSessions: db.prepare('SELECT COUNT(*) AS count FROM playback_sessions'),
    analyticsOverview: db.prepare(`
      SELECT
        COUNT(*) AS totalSessions,
        COALESCE(SUM(play_duration_ms), 0) AS totalPlayDurationMs,
        COUNT(DISTINCT user_id) AS uniqueUsers,
        COUNT(DISTINCT item_id) AS uniqueItems,
        COUNT(DISTINCT library_id) AS uniqueLibraries,
        COUNT(DISTINCT device_id) AS uniqueDevices,
        SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) AS completedSessions,
        MAX(last_seen_at) AS lastSessionAt
      FROM playback_sessions
    `),
    analyticsRecentSessions: db.prepare(`
      SELECT
        playback_session_id AS playbackSessionId,
        device_id AS deviceId,
        session_id AS sessionId,
        server_id AS serverId,
        server_name AS serverName,
        user_id AS userId,
        username,
        item_id AS itemId,
        item_name AS itemName,
        item_type AS itemType,
        library_id AS libraryId,
        library_name AS libraryName,
        client_name AS clientName,
        playback_method AS playbackMethod,
        started_at AS startedAt,
        ended_at AS endedAt,
        last_seen_at AS lastSeenAt,
        play_duration_ms AS playDurationMs,
        position_ticks AS positionTicks,
        runtime_ticks AS runtimeTicks,
        completed
      FROM playback_sessions
      ORDER BY last_seen_at DESC, started_at DESC
      LIMIT ?
    `),
    analyticsTopUsers: db.prepare(`
      SELECT
        user_id AS userId,
        username,
        COUNT(*) AS sessionCount,
        COALESCE(SUM(play_duration_ms), 0) AS totalPlayDurationMs,
        MAX(last_seen_at) AS lastSessionAt
      FROM playback_sessions
      WHERE user_id IS NOT NULL OR username IS NOT NULL
      GROUP BY user_id, username
      ORDER BY totalPlayDurationMs DESC, sessionCount DESC, username ASC
      LIMIT ?
    `),
    analyticsTopLibraries: db.prepare(`
      SELECT
        library_id AS libraryId,
        library_name AS libraryName,
        COUNT(*) AS sessionCount,
        COALESCE(SUM(play_duration_ms), 0) AS totalPlayDurationMs,
        COUNT(DISTINCT item_id) AS uniqueItems,
        MAX(last_seen_at) AS lastSessionAt
      FROM playback_sessions
      WHERE library_id IS NOT NULL OR library_name IS NOT NULL
      GROUP BY library_id, library_name
      ORDER BY totalPlayDurationMs DESC, sessionCount DESC, library_name ASC
      LIMIT ?
    `),
    analyticsSessionEvents: db.prepare(`
      SELECT
        id,
        playback_session_id AS playbackSessionId,
        event_type AS eventType,
        created_at AS createdAt,
        position_ticks AS positionTicks,
        details_json AS detailsJson
      FROM playback_session_events
      WHERE playback_session_id = ?
      ORDER BY id ASC
      LIMIT ?
    `),
    analyticsDailyTrends: db.prepare(`
      SELECT
        substr(last_seen_at, 1, 10) AS day,
        COUNT(*) AS sessionCount,
        COALESCE(SUM(play_duration_ms), 0) AS totalPlayDurationMs,
        COUNT(DISTINCT user_id) AS uniqueUsers,
        COUNT(DISTINCT item_id) AS uniqueItems
      FROM playback_sessions
      GROUP BY substr(last_seen_at, 1, 10)
      ORDER BY day DESC
      LIMIT ?
    `),
    analyticsTopItems: db.prepare(`
      SELECT
        item_id AS itemId,
        item_name AS itemName,
        item_type AS itemType,
        COUNT(*) AS sessionCount,
        COALESCE(SUM(play_duration_ms), 0) AS totalPlayDurationMs,
        MAX(last_seen_at) AS lastSessionAt,
        COUNT(DISTINCT user_id) AS uniqueUsers
      FROM playback_sessions
      WHERE item_id IS NOT NULL OR item_name IS NOT NULL
      GROUP BY item_id, item_name, item_type
      ORDER BY totalPlayDurationMs DESC, sessionCount DESC, itemName ASC
      LIMIT ?
    `),
    analyticsWatchHistory: db.prepare(`
      SELECT
        playback_session_id AS playbackSessionId,
        device_id AS deviceId,
        session_id AS sessionId,
        server_id AS serverId,
        server_name AS serverName,
        user_id AS userId,
        username,
        item_id AS itemId,
        item_name AS itemName,
        item_type AS itemType,
        library_id AS libraryId,
        library_name AS libraryName,
        client_name AS clientName,
        playback_method AS playbackMethod,
        started_at AS startedAt,
        ended_at AS endedAt,
        last_seen_at AS lastSeenAt,
        play_duration_ms AS playDurationMs,
        position_ticks AS positionTicks,
        runtime_ticks AS runtimeTicks,
        completed
      FROM playback_sessions
      WHERE
        (? IS NULL OR username = ? OR user_id = ?)
        AND (? IS NULL OR item_name LIKE ? OR item_id = ?)
      ORDER BY last_seen_at DESC, started_at DESC
      LIMIT ?
    `),
    analyticsUserOverview: db.prepare(`
      SELECT
        user_id AS userId,
        username,
        COUNT(*) AS sessionCount,
        COALESCE(SUM(play_duration_ms), 0) AS totalPlayDurationMs,
        COUNT(DISTINCT item_id) AS uniqueItems,
        COUNT(DISTINCT library_id) AS uniqueLibraries,
        MAX(last_seen_at) AS lastSessionAt
      FROM playback_sessions
      WHERE user_id = ? OR username = ?
      GROUP BY user_id, username
      ORDER BY totalPlayDurationMs DESC
      LIMIT 1
    `),
    analyticsUserRecent: db.prepare(`
      SELECT
        playback_session_id AS playbackSessionId,
        device_id AS deviceId,
        session_id AS sessionId,
        server_id AS serverId,
        server_name AS serverName,
        user_id AS userId,
        username,
        item_id AS itemId,
        item_name AS itemName,
        item_type AS itemType,
        library_id AS libraryId,
        library_name AS libraryName,
        client_name AS clientName,
        playback_method AS playbackMethod,
        started_at AS startedAt,
        ended_at AS endedAt,
        last_seen_at AS lastSeenAt,
        play_duration_ms AS playDurationMs,
        position_ticks AS positionTicks,
        runtime_ticks AS runtimeTicks,
        completed
      FROM playback_sessions
      WHERE user_id = ? OR username = ?
      ORDER BY last_seen_at DESC, started_at DESC
      LIMIT ?
    `),
    analyticsItemOverview: db.prepare(`
      SELECT
        item_id AS itemId,
        item_name AS itemName,
        item_type AS itemType,
        COUNT(*) AS sessionCount,
        COALESCE(SUM(play_duration_ms), 0) AS totalPlayDurationMs,
        COUNT(DISTINCT user_id) AS uniqueUsers,
        COUNT(DISTINCT library_id) AS uniqueLibraries,
        MAX(last_seen_at) AS lastSessionAt
      FROM playback_sessions
      WHERE item_id = ? OR item_name = ?
      GROUP BY item_id, item_name, item_type
      ORDER BY totalPlayDurationMs DESC
      LIMIT 1
    `),
    analyticsItemRecent: db.prepare(`
      SELECT
        playback_session_id AS playbackSessionId,
        device_id AS deviceId,
        session_id AS sessionId,
        server_id AS serverId,
        server_name AS serverName,
        user_id AS userId,
        username,
        item_id AS itemId,
        item_name AS itemName,
        item_type AS itemType,
        library_id AS libraryId,
        library_name AS libraryName,
        client_name AS clientName,
        playback_method AS playbackMethod,
        started_at AS startedAt,
        ended_at AS endedAt,
        last_seen_at AS lastSeenAt,
        play_duration_ms AS playDurationMs,
        position_ticks AS positionTicks,
        runtime_ticks AS runtimeTicks,
        completed
      FROM playback_sessions
      WHERE item_id = ? OR item_name = ?
      ORDER BY last_seen_at DESC, started_at DESC
      LIMIT ?
    `),
    findOpenPlaybackSessionsForScope: db.prepare(`
      SELECT
        playback_session_id AS playbackSessionId,
        server_id AS serverId,
        user_id AS userId,
        username,
        item_id AS itemId,
        item_name AS itemName,
        started_at AS startedAt,
        ended_at AS endedAt,
        last_seen_at AS lastSeenAt,
        play_duration_ms AS playDurationMs,
        position_ticks AS positionTicks,
        runtime_ticks AS runtimeTicks,
        completed
      FROM playback_sessions
      WHERE
        server_id = ?
        AND ended_at IS NULL
        AND (
          (user_id IS NOT NULL AND user_id = ?)
          OR (? IS NULL AND username = ?)
        )
    `),
    closePlaybackSession: db.prepare(`
      UPDATE playback_sessions
      SET ended_at = ?, last_seen_at = ?, completed = ?
      WHERE playback_session_id = ?
    `)
  };

  migrateLegacyState();

  return {
    dbFile,
    getConfig,
    saveConfig,
    recordEvent,
    getSyncLog,
    getDeviceSummaries,
    getDeviceWithLogs,
    upsertDeviceLogs,
    clearDeviceLogs,
    createAdminSession,
    validateAdminSession,
    getConfigSnapshots,
    restoreConfigSnapshot,
    upsertPlaybackSessions,
    getAnalyticsOverview,
    getRecentPlaybackSessions,
    getTopPlaybackUsers,
    getTopPlaybackServers,
    getTopPlaybackLibraries,
    getPlaybackSessionWithEvents,
    upsertMediaItemMetadata,
    getMediaItemMetadata,
    getDailyPlaybackTrends,
    getTopPlaybackItems,
    getWatchHistory,
    closeMissingPlaybackSessions,
    getPlaybackUserDetail,
    getPlaybackItemDetail
  };

  function initSchema() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS admin_sessions (
        token TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      
      CREATE TABLE IF NOT EXISTS config_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        reason TEXT NOT NULL,
        config_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        ip TEXT,
        user_agent TEXT,
        details_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_type_created_at ON events(type, created_at DESC);

      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        device_name TEXT NOT NULL,
        model TEXT,
        manufacturer TEXT,
        app_version TEXT,
        android_version TEXT,
        session_id TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        latest_entry_at TEXT,
        entry_count INTEGER NOT NULL DEFAULT 0,
        last_ip TEXT
      );

      CREATE TABLE IF NOT EXISTS device_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        received_at TEXT NOT NULL,
        level TEXT,
        tag TEXT,
        message TEXT,
        stack TEXT,
        FOREIGN KEY(device_id) REFERENCES devices(device_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_device_logs_device_id_id ON device_logs(device_id, id DESC);

      CREATE TABLE IF NOT EXISTS playback_sessions (
        playback_session_id TEXT PRIMARY KEY,
        device_id TEXT,
        session_id TEXT,
        server_id TEXT,
        server_name TEXT,
        user_id TEXT,
        username TEXT,
        item_id TEXT,
        item_name TEXT,
        item_type TEXT,
        library_id TEXT,
        library_name TEXT,
        client_name TEXT,
        playback_method TEXT,
        started_at TEXT,
        ended_at TEXT,
        last_seen_at TEXT NOT NULL,
        play_duration_ms INTEGER NOT NULL DEFAULT 0,
        position_ticks INTEGER,
        runtime_ticks INTEGER,
        completed INTEGER NOT NULL DEFAULT 0,
        raw_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_playback_sessions_last_seen_at ON playback_sessions(last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_playback_sessions_user_id ON playback_sessions(user_id, last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_playback_sessions_library_id ON playback_sessions(library_id, last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_playback_sessions_item_id ON playback_sessions(item_id, last_seen_at DESC);

      CREATE TABLE IF NOT EXISTS playback_session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        playback_session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        position_ticks INTEGER,
        details_json TEXT,
        FOREIGN KEY(playback_session_id) REFERENCES playback_sessions(playback_session_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_playback_session_events_session_id ON playback_session_events(playback_session_id, id DESC);

      CREATE TABLE IF NOT EXISTS media_item_metadata (
        server_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        item_name TEXT,
        item_type TEXT,
        series_name TEXT,
        season_name TEXT,
        production_year INTEGER,
        premiere_date TEXT,
        official_rating TEXT,
        community_rating REAL,
        runtime_ticks INTEGER,
        primary_image_tag TEXT,
        backdrop_image_tag TEXT,
        overview TEXT,
        genres_json TEXT,
        image_blur_hash TEXT,
        last_refreshed_at TEXT NOT NULL,
        PRIMARY KEY (server_id, item_id)
      );
      CREATE INDEX IF NOT EXISTS idx_media_item_metadata_item_id ON media_item_metadata(item_id, last_refreshed_at DESC);
    `);
  }

  function migrateLegacyState() {
    if (statements.getState.get('config')) {
      return;
    }

    const now = isoNow();
    let config = createDefaultConfig();
    let migratedFromLegacyConfig = false;

    if (fs.existsSync(legacyConfigFile)) {
      try {
        const raw = fs.readFileSync(legacyConfigFile, 'utf8');
        if (raw && raw.trim()) {
          const parsed = JSON.parse(raw);
          config = normalizeConfig(parsed);
          migratedFromLegacyConfig = true;
        }
      } catch (error) {
        console.error('Failed to migrate legacy config.json:', error);
      }
    }

    statements.upsertState.run('config', JSON.stringify(config), now);
    statements.insertSnapshot.run(now, migratedFromLegacyConfig ? 'legacy-config-migration' : 'initial-config', JSON.stringify(config));

    if (fs.existsSync(legacyDeviceLogsFile)) {
      try {
        const raw = fs.readFileSync(legacyDeviceLogsFile, 'utf8');
        if (raw && raw.trim()) {
          const parsed = JSON.parse(raw);
          const devices = parsed && parsed.devices && typeof parsed.devices === 'object' ? parsed.devices : {};
          Object.values(devices).forEach((device) => {
            migrateLegacyDevice(device);
          });
          recordEvent('legacy-device-logs-migration', null, {
            migratedDevices: Object.keys(devices).length
          });
        }
      } catch (error) {
        console.error('Failed to migrate legacy device logs:', error);
      }
    }
  }

  function createDefaultConfig() {
    return normalizeConfig({
      version: 1,
      globalPreferences: { ...defaultPreferences },
      servers: [],
      networkShares: [],
      setup_token: 'sf-setup-' + Math.random().toString(36).substr(2, 9)
    });
  }

  function normalizeConfig(input) {
    const config = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    return {
      version: Number(config.version) || 1,
      globalPreferences: {
        ...defaultPreferences,
        ...(config.globalPreferences && typeof config.globalPreferences === 'object' ? config.globalPreferences : {})
      },
      servers: Array.isArray(config.servers) ? config.servers : [],
      networkShares: Array.isArray(config.networkShares) ? config.networkShares : [],
      setup_token: typeof config.setup_token === 'string' && config.setup_token
        ? config.setup_token
        : ('sf-setup-' + Math.random().toString(36).substr(2, 9))
    };
  }

  function getConfig() {
    const row = statements.getState.get('config');
    if (!row || !row.value) {
      const config = createDefaultConfig();
      saveConfig(config, { reason: 'self-heal-config' });
      return config;
    }
    try {
      return normalizeConfig(JSON.parse(row.value));
    } catch (error) {
      console.error('Failed to parse stored config; resetting to defaults:', error);
      const config = createDefaultConfig();
      saveConfig(config, { reason: 'repair-corrupt-config' });
      return config;
    }
  }

  function saveConfig(config, options = {}) {
    const normalized = normalizeConfig(config);
    const now = isoNow();
    const nextJson = JSON.stringify(normalized);
    const current = statements.getState.get('config');
    const currentJson = current ? current.value : null;

    statements.upsertState.run('config', nextJson, now);

    if (currentJson !== nextJson) {
      statements.insertSnapshot.run(now, options.reason || 'config-update', nextJson);
    }

    if (options.eventType) {
      recordEvent(options.eventType, options.req, options.details || {});
    }

    return normalized;
  }

  function recordEvent(type, req, details = {}) {
    statements.insertEvent.run(
      type,
      isoNow(),
      req ? (req.ip || req.socket?.remoteAddress || null) : null,
      req ? (req.headers['user-agent'] || null) : null,
      JSON.stringify(details)
    );
  }

  
  function createAdminSession(token) {
    statements.createSession.run(token, isoNow());
  }

  function validateAdminSession(token) {
    return !!statements.getSession.get(token);
  }

  function getConfigSnapshots() {
    return statements.getSnapshots.all();
  }

  function restoreConfigSnapshot(id) {
    const row = statements.getSnapshotById.get(id);
    if (!row) return false;
    db.exec('BEGIN');
    try {
      statements.upsertState.run('config', row.config_json, isoNow());
      statements.insertSnapshot.run(isoNow(), 'restored-snapshot-' + id, row.config_json);
      db.exec('COMMIT');
      return true;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function getSyncLog(limit = 100) {
    return statements.syncEvents.all(limit).map((row) => ({
      timestamp: row.created_at,
      userAgent: row.user_agent,
      ip: row.ip,
      details: safeParseJson(row.details_json)
    }));
  }

  function getDeviceSummaries() {
    return statements.getDevices.all();
  }

  function getDeviceWithLogs(deviceId, limit) {
    const device = statements.getDevice.get(deviceId);
    if (!device) return null;
    const entries = statements.getDeviceLogs.all(deviceId, limit).reverse();
    return { device, entries };
  }

  
  function clearDeviceLogs(deviceId) {
    db.exec('BEGIN');
    try {
      statements.clearDeviceLogs.run(deviceId);
      statements.resetDeviceLogCount.run(deviceId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function upsertDeviceLogs(payload, req) {
    const now = isoNow();
    const deviceId = sanitizeText(payload.deviceId, 128) || 'unknown-device';
    const deviceName = sanitizeText(payload.deviceName || payload.model || 'SpatialFin Device', 160);
    const existing = statements.getDevice.get(deviceId);
    const entries = Array.isArray(payload.logs) ? payload.logs : [];
    let latestEntryAt = existing ? existing.latestEntryAt : null;

    db.exec('BEGIN');
    try {
      statements.upsertDevice.run(
        deviceId,
        deviceName,
        sanitizeText(payload.model || '', 160) || null,
        sanitizeText(payload.manufacturer || '', 120) || null,
        sanitizeText(payload.appVersion || '', 80) || null,
        sanitizeText(payload.androidVersion || '', 80) || null,
        sanitizeText(payload.sessionId || '', 120) || null,
        existing ? existing.firstSeenAt : now,
        now,
        latestEntryAt || existing?.latestEntryAt || now,
        existing ? existing.entryCount : 0,
        req.ip || req.socket?.remoteAddress || null
      );

      entries.forEach((entry) => {
        if (!entry || typeof entry !== 'object') return;
        const timestamp = sanitizeText(entry.timestamp || now, 80) || now;
        latestEntryAt = timestamp;
        statements.insertDeviceLog.run(
          deviceId,
          timestamp,
          now,
          sanitizeText(entry.level || '?', 16),
          sanitizeText(entry.tag || 'SpatialFin', 120),
          sanitizeText(entry.message || '', maxLogMessageLength),
          sanitizeText(entry.stack || '', maxLogMessageLength * 2)
        );
      });

      let entryCount = statements.countDeviceLogs.get(deviceId).count;
      if (entryCount > maxLogEntriesPerDevice) {
        const toDelete = entryCount - maxLogEntriesPerDevice;
        statements.deleteOldDeviceLogs.run(deviceId, toDelete);
        entryCount = maxLogEntriesPerDevice;
      }

      statements.upsertDevice.run(
        deviceId,
        deviceName,
        sanitizeText(payload.model || '', 160) || null,
        sanitizeText(payload.manufacturer || '', 120) || null,
        sanitizeText(payload.appVersion || '', 80) || null,
        sanitizeText(payload.androidVersion || '', 80) || null,
        sanitizeText(payload.sessionId || '', 120) || null,
        existing ? existing.firstSeenAt : now,
        now,
        latestEntryAt || existing?.latestEntryAt || now,
        entryCount,
        req.ip || req.socket?.remoteAddress || null
      );

      recordEvent('device_logs_uploaded', req, {
        deviceId,
        accepted: entries.length
      });

      db.exec('COMMIT');
      return statements.getDevice.get(deviceId);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function migrateLegacyDevice(device) {
    if (!device || typeof device !== 'object') return;
    upsertDeviceLogs({
      deviceId: device.deviceId || 'unknown-device',
      deviceName: device.deviceName || device.model || 'SpatialFin Device',
      model: device.model || null,
      manufacturer: device.manufacturer || null,
      appVersion: device.appVersion || null,
      androidVersion: device.androidVersion || null,
      sessionId: device.sessionId || null,
      logs: Array.isArray(device.entries) ? device.entries : []
    }, {
      ip: device.lastIp || null,
      socket: { remoteAddress: device.lastIp || null },
      headers: { 'user-agent': 'legacy-device-log-migration' }
    });
  }

  function upsertPlaybackSessions(payload, req) {
    const now = isoNow();
    const sessions = normalizePlaybackSessionsPayload(payload, now);
    let accepted = 0;

    db.exec('BEGIN');
    try {
      sessions.forEach((session) => {
        statements.upsertPlaybackSession.run(
          session.playbackSessionId,
          session.deviceId,
          session.sessionId,
          session.serverId,
          session.serverName,
          session.userId,
          session.username,
          session.itemId,
          session.itemName,
          session.itemType,
          session.libraryId,
          session.libraryName,
          session.clientName,
          session.playbackMethod,
          session.startedAt,
          session.endedAt,
          session.lastSeenAt,
          session.playDurationMs,
          session.positionTicks,
          session.runtimeTicks,
          session.completed ? 1 : 0,
          JSON.stringify(session.raw)
        );

        statements.insertPlaybackSessionEvent.run(
          session.playbackSessionId,
          session.eventType,
          session.eventAt,
          session.positionTicks,
          JSON.stringify(session.eventDetails)
        );
        accepted += 1;
      });

      if (accepted > 0) {
        recordEvent('analytics_sessions_ingested', req, {
          accepted,
          deviceId: sessions[0].deviceId || null
        });
      }

      db.exec('COMMIT');
      return {
        accepted,
        totalSessions: statements.countPlaybackSessions.get().count
      };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function upsertMediaItemMetadata(entries) {
    const items = Array.isArray(entries) ? entries : [];
    let accepted = 0;
    db.exec('BEGIN');
    try {
      items.forEach((entry) => {
        if (!entry || !entry.serverId || !entry.itemId) return;
        statements.upsertMediaItemMetadata.run(
          entry.serverId,
          entry.itemId,
          entry.itemName || null,
          entry.itemType || null,
          entry.seriesName || null,
          entry.seasonName || null,
          entry.productionYear ?? null,
          entry.premiereDate || null,
          entry.officialRating || null,
          entry.communityRating ?? null,
          entry.runtimeTicks ?? null,
          entry.primaryImageTag || null,
          entry.backdropImageTag || null,
          entry.overview || null,
          JSON.stringify(Array.isArray(entry.genres) ? entry.genres : []),
          entry.imageBlurHash || null,
          entry.lastRefreshedAt || isoNow()
        );
        accepted += 1;
      });
      db.exec('COMMIT');
      return { accepted };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function getMediaItemMetadata(serverId, itemId) {
    const row = serverId && itemId
      ? statements.getMediaItemMetadataByServerAndItem.get(serverId, itemId)
      : (itemId ? statements.getLatestMediaItemMetadataByItem.get(itemId) : null);
    return normalizeMediaItemMetadata(row);
  }

  function attachMediaMetadata(entity) {
    if (!entity || !entity.itemId) return entity;
    const metadata = getMediaItemMetadata(entity.serverId || null, entity.itemId);
    if (!metadata) return entity;
    return {
      ...entity,
      itemName: entity.itemName || metadata.itemName || null,
      itemType: entity.itemType || metadata.itemType || null,
      runtimeTicks: entity.runtimeTicks ?? metadata.runtimeTicks ?? null,
      itemMetadata: metadata
    };
  }

  function getAnalyticsOverview(options = {}) {
    const whereClause = buildAnalyticsRangeWhereClause(options);
    const row = db.prepare(`
      SELECT
        COUNT(*) AS totalSessions,
        COALESCE(SUM(play_duration_ms), 0) AS totalPlayDurationMs,
        COUNT(DISTINCT user_id) AS uniqueUsers,
        COUNT(DISTINCT item_id) AS uniqueItems,
        COUNT(DISTINCT library_id) AS uniqueLibraries,
        COUNT(DISTINCT device_id) AS uniqueDevices,
        SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) AS completedSessions,
        MAX(last_seen_at) AS lastSessionAt
      FROM playback_sessions
      ${whereClause.sql}
    `).get(...whereClause.params) || {};
    return {
      totalSessions: row.totalSessions || 0,
      totalPlayDurationMs: row.totalPlayDurationMs || 0,
      uniqueUsers: row.uniqueUsers || 0,
      uniqueItems: row.uniqueItems || 0,
      uniqueLibraries: row.uniqueLibraries || 0,
      uniqueDevices: row.uniqueDevices || 0,
      completedSessions: row.completedSessions || 0,
      completionRate: row.totalSessions ? Number(((row.completedSessions || 0) / row.totalSessions).toFixed(4)) : 0,
      lastSessionAt: row.lastSessionAt || null
    };
  }

  function getRecentPlaybackSessions(limit = 50, options = {}) {
    const whereClause = buildAnalyticsRangeWhereClause(options);
    return db.prepare(`
      SELECT
        playback_session_id AS playbackSessionId,
        device_id AS deviceId,
        session_id AS sessionId,
        server_id AS serverId,
        server_name AS serverName,
        user_id AS userId,
        username,
        item_id AS itemId,
        item_name AS itemName,
        item_type AS itemType,
        library_id AS libraryId,
        library_name AS libraryName,
        client_name AS clientName,
        playback_method AS playbackMethod,
        started_at AS startedAt,
        ended_at AS endedAt,
        last_seen_at AS lastSeenAt,
        play_duration_ms AS playDurationMs,
        position_ticks AS positionTicks,
        runtime_ticks AS runtimeTicks,
        completed
      FROM playback_sessions
      ${whereClause.sql}
      ORDER BY last_seen_at DESC, started_at DESC
      LIMIT ?
    `).all(...whereClause.params, limit).map((row) => attachMediaMetadata(normalizePlaybackSessionRow(row)));
  }

  function getTopPlaybackUsers(limit = 25, options = {}) {
    const whereClause = buildAnalyticsRangeWhereClause(options, 'WHERE (user_id IS NOT NULL OR username IS NOT NULL)');
    return db.prepare(`
      SELECT
        user_id AS userId,
        username,
        COUNT(*) AS sessionCount,
        COALESCE(SUM(play_duration_ms), 0) AS totalPlayDurationMs,
        MAX(last_seen_at) AS lastSessionAt
      FROM playback_sessions
      ${whereClause.sql}
      GROUP BY user_id, username
      ORDER BY totalPlayDurationMs DESC, sessionCount DESC, username ASC
      LIMIT ?
    `).all(...whereClause.params, limit).map((row) => ({
      userId: row.userId || null,
      username: row.username || null,
      sessionCount: row.sessionCount || 0,
      totalPlayDurationMs: row.totalPlayDurationMs || 0,
      lastSessionAt: row.lastSessionAt || null
    }));
  }

  function getTopPlaybackLibraries(limit = 25, options = {}) {
    const whereClause = buildAnalyticsRangeWhereClause(options, 'WHERE (library_id IS NOT NULL OR library_name IS NOT NULL)');
    return db.prepare(`
      SELECT
        library_id AS libraryId,
        library_name AS libraryName,
        COUNT(*) AS sessionCount,
        COALESCE(SUM(play_duration_ms), 0) AS totalPlayDurationMs,
        COUNT(DISTINCT item_id) AS uniqueItems,
        MAX(last_seen_at) AS lastSessionAt
      FROM playback_sessions
      ${whereClause.sql}
      GROUP BY library_id, library_name
      ORDER BY totalPlayDurationMs DESC, sessionCount DESC, library_name ASC
      LIMIT ?
    `).all(...whereClause.params, limit).map((row) => ({
      libraryId: row.libraryId || null,
      libraryName: row.libraryName || null,
      sessionCount: row.sessionCount || 0,
      totalPlayDurationMs: row.totalPlayDurationMs || 0,
      uniqueItems: row.uniqueItems || 0,
      lastSessionAt: row.lastSessionAt || null
    }));
  }

  function getTopPlaybackServers(limit = 25, options = {}) {
    const whereClause = buildAnalyticsRangeWhereClause(options, 'WHERE (server_id IS NOT NULL OR server_name IS NOT NULL)');
    return db.prepare(`
      SELECT
        server_id AS serverId,
        server_name AS serverName,
        COUNT(*) AS sessionCount,
        COALESCE(SUM(play_duration_ms), 0) AS totalPlayDurationMs,
        COUNT(DISTINCT user_id) AS uniqueUsers,
        COUNT(DISTINCT item_id) AS uniqueItems,
        COUNT(DISTINCT library_id) AS uniqueLibraries,
        MAX(last_seen_at) AS lastSessionAt
      FROM playback_sessions
      ${whereClause.sql}
      GROUP BY server_id, server_name
      ORDER BY totalPlayDurationMs DESC, sessionCount DESC, server_name ASC
      LIMIT ?
    `).all(...whereClause.params, limit).map((row) => ({
      serverId: row.serverId || null,
      serverName: row.serverName || null,
      sessionCount: row.sessionCount || 0,
      totalPlayDurationMs: row.totalPlayDurationMs || 0,
      uniqueUsers: row.uniqueUsers || 0,
      uniqueItems: row.uniqueItems || 0,
      uniqueLibraries: row.uniqueLibraries || 0,
      lastSessionAt: row.lastSessionAt || null
    }));
  }

  function getDailyPlaybackTrends(limit = 14, options = {}) {
    const whereClause = buildAnalyticsRangeWhereClause(options);
    return db.prepare(`
      SELECT
        substr(last_seen_at, 1, 10) AS day,
        COUNT(*) AS sessionCount,
        COALESCE(SUM(play_duration_ms), 0) AS totalPlayDurationMs,
        COUNT(DISTINCT user_id) AS uniqueUsers,
        COUNT(DISTINCT item_id) AS uniqueItems
      FROM playback_sessions
      ${whereClause.sql}
      GROUP BY substr(last_seen_at, 1, 10)
      ORDER BY day DESC
      LIMIT ?
    `).all(...whereClause.params, limit).reverse().map((row) => ({
      day: row.day,
      sessionCount: row.sessionCount || 0,
      totalPlayDurationMs: row.totalPlayDurationMs || 0,
      uniqueUsers: row.uniqueUsers || 0,
      uniqueItems: row.uniqueItems || 0
    }));
  }

  function getTopPlaybackItems(limit = 25, options = {}) {
    const whereClause = buildAnalyticsRangeWhereClause(options, 'WHERE (item_id IS NOT NULL OR item_name IS NOT NULL)');
    return db.prepare(`
      SELECT
        item_id AS itemId,
        item_name AS itemName,
        item_type AS itemType,
        COUNT(*) AS sessionCount,
        COALESCE(SUM(play_duration_ms), 0) AS totalPlayDurationMs,
        MAX(last_seen_at) AS lastSessionAt,
        COUNT(DISTINCT user_id) AS uniqueUsers
      FROM playback_sessions
      ${whereClause.sql}
      GROUP BY item_id, item_name, item_type
      ORDER BY totalPlayDurationMs DESC, sessionCount DESC, itemName ASC
      LIMIT ?
    `).all(...whereClause.params, limit).map((row) => {
      const enriched = attachMediaMetadata({
        itemId: row.itemId || null,
        itemName: row.itemName || null,
        itemType: row.itemType || null
      });
      return {
        itemId: enriched.itemId,
        itemName: enriched.itemName,
        itemType: enriched.itemType,
        itemMetadata: enriched.itemMetadata || null,
        sessionCount: row.sessionCount || 0,
        totalPlayDurationMs: row.totalPlayDurationMs || 0,
        uniqueUsers: row.uniqueUsers || 0,
        lastSessionAt: row.lastSessionAt || null
      };
    });
  }

  function getWatchHistory(options = {}) {
    const limit = Math.max(1, Math.min(500, Number(options.limit) || 100));
    const userFilter = options.user ? String(options.user) : null;
    const itemFilter = options.item ? String(options.item) : null;
    const itemLike = itemFilter ? `%${itemFilter}%` : null;
    const whereClause = buildAnalyticsRangeWhereClause(options, `
      WHERE
        (? IS NULL OR username = ? OR user_id = ?)
        AND (? IS NULL OR item_name LIKE ? OR item_id = ?)
    `);
    const raw = db.prepare(`
      SELECT
        playback_session_id AS playbackSessionId,
        device_id AS deviceId,
        session_id AS sessionId,
        server_id AS serverId,
        server_name AS serverName,
        user_id AS userId,
        username,
        item_id AS itemId,
        item_name AS itemName,
        item_type AS itemType,
        library_id AS libraryId,
        library_name AS libraryName,
        client_name AS clientName,
        playback_method AS playbackMethod,
        started_at AS startedAt,
        ended_at AS endedAt,
        last_seen_at AS lastSeenAt,
        play_duration_ms AS playDurationMs,
        position_ticks AS positionTicks,
        runtime_ticks AS runtimeTicks,
        completed
      FROM playback_sessions
      ${whereClause.sql}
      ORDER BY last_seen_at DESC, started_at DESC
      LIMIT ?
    `).all(
        userFilter, userFilter, userFilter,
        itemFilter, itemLike, itemFilter,
        ...whereClause.params,
        Math.min(limit * 5, 2000)
      )
      .map(normalizePlaybackSessionRow)
      .reverse();
    return groupWatchHistory(raw, watchEventThresholdMs).reverse().slice(0, limit).map(attachMediaMetadata);
  }

  function closeMissingPlaybackSessions(options = {}) {
    const serverId = options.serverId || null;
    const userId = options.userId || null;
    const username = options.username || null;
    const activePlaybackSessionIds = new Set(Array.isArray(options.activePlaybackSessionIds) ? options.activePlaybackSessionIds : []);
    const endedAt = options.endedAt || isoNow();
    if (!serverId || (!userId && !username)) {
      return { closed: 0 };
    }

    const openSessions = statements.findOpenPlaybackSessionsForScope.all(
      serverId,
      userId,
      userId,
      username
    );

    let closed = 0;
    db.exec('BEGIN');
    try {
      openSessions.forEach((session) => {
        if (activePlaybackSessionIds.has(session.playbackSessionId)) return;
        const completed = inferCompletionFromProgress(session);
        statements.closePlaybackSession.run(
          endedAt,
          endedAt,
          completed ? 1 : 0,
          session.playbackSessionId
        );
        statements.insertPlaybackSessionEvent.run(
          session.playbackSessionId,
          'stop',
          endedAt,
          session.positionTicks,
          JSON.stringify({ reason: 'session-missing-from-poll', completed })
        );
        closed += 1;
      });
      db.exec('COMMIT');
      return { closed };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function getPlaybackUserDetail(userRef, options = {}) {
    const ref = userRef ? String(userRef) : '';
    if (!ref) return null;
    const overview = statements.analyticsUserOverview.get(ref, ref);
    if (!overview) return null;
    const limit = Math.max(1, Math.min(200, Number(options.limit) || 30));
    const recent = statements.analyticsUserRecent
      .all(ref, ref, Math.min(limit * 5, 1000))
      .map(normalizePlaybackSessionRow)
      .reverse();
    return {
      overview: {
        userId: overview.userId || null,
        username: overview.username || null,
        sessionCount: overview.sessionCount || 0,
        totalPlayDurationMs: overview.totalPlayDurationMs || 0,
        uniqueItems: overview.uniqueItems || 0,
        uniqueLibraries: overview.uniqueLibraries || 0,
        lastSessionAt: overview.lastSessionAt || null
      },
      history: groupWatchHistory(recent, watchEventThresholdMs).reverse().slice(0, limit).map(attachMediaMetadata)
    };
  }

  function getPlaybackItemDetail(itemRef, options = {}) {
    const ref = itemRef ? String(itemRef) : '';
    if (!ref) return null;
    const overview = statements.analyticsItemOverview.get(ref, ref);
    if (!overview) return null;
    const limit = Math.max(1, Math.min(200, Number(options.limit) || 30));
    const recent = statements.analyticsItemRecent
      .all(ref, ref, Math.min(limit * 5, 1000))
      .map(normalizePlaybackSessionRow)
      .reverse();
    return {
      overview: {
        itemId: overview.itemId || null,
        itemName: overview.itemName || null,
        itemType: overview.itemType || null,
        sessionCount: overview.sessionCount || 0,
        totalPlayDurationMs: overview.totalPlayDurationMs || 0,
        uniqueUsers: overview.uniqueUsers || 0,
        uniqueLibraries: overview.uniqueLibraries || 0,
        lastSessionAt: overview.lastSessionAt || null,
        itemMetadata: getMediaItemMetadata(null, overview.itemId || null)
      },
      history: groupWatchHistory(recent, watchEventThresholdMs).reverse().slice(0, limit).map(attachMediaMetadata)
    };
  }

  function getPlaybackSessionWithEvents(playbackSessionId, limit = 500) {
    const session = db.prepare(`
      SELECT
        playback_session_id AS playbackSessionId,
        device_id AS deviceId,
        session_id AS sessionId,
        server_id AS serverId,
        server_name AS serverName,
        user_id AS userId,
        username,
        item_id AS itemId,
        item_name AS itemName,
        item_type AS itemType,
        library_id AS libraryId,
        library_name AS libraryName,
        client_name AS clientName,
        playback_method AS playbackMethod,
        started_at AS startedAt,
        ended_at AS endedAt,
        last_seen_at AS lastSeenAt,
        play_duration_ms AS playDurationMs,
        position_ticks AS positionTicks,
        runtime_ticks AS runtimeTicks,
        completed
      FROM playback_sessions
      WHERE playback_session_id = ?
    `).get(playbackSessionId);
    if (!session) return null;
    const events = statements.analyticsSessionEvents.all(playbackSessionId, limit).map((row) => ({
      id: row.id,
      playbackSessionId: row.playbackSessionId,
      eventType: row.eventType,
      createdAt: row.createdAt,
      positionTicks: row.positionTicks,
      details: safeParseJson(row.detailsJson)
    }));
    return {
      session: attachMediaMetadata(normalizePlaybackSessionRow(session)),
      events
    };
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function isoNow() {
  return new Date().toISOString();
}

function sanitizeText(value, maxLength) {
  if (value == null) return '';
  const text = String(value);
  return text.length > maxLength ? text.slice(0, maxLength) + '…' : text;
}

function safeParseJson(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch (_) {
    return null;
  }
}

function normalizePlaybackSessionsPayload(payload, now) {
  const rawSessions = Array.isArray(payload?.sessions)
    ? payload.sessions
    : (payload && typeof payload === 'object' ? [payload] : []);

  return rawSessions
    .map((session, index) => normalizePlaybackSession(session, now, index))
    .filter(Boolean);
}

function normalizePlaybackSession(session, now, index) {
  if (!session || typeof session !== 'object') return null;
  const playbackSessionId =
    sanitizeText(
      session.playbackSessionId ||
      session.sessionKey ||
      session.id ||
      buildPlaybackSessionId(session, index),
      160
    );
  if (!playbackSessionId) return null;

  const eventType = sanitizeText(session.eventType || inferEventType(session), 40) || 'progress';
  const eventAt = sanitizeText(session.eventAt || session.updatedAt || session.lastSeenAt || session.endedAt || now, 80) || now;
  const lastSeenAt = sanitizeText(session.lastSeenAt || session.updatedAt || session.endedAt || eventAt || now, 80) || now;
  const startedAt = sanitizeText(session.startedAt || eventAt, 80) || eventAt;
  const endedAt = sanitizeText(session.endedAt || '', 80) || null;

  const eventDetails = session.eventDetails && typeof session.eventDetails === 'object'
    ? session.eventDetails
    : {};

  return {
    playbackSessionId,
    deviceId: sanitizeText(session.deviceId || session.device_id || '', 128) || null,
    sessionId: sanitizeText(session.sessionId || session.session_id || '', 160) || null,
    serverId: sanitizeText(session.serverId || session.server_id || '', 128) || null,
    serverName: sanitizeText(session.serverName || session.server_name || '', 160) || null,
    userId: sanitizeText(session.userId || session.user_id || '', 128) || null,
    username: sanitizeText(session.username || session.userName || '', 160) || null,
    itemId: sanitizeText(session.itemId || session.item_id || '', 128) || null,
    itemName: sanitizeText(session.itemName || session.item_name || '', 240) || null,
    itemType: sanitizeText(session.itemType || session.item_type || '', 80) || null,
    libraryId: sanitizeText(session.libraryId || session.library_id || '', 128) || null,
    libraryName: sanitizeText(session.libraryName || session.library_name || '', 160) || null,
    clientName: sanitizeText(session.clientName || session.client_name || '', 120) || null,
    playbackMethod: sanitizeText(session.playbackMethod || session.playback_method || '', 80) || null,
    startedAt,
    endedAt,
    lastSeenAt,
    playDurationMs: sanitizeInteger(session.playDurationMs ?? session.play_duration_ms ?? session.playDuration ?? 0),
    positionTicks: sanitizeNullableInteger(session.positionTicks ?? session.position_ticks),
    runtimeTicks: sanitizeNullableInteger(session.runtimeTicks ?? session.runtime_ticks),
    completed: sanitizeBoolean(session.completed),
    eventType,
    eventAt,
    eventDetails,
    raw: session
  };
}

function buildPlaybackSessionId(session, index) {
  const parts = [
    session.deviceId || session.device_id || 'device',
    session.userId || session.user_id || session.username || 'user',
    session.itemId || session.item_id || 'item',
    session.startedAt || session.createdAt || session.lastSeenAt || new Date().toISOString(),
    index
  ];
  return parts.join(':');
}

function inferEventType(session) {
  if (session.completed === true) return 'stop';
  if (session.endedAt) return 'stop';
  if (session.startedAt && !session.lastSeenAt) return 'start';
  return 'progress';
}

function normalizePlaybackSessionRow(row) {
  return {
    playbackSessionId: row.playbackSessionId,
    deviceId: row.deviceId || null,
    sessionId: row.sessionId || null,
    serverId: row.serverId || null,
    serverName: row.serverName || null,
    userId: row.userId || null,
    username: row.username || null,
    itemId: row.itemId || null,
    itemName: row.itemName || null,
    itemType: row.itemType || null,
    libraryId: row.libraryId || null,
    libraryName: row.libraryName || null,
    clientName: row.clientName || null,
    playbackMethod: row.playbackMethod || null,
    startedAt: row.startedAt || null,
    endedAt: row.endedAt || null,
    lastSeenAt: row.lastSeenAt || null,
    playDurationMs: row.playDurationMs || 0,
    positionTicks: row.positionTicks ?? null,
    runtimeTicks: row.runtimeTicks ?? null,
    completed: Boolean(row.completed)
  };
}

function normalizeMediaItemMetadata(row) {
  if (!row) return null;
  return {
    serverId: row.serverId || null,
    itemId: row.itemId || null,
    itemName: row.itemName || null,
    itemType: row.itemType || null,
    seriesName: row.seriesName || null,
    seasonName: row.seasonName || null,
    productionYear: row.productionYear ?? null,
    premiereDate: row.premiereDate || null,
    officialRating: row.officialRating || null,
    communityRating: row.communityRating ?? null,
    runtimeTicks: row.runtimeTicks ?? null,
    primaryImageTag: row.primaryImageTag || null,
    backdropImageTag: row.backdropImageTag || null,
    overview: row.overview || null,
    genres: safeParseJson(row.genresJson) || [],
    imageBlurHash: row.imageBlurHash || null,
    lastRefreshedAt: row.lastRefreshedAt || null
  };
}

function sanitizeInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.round(parsed));
}

function sanitizeNullableInteger(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round(parsed));
}

function sanitizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  if (typeof value === 'number') return value !== 0;
  return false;
}

function inferCompletionFromProgress(session) {
  const runtimeTicks = Number(session.runtimeTicks);
  const positionTicks = Number(session.positionTicks);
  if (!Number.isFinite(runtimeTicks) || runtimeTicks <= 0) return false;
  if (!Number.isFinite(positionTicks) || positionTicks <= 0) return false;
  return positionTicks / runtimeTicks >= 0.9;
}

function groupWatchHistory(entries, thresholdMs) {
  const grouped = [];
  entries.forEach((entry) => {
    const previous = grouped[grouped.length - 1];
    if (previous && shouldMergeWatchEntries(previous, entry, thresholdMs)) {
      previous.sessionCount += 1;
      previous.playDurationMs += Number(entry.playDurationMs) || 0;
      previous.completed = previous.completed || !!entry.completed;
      previous.startedAt = minIso(previous.startedAt, entry.startedAt);
      previous.lastSeenAt = maxIso(previous.lastSeenAt, entry.lastSeenAt);
      previous.endedAt = maxIso(previous.endedAt, entry.endedAt);
      previous.positionTicks = maxNullableNumber(previous.positionTicks, entry.positionTicks);
      previous.runtimeTicks = maxNullableNumber(previous.runtimeTicks, entry.runtimeTicks);
      previous.playbackSessionIds.push(entry.playbackSessionId);
      return;
    }

    grouped.push({
      ...entry,
      sessionCount: 1,
      playbackSessionIds: [entry.playbackSessionId]
    });
  });
  return grouped;
}

function shouldMergeWatchEntries(previous, next, thresholdMs) {
  const sameServer = (previous.serverId || previous.serverName) === (next.serverId || next.serverName);
  const sameUser = (previous.userId || previous.username) === (next.userId || next.username);
  const sameItem = (previous.itemId || previous.itemName) === (next.itemId || next.itemName);
  if (!sameServer || !sameUser || !sameItem) return false;

  const previousTime = Date.parse(previous.lastSeenAt || previous.endedAt || previous.startedAt || 0);
  const nextTime = Date.parse(next.startedAt || next.lastSeenAt || next.endedAt || 0);
  if (!Number.isFinite(previousTime) || !Number.isFinite(nextTime)) return false;
  return Math.abs(nextTime - previousTime) <= thresholdMs;
}

function minIso(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function maxIso(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function maxNullableNumber(a, b) {
  const left = Number(a);
  const right = Number(b);
  if (!Number.isFinite(left)) return Number.isFinite(right) ? right : null;
  if (!Number.isFinite(right)) return left;
  return Math.max(left, right);
}

function buildAnalyticsRangeWhereClause(options = {}, baseWhere) {
  const days = Number(options.days);
  const clauses = [];
  const params = [];
  if (baseWhere && String(baseWhere).trim()) {
    const cleaned = String(baseWhere).replace(/^\s*WHERE\s+/i, '').trim();
    if (cleaned) clauses.push(cleaned);
  }
  if (Number.isFinite(days) && days > 0) {
    clauses.push('last_seen_at >= ?');
    params.push(new Date(Date.now() - (days * 24 * 60 * 60 * 1000)).toISOString());
  }
  return {
    sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params
  };
}

module.exports = {
  createStorage,
  DEFAULT_MAX_LOG_ENTRIES_PER_DEVICE,
  DEFAULT_MAX_LOG_MESSAGE_LENGTH
};
