const originalEmit = process.emit;
process.emit = function (name, data, ...args) {
  if (name === 'warning' && typeof data === 'object' && data.name === 'ExperimentalWarning' && data.message.includes('SQLite')) return false;
  return originalEmit.apply(process, [name, data, ...args]);
};
const express = require('express');
const qrcode = require('qrcode');
const bodyParser = require('body-parser');
const cors = require('cors');
const os = require('os');
const { WebSocketServer } = require('ws');
const helmet = require('helmet');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { createStorage } = require('./storage');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT) || 1982;

app.use(helmet({ contentSecurityPolicy: false })); // Disabled CSP for inline scripts if any
app.use(cors());
app.use(bodyParser.json({ limit: '5mb' }));
app.use(express.static('public'));

const DEFAULT_PREFERENCES = {
  // Language
  pref_audio_language: "jpn",
  pref_subtitle_language: "eng",
  pref_anime_audio_language: "jpn",
  pref_anime_subtitle_language: "eng",
  pref_non_anime_audio_language: "eng",
  pref_non_anime_subtitle_disabled: "true",
  pref_non_anime_subtitle_language: null,
  pref_smart_prefer_original_audio: "true",
  pref_smart_spoken_languages: "en,es,ja",

  // Interface
  pref_theme: "system",
  pref_dynamic_colors: "true",
  home_suggestions: "true",
  home_continue_watching: "true",
  home_next_up: "true",
  home_latest: "true",
  pref_display_extra_info: "false",
  pref_display_ratings: "true",

  // Player
  pref_player_seek_back_inc: "5000",
  pref_player_seek_forward_inc: "15000",
  pref_player_chapter_markers: "true",
  pref_player_trickplay: "true",
  pref_player_max_bitrate: "0",
  pref_libass_subtitle_usage: "auto",
  pref_logging_enabled: "false",

  // Voice
  pref_voice_control_enabled: "true",
  pref_voice_gesture_hand: "left",
  pref_voice_assistant_verbosity: "balanced",
  pref_voice_assistant_spoiler_policy: "cautious",
  pref_voice_assistant_spoken_replies: "true",
  pref_voice_assistant_voice: "male",
  pref_voice_assistant_cloud_api_key: null,

  // Seerr
  pref_seerr_enabled: "false",
  pref_seerr_url: null,
  pref_seerr_api_key: null,

  // TMDB
  pref_tmdb_api_key: null,
  pref_tmdb_auto_match: "true"
};

const storage = createStorage({
  rootDir: __dirname,
  defaultPreferences: DEFAULT_PREFERENCES
});

let appConfig = storage.getConfig();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function saveConfig() {
  appConfig = storage.saveConfig(appConfig, {
    reason: 'config-save'
  });
}

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

async function httpGet(urlStr, headers = {}, timeout = 5000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(urlStr, { headers, signal: controller.signal });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { data = text; }
    return { status: res.status, data };
  } finally {
    clearTimeout(id);
  }
}

async function httpPost(urlStr, body, headers = {}, timeout = 5000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    if (!headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(urlStr, {
      method: 'POST',
      headers,
      body: payload,
      signal: controller.signal
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { data = text; }
    return { status: res.status, data };
  } finally {
    clearTimeout(id);
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    const key = pair.substring(0, idx).trim();
    const val = pair.substring(idx + 1).trim();
    cookies[key] = decodeURIComponent(val);
  });
  return cookies;
}

// ---------------------------------------------------------------------------
// Admin authentication (opt-in)
// ---------------------------------------------------------------------------
const ADMIN_PASSWORD = process.env.COMPANION_ADMIN_PASSWORD || null;


function adminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) return next();
  // Exempt login endpoint
  if (req.path === '/login') return next();
  const cookies = parseCookies(req);
  const token = cookies['session'];
  if (token && storage.validateAdminSession(token)) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

const adminRouter = express.Router();
adminRouter.use(adminAuth);

function formatLogEntry(entry) {
  const timestamp = entry.timestamp || entry.receivedAt || new Date().toISOString();
  const level = entry.level || '?';
  const tag = entry.tag || 'SpatialFin';
  const message = entry.message || '';
  const header = `${timestamp} ${level}/${tag}: ${message}`;
  return entry.stack ? `${header}\n${entry.stack}` : header;
}

// ---------------------------------------------------------------------------
// Admin login & auth-check (login is exempt from auth via middleware)
// ---------------------------------------------------------------------------
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts, please try again later' }
});

