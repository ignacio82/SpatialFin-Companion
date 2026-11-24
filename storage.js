const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const net = require('node:net');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { normalizeNetworkShare } = require('./network-shares');
const { LOCAL_ONLY_PREF_KEYS, FORBIDDEN_KEYS } = require('./config-redaction');
const {
  stripBrackets,
  normalizeHostForMatch,
  effectivePortForUrl,
  isLoopbackIp,
  isSyntacticLoopbackHost,
} = require('./safe-fetch');

const DEFAULT_MAX_LOG_ENTRIES_PER_DEVICE = 5000;
const DEFAULT_MAX_LOG_MESSAGE_LENGTH = 4000;
const STRONG_SETUP_TOKEN_REGEX = /^sf-setup-[0-9a-f]{32,}$/;

function generateSetupToken() {
  return `sf-setup-${crypto.randomBytes(16).toString('hex')}`;
}

function isSetupTokenWeakValue(token) {
  return !STRONG_SETUP_TOKEN_REGEX.test(String(token || ''));
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function guardedChmod(targetPath, mode) {
  try {
    fs.chmodSync(targetPath, mode);
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'ENOTSUP' || err.code === 'EROFS')) {
      console.warn(`[storage] chmod ${mode.toString(8)} skipped on ${targetPath}: ${err.code}`);
    }
  }
}

