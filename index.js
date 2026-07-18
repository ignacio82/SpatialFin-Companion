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
const originalNetworkInterfaces = os.networkInterfaces;
let globalLocalIp = undefined;
const _netsRaw = originalNetworkInterfaces();
for (const name of Object.keys(_netsRaw)) {
  for (const net of _netsRaw[name]) {
    const isIPv4 = net.family === 'IPv4' || net.family === 4;
    if (isIPv4 && !net.internal && net.address.startsWith('192.168.1.')) {
      globalLocalIp = net.address;
      break;
    }
  }
  if (globalLocalIp) break;
}
if (!globalLocalIp) {
  for (const name of Object.keys(_netsRaw)) {
    for (const net of _netsRaw[name]) {
      const isIPv4 = net.family === 'IPv4' || net.family === 4;
      if (isIPv4 && !net.internal && !net.address.startsWith('172.') && !net.address.startsWith('192.168.96.')) {
        globalLocalIp = net.address;
        break;
      }
    }
    if (globalLocalIp) break;
  }
}

os.networkInterfaces = function() {
  const nets = originalNetworkInterfaces();
  const filtered = {};
  for (const name of Object.keys(nets)) {
    filtered[name] = nets[name].filter(net => {
      if (globalLocalIp && net.address === globalLocalIp) return true;
      if (!globalLocalIp && !net.internal) return true;
      return false;
    });
    if (filtered[name].length === 0) delete filtered[name];
  }
  if (Object.keys(filtered).length === 0) return nets;
  return filtered;
};
const { WebSocketServer, WebSocket } = require('ws');
const helmet = require('helmet');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const net = require('net');
const dns = require('dns').promises;
const Bonjour = require('bonjour-service').default;
const { execFile } = require('child_process');
const { promisify } = require('util');
const { DEFAULT_PREFERENCES } = require('./default-preferences');
const { createStorage } = require('./storage');
const updater = require('./updater');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const {
  buildNetworkShareTargetPath,
  buildNfsTarget,
  isPathWithinExport,
  normalizeNfsExportPath,
  normalizeShareRelativePath,
  validateNetworkShareForTest
} = require('./network-shares');
const { parseSmbClientListing } = require('./share-test-utils');
const { queryNfsExportsViaRpc } = require('./nfs-rpc');
const {
  buildPrivateIpv4DiscoveryTargets,
  collectPrivateIpv4SeedAddresses,
  describePrivateIpv4Subnets,
  extractHostFromAuthority,
  parseSmbClientShareList,
  sortAndDedupeDiscoveryResults
} = require('./share-discovery');
const {
  normalizeManualCode,
  isPrivateIpv4,
  validateTvPairingPayload,
  validateTvPairingInfo,
  buildTvReceiverUrl,
  buildTvInfoUrl,
  normalizeTvReceiverInput,
  buildTvPairingEnvelope,
  TV_PAIRING_PORT
} = require('./tv-pairing');
const { performSearch: performWebSearch } = require('./web-search');

const SEARXNG_URL = (process.env.COMPANION_SEARXNG_URL || '').trim();
const WEB_SEARCH_ENABLED = SEARXNG_URL.length > 0;

const app = express();
const PORT = Number(process.env.PORT) || 1982;
const ANALYTICS_SYNC_INTERVAL_MS = Math.max(30_000, Number(process.env.ANALYTICS_SYNC_INTERVAL_MS) || 120_000);
const execFileAsync = promisify(execFile);

// CSP permits inline handlers (UI still uses onclick="" everywhere) but
// blocks external scripts/objects and frames. Tightening further requires
// migrating every onclick= to addEventListener so 'unsafe-inline' +
// script-src-attr can be dropped.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      mediaSrc: ["'self'", 'blob:'],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      // Don't force http:// subresources to https:// — companion runs over
      // plain HTTP on the LAN by default.
      upgradeInsecureRequests: null
    }
  },
  crossOriginEmbedderPolicy: false,
  // HSTS makes no sense for plain-HTTP LAN deployment; opt-in via reverse proxy if needed.
  strictTransportSecurity: false
}));

const ALLOWED_CORS_ORIGINS = (process.env.COMPANION_CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    // Same-origin (no Origin header) and admin UI requests.
    if (!origin) return cb(null, true);
    if (ALLOWED_CORS_ORIGINS.length === 0) return cb(null, false);
    if (ALLOWED_CORS_ORIGINS.includes('*')) return cb(null, true);
    return cb(null, ALLOWED_CORS_ORIGINS.includes(origin));
  },
  credentials: true
}));
app.use(bodyParser.json({ limit: '5mb' }));
app.use(express.static('public'));

const storage = createStorage({
  rootDir: __dirname,
  defaultPreferences: DEFAULT_PREFERENCES
});

let appConfig = storage.getConfig();
let wss = null;
const analyticsSyncState = {
  running: false,
  lastRunAt: null,
  lastSuccessAt: null,
  lastError: null,
  accepted: 0,
  closed: 0,
  totalSessions: 0,
  polledServers: 0,
  polledUsers: 0,
  websocketConfigured: 0,
  websocketConnected: 0,
  websocketMessages: 0,
  websocketLastMessageAt: null
};
const jellyfinRealtimeSockets = new Map();
function envInt(name, defaultValue, min, max) {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return defaultValue;
  const clamped = Math.max(min, Math.min(max, Math.floor(raw)));
  return clamped;
}
const TV_PAIRING_DISCOVERY_TIMEOUT_MS = envInt('COMPANION_TV_DISCOVERY_TIMEOUT_MS', 1200, 200, 30_000);
const TV_PAIRING_POST_TIMEOUT_MS = envInt('COMPANION_TV_POST_TIMEOUT_MS', 5000, 500, 60_000);
const TV_PAIRING_DISCOVERY_CONCURRENCY = envInt('COMPANION_TV_DISCOVERY_CONCURRENCY', 24, 1, 128);
const NETWORK_SHARE_DISCOVERY_CONNECT_TIMEOUT_MS = envInt('COMPANION_SHARE_CONNECT_TIMEOUT_MS', 700, 100, 30_000);
const NETWORK_SHARE_DISCOVERY_CONCURRENCY = envInt('COMPANION_SHARE_DISCOVERY_CONCURRENCY', 48, 1, 128);
const NETWORK_SHARE_DISCOVERY_SMB_LIST_TIMEOUT_MS = envInt('COMPANION_SHARE_SMB_LIST_TIMEOUT_MS', 12000, 500, 120_000);

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

function buildJellyfinAuthHeaders(accessToken) {
  const token = String(accessToken || '').trim();
  return {
    'X-Emby-Token': token,
    'X-Emby-Authorization': `MediaBrowser Client="SpatialFin Companion", Device="Server", DeviceId="spatialfin-companion", Version="1.0.0", Token="${token}"`
  };
}

function ticksToMs(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.round(num / 10000);
}

function buildPlaybackEventType(session) {
  if (session.PlayState && session.PlayState.IsPaused) return 'pause';
  return 'progress';
}

function buildAnalyticsRequestContext(source) {
  return {
    ip: source || 'companion-internal',
    socket: { remoteAddress: source || 'companion-internal' },
    headers: { 'user-agent': source || 'companion-analytics-sync' }
  };
}

function formatSmbShareTestError(error) {
  const message = String(error && error.message ? error.message : error || 'Unknown SMB error');
  if (/STATUS_LOGON_FAILURE|STATUS_ACCESS_DENIED|invalid password/i.test(message)) {
    return 'Authentication failed. Check the SMB username and password.';
  }
  if (/STATUS_BAD_NETWORK_NAME|share name cannot be found|shared resource could not be found/i.test(message)) {
    return 'Share not found. Check the host and share name.';
  }
  if (/STATUS_OBJECT_PATH_NOT_FOUND|STATUS_OBJECT_NAME_NOT_FOUND|STATUS_NO_SUCH_FILE/i.test(message)) {
    return 'Path not found inside the SMB share.';
  }
  if (/STATUS_BAD_NETWORK_PATH|STATUS_HOST_UNREACHABLE|STATUS_NETWORK_NAME_DELETED|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENOTFOUND/i.test(message)) {
    return 'Unable to reach the SMB server.';
  }
  return message;
}

async function testSmbShareConnectionWithSmbClient(share) {
  const probePath = normalizeShareRelativePath(share.path);
  const args = [
    `//${share.host}/${share.shareName}`,
    '-U',
    `${share.username || ''}%${share.password || ''}`,
    '-g',
    '-c',
    'ls'
  ];

  if (share.domain) {
    args.push('-W', share.domain);
  }
  if (share.port && share.port !== 445) {
    args.push('-p', String(share.port));
  }
  if (probePath) {
    args.push('-D', probePath);
  }

  const { stdout } = await execFileAsync('smbclient', args, {
    timeout: 15000
  });
  const files = parseSmbClientListing(stdout);
  return {
    targetPath: probePath || '\\',
    fileCount: files.length,
    sample: files.slice(0, 5)
  };
}

function formatNfsShareTestError(error) {
  const message = String(error && error.message ? error.message : error || 'Unknown NFS error');
  if (/not advertised by the server/i.test(message)) {
    return 'Export path not found on the NFS server.';
  }
  if (/timed out|ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|ENETUNREACH/i.test(message)) {
    return 'Unable to reach the NFS server.';
  }
  return message;
}

function checkTcpPort(host, port, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });

    function cleanup() {
      socket.removeAllListeners('connect');
      socket.removeAllListeners('timeout');
      socket.removeAllListeners('error');
    }

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      cleanup();
      socket.end();
      resolve();
    });
    socket.once('timeout', () => {
      cleanup();
      socket.destroy();
      reject(new Error(`Connection to ${host}:${port} timed out.`));
    });
    socket.once('error', (error) => {
      cleanup();
      socket.destroy();
      reject(error);
    });
  });
}

function parseShowmountExports(stdout) {
  return String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^Export list for /i.test(line))
    .map((line) => normalizeNfsExportPath(line.split(/\s+/)[0], { allowRoot: true }))
    .filter(Boolean);
}

async function queryNfsExports(host) {
  try {
    const exports = await queryNfsExportsViaRpc(host, 12000);
    if (exports.length > 0) {
      return {
        exports: exports.map((entry) => normalizeNfsExportPath(entry.path, { allowRoot: true })).filter(Boolean),
        warning: null
      };
    }
  } catch (error) {
    const detail = extractCommandErrorOutput(error);
    if (/Mount daemon is not registered with portmapper/i.test(detail)) {
      return {
        exports: [],
        warning: 'Export discovery unavailable because this NFS server is reachable on port 2049 but does not expose mountd/rpcbind for export enumeration.'
      };
    }
  }

  try {
    const { stdout } = await execFileAsync('showmount', ['-e', host], {
      timeout: 12000
    });
    return {
      exports: parseShowmountExports(stdout),
      warning: null
    };
  } catch (error) {
    const fallbackExports = parseShowmountExports(error && error.stdout ? error.stdout : '');
    if (fallbackExports.length > 0) {
      return {
        exports: fallbackExports,
        warning: null
      };
    }

    if (error && error.code === 'ENOENT') {
      return {
        exports: [],
        warning: 'Export discovery unavailable because showmount is not installed.'
      };
    }

    const detail = extractCommandErrorOutput(error);
    if (/Program not registered|RPC: Program not registered|mount clntudp_create: RPC: Port mapper failure|clnt_create: RPC:/i.test(detail)) {
      return {
        exports: [],
        warning: 'Export discovery unavailable because this NFS server is reachable on port 2049 but does not expose mountd/rpcbind for export enumeration.'
      };
    }
    if (/timed out/i.test(detail)) {
      return {
        exports: [],
        warning: 'Export discovery timed out. Verified the NFS service port only.'
      };
    }
    return {
      exports: [],
      warning: detail || 'Export discovery unavailable. Verified the NFS service port only.'
    };
  }
}