adminRouter.post('/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  if (!ADMIN_PASSWORD) {
    return res.json({ authenticated: true });
  }
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  storage.createAdminSession(token);
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/`);
  res.json({ authenticated: true });
});

adminRouter.get('/auth-check', (req, res) => {
  res.json({ authenticated: true, authRequired: !!ADMIN_PASSWORD });
});

// ---------------------------------------------------------------------------
// Existing admin routes
// ---------------------------------------------------------------------------
adminRouter.get('/config', (req, res) => res.json(appConfig));

adminRouter.post('/config', (req, res) => {
  const { globalPreferences, servers, networkShares } = req.body;
  if (globalPreferences) appConfig.globalPreferences = globalPreferences;
  if (servers) appConfig.servers = servers;
  if (networkShares) appConfig.networkShares = networkShares;
  appConfig = storage.saveConfig(appConfig, {
    reason: 'config-update',
    eventType: 'config_updated',
    req,
    details: {
      servers: Array.isArray(appConfig.servers) ? appConfig.servers.length : 0,
      networkShares: Array.isArray(appConfig.networkShares) ? appConfig.networkShares.length : 0
    }
  });
  res.json({ status: 'ok' });
});

adminRouter.get('/qr', async (req, res) => {
  const host = req.query.host || getLocalIp();
  const payload = JSON.stringify({
    version: 1,
    companion_url: `http://${host}:${PORT}`,
    setup_token: appConfig.setup_token
  });
  try {
    const qrImage = await qrcode.toDataURL(payload);
    res.json({ qr: qrImage, payload });
  } catch (err) {
    res.status(500).json({ error: 'QR fail' });
  }
});

