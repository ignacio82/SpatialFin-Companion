'use strict';

const https = require('https');
const path = require('path');
const fs = require('fs');

const REPO = process.env.COMPANION_UPDATE_REPO || 'ignacio82/SpatialFin-Companion';
const CHECK_INTERVAL_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.COMPANION_UPDATE_INTERVAL_MS) || 24 * 60 * 60 * 1000
);
const AUTO_UPDATE = String(process.env.COMPANION_AUTO_UPDATE ?? 'true').toLowerCase() !== 'false';
const USER_AGENT = 'SpatialFin-Companion-Updater';

let lastCheckAt = null;
let lastCheckStatus = null;
let latestReleaseTag = null;
let timer = null;

function readCurrentVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch (_) {
    return '0.0.0';
  }
}

function parseSemver(raw) {
  if (!raw) return null;
  const clean = String(raw).trim().replace(/^v/i, '').split(/[-+]/)[0];
  const parts = clean.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts.slice(0, 3);
}

function isNewer(remote, local) {
  const r = parseSemver(remote);
  const l = parseSemver(local);
  if (!r || !l) return false;
  for (let i = 0; i < 3; i += 1) {
    if (r[i] > l[i]) return true;
    if (r[i] < l[i]) return false;
  }
  return false;
}

function fetchLatestTag() {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        host: 'api.github.com',
        path: `/repos/${REPO}/releases/latest`,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/vnd.github+json',
        },
        timeout: 15_000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode === 404) {
            resolve(null);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`GitHub API ${res.statusCode}`));
            return;
          }
          try {
            const payload = JSON.parse(body);
            resolve(payload.tag_name || null);
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('GitHub API timeout'));
    });
    req.on('error', reject);
  });
}

async function checkOnce() {
  lastCheckAt = new Date().toISOString();
  const current = readCurrentVersion();
  try {
    const tag = await fetchLatestTag();
    latestReleaseTag = tag;
    if (!tag) {
      lastCheckStatus = `no-release-yet (running ${current})`;
      return;
    }
    if (AUTO_UPDATE && isNewer(tag, current)) {
      lastCheckStatus = `update-available ${current} -> ${tag}; exiting for restart`;
      console.log(`[updater] ${tag} available (running ${current}); exiting so the container restarts onto the new tag.`);
      // Small delay so the log line flushes and any in-flight response completes.
      setTimeout(() => process.exit(0), 1000);
      return;
    }
    lastCheckStatus = `up-to-date (running ${current}, latest ${tag})`;
  } catch (error) {
    lastCheckStatus = `check-failed: ${error.message}`;
  }
}

function start() {
  if (!AUTO_UPDATE) {
    lastCheckStatus = 'disabled (COMPANION_AUTO_UPDATE=false)';
    console.log('[updater] auto-update disabled via COMPANION_AUTO_UPDATE=false');
    return;
  }
  if (timer) return;
  // First check one minute after boot so we don't race the server's startup.
  setTimeout(() => {
    checkOnce().catch(() => {});
  }, 60 * 1000);
  timer = setInterval(() => {
    checkOnce().catch(() => {});
  }, CHECK_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

function getStatus() {
  return {
    repo: REPO,
    currentVersion: readCurrentVersion(),
    autoUpdate: AUTO_UPDATE,
    intervalMs: CHECK_INTERVAL_MS,
    lastCheckAt,
    lastCheckStatus,
    latestReleaseTag,
  };
}

module.exports = { start, checkOnce, getStatus };