function normalizeOptionalPort(value, fallbackPort) {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return fallbackPort;
  return port;
}

function extractCommandErrorOutput(error) {
  if (!error) return '';
  return [
    error.stderr,
    error.stdout,
    error.message
  ]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .join('\n')
    .trim();
}

async function runWithConcurrency(items, limit, worker) {
  const queue = Array.isArray(items) ? items : [];
  const concurrency = Math.max(1, Math.min(Number(limit) || 1, queue.length || 1));
  let index = 0;

  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (index < queue.length) {
      const currentIndex = index;
      index += 1;
      await worker(queue[currentIndex], currentIndex);
    }
  }));
}

async function resolveDiscoverySeedAddress(req) {
  const authorities = [
    req && req.headers ? req.headers['x-forwarded-host'] : '',
    req && req.headers ? req.headers.host : ''
  ];

  for (const authority of authorities) {
    const host = extractHostFromAuthority(authority);
    if (!host || host === 'localhost') continue;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
      if (isPrivateIpv4(host)) return host;
      continue;
    }

    try {
      const resolved = await dns.lookup(host, { family: 4 });
      if (resolved && resolved.address && isPrivateIpv4(resolved.address)) return resolved.address;
    } catch (_) {
      // Ignore DNS lookup failures and fall back to interface inspection.
    }
  }

  return '';
}

function formatSmbShareDiscoveryError(error, username) {
  const message = extractCommandErrorOutput(error) || String(error && error.message ? error.message : error || 'Unknown SMB error');
  if (error && error.code === 'ENOENT') {
    return 'SMB share browsing is unavailable because smbclient is not installed in the companion runtime.';
  }
  if (/SMB1 disabled -- no workgroup available/i.test(message)) {
    return 'The SMB server responded, but workgroup enumeration failed after listing shares. Try again; if this persists, enter SMB credentials and browse the server directly.';
  }
  if (/STATUS_LOGON_FAILURE|STATUS_ACCESS_DENIED|NT_STATUS_ACCESS_DENIED|NT_STATUS_LOGON_FAILURE|invalid password/i.test(message)) {
    return username
      ? 'Authentication failed. Check the SMB username and password.'
      : 'Anonymous SMB browsing was denied. Enter SMB credentials and try again.';
  }
  if (/STATUS_BAD_NETWORK_PATH|STATUS_HOST_UNREACHABLE|STATUS_NETWORK_NAME_DELETED|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENOTFOUND/i.test(message)) {
    return 'Unable to reach the SMB server.';
  }
  return message;
}

function formatNfsExportDiscoveryError(error) {
  const message = extractCommandErrorOutput(error) || String(error && error.message ? error.message : error || 'Unknown NFS error');
  if (/timed out|ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|ENETUNREACH/i.test(message)) {
    return 'Unable to reach the NFS server.';
  }
  return message;
}

async function listSmbServerShares(options) {
  const host = String(options && options.host ? options.host : '').trim();
  if (!host) throw new Error('SMB host is required.');

  const username = String(options && options.username ? options.username : '').trim();
  const password = typeof (options && options.password) === 'string' ? options.password : '';
  const domain = String(options && options.domain ? options.domain : '').trim();
  const port = normalizeOptionalPort(options && options.port, 445);
  const args = ['-g', '-L', `//${host}`];

  if (username) {
    args.push('-U', `${username}%${password}`);
  } else {
    args.push('-N');
  }
  if (domain) {
    args.push('-W', domain);
  }
  if (port !== 445) {
    args.push('-p', String(port));
  }

  try {
    const { stdout } = await execFileAsync('smbclient', args, {
      timeout: NETWORK_SHARE_DISCOVERY_SMB_LIST_TIMEOUT_MS
    });
    return parseSmbClientShareList(stdout);
  } catch (error) {
    const fallbackShares = parseSmbClientShareList(error && error.stdout ? error.stdout : '');
    if (fallbackShares.length > 0) {
      return fallbackShares;
    }
    throw error;
  }
}

async function discoverNetworkShareCandidates(req) {
  const seedAddress = await resolveDiscoverySeedAddress(req);
  const extraHosts = seedAddress ? [seedAddress] : [];
  const networkInterfaces = seedAddress ? {} : os.networkInterfaces();
  const targets = buildPrivateIpv4DiscoveryTargets(networkInterfaces, extraHosts);
  const scannedSubnets = describePrivateIpv4Subnets(networkInterfaces, extraHosts);

  if (targets.length === 0) {
    throw new Error('Could not determine a private LAN subnet. Open SpatialFin Companion from a private IP address or browse a host manually.');
  }

  const warnings = [];
  const warningSet = new Set();
  const results = [];

  await runWithConcurrency(targets, NETWORK_SHARE_DISCOVERY_CONCURRENCY, async (ip) => {
    const [smbReachable, nfsReachable] = await Promise.all([
      checkTcpPort(ip, 445, NETWORK_SHARE_DISCOVERY_CONNECT_TIMEOUT_MS).then(() => true).catch(() => false),
      checkTcpPort(ip, 2049, NETWORK_SHARE_DISCOVERY_CONNECT_TIMEOUT_MS).then(() => true).catch(() => false)
    ]);

    if (smbReachable) {
      results.push({
        protocol: 'smb',
        kind: 'server',
        host: ip,
        label: ip,
        description: 'SMB server'
      });
    }

    if (!nfsReachable) return;

    const exportInfo = await queryNfsExports(ip);
    if (Array.isArray(exportInfo.exports) && exportInfo.exports.length > 0) {
      exportInfo.exports.forEach((exportPath) => {
        results.push({
          protocol: 'nfs',
          kind: 'share',
          host: ip,
          shareName: exportPath,
          label: exportPath,
          description: 'NFS export'
        });
      });
      return;
    }

    results.push({
      protocol: 'nfs',
      kind: 'server',
      host: ip,
      label: ip,
      description: exportInfo.warning || 'NFS server'
    });

    if (exportInfo.warning) {
      const warningMessage = `${ip}: ${exportInfo.warning}`;
      if (!warningSet.has(warningMessage)) {
        warningSet.add(warningMessage);
        warnings.push(warningMessage);
      }
    }
  });

  return {
    results: sortAndDedupeDiscoveryResults(results),
    warnings,
    scannedSubnets
  };
}

async function testSmbShareConnectionViaProbe(share) {
  const probePath = normalizeShareRelativePath(share.path);
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--openssl-legacy-provider', path.join(__dirname, 'smb-probe.js')],
      {
        env: {
          ...process.env,
          SMB_TEST_OPTIONS: JSON.stringify({
            host: share.host,
            shareName: share.shareName,
            username: share.username,
            password: share.password,
            domain: share.domain,
            port: share.port || 445,
            path: probePath
          })
        },
        timeout: 15000
      }
    );

    const parsed = JSON.parse(String(stdout || '').trim() || '{}');
    if (!parsed.ok) {
      const error = new Error(parsed.message || 'Unknown SMB error');
      if (parsed.code) error.code = parsed.code;
      throw error;
    }
    return {
      targetPath: parsed.targetPath || '\\',
      fileCount: Number(parsed.fileCount) || 0,
      sample: Array.isArray(parsed.sample) ? parsed.sample : []
    };
  } catch (error) {
    const stdout = error && typeof error.stdout === 'string' ? error.stdout.trim() : '';
    if (stdout) {
      try {
        const parsed = JSON.parse(stdout);
        const wrapped = new Error(parsed.message || error.message || 'Unknown SMB error');
        if (parsed.code) wrapped.code = parsed.code;
        throw wrapped;
      } catch (parseError) {
        if (parseError && parseError.message !== 'Unexpected end of JSON input' && !(parseError instanceof SyntaxError)) {
          throw parseError;
        }
      }
    }
    throw error;
  }
}

async function testSmbShareConnection(share) {
  let smbclientError = null;
  try {
    return await testSmbShareConnectionWithSmbClient(share);
  } catch (error) {
    smbclientError = error;
  }

  // Fallback to the bundled probe on any smbclient failure (missing binary or
  // protocol/auth error). Rethrow the original smbclient error if the probe
  // also fails so users see the first error they'd actually debug against.
  try {
    return await testSmbShareConnectionViaProbe(share);
  } catch (probeError) {
    if (smbclientError && smbclientError.code !== 'ENOENT') throw smbclientError;
    throw probeError;
  }
}

async function testNfsShareConnection(share) {
  const port = share.port || 2049;
  const targetPath = buildNetworkShareTargetPath(share);
  const requestedExport = normalizeNfsExportPath(share.shareName, { allowRoot: true }) || '/';

  await checkTcpPort(share.host, port);
  const exportInfo = await queryNfsExports(share.host);
  if (exportInfo.exports.length > 0) {
    const matched = exportInfo.exports.some((exportPath) => isPathWithinExport(requestedExport, exportPath));
    if (!matched) {
      throw new Error('The requested export path is not advertised by the server.');
    }
  }

  return {
    targetPath,
    sample: exportInfo.exports.slice(0, 5),
    warning: exportInfo.warning,
    exportVerified: exportInfo.exports.length > 0
  };
}

function normalizeJellyfinSession(serverConfig, userConfig, session) {
  if (!session || typeof session !== 'object') return null;
  const item = session.NowPlayingItem || session.NowPlayingItemDto || null;
  if (!item || !item.Id) return null;

  const sessionId = session.Id || session.PlayState?.MediaSourceId || null;
  const userId = session.UserId || userConfig.id || null;
  const username = session.UserName || userConfig.username || userConfig.name || null;
  const deviceId = session.DeviceId || session.DeviceName || session.Client || 'jellyfin-session';
  const positionTicks = session.PlayState?.PositionTicks ?? null;
  const runtimeTicks = item.RunTimeTicks ?? null;
  const lastSeenAt = session.LastPlaybackCheckIn || session.LastActivityDate || new Date().toISOString();

  return {
    playbackSessionId: `${serverConfig.id}:${sessionId || item.Id}:${userId || username || 'unknown'}:${deviceId}`,
    sessionId,
    deviceId,
    serverId: serverConfig.id || null,
    serverName: serverConfig.name || null,
    userId,
    username,
    itemId: item.Id || null,
    itemName: item.Name || item.SeriesName || 'Unknown Item',
    itemType: item.Type || null,
    libraryId: item.ParentId || item.CollectionType || null,
    libraryName: item.ParentTitle || item.CollectionType || null,
    clientName: session.Client || null,
    playbackMethod: session.PlayState?.PlayMethod || session.PlayState?.PlaybackMethod || null,
    startedAt: session.NowPlayingItem?.UserData?.LastPlayedDate || session.LastPlaybackCheckIn || lastSeenAt,
    lastSeenAt,
    endedAt: null,
    playDurationMs: ticksToMs(positionTicks),
    positionTicks,
    runtimeTicks,
    completed: false,
    eventType: buildPlaybackEventType(session),
    eventAt: lastSeenAt,
    eventDetails: {
      isPaused: !!session.PlayState?.IsPaused,
      isMuted: !!session.PlayState?.IsMuted,
      repeatMode: session.PlayState?.RepeatMode || null,
      shuffle: !!session.PlayState?.Shuffle,
      deviceName: session.DeviceName || null
    }
  };
}

function normalizeJellyfinItemMetadata(serverConfig, item) {
  if (!serverConfig || !item || !item.Id) return null;
  const imageTags = item.ImageTags && typeof item.ImageTags === 'object' ? item.ImageTags : {};
  const backdropImageTags = Array.isArray(item.BackdropImageTags) ? item.BackdropImageTags : [];
  return {
    serverId: serverConfig.id || null,
    itemId: item.Id || null,
    itemName: item.Name || item.SeriesName || null,
    itemType: item.Type || null,
    seriesName: item.SeriesName || null,
    seasonName: item.SeasonName || null,
    productionYear: item.ProductionYear ?? null,
    premiereDate: item.PremiereDate || null,
    officialRating: item.OfficialRating || null,
    communityRating: item.CommunityRating ?? null,
    runtimeTicks: item.RunTimeTicks ?? null,
    primaryImageTag: imageTags.Primary || imageTags.Thumb || null,
    backdropImageTag: backdropImageTags[0] || imageTags.Backdrop || null,
    overview: item.Overview || null,
    genres: Array.isArray(item.Genres) ? item.Genres : [],
    imageBlurHash: item.ImageBlurHashes?.Primary?.[imageTags.Primary || imageTags.Thumb] || null,
    lastRefreshedAt: new Date().toISOString()
  };
}