function assertNotSymlink(destPath) {
  try {
    const stat = fs.lstatSync(destPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing VACUUM INTO symlink destination: ${destPath}`);
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }
}

function createStorage(options) {
  const {
    rootDir,
    defaultPreferences,
    maxLogEntriesPerDevice = DEFAULT_MAX_LOG_ENTRIES_PER_DEVICE,
    maxLogMessageLength = DEFAULT_MAX_LOG_MESSAGE_LENGTH,
    watchEventThresholdMs = 60 * 60 * 1000
  } = options;

  const dataDir = path.join(rootDir, 'data');
  const backupsDir = path.join(dataDir, 'backups');
  const dbFile = path.join(dataDir, 'companion.sqlite');
  const preStage1BackupPath = path.join(dataDir, 'companion.sqlite.pre-stage1.bak');
  const legacyConfigFile = path.join(rootDir, 'config.json');
  const legacyDeviceLogsFile = path.join(dataDir, 'device-logs.json');

  ensureDir(dataDir, 0o700);
  ensureDir(backupsDir, 0o700);

  const existedBeforeOpen = fs.existsSync(dbFile);
  const db = new DatabaseSync(dbFile);
  guardedChmod(dbFile, 0o600);
  db.exec('PRAGMA busy_timeout = 250');
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
    setStateIfUnset: db.prepare(`
      INSERT OR IGNORE INTO app_state (key, value, updated_at)
      VALUES (?, ?, ?)
    `),
    deleteState: db.prepare('DELETE FROM app_state WHERE key = ?'),
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
    syncEventsSince: db.prepare(`
      SELECT created_at, details_json
      FROM events
      WHERE type = 'device_sync_pull' AND created_at >= ?
      ORDER BY id ASC
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
    upsertDeviceMeta: db.prepare(`
      INSERT INTO devices (
        device_id, device_name, app_version, first_seen_at, last_seen_at, entry_count, last_ip
      ) VALUES (?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        device_name = COALESCE(NULLIF(excluded.device_name, ''), devices.device_name),
        app_version = COALESCE(NULLIF(excluded.app_version, ''), devices.app_version),
        last_seen_at = excluded.last_seen_at,
        last_ip = COALESCE(excluded.last_ip, devices.last_ip)
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
        custom_name AS customName,
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
        custom_name AS customName,
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
    renameDevice: db.prepare('UPDATE devices SET custom_name = ? WHERE device_id = ?'),
    deleteDevice: db.prepare('DELETE FROM devices WHERE device_id = ?'),
    deletePlaybackSession: db.prepare('DELETE FROM playback_sessions WHERE playback_session_id = ?'),
    deleteAllPlaybackSessions: db.prepare('DELETE FROM playback_sessions'),
    deleteAllPlaybackSessionEvents: db.prepare('DELETE FROM playback_session_events'),
    deletePlaybackSessionsOlderThan: db.prepare('DELETE FROM playback_sessions WHERE COALESCE(last_seen_at, started_at) < ?'),
    deleteEventsOlderThan: db.prepare("DELETE FROM events WHERE created_at < ? AND (type != 'device_sync_pull' OR created_at < ?)"),
    deleteDeviceLogsOlderThan: db.prepare('DELETE FROM device_logs WHERE received_at < ?'),
    refreshDeviceEntryCounts: db.prepare(`
      UPDATE devices
      SET entry_count = (SELECT COUNT(*) FROM device_logs WHERE device_logs.device_id = devices.device_id),
          latest_entry_at = (SELECT MAX(timestamp) FROM device_logs WHERE device_logs.device_id = devices.device_id)
    `),
    clearDeviceLogs: db.prepare('DELETE FROM device_logs WHERE device_id = ?'),
    resetDeviceLogCount: db.prepare('UPDATE devices SET entry_count = 0, latest_entry_at = NULL WHERE device_id = ?'),
    createSession: db.prepare('INSERT INTO admin_sessions (token, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?)'),
    getSession: db.prepare('SELECT token, expires_at AS expiresAt FROM admin_sessions WHERE token = ?'),
    getAllActiveSessions: db.prepare('SELECT token, expires_at AS expiresAt FROM admin_sessions WHERE expires_at IS NULL OR expires_at > ?'),
    deleteSession: db.prepare('DELETE FROM admin_sessions WHERE token = ?'),
    touchSession: db.prepare('UPDATE admin_sessions SET last_used_at = ? WHERE token = ?'),
    pruneExpiredSessions: db.prepare('DELETE FROM admin_sessions WHERE expires_at IS NOT NULL AND expires_at <= ?'),
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

  const { migratedFromLegacyConfig } = migrateLegacyState();
  const isUpgradedDb = existedBeforeOpen || migratedFromLegacyConfig;

  // Initialize immutable instance_id, stage1_telemetry_started_at, config_version, and loopback seed
  const initNow = isoNow();
  statements.setStateIfUnset.run('instance_id', crypto.randomBytes(8).toString('hex'), initNow);
  statements.setStateIfUnset.run('stage1_telemetry_started_at', initNow, initNow);
  statements.setStateIfUnset.run('config_version', '1', initNow);

  if (!isUpgradedDb) {
    statements.setStateIfUnset.run('stage1_pre_backup_done', '1', initNow);
    statements.setStateIfUnset.run('stage1_live_vacuum_done', '1', initNow);
    statements.setStateIfUnset.run('stage1_backups_scrubbed', '1', initNow);
  }
  seedLoopbackAllowlistOnce(isUpgradedDb, initNow);

  // In-memory caches served during vacuumInFlight with zero SQLite statements
  let cachedInstanceId = statements.getState.get('instance_id')?.value || crypto.randomBytes(8).toString('hex');
  let cachedConfigVersion = Math.max(1, Number(statements.getState.get('config_version')?.value) || 1);
  let cachedAdminPasswordHash = statements.getState.get('admin_password_hash')?.value || null;
  const cachedTelemetryStartedAt = statements.getState.get('stage1_telemetry_started_at')?.value || initNow;

  let vacuumInFlight = false;
  const adminSessionSnapshot = new Map();
  let workerQueue = Promise.resolve();
  let activeWorker = null;
  let closed = false;

  return {
    dbFile,
    dataDir,
    backupsDir,
    preStage1BackupPath,
    isUpgradedDb,
    getConfig,
    saveConfig,
    saveConfigAndMigrateServerIds,
    normalizeConfig,
    getConfigVersion,
    getInstanceId,
    getAdminPasswordHash,
    setAdminPasswordHashIfUnset,
    isSetupTokenWeak,
    getConfigPullStats,
    getStateValue,
    setStateValue,
    deleteStateValue,
    recordEvent,
    getSyncLog,
    getDeviceSummaries,
    getDeviceWithLogs,
    upsertDevice,
    upsertDeviceLogs,
    clearDeviceLogs,
    renameDevice,
    deleteDevice,
    createAdminSession,
    validateAdminSession,
    isAdminSessionValid,
    deleteAdminSession,
    pruneExpiredAdminSessions,
    getConfigSnapshots,
    getConfigSnapshot,
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
    getPlaybackItemDetail,
    deletePlaybackSession,
    clearAllPlaybackSessions,
    prunePlaybackSessionsOlderThan,
    pruneDeviceLogsOlderThan,
    getDatabaseStats,
    vacuumDatabase,
    vacuumInto,
    isVacuumInFlight,
    enterVacuumInFlight,
    exitVacuumInFlight,
    runWorkerTask,
    runStage1UpgradeInWorker,
    runVacuumInWorker,
    runBackupInWorker,
    runScrubHistoricalBackupsInWorker,
    hasPreStage1Backup,
    prunePreStage1Backup,
    close
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
        created_at TEXT NOT NULL,
        expires_at TEXT,
        last_used_at TEXT
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

    addColumnIfMissing('admin_sessions', 'expires_at', 'TEXT');
    addColumnIfMissing('admin_sessions', 'last_used_at', 'TEXT');
    addColumnIfMissing('devices', 'custom_name', 'TEXT');
  }

  function addColumnIfMissing(table, column, type) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((c) => c.name === column)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  function migrateLegacyState() {
    if (statements.getState.get('config')) {
      return { migratedFromLegacyConfig: false };
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

    return { migratedFromLegacyConfig };
  }

  function seedLoopbackAllowlistOnce(upgraded, now) {
    if (statements.getState.get('stage1_loopback_seed_done')?.value === '1') {
      return;
    }
    const allowlist = new Set();
    const pendingCandidates = new Set();

    if (upgraded) {
      const row = statements.getState.get('config');
      const parsed = row && row.value ? safeParseJson(row.value) : null;
      const urls = [];
      if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.servers)) {
          for (const srv of parsed.servers) {
            if (Array.isArray(srv?.addresses)) {
              for (const addr of srv.addresses) urls.push(addr);
            }
            if (Array.isArray(srv?.users)) {
              for (const u of srv.users) {
                if (u?.preferences?.pref_seerr_url) urls.push(u.preferences.pref_seerr_url);
              }
            }
          }
        }
        if (parsed.globalPreferences?.pref_seerr_url) {
          urls.push(parsed.globalPreferences.pref_seerr_url);
        }
        if (parsed.devicePreferences && typeof parsed.devicePreferences === 'object') {
          for (const map of Object.values(parsed.devicePreferences)) {
            if (map?.pref_seerr_url) urls.push(map.pref_seerr_url);
          }
        }
      }

      for (const rawUrl of urls) {
        if (typeof rawUrl !== 'string' || !rawUrl.trim()) continue;
        try {
          const u = new URL(rawUrl.trim());
          if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
          const host = normalizeHostForMatch(u.hostname);
          const port = effectivePortForUrl(u);
          if (!host || !port) continue;
          const key = `${host}:${port}`;
          const cleanIp = stripBrackets(u.hostname);
          if (net.isIP(cleanIp)) {
            if (isLoopbackIp(cleanIp)) {
              allowlist.add(key);
            }
          } else if (isSyntacticLoopbackHost(host)) {
            allowlist.add(key);
          } else {
            pendingCandidates.add(key);
          }
        } catch (_) {}
      }

      if (allowlist.size > 0) {
        statements.upsertState.run('legacy_loopback_upstreams_allowlist', JSON.stringify(Array.from(allowlist)), now);
      }
      if (pendingCandidates.size > 0) {
        statements.upsertState.run(
          'stage1_pending_loopback_dns_candidates',
          JSON.stringify(Array.from(pendingCandidates)),
          now
        );
      }
    }

    statements.upsertState.run('stage1_loopback_seed_done', '1', now);
  }

  function createDefaultConfig() {
    return normalizeConfig({
      version: 1,
      globalPreferences: { ...defaultPreferences },
      devicePreferences: {},
      servers: [],
      networkShares: [],
      setup_token: generateSetupToken()
    });
  }

  function sanitizePreferenceMap(rawPrefs, { preserveNull = false } = {}) {
    const clean = {};
    if (!rawPrefs || typeof rawPrefs !== 'object' || Array.isArray(rawPrefs)) return clean;
    for (const [k, v] of Object.entries(rawPrefs)) {
      if (typeof k !== 'string' || k.length === 0 || FORBIDDEN_KEYS.has(k)) continue;
      if (LOCAL_ONLY_PREF_KEYS.has(k)) continue;
      if (v === null) {
        if (preserveNull) clean[k] = null;
        continue;
      }
      if (typeof v === 'string') clean[k] = v;
      else if (typeof v === 'boolean' || typeof v === 'number') clean[k] = String(v);
    }
    return clean;
  }

  // Per-user Music Assistant config + universal-plugin manifest URLs ride on the
  // server's users[] (the same container that already carries per-user
  // preferences). Coerce them to clean shapes while preserving everything else.
  function normalizeServers(rawServers) {
    if (!Array.isArray(rawServers)) return [];
    return rawServers.map((server) => {
      if (!server || typeof server !== 'object' || Array.isArray(server)) return server;
      const nextServer = { ...server };
      if (!Array.isArray(server.users)) return nextServer;
      nextServer.users = server.users.map((user) => {
        if (!user || typeof user !== 'object' || Array.isArray(user)) return user;
        const next = { ...user };
        delete next.password;
        delete next.has_verified_token;
        next.needs_relink = Boolean(user.needs_relink);

        if (user.preferences && typeof user.preferences === 'object' && !Array.isArray(user.preferences)) {
          next.preferences = sanitizePreferenceMap(user.preferences, { preserveNull: false });
        } else {
          next.preferences = {};
        }

        // musicAssistant: { url, token?, username?, password? } — drop unless url is set.
        const ma = user.musicAssistant;
        if (ma && typeof ma === 'object' && !Array.isArray(ma) && typeof ma.url === 'string' && ma.url.trim()) {
          const cleanMa = { url: ma.url.trim() };
          if (typeof ma.token === 'string' && ma.token) cleanMa.token = ma.token;
          if (typeof ma.username === 'string' && ma.username) cleanMa.username = ma.username;
          if (typeof ma.password === 'string' && ma.password) cleanMa.password = ma.password;
          next.musicAssistant = cleanMa;
        } else {
          delete next.musicAssistant;
        }
        // plugins: deduped list of manifest-URL strings.
        if (Array.isArray(user.plugins)) {
          const seen = new Set();
          const plugins = [];
          for (const entry of user.plugins) {
            if (typeof entry !== 'string') continue;
            const url = entry.trim();
            if (!url || seen.has(url)) continue;
            seen.add(url);
            plugins.push(url);
          }
          next.plugins = plugins;
        } else {
          delete next.plugins;
        }
        return next;
      });
      return nextServer;
    });
  }

  function normalizeConfig(input) {
    const config = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    // devicePreferences: { [deviceId]: { [prefKey]: stringValue | null } }
    // Each inner map is a sparse override over globalPreferences for that device.
    const rawDevicePrefs = config.devicePreferences && typeof config.devicePreferences === 'object' && !Array.isArray(config.devicePreferences)
      ? config.devicePreferences
      : {};
    const devicePreferences = {};
    for (const [deviceId, overrides] of Object.entries(rawDevicePrefs)) {
      if (!deviceId || typeof deviceId !== 'string' || FORBIDDEN_KEYS.has(deviceId)) continue;
      if (deviceId.length > 128) continue;
      if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) continue;
      const clean = sanitizePreferenceMap(overrides, { preserveNull: true });
      if (Object.keys(clean).length > 0) devicePreferences[deviceId] = clean;
    }

    const baseGlobal = sanitizePreferenceMap(defaultPreferences, { preserveNull: true });
    const incomingGlobal = sanitizePreferenceMap(
      config.globalPreferences && typeof config.globalPreferences === 'object' ? config.globalPreferences : {},
      { preserveNull: true }
    );
    const globalPreferences = { ...baseGlobal, ...incomingGlobal };

    const rawToken = typeof config.setup_token === 'string' ? config.setup_token.trim() : '';
    const setupToken = rawToken.length > 0 ? rawToken : generateSetupToken();

    const networkShares = Array.isArray(config.networkShares)
      ? config.networkShares
          .filter((sh) => sh && typeof sh === 'object' && !Array.isArray(sh))
          .map((sh) => normalizeNetworkShare(sh))
      : [];

    return {
      version: Number(config.version) || 1,
      globalPreferences,
      devicePreferences,
      servers: normalizeServers(config.servers),
      networkShares,
      setup_token: setupToken
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

    db.exec('BEGIN IMMEDIATE');
    try {
      const current = statements.getState.get('config');
      const currentJson = current ? current.value : null;
      const currentVer = Math.max(1, Number(statements.getState.get('config_version')?.value) || cachedConfigVersion);
      const nextVer = currentVer + 1;

      statements.upsertState.run('config', nextJson, now);
      statements.upsertState.run('config_version', String(nextVer), now);

      if (currentJson !== nextJson) {
        statements.insertSnapshot.run(now, options.reason || 'config-update', nextJson);
      }

      if (options.eventType) {
        recordEvent(options.eventType, options.req, options.details || {});
      }

      db.exec('COMMIT');
      cachedConfigVersion = nextVer;
      return normalized;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw error;
    }
  }

  function saveConfigAndMigrateServerIds(nextConfig, migrations = [], reason = null) {
    const normalized = normalizeConfig(nextConfig);
    const now = isoNow();
    const nextJson = JSON.stringify(normalized);
    const validMigrations = (Array.isArray(migrations) ? migrations : []).filter(
      (m) => m && m.oldId && m.newId && m.oldId !== m.newId
    );

    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('PRAGMA defer_foreign_keys = ON');
      const updateSessionServerId = db.prepare('UPDATE playback_sessions SET server_id = ? WHERE server_id = ?');
      const selectOpenSessions = db.prepare(
        'SELECT playback_session_id AS playbackSessionId FROM playback_sessions WHERE server_id = ? AND ended_at IS NULL'
      );
      const checkSessionKeyExists = db.prepare(
        'SELECT 1 FROM playback_sessions WHERE playback_session_id = ?'
      );
      const updateSessionKey = db.prepare(
        'UPDATE playback_sessions SET playback_session_id = ? WHERE playback_session_id = ?'
      );
      const updateSessionEventsKey = db.prepare(
        'UPDATE playback_session_events SET playback_session_id = ? WHERE playback_session_id = ?'
      );
      const upsertMigratedMetadata = db.prepare(`
        INSERT INTO media_item_metadata (
          server_id, item_id, item_name, item_type, series_name, season_name,
          production_year, premiere_date, official_rating, community_rating,
          runtime_ticks, primary_image_tag, backdrop_image_tag, overview,
          genres_json, image_blur_hash, last_refreshed_at
        )
        SELECT
          ?, item_id, item_name, item_type, series_name, season_name,
          production_year, premiere_date, official_rating, community_rating,
          runtime_ticks, primary_image_tag, backdrop_image_tag, overview,
          genres_json, image_blur_hash, last_refreshed_at
        FROM media_item_metadata
        WHERE server_id = ?
        ON CONFLICT(server_id, item_id) DO UPDATE SET
          item_name = CASE WHEN excluded.last_refreshed_at >= media_item_metadata.last_refreshed_at THEN excluded.item_name ELSE media_item_metadata.item_name END,
          item_type = CASE WHEN excluded.last_refreshed_at >= media_item_metadata.last_refreshed_at THEN excluded.item_type ELSE media_item_metadata.item_type END,
          series_name = CASE WHEN excluded.last_refreshed_at >= media_item_metadata.last_refreshed_at THEN excluded.series_name ELSE media_item_metadata.series_name END,
          season_name = CASE WHEN excluded.last_refreshed_at >= media_item_metadata.last_refreshed_at THEN excluded.season_name ELSE media_item_metadata.season_name END,
          production_year = CASE WHEN excluded.last_refreshed_at >= media_item_metadata.last_refreshed_at THEN excluded.production_year ELSE media_item_metadata.production_year END,
          premiere_date = CASE WHEN excluded.last_refreshed_at >= media_item_metadata.last_refreshed_at THEN excluded.premiere_date ELSE media_item_metadata.premiere_date END,
          official_rating = CASE WHEN excluded.last_refreshed_at >= media_item_metadata.last_refreshed_at THEN excluded.official_rating ELSE media_item_metadata.official_rating END,
          community_rating = CASE WHEN excluded.last_refreshed_at >= media_item_metadata.last_refreshed_at THEN excluded.community_rating ELSE media_item_metadata.community_rating END,
          runtime_ticks = CASE WHEN excluded.last_refreshed_at >= media_item_metadata.last_refreshed_at THEN excluded.runtime_ticks ELSE media_item_metadata.runtime_ticks END,
          primary_image_tag = CASE WHEN excluded.last_refreshed_at >= media_item_metadata.last_refreshed_at THEN excluded.primary_image_tag ELSE media_item_metadata.primary_image_tag END,
          backdrop_image_tag = CASE WHEN excluded.last_refreshed_at >= media_item_metadata.last_refreshed_at THEN excluded.backdrop_image_tag ELSE media_item_metadata.backdrop_image_tag END,
          overview = CASE WHEN excluded.last_refreshed_at >= media_item_metadata.last_refreshed_at THEN excluded.overview ELSE media_item_metadata.overview END,
          genres_json = CASE WHEN excluded.last_refreshed_at >= media_item_metadata.last_refreshed_at THEN excluded.genres_json ELSE media_item_metadata.genres_json END,
          image_blur_hash = CASE WHEN excluded.last_refreshed_at >= media_item_metadata.last_refreshed_at THEN excluded.image_blur_hash ELSE media_item_metadata.image_blur_hash END,
          last_refreshed_at = CASE WHEN excluded.last_refreshed_at >= media_item_metadata.last_refreshed_at THEN excluded.last_refreshed_at ELSE media_item_metadata.last_refreshed_at END
      `);
      const deleteOldMetadata = db.prepare('DELETE FROM media_item_metadata WHERE server_id = ?');

      for (const { oldId, newId } of validMigrations) {
        const openRows = selectOpenSessions.all(oldId);
        updateSessionServerId.run(newId, oldId);

        const prefix = `${oldId}:`;
        for (const row of openRows) {
          if (!row.playbackSessionId || !row.playbackSessionId.startsWith(prefix)) continue;
          const newKey = sanitizeText(newId + row.playbackSessionId.slice(oldId.length), 160);
          if (!newKey || newKey === row.playbackSessionId) continue;
          if (!checkSessionKeyExists.get(newKey)) {
            updateSessionKey.run(newKey, row.playbackSessionId);
            updateSessionEventsKey.run(newKey, row.playbackSessionId);
          }
        }

        upsertMigratedMetadata.run(newId, oldId);
        deleteOldMetadata.run(oldId);
      }

      const currentVer = Math.max(1, Number(statements.getState.get('config_version')?.value) || cachedConfigVersion);
      const nextVer = currentVer + 1;
      statements.upsertState.run('config', nextJson, now);
      statements.upsertState.run('config_version', String(nextVer), now);
      statements.insertSnapshot.run(now, reason || 'server-id-migration', nextJson);
      if (reason) {
        statements.insertEvent.run(reason, now, null, null, JSON.stringify({ migratedServers: validMigrations.length }));
      }

      db.exec('COMMIT');
      cachedConfigVersion = nextVer;
      return normalized;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw error;
    }
  }

  function getConfigVersion() {
    return cachedConfigVersion;
  }

  function getInstanceId() {
    return cachedInstanceId;
  }

  function getAdminPasswordHash() {
    return cachedAdminPasswordHash;
  }

  function setAdminPasswordHashIfUnset(hash) {
    const now = isoNow();
    const res = statements.setStateIfUnset.run('admin_password_hash', String(hash), now);
    if (res.changes > 0) {
      cachedAdminPasswordHash = String(hash);
      return { changed: true, changes: res.changes };
    }
    return { changed: false, changes: 0 };
  }

  function isSetupTokenWeak(token) {
    if (token !== undefined) return isSetupTokenWeakValue(token);
    const cfg = getConfig();
    return isSetupTokenWeakValue(cfg.setup_token);
  }

  function getStateValue(key) {
    const row = statements.getState.get(key);
    return row ? row.value : null;
  }

  function setStateValue(key, value) {
    statements.upsertState.run(key, String(value), isoNow());
  }

  function deleteStateValue(key) {
    statements.deleteState.run(key);
  }

  function getConfigPullStats() {
    const rows = statements.syncEventsSince.all(cachedTelemetryStartedAt);
    const nowMs = Date.now();
    const sixtyDaysAgoIso = new Date(nowMs - 60 * 86_400_000).toISOString();
    let total = 0;
    let qcBroker = 0;
    let legacy = 0;
    let last60DaysLegacy = 0;
    let lastLegacyPullAt = null;

    for (const row of rows) {
      total += 1;
      const details = safeParseJson(row.details_json) || {};
      if (details.qcBroker === true) {
        qcBroker += 1;
      } else {
        legacy += 1;
        if (row.created_at >= sixtyDaysAgoIso) {
          last60DaysLegacy += 1;
        }
        if (!lastLegacyPullAt || row.created_at > lastLegacyPullAt) {
          lastLegacyPullAt = row.created_at;
        }
      }
    }

    const startedMs = Date.parse(cachedTelemetryStartedAt);
    const telemetryAgeDays = Number.isFinite(startedMs) ? (nowMs - startedMs) / 86_400_000 : 0;
    const legacySunsetReady = last60DaysLegacy === 0 && qcBroker > 0 && telemetryAgeDays >= 60;

    return {
      configPulls: {
        total,
        qcBroker,
        legacy,
        last60DaysLegacy,
        lastLegacyPullAt,
      },
      legacySunsetReady,
    };
  }

  function recordEvent(type, req, details = {}) {
    if (vacuumInFlight) return;
    statements.insertEvent.run(
      type,
      isoNow(),
      req ? (req.ip || req.socket?.remoteAddress || null) : null,
      req ? (req.headers?.['user-agent'] || null) : null,
      JSON.stringify(details)
    );
  }

  function upsertDevice({ deviceId, deviceName, appVersion, lastIp } = {}) {
    if (vacuumInFlight) return;
    const cleanId = sanitizeText(deviceId, 128).trim();
    if (!cleanId) return;
    const cleanName = sanitizeText(deviceName || '', 160).trim() || cleanId;
    const cleanAppVersion = sanitizeText(appVersion || '', 80).trim() || null;
    const cleanIp = sanitizeText(lastIp || '', 120).trim() || null;
    const now = isoNow();
    statements.upsertDeviceMeta.run(cleanId, cleanName, cleanAppVersion, now, now, cleanIp);
  }

  function createAdminSession(token, ttlMs) {
    const now = isoNow();
    const ttl = Number(ttlMs);
    const expiresAt = Number.isFinite(ttl)
      ? new Date(Date.now() + ttl).toISOString()
      : null;
    statements.createSession.run(token, now, expiresAt, now);
    if (vacuumInFlight) {
      adminSessionSnapshot.set(sha256Hex(token), expiresAt);
    }
  }

  function checkSnapshotAdminSession(token) {
    const digest = sha256Hex(token);
    if (!adminSessionSnapshot.has(digest)) return false;
    const expiresAt = adminSessionSnapshot.get(digest);
    if (expiresAt && expiresAt <= isoNow()) {
      adminSessionSnapshot.delete(digest);
      return false;
    }
    return true;
  }

  function isAdminSessionValid(token) {
    if (!token || typeof token !== 'string') return false;
    if (vacuumInFlight) {
      return checkSnapshotAdminSession(token);
    }
    const row = statements.getSession.get(token);
    if (!row) return false;
    if (row.expiresAt && row.expiresAt <= isoNow()) {
      return false;
    }
    return true;
  }

  function validateAdminSession(token) {
    if (!token || typeof token !== 'string') return false;
    if (vacuumInFlight) {
      return checkSnapshotAdminSession(token);
    }
    const row = statements.getSession.get(token);
    if (!row) return false;
    if (row.expiresAt && row.expiresAt <= isoNow()) {
      statements.deleteSession.run(token);
      return false;
    }
    statements.touchSession.run(isoNow(), token);
    return true;
  }

  function deleteAdminSession(token) {
    if (!token) return;
    adminSessionSnapshot.delete(sha256Hex(token));
    if (!vacuumInFlight) {
      statements.deleteSession.run(token);
    }
  }

  function pruneExpiredAdminSessions() {
    if (vacuumInFlight) return;
    statements.pruneExpiredSessions.run(isoNow());
  }

  function getConfigSnapshots() {
    return statements.getSnapshots.all();
  }

  function getConfigSnapshot(id) {
    const row = statements.getSnapshotById.get(id);
    if (!row || !row.config_json) return null;
    return safeParseJson(row.config_json);
  }

  function isVacuumInFlight() {
    return vacuumInFlight;
  }

  function enterVacuumInFlight() {
    adminSessionSnapshot.clear();
    const rows = statements.getAllActiveSessions.all(isoNow());
    for (const row of rows) {
      if (row && row.token) {
        adminSessionSnapshot.set(sha256Hex(row.token), row.expiresAt || null);
      }
    }
    vacuumInFlight = true;
  }

  function exitVacuumInFlight() {
    vacuumInFlight = false;
    adminSessionSnapshot.clear();
  }

  function runWorkerTask(task) {
    const job = () =>
      new Promise((resolve, reject) => {
        if (closed) {
          reject(new Error('Storage is closed'));
          return;
        }
        const workerPath = path.join(__dirname, 'storage-vacuum-worker.js');
        const worker = new Worker(workerPath, {
          workerData: { ...task, dbFile },
        });
        activeWorker = worker;
        let settled = false;

        const finish = (err, res) => {
          if (settled) return;
          settled = true;
          if (activeWorker === worker) activeWorker = null;
          if (err) reject(err);
          else resolve(res);
        };

        worker.once('message', (msg) => {
          if (msg && msg.ok) {
            finish(null, msg.result);
          } else {
            const e = new Error(msg?.error?.message || 'Storage worker failed');
            if (msg?.error?.code) e.code = msg.error.code;
            if (msg?.error?.errcode) e.errcode = msg.error.errcode;
            finish(e);
          }
        });
        worker.once('error', (err) => finish(err));
        worker.once('exit', (code) => {
          if (!settled) {
            finish(new Error(`Storage worker exited unexpectedly with code ${code}`));
          }
        });
      });

    const next = workerQueue.then(job, job);
    workerQueue = next.catch(() => {});
    return next;
  }

  function runStage1UpgradeInWorker(normalizedConfigJson) {
    return runWorkerTask({
      op: 'stage1-upgrade',
      preBackupPath: preStage1BackupPath,
      normalizedConfigJson,
    });
  }

  function runVacuumInWorker() {
    return runWorkerTask({ op: 'vacuum' });
  }

  function runBackupInWorker(destPath) {
    return runWorkerTask({ op: 'vacuum-into', destPath });
  }

  function runScrubHistoricalBackupsInWorker() {
    return runWorkerTask({
      op: 'scrub-historical-backups',
      backupsDir,
    });
  }

  function hasPreStage1Backup() {
    try {
      return fs.existsSync(preStage1BackupPath);
    } catch (_) {
      return false;
    }
  }

  function prunePreStage1Backup(maxAgeDays = 14) {
    try {
      if (!fs.existsSync(preStage1BackupPath)) return { deleted: false };
      const stat = fs.lstatSync(preStage1BackupPath);
      if (!stat.isFile() || stat.isSymbolicLink()) return { deleted: false };
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs >= maxAgeDays * 86_400_000) {
        fs.unlinkSync(preStage1BackupPath);
        return { deleted: true };
      }
      return { deleted: false, ageDays: ageMs / 86_400_000 };
    } catch (_) {
      return { deleted: false };
    }
  }

  function vacuumInto(destPath) {
    assertNotSymlink(destPath);
    const dir = path.dirname(destPath);
    ensureDir(dir, 0o700);
    const tempPath = path.join(
      dir,
      `.${path.basename(destPath)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
    );
    try {
      db.prepare('VACUUM INTO ?').run(tempPath);
      guardedChmod(tempPath, 0o600);
      fs.renameSync(tempPath, destPath);
      guardedChmod(destPath, 0o600);
    } catch (err) {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch (_) {}
      throw err;
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    const workerToStop = activeWorker;
    if (workerToStop) {
      try {
        await workerToStop.terminate();
      } catch (_) {}
    }
    try {
      await workerQueue;
    } catch (_) {}
    try {
      db.close();
    } catch (_) {}
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
    db.exec('BEGIN IMMEDIATE');
    try {
      statements.clearDeviceLogs.run(deviceId);
      statements.resetDeviceLogCount.run(deviceId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function renameDevice(deviceId, customName) {
    const trimmed = typeof customName === 'string' ? customName.trim() : '';
    const value = trimmed ? sanitizeText(trimmed, 160) : null;
    const result = statements.renameDevice.run(value, deviceId);
    return { changes: result.changes, customName: value };
  }

  function deleteDevice(deviceId) {
    db.exec('BEGIN IMMEDIATE');
    try {
      statements.clearDeviceLogs.run(deviceId);
      const result = statements.deleteDevice.run(deviceId);
      db.exec('COMMIT');
      return { changes: result.changes };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function deletePlaybackSession(playbackSessionId) {
    const result = statements.deletePlaybackSession.run(playbackSessionId);
    return { changes: result.changes };
  }

  function clearAllPlaybackSessions() {
    db.exec('BEGIN IMMEDIATE');
    try {
      statements.deleteAllPlaybackSessionEvents.run();
      const result = statements.deleteAllPlaybackSessions.run();
      db.exec('COMMIT');
      return { deleted: result.changes };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function prunePlaybackSessionsOlderThan(days) {
    const parsed = Number(days);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error('days must be a positive number');
    }
    const now = Date.now();
    const cutoffMs = now - parsed * 86_400_000;
    const cutoff = new Date(cutoffMs).toISOString();
    const syncPullCutoff = new Date(Math.min(cutoffMs, now - 65 * 86_400_000)).toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      const sessions = statements.deletePlaybackSessionsOlderThan.run(cutoff);
      const events = statements.deleteEventsOlderThan.run(cutoff, syncPullCutoff);
      db.exec('COMMIT');
      return { deleted: sessions.changes, eventsDeleted: events.changes, cutoff };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function pruneDeviceLogsOlderThan(days) {
    const parsed = Number(days);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error('days must be a positive number');
    }
    const cutoff = new Date(Date.now() - parsed * 86400 * 1000).toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = statements.deleteDeviceLogsOlderThan.run(cutoff);
      statements.refreshDeviceEntryCounts.run();
      db.exec('COMMIT');
      return { deleted: result.changes, cutoff };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function getDatabaseStats() {
    let fileSizeBytes = 0;
    try {
      fileSizeBytes = fs.statSync(dbFile).size;
    } catch (_) {}
    const counts = {
      playbackSessions: db.prepare('SELECT COUNT(*) AS c FROM playback_sessions').get().c || 0,
      playbackSessionEvents: db.prepare('SELECT COUNT(*) AS c FROM playback_session_events').get().c || 0,
      deviceLogs: db.prepare('SELECT COUNT(*) AS c FROM device_logs').get().c || 0,
      devices: db.prepare('SELECT COUNT(*) AS c FROM devices').get().c || 0,
      mediaItemMetadata: db.prepare('SELECT COUNT(*) AS c FROM media_item_metadata').get().c || 0,
      events: db.prepare('SELECT COUNT(*) AS c FROM events').get().c || 0
    };
    const oldestPlaybackAt = db.prepare('SELECT MIN(COALESCE(last_seen_at, started_at)) AS ts FROM playback_sessions').get().ts || null;
    const oldestDeviceLogAt = db.prepare('SELECT MIN(received_at) AS ts FROM device_logs').get().ts || null;
    return {
      fileSizeBytes,
      counts,
      oldestPlaybackAt,
      oldestDeviceLogAt
    };
  }

  function vacuumDatabase() {
    db.exec('VACUUM');
  }

  function upsertDeviceLogs(payload, req) {
    const now = isoNow();
    const deviceId = sanitizeText(payload.deviceId, 128) || 'unknown-device';
    const deviceName = sanitizeText(payload.deviceName || payload.model || 'SpatialFin Device', 160);
    const existing = statements.getDevice.get(deviceId);
    const entries = Array.isArray(payload.logs) ? payload.logs : [];
    let latestEntryAt = existing ? existing.latestEntryAt : null;

    db.exec('BEGIN IMMEDIATE');
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

    db.exec('BEGIN IMMEDIATE');
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
    db.exec('BEGIN IMMEDIATE');
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
    const whereClause = buildAnalyticsRangeWhereClause(options, "WHERE library_name IS NOT NULL AND TRIM(library_name) <> ''");
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
    db.exec('BEGIN IMMEDIATE');
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

function ensureDir(dir, mode = 0o700) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode });
  }
  guardedChmod(dir, mode);
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
  generateSetupToken,
  isSetupTokenWeakValue,
  STRONG_SETUP_TOKEN_REGEX,
  DEFAULT_MAX_LOG_ENTRIES_PER_DEVICE,
  DEFAULT_MAX_LOG_MESSAGE_LENGTH
};
