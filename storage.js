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
    maxLogMessageLength = DEFAULT_MAX_LOG_MESSAGE_LENGTH
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
    restoreConfigSnapshot
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

module.exports = {
  createStorage,
  DEFAULT_MAX_LOG_ENTRIES_PER_DEVICE,
  DEFAULT_MAX_LOG_MESSAGE_LENGTH
};