function findConfigServerById(serverId) {
  appConfig = storage.getConfig();
  return (Array.isArray(appConfig.servers) ? appConfig.servers : []).find((server) => server && server.id === serverId) || null;
}

function findVerifiedUserForServer(serverId, preferredUserId, preferredUsername) {
  const server = findConfigServerById(serverId);
  if (!server || !Array.isArray(server.users)) return { server: null, user: null };
  const candidates = server.users.filter((user) => user && user.access_token);
  const exact = candidates.find((user) => (preferredUserId && user.id === preferredUserId) || (preferredUsername && (user.username === preferredUsername || user.name === preferredUsername)));
  return { server, user: exact || candidates[0] || null };
}

const JELLYFIN_METADATA_CACHE_TTL_MS = Math.max(
  60_000,
  Number(process.env.COMPANION_ITEM_METADATA_TTL_MS) || 30 * 60_000
);
// Shorter TTL for "this item does not exist / is inaccessible" entries so a
// later re-add or permission change isn't permanently hidden. Long enough to
// suppress the hot-loop of retries against deleted items observed in the
// analytics path (see enrichSessionsWithItemMetadata) — an uncached 404 spams
// a log line per session-event, pushes real work off the event loop, and was
// implicated in a WS-upgrade hang after long container runtimes.
const JELLYFIN_METADATA_NEGATIVE_TTL_MS = Math.max(
  30_000,
  Number(process.env.COMPANION_ITEM_METADATA_NEGATIVE_TTL_MS) || 5 * 60_000
);
const JELLYFIN_METADATA_CACHE_MAX = 2000;
const jellyfinItemMetadataCache = new Map(); // key -> { value, expiresAt, negative? }

function metadataCacheKey(serverId, itemId) {
  return `${serverId || 'server'}:${itemId}`;
}

/**
 * Returns `{ hit: true, value }` for a positive cache hit, `{ hit: true,
 * value: null, negative: true }` for a cached "known missing" entry, and
 * `{ hit: false }` for a miss. Keeping negative/positive/miss distinguishable
 * lets callers skip the Jellyfin round trip for known-missing items without
 * losing the ability to log the first failure.
 */
function getCachedItemMetadata(serverConfig, itemId) {
  const key = metadataCacheKey(serverConfig && serverConfig.id, itemId);
  const entry = jellyfinItemMetadataCache.get(key);
  if (!entry) return { hit: false };
  if (entry.expiresAt <= Date.now()) {
    jellyfinItemMetadataCache.delete(key);
    return { hit: false };
  }
  return { hit: true, value: entry.value, negative: entry.negative === true };
}

function setCachedItemMetadata(serverConfig, itemId, value) {
  if (!value) return;
  const key = metadataCacheKey(serverConfig && serverConfig.id, itemId);
  if (jellyfinItemMetadataCache.size >= JELLYFIN_METADATA_CACHE_MAX) {
    const firstKey = jellyfinItemMetadataCache.keys().next().value;
    if (firstKey) jellyfinItemMetadataCache.delete(firstKey);
  }
  jellyfinItemMetadataCache.set(key, {
    value,
    expiresAt: Date.now() + JELLYFIN_METADATA_CACHE_TTL_MS
  });
}

function setCachedItemMetadataNegative(serverConfig, itemId) {
  const key = metadataCacheKey(serverConfig && serverConfig.id, itemId);
  if (jellyfinItemMetadataCache.size >= JELLYFIN_METADATA_CACHE_MAX) {
    const firstKey = jellyfinItemMetadataCache.keys().next().value;
    if (firstKey) jellyfinItemMetadataCache.delete(firstKey);
  }
  jellyfinItemMetadataCache.set(key, {
    value: null,
    negative: true,
    expiresAt: Date.now() + JELLYFIN_METADATA_NEGATIVE_TTL_MS
  });
}

async function fetchJellyfinItemMetadata(serverConfig, userConfig, itemId) {
  const baseUrl = String((serverConfig.addresses && serverConfig.addresses[0]) || '').replace(/\/+$/, '');
  const token = userConfig && userConfig.access_token;
  if (!baseUrl || !token || !itemId) return null;
  const cached = getCachedItemMetadata(serverConfig, itemId);
  if (cached.hit) {
    // Known-missing entries short-circuit the round trip. Their TTL is shorter
    // than positive entries so a re-added item eventually re-fetches.
    return cached.value;
  }
  const encodedItemId = encodeURIComponent(itemId);
  const userId = userConfig.id ? encodeURIComponent(userConfig.id) : null;
  const itemPath = userId ? `/Users/${userId}/Items/${encodedItemId}` : `/Items/${encodedItemId}`;
  const query = 'Fields=Overview,PrimaryImageAspectRatio,PremiereDate,ProductionYear,CommunityRating,OfficialRating,Genres,RunTimeTicks,SeriesName,SeasonName,ImageTags,BackdropImageTags,ImageBlurHashes';
  const result = await httpGet(`${baseUrl}${itemPath}?${query}`, buildJellyfinAuthHeaders(token), 10000);
  if (result.status !== 200 || !result.data || typeof result.data !== 'object') {
    // Cache the miss so rapid analytics events don't re-hammer Jellyfin with
    // the same 404. 401/403/410 follow the same pattern — the item is either
    // gone or inaccessible, and retrying on every session event just floods
    // the log and wastes outbound requests.
    if ([404, 401, 403, 410].includes(result.status)) {
      setCachedItemMetadataNegative(serverConfig, itemId);
    }
    throw new Error(`Item fetch failed for ${serverConfig.name || baseUrl}: HTTP ${result.status}`);
  }
  const metadata = normalizeJellyfinItemMetadata(serverConfig, result.data);
  setCachedItemMetadata(serverConfig, itemId, metadata);
  return metadata;
}

async function enrichSessionsWithItemMetadata(serverConfig, userConfig, sessions) {
  const list = Array.isArray(sessions) ? sessions.filter((session) => session && session.itemId) : [];
  if (!list.length) return { accepted: 0 };
  const unique = new Map();
  list.forEach((session) => {
    const key = `${serverConfig.id || 'server'}:${session.itemId}`;
    if (!unique.has(key)) unique.set(key, session.itemId);
  });
  const entries = [];
  for (const itemId of unique.values()) {
    // Skip known-missing items entirely. fetchJellyfinItemMetadata would also
    // short-circuit via its own cache lookup, but checking here keeps the log
    // path quiet — otherwise every analytics sync prints one warn per dead
    // itemId until the negative TTL expires.
    if (getCachedItemMetadata(serverConfig, itemId).negative) continue;
    try {
      const metadata = await fetchJellyfinItemMetadata(serverConfig, userConfig, itemId);
      if (metadata) entries.push(metadata);
    } catch (error) {
      console.warn('Metadata enrichment failed:', serverConfig.name || serverConfig.id, itemId, error.message);
    }
  }
  return entries.length ? storage.upsertMediaItemMetadata(entries) : { accepted: 0 };
}

async function fetchJellyfinSessions(serverConfig, userConfig) {
  const baseUrl = String((serverConfig.addresses && serverConfig.addresses[0]) || '').replace(/\/+$/, '');
  const token = userConfig && userConfig.access_token;
  if (!baseUrl || !token) return [];

  const result = await httpGet(`${baseUrl}/Sessions`, buildJellyfinAuthHeaders(token), 10000);
  if (result.status !== 200 || !Array.isArray(result.data)) {
    throw new Error(`Session fetch failed for ${serverConfig.name || baseUrl}: HTTP ${result.status}`);
  }

  return result.data
    .map((session) => normalizeJellyfinSession(serverConfig, userConfig, session))
    .filter(Boolean);
}

function buildJellyfinSocketKey(serverConfig, userConfig) {
  return `${serverConfig.id || serverConfig.name || 'server'}:${userConfig.id || userConfig.username || userConfig.name || 'user'}`;
}

function buildJellyfinSocketUrl(serverConfig, userConfig) {
  const baseUrl = String((serverConfig.addresses && serverConfig.addresses[0]) || '').replace(/\/+$/, '');
  const token = String(userConfig && userConfig.access_token || '').trim();
  if (!baseUrl || !token) return null;
  const wsBase = baseUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  return `${wsBase}/socket?api_key=${encodeURIComponent(token)}&deviceId=spatialfin-companion`;
}

function broadcastAdminEvent(message) {
  if (!wss) return;
  const encoded = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(encoded);
  });
}

function refreshRealtimeSocketSummary() {
  const entries = Array.from(jellyfinRealtimeSockets.values());
  analyticsSyncState.websocketConfigured = entries.length;
  analyticsSyncState.websocketConnected = entries.filter((entry) => entry.connected).length;
  analyticsSyncState.websocketMessages = entries.reduce((total, entry) => total + (entry.messageCount || 0), 0);
  analyticsSyncState.websocketLastMessageAt = entries.reduce((latest, entry) => {
    if (!entry.lastMessageAt) return latest;
    if (!latest) return entry.lastMessageAt;
    return Date.parse(entry.lastMessageAt) > Date.parse(latest) ? entry.lastMessageAt : latest;
  }, null);
}

function getRealtimeSocketStatus() {
  return Array.from(jellyfinRealtimeSockets.values())
    .map((entry) => ({
      key: entry.key,
      serverId: entry.serverConfig.id || null,
      serverName: entry.serverConfig.name || null,
      username: entry.userConfig.username || entry.userConfig.name || null,
      connected: !!entry.connected,
      state: entry.connected ? 'connected' : (entry.reconnectTimer ? 'reconnecting' : 'disconnected'),
      reconnectAttempt: entry.reconnectAttempt || 0,
      nextReconnectAt: entry.nextReconnectAt || null,
      messageCount: entry.messageCount || 0,
      lastMessageAt: entry.lastMessageAt || null,
      lastError: entry.lastError || null,
      url: entry.url || null
    }))
    .sort((left, right) => {
      const connectedDelta = Number(right.connected) - Number(left.connected);
      if (connectedDelta !== 0) return connectedDelta;
      return String(left.serverName || left.serverId || left.key).localeCompare(String(right.serverName || right.serverId || right.key));
    });
}

function scheduleSocketScopeRefresh(entry, reason) {
  if (!entry) return;
  if (entry.refreshTimer) clearTimeout(entry.refreshTimer);
  entry.refreshTimer = setTimeout(async () => {
    entry.refreshTimer = null;
    try {
      const sessions = await fetchJellyfinSessions(entry.serverConfig, entry.userConfig);
      const activePlaybackSessionIds = sessions.map((session) => session.playbackSessionId);
      let result = { accepted: 0, totalSessions: storage.getAnalyticsOverview().totalSessions };
      await enrichSessionsWithItemMetadata(entry.serverConfig, entry.userConfig, sessions);
      if (sessions.length > 0) {
        result = storage.upsertPlaybackSessions({ sessions }, buildAnalyticsRequestContext('companion-analytics-websocket'));
      }
      const closedResult = storage.closeMissingPlaybackSessions({
        serverId: entry.serverConfig.id || null,
        userId: entry.userConfig.id || null,
        username: entry.userConfig.username || entry.userConfig.name || null,
        activePlaybackSessionIds,
        endedAt: new Date().toISOString()
      });
      analyticsSyncState.accepted = result.accepted || 0;
      analyticsSyncState.closed = closedResult.closed || 0;
      analyticsSyncState.totalSessions = result.totalSessions || analyticsSyncState.totalSessions || 0;
      analyticsSyncState.lastSuccessAt = new Date().toISOString();
      broadcastAdminEvent({
        type: 'analytics_sync_completed',
        accepted: analyticsSyncState.accepted,
        closed: analyticsSyncState.closed,
        totalSessions: analyticsSyncState.totalSessions,
        polledServers: analyticsSyncState.polledServers,
        polledUsers: analyticsSyncState.polledUsers
      });
      storage.recordEvent('analytics_websocket_refresh', null, {
        reason,
        serverId: entry.serverConfig.id || null,
        username: entry.userConfig.username || entry.userConfig.name || null,
        accepted: analyticsSyncState.accepted,
        closed: analyticsSyncState.closed
      });
    } catch (error) {
      console.warn('Analytics websocket refresh failed:', entry.serverConfig.name || entry.serverConfig.id, entry.userConfig.username || entry.userConfig.name, error.message);
    }
  }, 800);
}

