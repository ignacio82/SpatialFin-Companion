'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { LOCAL_ONLY_PREF_KEYS, FORBIDDEN_KEYS } = require('./config-redaction');

function guardedChmod(targetPath, mode) {
  try {
    fs.chmodSync(targetPath, mode);
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'ENOTSUP' || err.code === 'EROFS')) {
      console.warn(`[storage-worker] chmod ${mode.toString(8)} skipped on ${targetPath}: ${err.code}`);
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

function vacuumIntoSync(db, destPath) {
  assertNotSymlink(destPath);
  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    guardedChmod(dir, 0o700);
  }
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

function scrubPreferenceMapInPlace(prefs) {
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return false;
  let changed = false;
  for (const key of Object.keys(prefs)) {
    if (FORBIDDEN_KEYS.has(key) || LOCAL_ONLY_PREF_KEYS.has(key)) {
      delete prefs[key];
      changed = true;
    }
  }
  return changed;
}

function scrubConfigObject(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return { config, changed: false };
  let changed = false;
  if (Object.prototype.hasOwnProperty.call(config, 'instance_id')) {
    delete config.instance_id;
    changed = true;
  }
  if (scrubPreferenceMapInPlace(config.globalPreferences)) changed = true;
  if (config.devicePreferences && typeof config.devicePreferences === 'object') {
    for (const [devId, map] of Object.entries(config.devicePreferences)) {
      if (FORBIDDEN_KEYS.has(devId)) {
        delete config.devicePreferences[devId];
        changed = true;
      } else if (scrubPreferenceMapInPlace(map)) {
        changed = true;
      }
    }
  }
  if (Array.isArray(config.servers)) {
    for (const srv of config.servers) {
      if (!srv || !Array.isArray(srv.users)) continue;
      for (const user of srv.users) {
        if (!user || typeof user !== 'object') continue;
        if (Object.prototype.hasOwnProperty.call(user, 'password')) {
          delete user.password;
          changed = true;
        }
        if (Object.prototype.hasOwnProperty.call(user, 'has_verified_token')) {
          delete user.has_verified_token;
          changed = true;
        }
        if (scrubPreferenceMapInPlace(user.preferences)) changed = true;
      }
    }
  }
  return { config, changed };
}

function scrubDatabaseTables(db, normalizedConfigJson = null) {
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const hasAppState = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_state'").get();
    if (hasAppState) {
      if (typeof normalizedConfigJson === 'string' && normalizedConfigJson.length > 0) {
        db.prepare(`
          INSERT INTO app_state (key, value, updated_at)
          VALUES ('config', ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(normalizedConfigJson, now);
      } else {
        const row = db.prepare("SELECT value FROM app_state WHERE key = 'config'").get();
        if (row && row.value) {
          try {
            const parsed = JSON.parse(row.value);
            const { config, changed } = scrubConfigObject(parsed);
            if (changed) {
              db.prepare("UPDATE app_state SET value = ?, updated_at = ? WHERE key = 'config'").run(
                JSON.stringify(config),
                now
              );
            }
          } catch (_) {}
        }
      }
    }

    const hasSnapshots = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='config_snapshots'")
      .get();
    if (hasSnapshots) {
      const rows = db.prepare('SELECT id, config_json FROM config_snapshots').all();
      const updateStmt = db.prepare('UPDATE config_snapshots SET config_json = ? WHERE id = ?');
      for (const row of rows) {
        if (!row || !row.config_json) continue;
        try {
          const parsed = JSON.parse(row.config_json);
          const { config, changed } = scrubConfigObject(parsed);
          if (changed) {
            updateStmt.run(JSON.stringify(config), row.id);
          }
        } catch (_) {}
      }
    }

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {}
    throw err;
  }
}

function runCheckpointTruncateWithRetry(db, maxAttempts = 6) {
  let lastResult = { busy: 1, log: -1, checkpointed: -1 };
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    lastResult = row || lastResult;
    if (lastResult.busy === 0 && lastResult.log === lastResult.checkpointed) {
      return { ok: true, ...lastResult };
    }
    // Brief synchronous spin-wait via Atomics.wait on a throwaway SAB
    const sab = new SharedArrayBuffer(4);
    const view = new Int32Array(sab);
    Atomics.wait(view, 0, 0, Math.min(250, 25 * (attempt + 1)));
  }
  return { ok: false, ...lastResult };
}

function openWorkerDb(dbFile) {
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

function setState(db, key, value) {
  db.prepare(`
    INSERT INTO app_state (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value), new Date().toISOString());
}

function getState(db, key) {
  const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get(key);
  return row ? row.value : null;
}

function handleTask(task) {
  const { op, dbFile } = task;

  if (op === 'vacuum') {
    const db = openWorkerDb(dbFile);
    try {
      db.exec('VACUUM');
      const checkpoint = runCheckpointTruncateWithRetry(db);
      return { ok: true, checkpoint };
    } finally {
      db.close();
    }
  }

  if (op === 'vacuum-into') {
    const db = openWorkerDb(dbFile);
    try {
      vacuumIntoSync(db, task.destPath);
      return { ok: true, destPath: task.destPath };
    } finally {
      db.close();
    }
  }

  if (op === 'stage1-upgrade') {
    const db = openWorkerDb(dbFile);
    try {
      const preBackupDone = getState(db, 'stage1_pre_backup_done') === '1';
      let preBackupCreated = false;
      if (!preBackupDone && task.preBackupPath) {
        vacuumIntoSync(db, task.preBackupPath);
        setState(db, 'stage1_pre_backup_done', '1');
        preBackupCreated = true;
      }

      const liveVacuumDone = getState(db, 'stage1_live_vacuum_done') === '1';
      let checkpoint = null;
      if (!liveVacuumDone) {
        scrubDatabaseTables(db, task.normalizedConfigJson || null);
        db.exec('VACUUM');
        checkpoint = runCheckpointTruncateWithRetry(db);
        if (checkpoint.ok) {
          setState(db, 'stage1_live_vacuum_done', '1');
        }
      }

      return {
        ok: true,
        preBackupCreated,
        liveVacuumDone: liveVacuumDone || Boolean(checkpoint && checkpoint.ok),
        checkpoint,
      };
    } finally {
      db.close();
    }
  }

  if (op === 'scrub-historical-backups') {
    const mainDb = openWorkerDb(dbFile);
    try {
      if (getState(mainDb, 'stage1_backups_scrubbed') === '1') {
        return { ok: true, skipped: true, scrubbedCount: 0, quarantined: [] };
      }

      const backupsDir = task.backupsDir;
      let scrubbedCount = 0;
      const quarantined = [];

      if (backupsDir && fs.existsSync(backupsDir)) {
        const entries = fs.readdirSync(backupsDir);
        for (const name of entries) {
          if (!name.endsWith('.sqlite.bak')) continue;
          const fullPath = path.join(backupsDir, name);
          let origMtime = null;
          let origAtime = null;
          try {
            const stat = fs.lstatSync(fullPath);
            if (!stat.isFile() || stat.isSymbolicLink()) continue;
            origMtime = stat.mtime;
            origAtime = stat.atime;
          } catch (_) {
            continue;
          }

          let backupDb = null;
          try {
            backupDb = new DatabaseSync(fullPath);
            backupDb.exec('PRAGMA busy_timeout = 5000');
            scrubDatabaseTables(backupDb, null);
            backupDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
            backupDb.exec('PRAGMA journal_mode = DELETE');
            backupDb.exec('VACUUM');
            scrubbedCount += 1;
          } catch (err) {
            try {
              if (backupDb) {
                backupDb.close();
                backupDb = null;
              }
            } catch (_) {}
            const quarantinePath = `${fullPath}.corrupt-${Date.now()}`;
            try {
              fs.renameSync(fullPath, quarantinePath);
              quarantined.push(path.basename(quarantinePath));
            } catch (_) {}
            continue;
          } finally {
            if (backupDb) {
              try {
                backupDb.close();
              } catch (_) {}
            }
          }

          for (const suffix of ['-wal', '-shm']) {
            const sidecar = `${fullPath}${suffix}`;
            try {
              if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
            } catch (_) {}
          }
          guardedChmod(fullPath, 0o600);
          if (origAtime && origMtime) {
            try {
              fs.utimesSync(fullPath, origAtime, origMtime);
            } catch (_) {}
          }
        }
      }

      setState(mainDb, 'stage1_backups_scrubbed', '1');
      return { ok: true, skipped: false, scrubbedCount, quarantined };
    } finally {
      mainDb.close();
    }
  }

  throw new Error(`Unknown storage worker op: ${op}`);
}

if (parentPort) {
  try {
    const result = handleTask(workerData);
    parentPort.postMessage({ ok: true, result });
  } catch (err) {
    parentPort.postMessage({
      ok: false,
      error: {
        message: err?.message || String(err),
        code: err?.code,
        errcode: err?.errcode,
      },
    });
  }
}

module.exports = { handleTask, scrubConfigObject };