// ---------------------------------------------------------------------------
// New admin routes
// ---------------------------------------------------------------------------
adminRouter.post('/test-jellyfin', async (req, res) => {
  try {
    const url = (req.body.url || '').replace(/\/+$/, '');
    const result = await httpGet(`${url}/System/Info/Public`);
    if (result.status === 200 && result.data) {
      res.json({ success: true, serverName: result.data.ServerName, version: result.data.Version });
    } else {
      res.json({ success: false, error: `Unexpected status ${result.status}` });
    }
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

adminRouter.post('/test-seerr', async (req, res) => {
  try {
    const { url, apiKey } = req.body;
    const cleanUrl = (url || '').replace(/\/+$/, '');
    const result = await httpGet(`${cleanUrl}/api/v1/status`, { 'X-Api-Key': apiKey });
    if (result.status === 200) {
      res.json({ success: true, data: result.data });
    } else {
      res.json({ success: false, error: `Unexpected status ${result.status}` });
    }
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

adminRouter.post('/verify-user', async (req, res) => {
  try {
    const { serverUrl, username, password } = req.body;
    const cleanUrl = (serverUrl || '').replace(/\/+$/, '');
    const authHeader = 'MediaBrowser Client="SpatialFin Companion", Device="Server", DeviceId="spatialfin-companion", Version="1.0.0"';
    const result = await httpPost(
      `${cleanUrl}/Users/AuthenticateByName`,
      { Username: username, Pw: password },
      { 'X-Emby-Authorization': authHeader }
    );
    if (result.status === 200 && result.data) {
      const accessToken = result.data.AccessToken;
      const userId = result.data.User ? result.data.User.Id : result.data.UserId;
      // Save access_token to matching user in config
      if (appConfig.servers) {
        for (const server of appConfig.servers) {
          if (server.users) {
            for (const user of server.users) {
              if (user.username === username || user.name === username) {
                user.access_token = accessToken;
              }
            }
          }
        }
        appConfig = storage.saveConfig(appConfig, {
          reason: 'verify-user',
          eventType: 'user_verified',
          req,
          details: {
            username,
            serverUrl: cleanUrl
          }
        });
      }
      res.json({ success: true, userId, accessToken });
    } else {
      res.json({ success: false, error: `Authentication failed with status ${result.status}` });
    }
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

adminRouter.post('/rotate-token', (req, res) => {
  appConfig.setup_token = 'sf-setup-' + crypto.randomBytes(6).toString('hex');
  appConfig = storage.saveConfig(appConfig, {
    reason: 'rotate-token',
    eventType: 'token_rotated',
    req
  });
  res.json({ setup_token: appConfig.setup_token });
});

adminRouter.get('/config/snapshots', (req, res) => {
  res.json(storage.getConfigSnapshots());
});

adminRouter.post('/config/snapshots/restore', (req, res) => {
  try {
    const success = storage.restoreConfigSnapshot(req.body.id);
    if (success) {
      appConfig = storage.getConfig();
      res.json({ success: true, config: appConfig });
    } else {
      res.status(404).json({ success: false, error: 'Snapshot not found' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

adminRouter.get('/config/export', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="spatialfin-config.json"');
  res.json(appConfig);
});

adminRouter.post('/config/import', (req, res) => {
  try {
    const imported = req.body;
    if (!imported || typeof imported !== 'object' || Array.isArray(imported)) {
      return res.status(400).json({ error: 'Invalid config: must be a JSON object' });
    }
    if (imported.globalPreferences) {
      appConfig.globalPreferences = { ...appConfig.globalPreferences, ...imported.globalPreferences };
    }
    if (imported.servers) {
      appConfig.servers = imported.servers;
    }
    if (imported.networkShares) {
      appConfig.networkShares = imported.networkShares;
    }
    if (imported.setup_token) {
      appConfig.setup_token = imported.setup_token;
    }
    appConfig = storage.saveConfig(appConfig, {
      reason: 'config-import',
      eventType: 'config_imported',
      req,
      details: {
        importedServers: Array.isArray(imported.servers) ? imported.servers.length : 0,
        importedShares: Array.isArray(imported.networkShares) ? imported.networkShares.length : 0
      }
    });
    res.json({ status: 'ok', config: appConfig });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

adminRouter.get('/sync-log', (req, res) => {
  res.json(storage.getSyncLog(100));
});

adminRouter.get('/device-logs', (req, res) => {
  res.json({
    loggingEnabled: appConfig.globalPreferences.pref_logging_enabled === 'true',
    devices: storage.getDeviceSummaries()
  });
});

adminRouter.get('/device-logs/:deviceId', (req, res) => {
  const requestedLimit = Number(req.query.limit) || 500;
  const limit = Math.max(1, Math.min(2000, requestedLimit));
  const result = storage.getDeviceWithLogs(req.params.deviceId, limit);
  if (!result) {
    return res.status(404).json({ error: 'Device logs not found' });
  }
  res.json({
    device: result.device,
    entries: result.entries
  });
});

adminRouter.get('/device-logs/:deviceId/download', (req, res) => {
  const result = storage.getDeviceWithLogs(req.params.deviceId, 1000000);
  if (!result) {
    return res.status(404).json({ error: 'Device logs not found' });
  }
  const { device, entries } = result;
  const safeName = (device.deviceName || device.deviceId || 'spatialfin-device')
    .replace(/[^a-z0-9-_]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'spatialfin-device';
  const lines = [
    `Device: ${device.deviceName || device.deviceId}`,
    `Device ID: ${device.deviceId}`,
    `Model: ${device.manufacturer ? device.manufacturer + ' ' : ''}${device.model || ''}`.trim(),
    `App Version: ${device.appVersion || '-'}`,
    `Android Version: ${device.androidVersion || '-'}`,
    `Last Seen: ${device.lastSeenAt || '-'}`,
    `Entries: ${entries.length}`,
    ''
  ];
  entries.forEach((entry) => {
    lines.push(formatLogEntry(entry));
    lines.push('');
  });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}-logs.txt"`);
  res.send(lines.join('\n'));
});

adminRouter.delete('/device-logs/:deviceId', (req, res) => {
  storage.clearDeviceLogs(req.params.deviceId);
  res.json({ status: 'ok' });
});

app.use('/api/admin', adminRouter);

// ---------------------------------------------------------------------------
// Public API (NOT under admin auth)
// ---------------------------------------------------------------------------
app.get('/api/v1/config', (req, res) => {
  const token = req.headers['x-setup-token'];
  if (token !== appConfig.setup_token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  storage.recordEvent('device_sync_pull', req, {
    setupTokenPrefix: appConfig.setup_token.slice(0, 12)
  });
  res.json(appConfig);
});

app.post('/api/v1/device-logs', (req, res) => {
  const token = req.headers['x-setup-token'];
  if (token !== appConfig.setup_token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const payload = req.body || {};
  if (!payload.deviceId || !Array.isArray(payload.logs) || payload.logs.length === 0) {
    return res.status(400).json({ error: 'Invalid log payload' });
  }
  const device = storage.upsertDeviceLogs(payload, req);
  res.json({
    status: 'ok',
    deviceId: device.deviceId,
    accepted: payload.logs.length,
    totalEntries: device.entryCount
  });
  
  if (wss) {
    const msg = JSON.stringify({ type: 'new_logs', deviceId: device.deviceId, logs: payload.logs });
    wss.clients.forEach(client => {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(msg);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
});

// Automated Backups
function backupDatabase() {
  const dataDir = path.join(__dirname, 'data');
  const backupDir = path.join(dataDir, 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const dbFile = path.join(dataDir, 'companion.sqlite');
  if (!fs.existsSync(dbFile)) return;
  const backupFile = path.join(backupDir, `companion-${new Date().toISOString().split('T')[0]}.sqlite.bak`);
  fs.copyFileSync(dbFile, backupFile);
  
  const files = fs.readdirSync(backupDir).map(f => ({ name: f, time: fs.statSync(path.join(backupDir, f)).mtime.getTime() }));
  files.sort((a, b) => b.time - a.time);
  files.slice(7).forEach(f => fs.unlinkSync(path.join(backupDir, f.name)));
}
setInterval(backupDatabase, 24 * 60 * 60 * 1000);
backupDatabase();

const server = app.listen(PORT, '0.0.0.0', () => {

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  // Client connected for log streaming
});

  console.log(`SpatialFin Companion on port ${PORT}`);
});