function looksLikePlaybackMessage(messageType) {
  const normalized = String(messageType || '').toLowerCase();
  return normalized.includes('session')
    || normalized.includes('play')
    || normalized.includes('progress')
    || normalized.includes('pause')
    || normalized.includes('stop');
}

function extractRealtimeSessionsFromMessage(serverConfig, userConfig, payload) {
  const sources = [];
  if (Array.isArray(payload)) sources.push(payload);
  if (Array.isArray(payload?.Data)) sources.push(payload.Data);
  if (Array.isArray(payload?.data)) sources.push(payload.data);
  if (Array.isArray(payload?.MessageData)) sources.push(payload.MessageData);
  if (payload?.Data && typeof payload.Data === 'object' && Array.isArray(payload.Data.Items)) sources.push(payload.Data.Items);
  if (payload?.data && typeof payload.data === 'object' && Array.isArray(payload.data.Items)) sources.push(payload.data.Items);

  if (payload?.Data && typeof payload.Data === 'object' && (payload.Data.NowPlayingItem || payload.Data.NowPlayingItemDto)) {
    sources.push([payload.Data]);
  }
  if (payload?.data && typeof payload.data === 'object' && (payload.data.NowPlayingItem || payload.data.NowPlayingItemDto)) {
    sources.push([payload.data]);
  }

  const normalized = [];
  sources.forEach((items) => {
    items.forEach((item) => {
      const session = normalizeJellyfinSession(serverConfig, userConfig, item);
      if (session) normalized.push(session);
    });
  });
  return normalized;
}

function subscribeToJellyfinSocket(entry) {
  if (!entry || !entry.socket || entry.socket.readyState !== WebSocket.OPEN) return;
  try {
    entry.socket.send(JSON.stringify({ MessageType: 'SessionsStart', Data: '0,1500' }));
  } catch (_) {}
}

function connectJellyfinRealtimeSocket(serverConfig, userConfig) {
  const url = buildJellyfinSocketUrl(serverConfig, userConfig);
  const key = buildJellyfinSocketKey(serverConfig, userConfig);
  if (!url) return;

  const existing = jellyfinRealtimeSockets.get(key);
  if (existing && existing.url === url) return;
  if (existing) {
    existing.aborted = true;
    existing.closedManually = true;
    if (existing.refreshTimer) clearTimeout(existing.refreshTimer);
    if (existing.reconnectTimer) clearTimeout(existing.reconnectTimer);
    try { existing.socket && existing.socket.close(); } catch (_) {}
  }

  const entry = {
    key,
    url,
    serverConfig,
    userConfig,
    socket: null,
    connected: false,
    reconnectAttempt: 0,
    reconnectTimer: null,
    refreshTimer: null,
    closedManually: false,
    aborted: false,
    disabled: false,
    messageCount: 0,
    lastMessageAt: null
  };
  jellyfinRealtimeSockets.set(key, entry);
  refreshRealtimeSocketSummary();

  const open = () => {
    if (entry.aborted || entry.disabled) return;
    if (jellyfinRealtimeSockets.get(key) !== entry) {
      entry.aborted = true;
      return;
    }
    const socket = new WebSocket(url, {
      headers: buildJellyfinAuthHeaders(userConfig.access_token)
    });
    entry.socket = socket;

    socket.on('open', () => {
      entry.connected = true;
      entry.reconnectAttempt = 0;
      entry.nextReconnectAt = null;
      entry.lastError = null;
      refreshRealtimeSocketSummary();
      subscribeToJellyfinSocket(entry);
      scheduleSocketScopeRefresh(entry, 'websocket-open');
    });

    socket.on('message', async (raw) => {
      entry.connected = true;
      entry.messageCount += 1;
      entry.lastMessageAt = new Date().toISOString();
      refreshRealtimeSocketSummary();

      let payload;
      try {
        payload = JSON.parse(raw.toString());
      } catch (_) {
        return;
      }

      const messageType = payload.MessageType || payload.messageType || payload.Type || payload.type || '';
      const sessions = extractRealtimeSessionsFromMessage(serverConfig, userConfig, payload);
      if (sessions.length > 0) {
        try {
          await enrichSessionsWithItemMetadata(serverConfig, userConfig, sessions);
        } catch (error) {
          console.warn('Realtime metadata enrichment failed:', serverConfig.name || serverConfig.id, error.message);
        }
        try {
          const result = storage.upsertPlaybackSessions({ sessions }, buildAnalyticsRequestContext('companion-analytics-websocket'));
          analyticsSyncState.accepted = result.accepted || 0;
          analyticsSyncState.totalSessions = result.totalSessions || analyticsSyncState.totalSessions || 0;
          analyticsSyncState.lastSuccessAt = new Date().toISOString();
          broadcastAdminEvent({
            type: 'analytics_sessions_ingested',
            accepted: result.accepted || 0,
            totalSessions: analyticsSyncState.totalSessions
          });
        } catch (error) {
          analyticsSyncState.lastError = error.message;
          console.warn('Realtime session upsert failed:', serverConfig.name || serverConfig.id, error.message);
        }
      }

      if (looksLikePlaybackMessage(messageType)) {
        scheduleSocketScopeRefresh(entry, `websocket:${messageType || 'message'}`);
      }
    });

    socket.on('unexpected-response', (_req, response) => {
      const status = response && response.statusCode;
      if (status === 401 || status === 403) {
        entry.disabled = true;
        entry.lastError = `WebSocket auth failed (HTTP ${status})`;
        console.warn('Disabling Jellyfin realtime socket:', serverConfig.name || serverConfig.id, entry.lastError);
        refreshRealtimeSocketSummary();
      }
      try { response && response.destroy && response.destroy(); } catch (_) {}
    });

    socket.on('close', () => {
      entry.connected = false;
      entry.socket = null;
      refreshRealtimeSocketSummary();
      if (entry.closedManually || entry.aborted || entry.disabled) return;
      if (jellyfinRealtimeSockets.get(key) !== entry) return;
      const retryDelay = Math.min(60_000, 2000 * Math.max(1, ++entry.reconnectAttempt));
      entry.nextReconnectAt = new Date(Date.now() + retryDelay).toISOString();
      entry.reconnectTimer = setTimeout(() => {
        entry.reconnectTimer = null;
        if (entry.aborted || entry.disabled) return;
        if (jellyfinRealtimeSockets.get(key) !== entry) return;
        open();
      }, retryDelay);
    });

    socket.on('error', (error) => {
      entry.connected = false;
      entry.lastError = error.message;
      analyticsSyncState.lastError = error.message;
      refreshRealtimeSocketSummary();
    });
  };

  open();
}

let reconcileInFlight = false;
let reconcilePending = false;
function reconcileJellyfinRealtimeSockets() {
  if (reconcileInFlight) {
    reconcilePending = true;
    return;
  }
  reconcileInFlight = true;
  try {
    appConfig = storage.getConfig();
    const desiredKeys = new Set();
    const servers = Array.isArray(appConfig.servers) ? appConfig.servers : [];
    servers.forEach((server) => {
      const users = Array.isArray(server.users) ? server.users.filter((user) => user && user.access_token) : [];
      users.forEach((user) => {
        const key = buildJellyfinSocketKey(server, user);
        desiredKeys.add(key);
        connectJellyfinRealtimeSocket(server, user);
      });
    });

    Array.from(jellyfinRealtimeSockets.entries()).forEach(([key, entry]) => {
      if (desiredKeys.has(key)) return;
      entry.aborted = true;
      entry.closedManually = true;
      if (entry.refreshTimer) clearTimeout(entry.refreshTimer);
      if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
      try { entry.socket && entry.socket.close(); } catch (_) {}
      jellyfinRealtimeSockets.delete(key);
    });
    refreshRealtimeSocketSummary();
  } finally {
    reconcileInFlight = false;
    if (reconcilePending) {
      reconcilePending = false;
      setImmediate(reconcileJellyfinRealtimeSockets);
    }
  }
}

async function runAnalyticsSync(reason) {
  if (analyticsSyncState.running) {
    return { skipped: true, reason: 'already-running', state: analyticsSyncState };
  }

  analyticsSyncState.running = true;
  analyticsSyncState.lastRunAt = new Date().toISOString();
  analyticsSyncState.lastError = null;

  let polledServers = 0;
  let polledUsers = 0;
  let closedSessions = 0;
  const collectedSessions = [];

  try {
    appConfig = storage.getConfig();
    const servers = Array.isArray(appConfig.servers) ? appConfig.servers : [];
    for (const server of servers) {
      const users = Array.isArray(server.users) ? server.users.filter((user) => user && user.access_token) : [];
      if (!users.length) continue;
      polledServers += 1;
      for (const user of users) {
        polledUsers += 1;
        try {
          const sessions = await fetchJellyfinSessions(server, user);
          collectedSessions.push(...sessions);
          await enrichSessionsWithItemMetadata(server, user, sessions);
          const activePlaybackSessionIds = sessions.map((session) => session.playbackSessionId);
          const closedResult = storage.closeMissingPlaybackSessions({
            serverId: server.id || null,
            userId: user.id || null,
            username: user.username || user.name || null,
            activePlaybackSessionIds,
            endedAt: new Date().toISOString()
          });
          closedSessions += closedResult.closed || 0;
        } catch (error) {
          console.warn('Analytics sync user poll failed:', server.name || server.id, user.username || user.name, error.message);
        }
      }
    }

    let result = { accepted: 0, totalSessions: storage.getAnalyticsOverview().totalSessions };
    if (collectedSessions.length > 0) {
      result = storage.upsertPlaybackSessions({ sessions: collectedSessions }, buildAnalyticsRequestContext('companion-analytics-sync'));
    }

    analyticsSyncState.lastSuccessAt = new Date().toISOString();
    analyticsSyncState.accepted = result.accepted || 0;
    analyticsSyncState.closed = closedSessions;
    analyticsSyncState.totalSessions = result.totalSessions || analyticsSyncState.totalSessions || 0;
    analyticsSyncState.polledServers = polledServers;
    analyticsSyncState.polledUsers = polledUsers;

    storage.recordEvent('analytics_sync_completed', null, {
      reason,
      accepted: analyticsSyncState.accepted,
      closed: analyticsSyncState.closed,
      polledServers,
      polledUsers
    });

    broadcastAdminEvent({
      type: 'analytics_sync_completed',
      accepted: analyticsSyncState.accepted,
      closed: analyticsSyncState.closed,
      totalSessions: analyticsSyncState.totalSessions,
      polledServers,
      polledUsers
    });

    return { skipped: false, state: analyticsSyncState };
  } catch (error) {
    analyticsSyncState.lastError = error.message;
    storage.recordEvent('analytics_sync_failed', null, {
      reason,
      error: error.message
    });
    return { skipped: false, state: analyticsSyncState, error };
  } finally {
    analyticsSyncState.running = false;
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

function buildCompanionBaseUrl(req, requestedUrl) {
  const raw = String(requestedUrl || '').trim();
  const protoHeader = req.headers['x-forwarded-proto'];
  const fallbackProtocol = typeof protoHeader === 'string' && protoHeader
    ? protoHeader.split(',')[0].trim()
    : (req.protocol || 'http');
  const fallbackUrl = `${fallbackProtocol}://${req.get('host')}`;
  const candidate = raw || fallbackUrl;
  const parsed = new URL(candidate);
  if (!/^https?:$/i.test(parsed.protocol)) {
    throw new Error('Companion URL must use HTTP or HTTPS');
  }
  return parsed.toString().replace(/\/+$/, '');
}

async function mapWithConcurrency(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  const size = Math.max(1, Math.min(concurrency || 1, list.length || 1));
  const results = new Array(list.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= list.length) return;
      results[index] = await worker(list[index], index);
    }
  }

  await Promise.all(Array.from({ length: size }, runWorker));
  return results;
}

/**
 * Map concurrently and stop firing NEW workers once `done(result)` returns true
 * for any completed worker. In-flight workers still finish (so we don't leak
 * AbortControllers), but we cap the total time closer to the first-match
 * latency instead of the worst-case full sweep.
 */
async function mapWithConcurrencyUntil(items, concurrency, worker, done) {
  const list = Array.isArray(items) ? items : [];
  const size = Math.max(1, Math.min(concurrency || 1, list.length || 1));
  const results = new Array(list.length);
  let nextIndex = 0;
  let stop = false;

  async function runWorker() {
    while (!stop) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= list.length) return;
      const result = await worker(list[index], index);
      results[index] = result;
      if (done && done(result)) stop = true;
    }
  }

  await Promise.all(Array.from({ length: size }, runWorker));
  return results;
}

async function resolveTvDiscoveryPlan(req) {
  const seedAddress = await resolveDiscoverySeedAddress(req);
  const extraHosts = seedAddress ? [seedAddress] : [];
  // Always include os.networkInterfaces() alongside the request-derived seed.
  // If the request comes in via a reverse-proxy, WireGuard tunnel, or Docker
  // bridge, the seed can land on a subnet that doesn't actually contain the
  // TV. Merging host interfaces guarantees we still sweep every LAN the
  // companion is on — dedup happens inside buildPrivateIpv4DiscoveryTargets.
  const networkInterfaces = os.networkInterfaces();
  const ips = buildPrivateIpv4DiscoveryTargets(networkInterfaces, extraHosts);

  return {
    targets: ips,
    scannedSubnets: describePrivateIpv4Subnets(networkInterfaces, extraHosts)
  };
}

async function fetchTvPairingCandidate(ip, receiverUrlOverride) {
  try {
    const receiverUrl = receiverUrlOverride || buildTvReceiverUrl(ip);
    const infoUrl = receiverUrlOverride ? normalizeTvReceiverInput(receiverUrlOverride).infoUrl : buildTvInfoUrl(ip);
    const result = await httpGet(infoUrl, {}, TV_PAIRING_DISCOVERY_TIMEOUT_MS);
    if (result.status !== 200 || !result.data || typeof result.data !== 'object') {
      return null;
    }
    const validated = validateTvPairingInfo(result.data);
    if (!validated.ok && !validated.issues.every((issue) => /expired/i.test(issue))) {
      return null;
    }
    return {
      ip,
      receiver_url: receiverUrl,
      version: validated.info.version,
      manual_code: validated.info.manual_code,
      device_name: validated.info.device_name || `TV ${ip}`,
      expires_at_epoch_ms: validated.info.expires_at_epoch_ms,
      pairing_token: validated.info.pairing_token || ''
    };
  } catch (_) {
    return null;
  }
}

async function discoverTvCandidates(req, manualCode) {
  const normalizedCode = normalizeManualCode(manualCode);
  if (!normalizedCode || normalizedCode.length !== 6) {
    return { error: 'invalid_code', message: 'Enter the 6-character TV code.', candidates: [] };
  }

  const discoveryPlan = await resolveTvDiscoveryPlan(req);
  if (!discoveryPlan.targets.length) {
    return { error: 'local_network_unavailable', message: 'No private local network was found on the companion host.', candidates: [] };
  }

  console.info('TV pairing discovery started:', {
    targetCount: discoveryPlan.targets.length,
    codePrefix: normalizedCode.slice(0, 3),
    scannedSubnets: discoveryPlan.scannedSubnets
  });
  // Stop firing new sweep requests as soon as any responder's manual_code
  // matches — no point scanning the other 200+ IPs once we've found the TV.
  const scanned = await mapWithConcurrencyUntil(
    discoveryPlan.targets,
    TV_PAIRING_DISCOVERY_CONCURRENCY,
    fetchTvPairingCandidate,
    (result) => result && result.manual_code === normalizedCode
  );
  const candidates = scanned.filter(Boolean).filter((entry) => entry.manual_code === normalizedCode);
  const now = Date.now();
  const activeCandidates = candidates.filter((entry) => Number(entry.expires_at_epoch_ms) > now);

  console.info('TV pairing discovery completed:', {
    targetCount: discoveryPlan.targets.length,
    respondingCount: scanned.filter(Boolean).length,
    matchedCount: candidates.length,
    activeCount: activeCandidates.length,
    scannedSubnets: discoveryPlan.scannedSubnets
  });

  if (activeCandidates.length > 0) {
    return { candidates: activeCandidates, scannedCount: discoveryPlan.targets.length };
  }
  if (candidates.length > 0) {
    return {
      error: 'expired_code',
      message: 'That TV code has expired. Start pairing again on the TV and try once more.',
      candidates,
      scannedCount: discoveryPlan.targets.length
    };
  }
  return {
    error: 'code_not_found',
    message: 'No TV on the local network matched that code.',
    candidates: [],
    scannedCount: discoveryPlan.targets.length
  };
}

async function lookupTvCandidateByReceiverUrl(receiverInput, manualCode) {
  const normalizedCode = normalizeManualCode(manualCode);
  if (!normalizedCode || normalizedCode.length !== 6) {
    return {
      error: 'invalid_code',
      message: 'Enter the 6-character TV code.'
    };
  }

  const receiver = normalizeTvReceiverInput(receiverInput);
  if (!receiver.ok) {
    return {
      error: 'invalid_receiver_url',
      message: receiver.issues[0] || 'Enter the TV receiver URL shown on the TV.'
    };
  }

  let candidate;
  try {
    candidate = await fetchTvPairingCandidate(receiver.host || 'TV', receiver.receiverUrl);
  } catch (_) {
    candidate = null;
  }

  if (!candidate) {
    return {
      error: 'tv_unreachable',
      message: 'The TV could not be reached at that receiver URL.'
    };
  }
  if (candidate.manual_code !== normalizedCode) {
    return {
      error: 'code_not_found',
      message: 'That TV URL responded, but the 6-character code did not match.'
    };
  }
  if (Number(candidate.expires_at_epoch_ms) <= Date.now()) {
    return {
      error: 'expired_code',
      message: 'That TV code has expired. Start pairing again on the TV and try once more.',
      candidate
    };
  }
  return {
    candidate
  };
}

function buildTvPairingError(result, usedManualCodeFallback) {
  const errorCode = result && result.data && typeof result.data === 'object' ? result.data.error : null;
  if (result && result.status === 401 && errorCode === 'invalid_pairing_token') {
    if (usedManualCodeFallback) {
      return {
        error: 'invalid_pairing_token',
        message: 'The TV rejected the 6-character pairing code. Refresh the code on the TV and try again.'
      };
    }
    return {
      error: 'invalid_pairing_token',
      message: 'The TV rejected the pairing token.'
    };
  }
  if (result && result.status >= 500) {
    return {
      error: 'config_push_failed',
      message: 'The TV could not apply the companion config.'
    };
  }
  return {
    error: 'config_push_failed',
    message: `Pairing failed with HTTP ${result ? result.status : 'unknown'}.`
  };
}

async function postTvPairingEnvelope({ payload, companionUrl, pairingTokenOverride }) {
  appConfig = storage.getConfig();
  const envelope = buildTvPairingEnvelope(appConfig, companionUrl);
  const token = String(pairingTokenOverride || payload.pairing_token || '').trim();
  let result;
  try {
    result = await httpPost(payload.receiver_url, envelope, {
      'X-Pairing-Token': token
    }, TV_PAIRING_POST_TIMEOUT_MS);
  } catch (error) {
    throw {
      error: 'tv_unreachable',
      message: error && error.name === 'AbortError'
        ? 'The TV did not respond in time.'
        : 'The TV could not be reached on the local network.'
    };
  }

  if (result.status < 200 || result.status >= 300) {
    throw buildTvPairingError(result, !!pairingTokenOverride && pairingTokenOverride === payload.manual_code);
  }

  console.info('TV pairing config pushed:', {
    deviceName: payload.device_name || 'Unknown TV',
    receiverUrl: payload.receiver_url,
    expiresAt: payload.expires_at_epoch_ms
  });

  return {
    status: result.status,
    data: result.data
  };
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
const ADMIN_SESSION_TTL_MS = Math.max(
  5 * 60_000,
  Number(process.env.COMPANION_SESSION_TTL_MS) || 12 * 60 * 60 * 1000
);
const ADMIN_SESSION_REMEMBER_TTL_MS = Math.max(
  ADMIN_SESSION_TTL_MS,
  Number(process.env.COMPANION_SESSION_REMEMBER_TTL_MS) || 30 * 24 * 60 * 60 * 1000
);
const ADMIN_COOKIE_SECURE = process.env.COMPANION_COOKIE_SECURE === '1'
  || process.env.COMPANION_COOKIE_SECURE === 'true';

function buildSessionCookie(token, maxAgeMs) {
  const parts = [`session=${token}`, 'HttpOnly', 'Path=/', 'SameSite=Strict'];
  if (ADMIN_COOKIE_SECURE) parts.push('Secure');
  if (Number.isFinite(maxAgeMs) && maxAgeMs > 0) {
    parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  }
  return parts.join('; ');
}

function buildLogoutCookie() {
  const parts = ['session=', 'HttpOnly', 'Path=/', 'SameSite=Strict', 'Max-Age=0'];
  if (ADMIN_COOKIE_SECURE) parts.push('Secure');
  return parts.join('; ');
}

function adminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) return next();
  // Exempt login + auth-check + logout (logout should never 401)
  if (req.path === '/login' || req.path === '/auth-check' || req.path === '/logout') return next();
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
  const { password, remember } = req.body || {};
  if (!ADMIN_PASSWORD) {
    return res.json({ authenticated: true });
  }
  const provided = typeof password === 'string' ? password : '';
  const expected = ADMIN_PASSWORD;
  const providedBuf = Buffer.from(provided, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const match = providedBuf.length === expectedBuf.length
    && crypto.timingSafeEqual(providedBuf, expectedBuf);
  if (!match) {
    storage.recordEvent('admin-login-failed', req, { ip: req.ip });
    return res.status(401).json({ error: 'Invalid password' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  const ttl = remember ? ADMIN_SESSION_REMEMBER_TTL_MS : ADMIN_SESSION_TTL_MS;
  storage.createAdminSession(token, ttl);
  storage.recordEvent('admin-login-success', req, { remember: !!remember });
  res.setHeader('Set-Cookie', buildSessionCookie(token, ttl));
  res.json({ authenticated: true, expiresInMs: ttl });
});

adminRouter.post('/logout', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies['session'];
  if (token) storage.deleteAdminSession(token);
  res.setHeader('Set-Cookie', buildLogoutCookie());
  res.json({ ok: true });
});

adminRouter.get('/auth-check', (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res.json({ authenticated: true, authRequired: false });
  }
  const cookies = parseCookies(req);
  const token = cookies['session'];
  res.json({
    authenticated: !!(token && storage.validateAdminSession(token)),
    authRequired: true
  });
});

// ---------------------------------------------------------------------------
// Existing admin routes
// ---------------------------------------------------------------------------
adminRouter.get('/config', (req, res) => res.json(appConfig));

function validateConfigPatch(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: ['Request body must be a JSON object.'] };
  }
  const { globalPreferences, devicePreferences, servers, networkShares } = body;
  if (globalPreferences !== undefined && (
    typeof globalPreferences !== 'object' || Array.isArray(globalPreferences) || globalPreferences === null
  )) {
    errors.push('globalPreferences must be an object.');
  }
  if (devicePreferences !== undefined) {
    if (typeof devicePreferences !== 'object' || Array.isArray(devicePreferences) || devicePreferences === null) {
      errors.push('devicePreferences must be an object keyed by deviceId.');
    } else {
      for (const [deviceId, overrides] of Object.entries(devicePreferences)) {
        if (!deviceId || typeof deviceId !== 'string') {
          errors.push('devicePreferences keys must be non-empty device IDs.');
          continue;
        }
        if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
          errors.push(`devicePreferences["${deviceId}"] must be an object.`);
        }
      }
    }
  }
  if (servers !== undefined && !Array.isArray(servers)) {
    errors.push('servers must be an array.');
  } else if (Array.isArray(servers)) {
    servers.forEach((server, idx) => {
      if (!server || typeof server !== 'object' || Array.isArray(server)) {
        errors.push(`servers[${idx}] must be an object.`);
        return;
      }
      if (server.users !== undefined && !Array.isArray(server.users)) {
        errors.push(`servers[${idx}].users must be an array.`);
      } else if (Array.isArray(server.users)) {
        server.users.forEach((user, uIdx) => {
          if (!user || typeof user !== 'object' || Array.isArray(user)) return;
          if (user.musicAssistant !== undefined && user.musicAssistant !== null) {
            const ma = user.musicAssistant;
            if (typeof ma !== 'object' || Array.isArray(ma) || typeof ma.url !== 'string') {
              errors.push(`servers[${idx}].users[${uIdx}].musicAssistant must be an object with a string url.`);
            }
          }
          if (user.plugins !== undefined && user.plugins !== null) {
            if (!Array.isArray(user.plugins) || user.plugins.some((p) => typeof p !== 'string')) {
              errors.push(`servers[${idx}].users[${uIdx}].plugins must be an array of manifest URL strings.`);
            }
          }
        });
      }
      if (server.addresses !== undefined && !Array.isArray(server.addresses)) {
        errors.push(`servers[${idx}].addresses must be an array.`);
      }
    });
  }
  if (networkShares !== undefined && !Array.isArray(networkShares)) {
    errors.push('networkShares must be an array.');
  } else if (Array.isArray(networkShares)) {
    networkShares.forEach((share, idx) => {
      if (!share || typeof share !== 'object' || Array.isArray(share)) {
        errors.push(`networkShares[${idx}] must be an object.`);
      }
    });
  }
  return { errors };
}

adminRouter.post('/config', (req, res) => {
  const { errors } = validateConfigPatch(req.body);
  if (errors.length) {
    return res.status(400).json({ error: 'Invalid configuration payload', details: errors });
  }
  const { globalPreferences, devicePreferences, servers, networkShares } = req.body;
  if (globalPreferences) appConfig.globalPreferences = globalPreferences;
  if (devicePreferences) appConfig.devicePreferences = devicePreferences;
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
  reconcileJellyfinRealtimeSockets();
  broadcastConfigChanged();
  res.json({ status: 'ok' });
});

// Dedicated endpoints for per-device preference overrides. Having them
// separate from the big config endpoint lets the admin UI update a single
// device without round-tripping the whole payload, and lets us target the
// change broadcast precisely.
adminRouter.put('/device-preferences/:deviceId', (req, res) => {
  const deviceId = String(req.params.deviceId || '').trim();
  if (!deviceId) return res.status(400).json({ error: 'Missing deviceId' });
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Body must be an object of preference key/value pairs' });
  }
  const current = appConfig.devicePreferences || {};
  const existing = (current[deviceId] && typeof current[deviceId] === 'object') ? current[deviceId] : {};
  // Merge: keys explicitly set to null clear the override; others overwrite.
  const next = { ...existing };
  for (const [k, v] of Object.entries(body)) {
    if (typeof k !== 'string' || k.length === 0) continue;
    if (v === null || v === undefined) {
      delete next[k];
    } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      next[k] = String(v);
    }
  }
  const nextDevicePrefs = { ...current };
  if (Object.keys(next).length === 0) delete nextDevicePrefs[deviceId];
  else nextDevicePrefs[deviceId] = next;
  appConfig.devicePreferences = nextDevicePrefs;
  appConfig = storage.saveConfig(appConfig, {
    reason: 'device-preferences-update',
    eventType: 'device_preferences_updated',
    req,
    details: { deviceId, keys: Object.keys(next) }
  });
  broadcastConfigChanged(deviceId);
  res.json({ status: 'ok', deviceId, overrides: next });
});

adminRouter.delete('/device-preferences/:deviceId', (req, res) => {
  const deviceId = String(req.params.deviceId || '').trim();
  if (!deviceId) return res.status(400).json({ error: 'Missing deviceId' });
  const current = appConfig.devicePreferences || {};
  if (!current[deviceId]) return res.json({ status: 'ok', deviceId, cleared: false });
  const next = { ...current };
  delete next[deviceId];
  appConfig.devicePreferences = next;
  appConfig = storage.saveConfig(appConfig, {
    reason: 'device-preferences-clear',
    eventType: 'device_preferences_cleared',
    req,
    details: { deviceId }
  });
  broadcastConfigChanged(deviceId);
  res.json({ status: 'ok', deviceId, cleared: true });
});

function broadcastConfigChanged(deviceId = null) {
  broadcastAdminEvent({ type: 'config_changed', deviceId });
}

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

adminRouter.get('/tv-pairing/subnet-hint', async (req, res) => {
  // Return the first private /24 the companion sees so the UI can prefill
  // an IP like "192.168.1.X" for the direct-entry flow.
  try {
    const seedAddress = await resolveDiscoverySeedAddress(req);
    const networkInterfaces = os.networkInterfaces();
    const seeds = collectPrivateIpv4SeedAddresses(
      networkInterfaces,
      seedAddress ? [seedAddress] : []
    );
    const primary = seeds[0] || '';
    const parts = primary.split('.');
    const prefix = parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.` : '';
    res.json({
      primary,
      prefix,
      port: TV_PAIRING_PORT,
      subnets: describePrivateIpv4Subnets(
        networkInterfaces,
        seedAddress ? [seedAddress] : []
      )
    });
  } catch (error) {
    res.status(500).json({ error: 'subnet_hint_failed', message: error.message });
  }
});

adminRouter.post('/tv-pairing/discover', async (req, res) => {
  try {
    const manualCode = normalizeManualCode(req.body && req.body.manualCode);
    const result = await discoverTvCandidates(req, manualCode);
    if (result.error === 'invalid_code') {
      return res.status(400).json(result);
    }
    if (result.error === 'local_network_unavailable') {
      return res.status(503).json(result);
    }
    if (result.error === 'expired_code') {
      return res.status(410).json(result);
    }
    if (result.error === 'code_not_found') {
      return res.status(404).json(result);
    }
    res.json({
      candidates: result.candidates,
      scannedCount: result.scannedCount
    });
  } catch (error) {
    console.warn('TV pairing discovery failed:', error.message);
    res.status(500).json({
      error: 'discovery_failed',
      message: 'TV discovery failed.'
    });
  }
});

adminRouter.post('/tv-pairing/resolve', async (req, res) => {
  try {
    const receiverUrl = req.body && req.body.receiverUrl;
    const manualCode = normalizeManualCode(req.body && req.body.manualCode);
    const result = await lookupTvCandidateByReceiverUrl(receiverUrl, manualCode);
    if (result.error === 'invalid_code' || result.error === 'invalid_receiver_url') {
      return res.status(400).json(result);
    }
    if (result.error === 'expired_code') {
      return res.status(410).json(result);
    }
    if (result.error === 'code_not_found') {
      return res.status(404).json(result);
    }
    if (result.error === 'tv_unreachable') {
      return res.status(504).json(result);
    }
    res.json({
      candidate: result.candidate
    });
  } catch (error) {
    console.warn('TV pairing direct lookup failed:', error.message);
    res.status(500).json({
      error: 'lookup_failed',
      message: 'TV lookup failed.'
    });
  }
});

adminRouter.post('/tv-pairing/pair-qr', async (req, res) => {
  try {
    const parsedPayload = typeof req.body.payload === 'string' ? JSON.parse(req.body.payload) : req.body.payload;
    const validated = validateTvPairingPayload(parsedPayload);
    if (!validated.ok) {
      return res.status(400).json({
        error: 'invalid_qr_payload',
        message: validated.issues[0] || 'The scanned TV QR code is invalid.'
      });
    }
    const companionUrl = buildCompanionBaseUrl(req, req.body.companionUrl);
    await postTvPairingEnvelope({
      payload: validated.payload,
      companionUrl
    });
    res.json({
      ok: true,
      deviceName: validated.payload.device_name || 'TV'
    });
  } catch (error) {
    const status = error && error.error
      ? (error.error === 'invalid_pairing_token' ? 401 : (error.error === 'tv_unreachable' ? 504 : 502))
      : 500;
    console.warn('TV QR pairing failed:', error.message);
    res.status(status).json({
      error: error.error || 'pairing_failed',
      message: error.message || 'TV pairing failed.'
    });
  }
});

adminRouter.post('/tv-pairing/pair-manual', async (req, res) => {
  try {
    const candidate = req.body && typeof req.body.candidate === 'object' ? req.body.candidate : {};
    const infoValidation = validateTvPairingInfo(candidate);
    if (!infoValidation.ok) {
      return res.status(400).json({
        error: 'invalid_candidate',
        message: infoValidation.issues[0] || 'The selected TV pairing candidate is invalid.'
      });
    }

    const receiverUrl = String(candidate.receiver_url || '').trim() || buildTvReceiverUrl(candidate.ip);
    const payload = {
      version: 1,
      receiver_url: receiverUrl,
      pairing_token: typeof candidate.pairing_token === 'string' ? candidate.pairing_token.trim() : '',
      manual_code: infoValidation.info.manual_code,
      device_name: infoValidation.info.device_name,
      expires_at_epoch_ms: infoValidation.info.expires_at_epoch_ms
    };
    const validated = validateTvPairingPayload(payload);
    const companionUrl = buildCompanionBaseUrl(req, req.body.companionUrl);
    const fallbackToken = payload.pairing_token || payload.manual_code;
    const remainingIssues = validated.issues.filter((issue) => !(payload.pairing_token === '' && /pairing token/i.test(issue)));
    if (remainingIssues.length > 0) {
      return res.status(400).json({
        error: 'invalid_candidate',
        message: remainingIssues[0]
      });
    }
    if (Number(payload.expires_at_epoch_ms) <= Date.now()) {
      return res.status(410).json({
        error: 'expired_code',
        message: 'That TV code has expired. Start pairing again on the TV and try once more.'
      });
    }

    await postTvPairingEnvelope({
      payload,
      companionUrl,
      pairingTokenOverride: fallbackToken
    });
    res.json({
      ok: true,
      deviceName: payload.device_name || candidate.ip || 'TV',
      usedManualCodeFallback: !payload.pairing_token
    });
  } catch (error) {
    const status = error && error.error
      ? (error.error === 'invalid_pairing_token' ? 401 : (error.error === 'tv_unreachable' ? 504 : 502))
      : 500;
    console.warn('TV manual pairing failed:', error.message);
    res.status(status).json({
      error: error.error || 'pairing_failed',
      message: error.message || 'TV pairing failed.'
    });
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

adminRouter.post('/test-network-share', async (req, res) => {
  const validation = validateNetworkShareForTest(req.body || {});
  if (!validation.ok) {
    return res.json({
      success: false,
      error: validation.issues[0]
    });
  }

  try {
    if (validation.share.protocol === 'nfs') {
      const result = await testNfsShareConnection(validation.share);
      return res.json({
        success: true,
        protocol: 'nfs',
        targetPath: result.targetPath,
        exportVerified: result.exportVerified,
        sample: result.sample,
        warning: result.warning
      });
    }

    const result = await testSmbShareConnection(validation.share);
    return res.json({
      success: true,
      protocol: 'smb',
      targetPath: result.targetPath,
      fileCount: result.fileCount,
      sample: result.sample
    });
  } catch (error) {
    res.json({
      success: false,
      error: validation.share.protocol === 'nfs'
        ? formatNfsShareTestError(error)
        : formatSmbShareTestError(error)
    });
  }
});

adminRouter.post('/discover-network-shares', async (req, res) => {
  try {
    const discovery = await discoverNetworkShareCandidates(req);
    res.json({
      success: true,
      results: discovery.results,
      warnings: discovery.warnings,
      scannedSubnets: discovery.scannedSubnets
    });
  } catch (error) {
    res.json({
      success: false,
      error: error && error.message ? error.message : 'Network share discovery failed.'
    });
  }
});

adminRouter.post('/discover-smb-server-shares', async (req, res) => {
  const payload = req.body || {};
  const host = String(payload.host || '').trim();
  if (!host) {
    return res.json({
      success: false,
      error: 'SMB host is required.'
    });
  }

  try {
    const shares = await listSmbServerShares(payload);
    res.json({
      success: true,
      host,
      shares
    });
  } catch (error) {
    res.json({
      success: false,
      error: formatSmbShareDiscoveryError(error, payload.username)
    });
  }
});

adminRouter.post('/discover-nfs-exports', async (req, res) => {
  const payload = req.body || {};
  const host = String(payload.host || '').trim();
  if (!host) {
    return res.json({
      success: false,
      error: 'NFS host is required.'
    });
  }

  try {
    await checkTcpPort(host, normalizeOptionalPort(payload.port, 2049));
    const exportInfo = await queryNfsExports(host);
    if ((!Array.isArray(exportInfo.exports) || exportInfo.exports.length === 0) && exportInfo.warning) {
      return res.json({
        success: false,
        error: exportInfo.warning
      });
    }

    res.json({
      success: true,
      host,
      exports: exportInfo.exports,
      warning: exportInfo.warning
    });
  } catch (error) {
    res.json({
      success: false,
      error: formatNfsExportDiscoveryError(error)
    });
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
                user.id = userId;
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
        reconcileJellyfinRealtimeSockets();
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

const SECRET_PREF_KEYS = new Set([
  'pref_tmdb_api_key',
  'pref_omdb_api_key',
  'pref_voice_assistant_cloud_api_key'
]);
const SECRET_PLACEHOLDER = '***REDACTED***';

function redactConfigForExport(config) {
  const clone = JSON.parse(JSON.stringify(config || {}));
  if (clone.globalPreferences && typeof clone.globalPreferences === 'object') {
    for (const key of Object.keys(clone.globalPreferences)) {
      if (SECRET_PREF_KEYS.has(key) && clone.globalPreferences[key]) {
        clone.globalPreferences[key] = SECRET_PLACEHOLDER;
      }
    }
  }
  if (Array.isArray(clone.servers)) {
    clone.servers.forEach((server) => {
      if (!server || typeof server !== 'object') return;
      if (Array.isArray(server.users)) {
        server.users.forEach((user) => {
          if (user && user.access_token) user.access_token = SECRET_PLACEHOLDER;
          if (user && user.password) delete user.password;
          if (user && user.musicAssistant && user.musicAssistant.token) {
            user.musicAssistant.token = SECRET_PLACEHOLDER;
          }
          if (user && user.musicAssistant && user.musicAssistant.password) {
            user.musicAssistant.password = SECRET_PLACEHOLDER;
          }
        });
      }
    });
  }
  if (Array.isArray(clone.networkShares)) {
    clone.networkShares.forEach((share) => {
      if (share && share.password) share.password = SECRET_PLACEHOLDER;
    });
  }
  if (clone.setup_token) clone.setup_token = SECRET_PLACEHOLDER;
  return clone;
}

adminRouter.get('/config/export', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="spatialfin-config.json"');
  const includeSecrets = req.query.includeSecrets === '1' || req.query.includeSecrets === 'true';
  const payload = includeSecrets ? appConfig : redactConfigForExport(appConfig);
  res.json(payload);
});

function restoreRedactedSecrets(imported, current) {
  // Replace redacted placeholders with the existing values so partial exports
  // can be re-imported without losing credentials.
  if (imported.globalPreferences && typeof imported.globalPreferences === 'object'
      && current && current.globalPreferences) {
    for (const key of Object.keys(imported.globalPreferences)) {
      if (SECRET_PREF_KEYS.has(key) && imported.globalPreferences[key] === SECRET_PLACEHOLDER) {
        imported.globalPreferences[key] = current.globalPreferences[key] || '';
      }
    }
  }
  if (Array.isArray(imported.servers) && Array.isArray(current && current.servers)) {
    const byId = new Map(current.servers.map((s) => [s.id, s]));
    imported.servers.forEach((server) => {
      const existing = byId.get(server && server.id);
      if (!existing || !Array.isArray(server.users)) return;
      const existingUsers = new Map((existing.users || []).map((u) => [u.username || u.name, u]));
      server.users.forEach((user) => {
        if (!user) return;
        const prev = existingUsers.get(user.username || user.name);
        if (user.access_token === SECRET_PLACEHOLDER) {
          user.access_token = (prev && prev.access_token) || '';
        }
        if (user.musicAssistant && user.musicAssistant.token === SECRET_PLACEHOLDER) {
          user.musicAssistant.token = (prev && prev.musicAssistant && prev.musicAssistant.token) || '';
        }
        if (user.musicAssistant && user.musicAssistant.password === SECRET_PLACEHOLDER) {
          user.musicAssistant.password = (prev && prev.musicAssistant && prev.musicAssistant.password) || '';
        }
      });
    });
  }
  if (imported.setup_token === SECRET_PLACEHOLDER && current && current.setup_token) {
    imported.setup_token = current.setup_token;
  }
  return imported;
}

adminRouter.post('/config/import', (req, res) => {
  try {
    let imported = req.body;
    if (!imported || typeof imported !== 'object' || Array.isArray(imported)) {
      return res.status(400).json({ error: 'Invalid config: must be a JSON object' });
    }
    const { errors } = validateConfigPatch(imported);
    if (errors.length) {
      return res.status(400).json({ error: 'Invalid configuration payload', details: errors });
    }
    imported = restoreRedactedSecrets(imported, appConfig);
    if (imported.globalPreferences) {
      appConfig.globalPreferences = { ...appConfig.globalPreferences, ...imported.globalPreferences };
    }
    if (imported.servers) {
      appConfig.servers = imported.servers;
    }
    if (imported.networkShares) {
      appConfig.networkShares = imported.networkShares;
    }
    if (imported.setup_token && typeof imported.setup_token === 'string') {
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
    reconcileJellyfinRealtimeSockets();
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
  const safeName = (device.customName || device.deviceName || device.deviceId || 'spatialfin-device')
    .replace(/[^a-z0-9-_]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'spatialfin-device';
  const lines = [
    `Device: ${device.customName || device.deviceName || device.deviceId}`,
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

adminRouter.patch('/devices/:deviceId', (req, res) => {
  const name = typeof (req.body && req.body.customName) === 'string' ? req.body.customName : '';
  if (name.length > 160) {
    return res.status(400).json({ error: 'Name too long (max 160 characters)' });
  }
  const result = storage.renameDevice(req.params.deviceId, name);
  if (!result.changes) {
    return res.status(404).json({ error: 'Device not found' });
  }
  res.json({ status: 'ok', customName: result.customName });
});

adminRouter.delete('/devices/:deviceId', (req, res) => {
  const result = storage.deleteDevice(req.params.deviceId);
  if (!result.changes) {
    return res.status(404).json({ error: 'Device not found' });
  }
  res.json({ status: 'ok' });
});

adminRouter.post('/device-logs/prune', (req, res) => {
  const days = Number(req.body && req.body.olderThanDays);
  if (!Number.isFinite(days) || days <= 0) {
    return res.status(400).json({ error: 'olderThanDays must be a positive number' });
  }
  try {
    const result = storage.pruneDeviceLogsOlderThan(days);
    res.json({ status: 'ok', ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

adminRouter.get('/analytics/overview', (req, res) => {
  const recentLimit = Math.max(1, Math.min(100, Number(req.query.recentLimit) || 10));
  const topLimit = Math.max(1, Math.min(100, Number(req.query.topLimit) || 10));
  const trendLimit = Math.max(1, Math.min(60, Number(req.query.trendLimit) || 14));
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  res.json({
    sync: analyticsSyncState,
    realtimeSockets: getRealtimeSocketStatus(),
    rangeDays: days,
    overview: storage.getAnalyticsOverview({ days }),
    recentSessions: storage.getRecentPlaybackSessions(recentLimit, { days }),
    topUsers: storage.getTopPlaybackUsers(topLimit, { days }),
    topServers: storage.getTopPlaybackServers(topLimit, { days }),
    topLibraries: storage.getTopPlaybackLibraries(topLimit, { days }),
    trends: storage.getDailyPlaybackTrends(trendLimit, { days }),
    topItems: storage.getTopPlaybackItems(topLimit, { days })
  });
});

adminRouter.get('/analytics/sync-status', (req, res) => {
  res.json({
    sync: analyticsSyncState,
    realtimeSockets: getRealtimeSocketStatus(),
    intervalMs: ANALYTICS_SYNC_INTERVAL_MS
  });
});

adminRouter.get('/analytics/realtime-status', (req, res) => {
  res.json({
    sync: analyticsSyncState,
    sockets: getRealtimeSocketStatus()
  });
});

adminRouter.get('/analytics/artwork/:serverId/:itemId', async (req, res) => {
  const lookup = findVerifiedUserForServer(req.params.serverId, null, null);
  if (!lookup.server || !lookup.user) {
    return res.status(404).json({ error: 'Artwork source not available' });
  }
  const baseUrl = String((lookup.server.addresses && lookup.server.addresses[0]) || '').replace(/\/+$/, '');
  const token = lookup.user.access_token;
  const url = `${baseUrl}/Items/${encodeURIComponent(req.params.itemId)}/Images/Primary?maxHeight=420&quality=90`;
  try {
    const upstream = await fetch(url, {
      headers: buildJellyfinAuthHeaders(token)
    });
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: 'Artwork fetch failed' });
    }
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const arrayBuffer = await upstream.arrayBuffer();
    res.end(Buffer.from(arrayBuffer));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.post('/analytics/sync-now', async (req, res) => {
  const result = await runAnalyticsSync('manual');
  if (result.error) {
    return res.status(500).json({
      success: false,
      error: result.error.message,
      sync: analyticsSyncState
    });
  }
  res.json({
    success: true,
    skipped: !!result.skipped,
    sync: analyticsSyncState
  });
});

adminRouter.get('/analytics/sessions', (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  res.json({
    sessions: storage.getRecentPlaybackSessions(limit, { days })
  });
});

adminRouter.get('/analytics/sessions/:playbackSessionId', (req, res) => {
  const limit = Math.max(1, Math.min(2000, Number(req.query.limit) || 500));
  const result = storage.getPlaybackSessionWithEvents(req.params.playbackSessionId, limit);
  if (!result) {
    return res.status(404).json({ error: 'Playback session not found' });
  }
  res.json(result);
});

adminRouter.get('/analytics/users', (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25));
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  res.json({
    users: storage.getTopPlaybackUsers(limit, { days })
  });
});

adminRouter.get('/analytics/users/:userRef', (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 30));
  const result = storage.getPlaybackUserDetail(req.params.userRef, { limit });
  if (!result) {
    return res.status(404).json({ error: 'User analytics not found' });
  }
  res.json(result);
});

adminRouter.get('/analytics/libraries', (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25));
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  res.json({
    libraries: storage.getTopPlaybackLibraries(limit, { days })
  });
});

adminRouter.get('/analytics/servers', (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25));
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  res.json({
    servers: storage.getTopPlaybackServers(limit, { days })
  });
});

adminRouter.get('/analytics/trends', (req, res) => {
  const limit = Math.max(1, Math.min(90, Number(req.query.limit) || 30));
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  res.json({
    trends: storage.getDailyPlaybackTrends(limit, { days })
  });
});

adminRouter.get('/analytics/items', (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25));
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  res.json({
    items: storage.getTopPlaybackItems(limit, { days })
  });
});

adminRouter.get('/analytics/items/:itemRef', (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 30));
  const result = storage.getPlaybackItemDetail(req.params.itemRef, { limit });
  if (!result) {
    return res.status(404).json({ error: 'Item analytics not found' });
  }
  res.json(result);
});

adminRouter.get('/analytics/history', (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  res.json({
    history: storage.getWatchHistory({
      limit,
      days,
      user: req.query.user || null,
      item: req.query.item || null
    })
  });
});

adminRouter.delete('/analytics/history', (req, res) => {
  const result = storage.clearAllPlaybackSessions();
  res.json({ status: 'ok', ...result });
});

adminRouter.delete('/analytics/sessions/:playbackSessionId', (req, res) => {
  const result = storage.deletePlaybackSession(req.params.playbackSessionId);
  if (!result.changes) {
    return res.status(404).json({ error: 'Playback session not found' });
  }
  res.json({ status: 'ok' });
});

adminRouter.post('/analytics/prune', (req, res) => {
  const days = Number(req.body && req.body.olderThanDays);
  if (!Number.isFinite(days) || days <= 0) {
    return res.status(400).json({ error: 'olderThanDays must be a positive number' });
  }
  try {
    const result = storage.prunePlaybackSessionsOlderThan(days);
    res.json({ status: 'ok', ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

adminRouter.get('/database/stats', (req, res) => {
  res.json(storage.getDatabaseStats());
});

adminRouter.post('/database/vacuum', (req, res) => {
  try {
    storage.vacuumDatabase();
    res.json({ status: 'ok', ...storage.getDatabaseStats() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const APP_VERSION = (() => {
  try { return require('./package.json').version || ''; } catch (_) { return ''; }
})();

app.get('/api/meta', (req, res) => {
  res.json({
    version: APP_VERSION,
    capabilities: {
      // True when a local SearXNG sidecar (or a user-provided SearXNG URL) is
      // reachable via the companion. Lets the headset hide the web_search tool
      // action when nothing is configured instead of probing on every query.
      web_search: WEB_SEARCH_ENABLED,
    },
  });
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

// Web search proxy. Fronts the local SearXNG sidecar (or a user-overridden
// URL) and returns a trimmed JSON shape. The headset never hits SearXNG
// directly — SearXNG is bound to loopback and this endpoint is the only way in.
//
// Rate-limited independently from the admin login limiter: per-IP, a reasonable
// burst for conversational AI (a handful of queries in flight per turn).
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many search requests' },
});

app.get('/api/v1/search', searchLimiter, async (req, res) => {
  const token = req.headers['x-setup-token'];
  if (token !== appConfig.setup_token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!WEB_SEARCH_ENABLED) {
    return res.status(503).json({ error: 'Web search is not configured' });
  }
  const query = typeof req.query.q === 'string' ? req.query.q : '';
  try {
    const payload = await performWebSearch({ query, searxngUrl: SEARXNG_URL });
    storage.recordEvent('web_search', req, {
      queryLen: query.length,
      resultCount: payload.results.length,
    });
    res.json(payload);
  } catch (err) {
    const status = typeof err.status === 'number' ? err.status : 500;
    res.status(status).json({ error: err.message || 'Search failed' });
  }
});

app.post('/api/v1/analytics/sessions', (req, res) => {
  const token = req.headers['x-setup-token'];
  if (token !== appConfig.setup_token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const payload = req.body || {};
  const sessionCount = Array.isArray(payload.sessions)
    ? payload.sessions.length
    : (payload && typeof payload === 'object' ? 1 : 0);
  if (sessionCount === 0) {
    return res.status(400).json({ error: 'Invalid analytics payload' });
  }

  const result = storage.upsertPlaybackSessions(payload, req);
  res.json({
    status: 'ok',
    accepted: result.accepted,
    totalSessions: result.totalSessions
  });

  if (wss && result.accepted > 0) {
    const msg = JSON.stringify({
      type: 'analytics_sessions_ingested',
      accepted: result.accepted,
      totalSessions: result.totalSessions
    });
    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        client.send(msg);
      }
    });
  }
});

const activeFCastReceivers = new Map();

app.post('/api/fcast/register', (req, res) => {
  const { ip, port, name } = req.body;
  if (!ip || !port || !name) {
    return res.status(400).json({ error: 'Missing ip, port, or name' });
  }
  const id = `${ip}:${port}`;
  activeFCastReceivers.set(id, { ip, port, name, lastSeen: Date.now() });
  res.json({ status: 'ok' });
});

app.get('/api/fcast/receivers', cors(), (req, res) => {
  const now = Date.now();
  const receivers = [];
  for (const [id, receiver] of activeFCastReceivers.entries()) {
    if (now - receiver.lastSeen > 60000) { // Prune stale receivers older than 60 seconds
      activeFCastReceivers.delete(id);
    } else {
      receivers.push(receiver);
    }
  }
  res.json(receivers);
});


app.get('/api/auth/credentials', cors(), (req, res) => {
  const servers = Array.isArray(appConfig.servers) ? appConfig.servers : [];
  const credentialsList = [];
  
  for (const server of servers) {
    const users = Array.isArray(server.users) ? server.users : [];
    for (const user of users) {
      credentialsList.push({
        serverUrl: (server.addresses && server.addresses[0]) || '',
        apiToken: user.access_token || '',
        userId: user.id || 'unknown_id',
        username: user.username || user.name || 'Companion User',
        password: user.password || '',
        musicAssistant: user.musicAssistant || null
      });
    }
  }
  
  if (credentialsList.length > 0) {
    return res.json(credentialsList);
  }
  
  return res.status(404).json({ error: 'No configured credentials' });
});

app.get('/api/preferences', cors(), (req, res) => {
  const prefs = appConfig.globalPreferences || {};
  res.json({
    seerr_enabled: prefs.pref_seerr_enabled === 'true',
    seerr_url: prefs.pref_seerr_url || '',
    seerr_api_key: prefs.pref_seerr_api_key || ''
  });
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
  console.log(`SpatialFin Companion on port ${PORT}`);
  updater.start();
});

wss = new WebSocketServer({ server });



const bonjour = new Bonjour();

// Use bonjour to find other receivers on the network and add them to activeFCastReceivers
const fcastBrowser = bonjour.find({ type: 'fcast' });
fcastBrowser.on('up', (service) => {
  if (service.addresses && service.addresses.length > 0) {
    const ip = service.addresses.find(a => a.includes('.')) || service.addresses[0];
    const id = `${ip}:${service.port}`;
    const name = (service.txt && service.txt.appName) ? `${service.txt.appName} (${service.name})` : service.name;
    activeFCastReceivers.set(id, { ip, port: service.port, name, lastSeen: Date.now() });
  }
});
fcastBrowser.on('down', (service) => {
  if (service.addresses && service.addresses.length > 0) {
    const ip = service.addresses.find(a => a.includes('.')) || service.addresses[0];
    const id = `${ip}:${service.port}`;
    activeFCastReceivers.delete(id);
  }
});
// Periodically poll known services to update their lastSeen
setInterval(() => {
  fcastBrowser.update();
  for (const service of fcastBrowser.services) {
    if (service.addresses && service.addresses.length > 0) {
      const ip = service.addresses.find(a => a.includes('.')) || service.addresses[0];
      const id = `${ip}:${service.port}`;
      if (activeFCastReceivers.has(id)) {
        activeFCastReceivers.get(id).lastSeen = Date.now();
      }
    }
  }
}, 30000);

wss.on('connection', (ws, req) => {
  if (req.url && req.url.startsWith('/api/fcast/receive')) {
    let tcpSocket = null;
    let mdnsService = null;
    let messageBuffer = Buffer.alloc(0);

    const bridgeServer = net.createServer((socket) => {
      if (tcpSocket) {
        socket.destroy(); // Only allow one sender at a time
        return;
      }
      tcpSocket = socket;

      // Send Version (opcode 11) and Initial (opcode 14) to identify ourselves as SpatialFin
      // so the Android sender preserves metadata (especially splitAv role) in Play messages.
      const sendFCastFrame = (opcode, jsonObj) => {
        const jsonStr = JSON.stringify(jsonObj);
        const jsonBytes = Buffer.from(jsonStr, 'utf8');
        const size = 1 + jsonBytes.length;
        const frame = Buffer.alloc(4 + size);
        frame.writeUInt32LE(size, 0);
        frame[4] = opcode;
        jsonBytes.copy(frame, 5);
        socket.write(frame);
      };
      sendFCastFrame(11, { version: 4 }); // Version
      sendFCastFrame(14, {               // Initial (receiver info)
        friendlyName: 'SpatialFin Web',
        appName: 'SpatialFin Web',
        appVersion: '1.0.0'
      });
      
      socket.on('data', (data) => {
        messageBuffer = Buffer.concat([messageBuffer, data]);
        while (messageBuffer.length >= 4) {
          const length = messageBuffer.readUInt32LE(0);
          if (messageBuffer.length >= 4 + length) {
            const payload = messageBuffer.subarray(4, 4 + length);
            messageBuffer = messageBuffer.subarray(4 + length);
            ws.send(payload); // Send without length prefix
          } else {
            break;
          }
        }
      });
      
      socket.on('close', () => {
        tcpSocket = null;
      });
      
      socket.on('error', (err) => {
        console.error('Bridge TCP socket error:', err);
      });
    });

    bridgeServer.listen(0, '0.0.0.0', () => {
      const port = bridgeServer.address().port;
      const hostname = os.hostname();
      const uniqueId = crypto.randomBytes(2).toString('hex');

      mdnsService = bonjour.publish({
        name: `SpatialFin Web (${hostname}-${uniqueId})`,
        type: 'fcast',
        protocol: 'tcp',
        port: port,
        host: globalLocalIp,
        txt: { 
          txtvers: '1',
          appName: 'SpatialFin Web',
          appVersion: '1.0.0'
        }
      });
      mdnsService.on('error', (err) => {
        console.error('mDNS error:', err);
      });
      console.log(`FCast Bridge started on port ${port} for Web App (${uniqueId}) at ${globalLocalIp || 'default IP'}`);
    });

    ws.on('message', (data) => {
      if (tcpSocket) {
        const lengthPrefix = Buffer.alloc(4);
        lengthPrefix.writeUInt32LE(data.length, 0);
        tcpSocket.write(Buffer.concat([lengthPrefix, data]));
      }
    });

    ws.on('close', () => {
      if (mdnsService) {
        mdnsService.stop();
        mdnsService = null;
      }
      if (tcpSocket) {
        tcpSocket.destroy();
        tcpSocket = null;
      }
      bridgeServer.close();
      console.log('FCast Bridge closed');
    });
    
    return;
  }

  // Client connected for live log and analytics streaming.
});

reconcileJellyfinRealtimeSockets();

setInterval(() => {
  runAnalyticsSync('interval').catch((error) => {
    console.error('Analytics sync interval failed:', error);
  });
}, ANALYTICS_SYNC_INTERVAL_MS);

try { storage.pruneExpiredAdminSessions(); } catch (_) {}
setInterval(() => {
  try { storage.pruneExpiredAdminSessions(); } catch (_) {}
}, 60 * 60 * 1000);

setTimeout(() => {
  runAnalyticsSync('startup').catch((error) => {
    console.error('Analytics sync startup failed:', error);
  });
}, 5000);
