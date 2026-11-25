'use strict';

const originalEmit = process.emit;
process.emit = function (name, data, ...args) {
  if (name === 'warning' && typeof data === 'object' && data.name === 'ExperimentalWarning' && data.message.includes('SQLite')) return false;
  return originalEmit.apply(process, [name, data, ...args]);
};

const express = require('express');
const qrcode = require('qrcode');
const bodyParser = require('body-parser');
const os = require('node:os');
const { WebSocketServer, WebSocket } = require('ws');
const helmet = require('helmet');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const dns = require('node:dns');
const dnsPromises = require('node:dns').promises;
const Bonjour = require('bonjour-service').default;
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const { DEFAULT_PREFERENCES } = require('./default-preferences');
const {
  createStorage,
  generateSetupToken,
  isSetupTokenWeakValue,
  STRONG_SETUP_TOKEN_REGEX,
} = require('./storage');
const updater = require('./updater');
const {
  buildNetworkShareTargetPath,
  isPathWithinExport,
  normalizeNetworkShare,
  normalizeNfsExportPath,
  normalizeShareRelativePath,
  validateNetworkShareForTest,
} = require('./network-shares');
const { parseSmbClientListing } = require('./share-test-utils');
const { queryNfsExportsViaRpc } = require('./nfs-rpc');
const {
  buildPrivateIpv4DiscoveryTargets,
  collectPrivateIpv4SeedAddresses,
  describePrivateIpv4Subnets,
  extractHostFromAuthority,
  extractRightmostHeaderValue,
  getPrimaryLanIpv4,
  getPrimaryLanIpv4WithInterface,
  getPrimaryLanUlaIpv6,
  getScanNetworkInterfaces,
  parseSmbClientShareList,
  sortAndDedupeDiscoveryResults,
} = require('./share-discovery');
const {
  normalizeManualCode,
  isPrivateIpv4,
  validateTvPairingPayload,
  validateTvPairingInfo,
  buildTvReceiverUrl,
  buildTvInfoUrl,
  buildTvInfoUrlFromReceiverUrl,
  buildCompanionHandoffUrlFromReceiverUrl,
  normalizeTvReceiverInput,
  extractMdnsCandidates,
  buildTvPairingEnvelope,
  buildCompanionHandoffPayload,
  parseSetupUrlQr,
  TV_PAIRING_PORT,
} = require('./tv-pairing');
const {
  normalizeUuid,
  normalizeUrl,
  normalizeSixDigitCode,
  probePublicSystemInfo,
  initiateQuickConnect,
  pollQuickConnect,
  exchangeQuickConnect,
  authorizeQuickConnect,
  checkQuickConnectEnabled,
  evaluateServerAddressBindingImpact,
  mergeCanonicalServerInDraft,
  generatePendingId,
  isLegacySyntheticServerId,
} = require('./quick-connect');
const { performSearch: performWebSearch } = require('./web-search');
const {
  POLICY_RECEIVER_LAN_HTTP_ONLY,
  POLICY_PRIVATE_LAN_ONLY,
  POLICY_PUBLIC_OR_LAN,
  SsrfBlockedError,
  stripBrackets,
  normalizeHostForMatch,
  effectivePortForUrl,
  unwrapIpv4InIpv6,
  isNonCanonicalIpv4Host,
  isSyntacticLoopbackHost,
  isLoopbackIp,
  isPrivateOrLanIp,
  isReceiverLanIp,
  isSelfSsrfTarget,
  validateInitialUrl,
  createPinnedLookup,
  validateLanHost,
  safeFetch,
} = require('./safe-fetch');
const {
  SECRET_PLACEHOLDER,
  FORBIDDEN_KEYS,
  isValidMapKey,
  normalizeId,
  scrubApiKeyFromText,
  redactConfigForExport,
  restoreRedactedSecrets,
  lookupStoredShareSecret,
  lookupStoredSeerrApiKey,
  resolveEffectiveDevicePreferences,
  isolateUserPreferencesForDevice,
} = require('./config-redaction');

const execFileAsync = promisify(execFile);
const scryptAsync = promisify(crypto.scrypt);

const APP_VERSION = (() => {
  try { return require('./package.json').version || ''; } catch (_) { return ''; }
})();

const TOKEN_CORS_PATHS = new Set([
  '/api/fcast/receivers',
  '/api/fcast/ws-ticket',
  '/api/preferences',
  '/api/v1/config',
  '/api/v1/auth/authorize-quick-connect',
]);

const ALLOWED_ARTWORK_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
]);

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_PASSWORD_BYTES = 1024;
const MIN_BOOTSTRAP_PASSWORD_BYTES = 8;
const MAX_ADMIN_WS_BUFFER = 1 * 1024 * 1024;
const MAX_FCAST_WS_BUFFER = 4 * 1024 * 1024;
const MAX_FCAST_FRAME_BYTES = 1 * 1024 * 1024;

function envInt(name, defaultValue, min, max) {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return defaultValue;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

function sha256Buf(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest();
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function timingSafeStringEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return crypto.timingSafeEqual(sha256Buf(a), sha256Buf(b));
}

function generateBootstrapPin(length = 12) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CROCKFORD_ALPHABET[bytes[i] % CROCKFORD_ALPHABET.length];
  }
  return out;
}

async function hashPasswordScrypt(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scryptAsync(String(password), salt, 64);
  return `scrypt$${salt}$${Buffer.from(derived).toString('hex')}`;
}

async function verifyPasswordScrypt(password, storedHash) {
  if (typeof storedHash !== 'string' || !storedHash.startsWith('scrypt$')) return false;
  const parts = storedHash.split('$');
  if (parts.length !== 3) return false;
  const [, salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;
  try {
    const derived = await scryptAsync(String(password), salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(derived), expected);
  } catch (_) {
    return false;
  }
}

function normalizePathForMatch(rawPath) {
  const clean = String(rawPath || '/').split('?')[0].replace(/\/+/g, '/');
  if (clean.length > 1 && clean.endsWith('/')) return clean.slice(0, -1);
  return clean;
}

function parseCookies(req) {
  const header = req && req.headers ? (req.headers.cookie || '') : '';
  const cookies = {};
  String(header).split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    const key = pair.substring(0, idx).trim();
    const val = pair.substring(idx + 1).trim();
    if (!key) return;
    try {
      cookies[key] = decodeURIComponent(val);
    } catch (_) {
      // Skip malformed percent-encoded cookies without throwing URIError.
    }
  });
  return cookies;
}

function normalizeClientIpBucket(rawIp) {
  const clean = stripBrackets(String(rawIp || '').split('%')[0].trim());
  if (!clean) return 'unknown';
  const unwrapped = unwrapIpv4InIpv6(clean);
  if (net.isIPv4(unwrapped)) return unwrapped;
  if (net.isIPv6(unwrapped)) {
    return ipKeyGenerator(unwrapped, 64);
  }
  return clean.toLowerCase();
}

function hasForwardingHeaders(req) {
  const headers = (req && req.headers) || {};
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    if (lower.startsWith('x-forwarded-') || lower === 'forwarded' || lower === 'via') {
      return true;
    }
  }
  return false;
}

function isLoopbackHostHeader(hostHeader) {
  const raw = String(hostHeader || '').trim().toLowerCase();
  if (!raw) return false;
  return /^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(raw);
}

function isSqliteBusyError(err) {
  if (!err) return false;
  if (err.errcode === 5 || err.code === 'SQLITE_BUSY') return true;
  return /database is locked/i.test(String(err.message || ''));
}

function sanitizeText(value, maxLength) {
  if (value == null) return '';
  const text = String(value).replace(/[\r\n\0]+/g, ' ').trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

/**
 * Per-middleware bounded memory store for express-rate-limit v8.
 * Sets `localKeys = true`, pins actively blocked keys until resetTime,
 * and fails closed when all `maxEntries` slots are actively blocked.
 */
class BoundedMemoryStore {
  constructor(maxEntries = 4096) {
    this.maxEntries = maxEntries;
    this.localKeys = true;
    this.windowMs = 60_000;
    this.limit = 60;
    this.entries = new Map();
  }

  init(options = {}) {
    if (Number.isFinite(options.windowMs) && options.windowMs > 0) {
      this.windowMs = options.windowMs;
    }
    const rawLimit = typeof options.limit === 'number'
      ? options.limit
      : (typeof options.max === 'number' ? options.max : 60);
    if (Number.isFinite(rawLimit) && rawLimit > 0) {
      this.limit = rawLimit;
    }
  }

  _evictIfNeeded(now) {
    if (this.entries.size < this.maxEntries) return true;
    // Pass 1: evict expired entries
    for (const [k, rec] of this.entries.entries()) {
      if (rec.resetTimeMs <= now) {
        this.entries.delete(k);
      }
    }
    if (this.entries.size < this.maxEntries) return true;
    // Pass 2: evict lowest-hit non-blocked entry (pinning blocked entries until resetTime)
    let victimKey = null;
    let victimHits = Infinity;
    for (const [k, rec] of this.entries.entries()) {
      if (rec.totalHits >= this.limit) continue;
      if (rec.totalHits < victimHits) {
        victimHits = rec.totalHits;
        victimKey = k;
      }
    }
    if (victimKey !== null) {
      this.entries.delete(victimKey);
      return true;
    }
    return false;
  }

  increment(key) {
    const now = Date.now();
    const existing = this.entries.get(key);
    if (existing && existing.resetTimeMs > now) {
      existing.totalHits += 1;
      return {
        totalHits: existing.totalHits,
        resetTime: new Date(existing.resetTimeMs),
      };
    }
    if (existing) {
      this.entries.delete(key);
    }
    if (!this._evictIfNeeded(now)) {
      // Fail closed when all slots are actively blocked
      return {
        totalHits: this.limit + 1,
        resetTime: new Date(now + this.windowMs),
      };
    }
    const resetTimeMs = now + this.windowMs;
    const rec = { totalHits: 1, resetTimeMs };
    this.entries.set(key, rec);
    return {
      totalHits: 1,
      resetTime: new Date(resetTimeMs),
    };
  }

  decrement(key) {
    const existing = this.entries.get(key);
    if (!existing) return;
    existing.totalHits = Math.max(0, existing.totalHits - 1);
  }

  resetKey(key) {
    this.entries.delete(key);
  }

  shutdown() {
    this.entries.clear();
  }
}

function buildJellyfinAuthHeadersForInstance(instanceId, accessToken) {
  const token = String(accessToken || '').trim();
  const deviceId = `spatialfin-companion-${instanceId || 'default'}`;
  const baseAuth = `MediaBrowser Client="SpatialFin Companion", Device="Server", DeviceId="${deviceId}", Version="${APP_VERSION || '1.0.0'}"`;
  if (!token) {
    return {
      Authorization: baseAuth,
      'X-Emby-Authorization': baseAuth,
    };
  }
  return {
    Authorization: `${baseAuth}, Token="${token}"`,
    'X-Emby-Token': token,
    'X-Emby-Authorization': `${baseAuth}, Token="${token}"`,
  };
}

function validateConfigTargets(config, {
  legacyLoopbackAllowlist = [],
  allowLoopbackUpstreams = false,
  sections = null,
  devicePreferenceTargetId = null,
  selfPort = Number(process.env.PORT) || 1982,
} = {}) {
  const checkAll = !sections;
  const hasSection = (name) => checkAll || sections.has(name);

  const validatePublicOrLanUrl = (rawUrl, label, { honorLoopbackAllowlist = true } = {}) => {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) return;
    validateInitialUrl(rawUrl.trim(), POLICY_PUBLIC_OR_LAN, {
      allowLoopback: honorLoopbackAllowlist && allowLoopbackUpstreams,
      legacyLoopbackAllowlist: honorLoopbackAllowlist ? legacyLoopbackAllowlist : [],
      selfPort,
    });
  };

  if (devicePreferenceTargetId) {
    const map = config?.devicePreferences?.[devicePreferenceTargetId];
    if (map && typeof map === 'object' && typeof map.pref_seerr_url === 'string' && map.pref_seerr_url.trim()) {
      validatePublicOrLanUrl(map.pref_seerr_url, `devicePreferences.${devicePreferenceTargetId}.pref_seerr_url`, {
        honorLoopbackAllowlist: true,
      });
    }
    return;
  }

  if (hasSection('globalPreferences') && config?.globalPreferences?.pref_seerr_url) {
    validatePublicOrLanUrl(config.globalPreferences.pref_seerr_url, 'globalPreferences.pref_seerr_url', {
      honorLoopbackAllowlist: true,
    });
  }

  if (hasSection('devicePreferences') && config?.devicePreferences && typeof config.devicePreferences === 'object') {
    for (const [devId, prefs] of Object.entries(config.devicePreferences)) {
      if (prefs && typeof prefs === 'object' && prefs.pref_seerr_url) {
        validatePublicOrLanUrl(prefs.pref_seerr_url, `devicePreferences.${devId}.pref_seerr_url`, {
          honorLoopbackAllowlist: true,
        });
      }
    }
  }

  if (hasSection('servers') && Array.isArray(config?.servers)) {
    for (const srv of config.servers) {
      if (!srv || typeof srv !== 'object') continue;
      if (Array.isArray(srv.addresses)) {
        for (const addr of srv.addresses) {
          validatePublicOrLanUrl(addr, `servers.${srv.id}.addresses`, {
            honorLoopbackAllowlist: true,
          });
        }
      }
      if (Array.isArray(srv.users)) {
        for (const user of srv.users) {
          if (!user || typeof user !== 'object') continue;
          if (user.preferences?.pref_seerr_url) {
            validatePublicOrLanUrl(user.preferences.pref_seerr_url, `servers.${srv.id}.users.pref_seerr_url`, {
              honorLoopbackAllowlist: true,
            });
          }
          // Client-pushed MA URL & plugins unconditionally forbid loopback
          if (user.musicAssistant?.url) {
            validatePublicOrLanUrl(user.musicAssistant.url, `servers.${srv.id}.users.musicAssistant.url`, {
              honorLoopbackAllowlist: false,
            });
          }
          if (Array.isArray(user.plugins)) {
            for (const pUrl of user.plugins) {
              validatePublicOrLanUrl(pUrl, `servers.${srv.id}.users.plugins`, {
                honorLoopbackAllowlist: false,
              });
            }
          }
        }
      }
    }
  }

  if (hasSection('networkShares') && Array.isArray(config?.networkShares)) {
    for (const rawShare of config.networkShares) {
      if (!rawShare || typeof rawShare !== 'object') continue;
      const sh = normalizeNetworkShare(rawShare);
      if (!sh.host) continue;
      const cleanHost = stripBrackets(sh.host);
      if (/[\r\n\0\s/\\;]/.test(cleanHost) || cleanHost.startsWith('-') || cleanHost.includes('%')) {
        throw new SsrfBlockedError(`Unsafe network share host: ${sh.host}`);
      }
      if (isNonCanonicalIpv4Host(cleanHost) || isSyntacticLoopbackHost(cleanHost)) {
        throw new SsrfBlockedError(`Disallowed network share host: ${sh.host}`);
      }
      if (net.isIP(cleanHost)) {
        if (!isPrivateOrLanIp(cleanHost, { allowCgnat: true })) {
          throw new SsrfBlockedError(`Network share host ${cleanHost} must be a private LAN IP`);
        }
      }
    }
  }
}

function buildTvPairingError(result, usedManualCodeFallback) {
  const data = result && result.data && typeof result.data === 'object' ? result.data : {};
  const rawCode = String(data.error_code || data.error || '').trim();
  const status = result ? result.status : 0;

  if (status === 401 && (rawCode === 'pairing_token_invalid' || rawCode === 'invalid_pairing_token')) {
    return {
      status: 401,
      error_code: 'pairing_token_invalid',
      error: usedManualCodeFallback
        ? 'The device rejected the 6-character pairing code. Refresh the code on the device and try again.'
        : 'The device rejected the pairing token.',
    };
  }
  if (status === 409 && rawCode === 'pairing_cancelled') {
    return {
      status: 409,
      error_code: 'pairing_cancelled',
      error: data.error || 'Pairing was cancelled on the device.',
    };
  }
  if (status === 409 && rawCode === 'pairing_code_expired') {
    return {
      status: 409,
      error_code: 'pairing_code_expired',
      error: data.error || 'The pairing code has expired. Generate a new code on the device.',
    };
  }
  if (status === 409 && rawCode === 'pairing_session_active') {
    return {
      status: 409,
      error_code: 'pairing_session_active',
      error: data.error || 'Another pairing session is already in progress on this device.',
    };
  }
  if (status === 429) {
    return {
      status: 429,
      error_code: 'pairing_rate_limited',
      error: data.error || 'Too many pairing attempts. Wait a moment and try again.',
    };
  }
  if (status === 400 && rawCode === 'pairing_code_format') {
    return {
      status: 400,
      error_code: 'pairing_code_format',
      error: data.error || 'Invalid pairing code format.',
    };
  }
  if (status === 400 && rawCode === 'ssrf_blocked') {
    return {
      status: 400,
      error_code: 'ssrf_blocked',
      error: data.error || 'Companion URL was rejected by the device.',
    };
  }
  if (status === 403 && rawCode === 'host_rejected') {
    return {
      status: 403,
      error_code: 'host_rejected',
      error: data.error || 'The device rejected the request host header.',
    };
  }
  if (status === 422) {
    return {
      status: 422,
      error_code: rawCode || 'import_failed',
      error: data.error || 'The device could not import the configuration.',
    };
  }
  if (status === 503) {
    return {
      status: 503,
      error_code: 'server_busy',
      error: data.error || 'The device is busy. Try again shortly.',
    };
  }
  if (status === 504) {
    return {
      status: 504,
      error_code: 'pairing_timeout',
      error: data.error || 'The device timed out while applying configuration.',
    };
  }
  if (status >= 500) {
    return {
      status: 502,
      error_code: 'server_http_error',
      error: data.error || 'The device could not apply the companion config.',
    };
  }
  return {
    status: 502,
    error_code: rawCode || 'server_http_error',
    error: data.error || `Pairing failed with HTTP ${status || 'unknown'}.`,
  };
}

function closeWithTerminateFailsafe(ws, code = 4401, delayMs = 1_000) {
  if (!ws) return;
  try {
    ws.close(code);
  } catch (_) {}
  const t = setTimeout(() => {
    try {
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.terminate();
      }
    } catch (_) {}
  }, delayMs);
  if (typeof t.unref === 'function') t.unref();
}

function createCompanionApp(options = {}) {
  const rootDir = options.rootDir || __dirname;
  const port = options.port !== undefined ? Number(options.port) : (Number(process.env.PORT) || 1982);
  const bindHost = options.host || '0.0.0.0';
  const trustProxy = options.trustProxy !== undefined
    ? Boolean(options.trustProxy)
    : process.env.COMPANION_TRUST_PROXY === '1';
  const adminPasswordEnv = options.adminPassword !== undefined
    ? (options.adminPassword || null)
    : (process.env.COMPANION_ADMIN_PASSWORD || null);
  const allowLoopbackUpstreams = options.allowLoopbackUpstreams !== undefined
    ? Boolean(options.allowLoopbackUpstreams)
    : process.env.COMPANION_ALLOW_LOOPBACK_UPSTREAMS === '1';
  const searxngUrl = String(
    options.searxngUrl !== undefined ? options.searxngUrl : (process.env.COMPANION_SEARXNG_URL || '')
  ).trim();
  const webSearchEnabled = searxngUrl.length > 0;
  const fetchImpl = options.fetchImpl || safeFetch;
  const dnsLookup = options.dnsLookup || dns.lookup;
  const getInterfaces = options.getInterfaces || (() => os.networkInterfaces());
  const enableBackgroundTasks = options.enableBackgroundTasks !== false;
  const enableMdns = options.enableMdns !== false;

  const ANALYTICS_SYNC_INTERVAL_MS = Math.max(
    30_000,
    Number(process.env.ANALYTICS_SYNC_INTERVAL_MS) || 120_000
  );
  const TV_PAIRING_DISCOVERY_TIMEOUT_MS = envInt('COMPANION_TV_DISCOVERY_TIMEOUT_MS', 500, 100, 30_000);
  const NETWORK_SHARE_DISCOVERY_CONNECT_TIMEOUT_MS = envInt('COMPANION_SHARE_CONNECT_TIMEOUT_MS', 700, 100, 30_000);
  const NETWORK_SHARE_DISCOVERY_CONCURRENCY = envInt('COMPANION_SHARE_DISCOVERY_CONCURRENCY', 48, 1, 128);
  const NETWORK_SHARE_DISCOVERY_SMB_LIST_TIMEOUT_MS = envInt('COMPANION_SHARE_SMB_LIST_TIMEOUT_MS', 12000, 500, 120_000);

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

  const storage = options.storage || createStorage({
    rootDir,
    defaultPreferences: DEFAULT_PREFERENCES,
  });

  let appConfig = storage.getConfig();
  let legacyLoopbackAllowlist = (() => {
    try {
      const raw = storage.getStateValue('legacy_loopback_upstreams_allowlist');
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  })();

  const rateLimitValidate = trustProxy ? undefined : { xForwardedForHeader: false };

  // Vacuum coordination
  let activeVacuumPromise = null;

  // Config mutation serialization lock (never held across outbound network I/O)
  let configLockTail = Promise.resolve();
  function withConfigLock(fn) {
    const run = async () => {
      await waitForVacuumIfNeeded(3_000);
      return fn();
    };
    const next = configLockTail.then(run, run);
    configLockTail = next.catch(() => {});
    return next;
  }

  async function waitForVacuumIfNeeded(maxWaitMs = 3_000) {
    if (!storage.isVacuumInFlight()) return;
    if (!activeVacuumPromise) {
      const err = new Error('Database maintenance in progress');
      err.status = 503;
      err.errorCode = 'maintenance_in_progress';
      throw err;
    }
    let timer = null;
    try {
      await Promise.race([
        activeVacuumPromise,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const err = new Error('Database maintenance in progress');
            err.status = 503;
            err.errorCode = 'maintenance_in_progress';
            reject(err);
          }, maxWaitMs);
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function sendMaintenance503(res) {
    res.setHeader('Retry-After', '2');
    return res.status(503).json({
      error: 'Database maintenance in progress; please retry shortly.',
      error_code: 'maintenance_in_progress',
    });
  }

  function handleSqliteOrMaintenanceError(res, err) {
    if (err && (err.status === 503 || err.errorCode === 'maintenance_in_progress' || (storage.isVacuumInFlight() && isSqliteBusyError(err)))) {
      return sendMaintenance503(res);
    }
    return res.status(500).json({
      error: err?.message || 'Storage error',
      error_code: 'storage_error',
    });
  }

  // Bootstrap PIN state (unconfigured headless LAN)
  let activeBootstrapPin = null;
  let bootstrapPinExpiresAt = 0;
  let lastBootstrapPinMintAt = 0;
  const bootstrapPinFailuresByIp = new Map(); // bucket -> count
  const bootstrapPinFailedIps = new Set();
  const bootstrapPinCooldownByIp = new Map(); // bucket -> expiresAtMs (max 4096, pinned)
  let bootstrapPinGlobalFailures = 0;
  const BOOTSTRAP_COOLDOWN_MAX = 4096;

  function pruneBootstrapCooldowns(now) {
    for (const [k, exp] of bootstrapPinCooldownByIp.entries()) {
      if (exp <= now) bootstrapPinCooldownByIp.delete(k);
    }
  }

  function recordBootstrapCooldown(bucket, untilMs) {
    const now = Date.now();
    pruneBootstrapCooldowns(now);
    if (!bootstrapPinCooldownByIp.has(bucket) && bootstrapPinCooldownByIp.size >= BOOTSTRAP_COOLDOWN_MAX) {
      return false;
    }
    bootstrapPinCooldownByIp.set(bucket, untilMs);
    return true;
  }

  function getBootstrapCooldownUntil(bucket) {
    const now = Date.now();
    const until = bootstrapPinCooldownByIp.get(bucket) || 0;
    if (until <= now) {
      bootstrapPinCooldownByIp.delete(bucket);
      return 0;
    }
    return until;
  }

  function maybeMintBootstrapPin() {
    const now = Date.now();
    if (activeBootstrapPin && now < bootstrapPinExpiresAt) return;
    if (now - lastBootstrapPinMintAt < 60_000) return;
    activeBootstrapPin = generateBootstrapPin(12);
    bootstrapPinExpiresAt = now + 15 * 60_000;
    lastBootstrapPinMintAt = now;
    bootstrapPinGlobalFailures = 0;
    bootstrapPinFailuresByIp.clear();
    bootstrapPinFailedIps.clear();
    console.log(`[bootstrap] Admin password is not configured. One-time bootstrap PIN (valid 15 min): ${activeBootstrapPin}`);
  }

  function hasConfiguredAdminPassword() {
    return Boolean(adminPasswordEnv || storage.getAdminPasswordHash());
  }

  function getEffectiveClientIp(req) {
    if (trustProxy) {
      const forwarded = extractRightmostHeaderValue(req.headers?.['x-forwarded-for']);
      if (forwarded) return forwarded;
    }
    return req.socket?.remoteAddress || req.ip || '127.0.0.1';
  }

  function getEffectiveRequestOrigin(req) {
    let proto = req.socket?.encrypted ? 'https' : 'http';
    let hostHeader = req.headers?.host || '';

    if (trustProxy) {
      const fwdProto = extractRightmostHeaderValue(req.headers?.['x-forwarded-proto']);
      if (fwdProto) proto = fwdProto.toLowerCase();
      const fwdHost = extractRightmostHeaderValue(req.headers?.['x-forwarded-host']);
      if (fwdHost) hostHeader = fwdHost;
    }

    if (proto !== 'http' && proto !== 'https') return null;
    const trimmedHost = String(hostHeader || '').trim();
    if (!trimmedHost || /[\s/\\@?#]/.test(trimmedHost)) return null;

    try {
      const parsed = new URL(`${proto}://${trimmedHost}`);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
        return null;
      }
      return parsed.origin.toLowerCase();
    } catch (_) {
      return null;
    }
  }

  function isSameOriginHttpRequest(req) {
    const originHeader = req.headers?.origin;
    if (!originHeader) return true;
    const expected = getEffectiveRequestOrigin(req);
    if (!expected) return false;
    try {
      const parsed = new URL(String(originHeader).trim());
      return parsed.origin.toLowerCase() === expected;
    } catch (_) {
      return false;
    }
  }

  function isSameOriginWsUpgrade(req) {
    const originHeader = req.headers?.origin;
    if (!originHeader || !String(originHeader).trim()) return false;
    return isSameOriginHttpRequest(req);
  }

  function checkDirectLoopbackRequest(req) {
    const sockIp = stripBrackets(String(req.socket?.remoteAddress || '').split('%')[0]);
    const isDirectLoopbackSocket =
      !trustProxy &&
      !hasForwardingHeaders(req) &&
      (sockIp === '127.0.0.1' || sockIp === '::1' || sockIp === '::ffff:127.0.0.1');

    if (!isDirectLoopbackSocket) {
      return { ok: false, reason: 'admin_password_required' };
    }
    if (!isLoopbackHostHeader(req.headers?.host)) {
      return { ok: false, reason: 'host_rejected' };
    }
    return { ok: true, reason: null };
  }

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

  function buildJellyfinAuthHeaders(accessToken) {
    return buildJellyfinAuthHeadersForInstance(storage.getInstanceId(), accessToken);
  }

  function getActualPort() {
    try {
      const addr = server.address();
      if (addr && typeof addr === 'object' && addr.port) return addr.port;
    } catch (_) {}
    return port;
  }

  function buildCompanionBaseUrl(req, requestedUrl, { forHandoff = false } = {}) {
    const raw = String(requestedUrl || '').trim();
    const rawIfaces = getInterfaces();
    const lanIpv4 = getPrimaryLanIpv4(rawIfaces);
    const lanUla6 = getPrimaryLanUlaIpv6(rawIfaces);

    const resolveFallbackLanOrigin = (proto, explicitPort) => {
      const targetPort = explicitPort || String(getActualPort());
      if (lanIpv4) return `${proto}://${lanIpv4}:${targetPort}`;
      if (lanUla6) return `${proto}://[${lanUla6}]:${targetPort}`;
      return null;
    };

    if (raw) {
      let parsed;
      try {
        parsed = new URL(raw);
      } catch (_) {
        const err = new Error('Invalid Companion URL');
        err.status = 400;
        err.errorCode = 'invalid_request';
        throw err;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        const err = new Error('Companion URL must use HTTP or HTTPS');
        err.status = 400;
        err.errorCode = 'invalid_request';
        throw err;
      }
      if (forHandoff) {
        validateInitialUrl(parsed.toString(), POLICY_PRIVATE_LAN_ONLY, { selfPort: getActualPort() });
      }
      return parsed.toString().replace(/\/+$/, '');
    }

    const origin = getEffectiveRequestOrigin(req);
    if (!origin) {
      const err = new Error('Malformed Host or X-Forwarded-Host header');
      err.status = 400;
      err.errorCode = 'invalid_request';
      throw err;
    }
    const parsed = new URL(origin);
    const hostClean = stripBrackets(parsed.hostname);
    const isLoopback = isSyntacticLoopbackHost(hostClean) || (net.isIP(hostClean) && isLoopbackIp(hostClean));

    if (isLoopback) {
      const rewritten = resolveFallbackLanOrigin(parsed.protocol.slice(0, -1), parsed.port);
      if (rewritten) return rewritten.replace(/\/+$/, '');
      if (forHandoff) {
        const err = new Error('No private LAN address is available for device handoff.');
        err.status = 503;
        err.errorCode = 'local_network_unavailable';
        throw err;
      }
      return parsed.origin.replace(/\/+$/, '');
    }

    if (forHandoff) {
      const lowerHost = hostClean.toLowerCase().replace(/\.+$/, '');
      const isPrivateIp = net.isIP(hostClean) && isPrivateOrLanIp(hostClean, { allowCgnat: true });
      const isLanHostname =
        !net.isIP(hostClean) &&
        (lowerHost.endsWith('.local') || lowerHost.endsWith('.home.arpa') || lowerHost.endsWith('.lan'));
      if (isPrivateIp || isLanHostname) {
        return parsed.origin.replace(/\/+$/, '');
      }
      const lanFallback = resolveFallbackLanOrigin('http', String(getActualPort()));
      if (lanFallback) return lanFallback.replace(/\/+$/, '');
      const err = new Error('No private LAN address is available for device handoff.');
      err.status = 503;
      err.errorCode = 'local_network_unavailable';
      throw err;
    }

    return parsed.origin.replace(/\/+$/, '');
  }

  // Cooldowns & bounded state maps
  let lastShareDiscoverAt = 0;
  let lastTvDiscoverAt = 0;
  const fcastWsTickets = new Map(); // ticket -> expiresAtMs
  const MAX_FCAST_WS_TICKETS = 32;
  const activeRegisteredFCastReceivers = new Map(); // id -> { ip, port, name, lastSeen }
  const activeMdnsFCastReceivers = new Map(); // id -> { ip, port, name, lastSeen }
  const MAX_REGISTERED_FCAST_RECEIVERS = 64;
  const recentHandoffAttempts = new Map(); // key -> expiresAtMs (max 32, 75s TTL)
  const MAX_RECENT_HANDOFF_ATTEMPTS = 32;
  const RECENT_HANDOFF_TTL_MS = 75_000;

  // WebSocket pools & throttling
  const adminSyncWss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const fcastWss = new WebSocketServer({ noServer: true, maxPayload: MAX_FCAST_FRAME_BYTES });
  const activeFcastConnections = new Set(); // cleanup functions
  const wsRejectBuckets = new Map(); // ipBucket -> { count, resetAt }
  const MAX_WS_REJECT_BUCKETS = 1024;
  const fcastConnCountByBucket = new Map();
  const adminConnCountByBucket = new Map();

  function recordWsRejection(bucket) {
    const now = Date.now();
    const rec = wsRejectBuckets.get(bucket);
    if (rec && rec.resetAt > now) {
      rec.count += 1;
      // Refresh LRU order
      wsRejectBuckets.delete(bucket);
      wsRejectBuckets.set(bucket, rec);
      return rec.count;
    }
    if (wsRejectBuckets.size >= MAX_WS_REJECT_BUCKETS) {
      for (const [k, v] of wsRejectBuckets.entries()) {
        if (v.resetAt <= now) wsRejectBuckets.delete(k);
      }
      if (wsRejectBuckets.size >= MAX_WS_REJECT_BUCKETS) {
        const oldestKey = wsRejectBuckets.keys().next().value;
        if (oldestKey !== undefined) wsRejectBuckets.delete(oldestKey);
      }
    }
    wsRejectBuckets.set(bucket, { count: 1, resetAt: now + 60_000 });
    return 1;
  }

  function isWsBucketThrottled(bucket) {
    const now = Date.now();
    const rec = wsRejectBuckets.get(bucket);
    if (!rec) return false;
    if (rec.resetAt <= now) {
      wsRejectBuckets.delete(bucket);
      return false;
    }
    return rec.count >= 20;
  }

  function broadcastAdminEvent(message, { includeSetupTokenClients = false } = {}) {
    const encoded = JSON.stringify(message);
    for (const client of adminSyncWss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (!includeSetupTokenClients && client._authType === 'setup_token') continue;
      if (client._authType === 'session' && !storage.isAdminSessionValid(client._sessionToken)) {
        closeWithTerminateFailsafe(client, 4401, 1_000);
        continue;
      }
      if (client.bufferedAmount > MAX_ADMIN_WS_BUFFER) {
        closeWithTerminateFailsafe(client, 4008, 1_000);
        continue;
      }
      try {
        client.send(encoded);
      } catch (_) {}
    }
  }

  function broadcastConfigChanged(deviceId = null) {
    broadcastAdminEvent(
      { type: 'config_changed', deviceId, targetDeviceId: deviceId },
      { includeSetupTokenClients: true }
    );
  }

  function revokeSetupTokenWebSockets() {
    fcastWsTickets.clear();
    for (const cleanup of Array.from(activeFcastConnections)) {
      try { cleanup(4401); } catch (_) {}
    }
    for (const client of adminSyncWss.clients) {
      if (client._authType === 'setup_token') {
        closeWithTerminateFailsafe(client, 4401, 1_000);
      }
    }
  }

  function revokeSessionWebSockets(sessionToken) {
    if (!sessionToken) return;
    for (const client of adminSyncWss.clients) {
      if (client._authType === 'session' && client._sessionToken === sessionToken) {
        closeWithTerminateFailsafe(client, 4401, 1_000);
      }
    }
  }

  function revokeLoopbackUnconfiguredWebSockets() {
    for (const client of adminSyncWss.clients) {
      if (client._authType === 'loopback_unconfigured') {
        closeWithTerminateFailsafe(client, 4401, 1_000);
      }
    }
  }

  // Analytics & Jellyfin realtime socket state
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
    websocketLastMessageAt: null,
  };
  const jellyfinRealtimeSockets = new Map();
  const relinkDebounceTimers = new Map();

  function cancelPendingRelink(serverId, userId) {
    const key = `${serverId || ''}:${userId || ''}`;
    const timer = relinkDebounceTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      relinkDebounceTimers.delete(key);
    }
  }

  function scheduleMarkUserNeedsRelink(serverId, userId, failedTokenDigest) {
    if (!serverId || !userId || !failedTokenDigest) return;
    const key = `${serverId}:${userId}`;
    if (relinkDebounceTimers.has(key)) return;
    const timer = setTimeout(() => {
      relinkDebounceTimers.delete(key);
      withConfigLock(async () => {
        const draft = structuredClone(appConfig);
        const srv = findConfigServerByIdInConfig(draft, serverId);
        if (!srv || !Array.isArray(srv.users)) return;
        const user = srv.users.find(
          (u) => u && ((u.id && normalizeId(u.id) === normalizeId(userId)) || u.username === userId)
        );
        if (!user || user.needs_relink === true || !user.access_token) return;
        if (sha256Hex(user.access_token) !== failedTokenDigest) return;
        user.needs_relink = true;
        appConfig = storage.saveConfig(draft, {
          reason: 'user-needs-relink',
          eventType: 'user_needs_relink',
          details: { serverId: srv.id, userId: user.id || user.username },
        });
        broadcastConfigChanged();
        reconcileJellyfinRealtimeSockets();
      }).catch((err) => {
        console.warn('[relink] Failed to mark user needs_relink:', err?.message || err);
      });
    }, 1_500);
    if (typeof timer.unref === 'function') timer.unref();
    relinkDebounceTimers.set(key, timer);
  }

  async function safeHttpJson(urlStr, {
    method = 'GET',
    body,
    headers = {},
    timeoutMs = 5_000,
    signal,
    policy = POLICY_PUBLIC_OR_LAN,
    maxRedirects = 5,
    allowCrossOriginRedirects,
    allowLoopback = allowLoopbackUpstreams,
    maxResponseBytes = 1024 * 1024,
  } = {}) {
    const reqHeaders = { ...headers };
    let serializedBody = undefined;
    if (body !== undefined) {
      serializedBody = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
      if (!reqHeaders['Content-Type'] && !reqHeaders['content-type']) {
        reqHeaders['Content-Type'] = 'application/json';
      }
    }
    const res = await fetchImpl(urlStr, {
      method,
      headers: reqHeaders,
      body: serializedBody,
      timeoutMs,
      signal,
      policy,
      maxRedirects,
      allowCrossOriginRedirects,
      allowLoopback,
      legacyLoopbackAllowlist,
      selfPort: getActualPort(),
      maxResponseBytes,
      dnsLookup,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { data = text; }
    return { status: res.status, data, headers: res.headers, url: res.url };
  }

  function findConfigServerByIdInConfig(cfg, serverId) {
    if (!serverId || !cfg || !Array.isArray(cfg.servers)) return null;
    const norm = normalizeId(serverId);
    return (
      cfg.servers.find((server) => {
        if (!server) return false;
        if (server.id === serverId || normalizeId(server.id) === norm) return true;
        if (Array.isArray(server.legacy_ids)) {
          return server.legacy_ids.some((lid) => lid === serverId || normalizeId(lid) === norm);
        }
        return false;
      }) || null
    );
  }

  function findConfigServerById(serverId) {
    return findConfigServerByIdInConfig(appConfig, serverId);
  }

  function findVerifiedUserForServer(serverId, preferredUserId, preferredUsername) {
    const server = findConfigServerById(serverId);
    if (!server || !Array.isArray(server.users)) return { server: null, user: null };
    const candidates = server.users.filter((user) => user && user.access_token && user.needs_relink !== true);
    const exact = candidates.find(
      (user) =>
        (preferredUserId && user.id && normalizeId(user.id) === normalizeId(preferredUserId)) ||
        (preferredUsername && (user.username === preferredUsername || user.name === preferredUsername))
    );
    return { server, user: exact || candidates[0] || null };
  }

  function findExactUserForServer(serverId, userId, username = null) {
    const server = findConfigServerById(serverId);
    if (!server) return { server: null, user: null };
    const users = Array.isArray(server.users) ? server.users : [];
    const user = users.find((u) => {
      if (!u) return false;
      if (userId && u.id && normalizeId(u.id) === normalizeId(userId)) return true;
      if (username && String(u.username || u.name || '').toLowerCase() === String(username).toLowerCase()) return true;
      return false;
    }) || null;
    return { server, user };
  }

  async function verifyServerIdentityFor401(serverConfig, baseUrl) {
    if (!serverConfig || !serverConfig.id || isLegacySyntheticServerId(serverConfig.id)) {
      return true;
    }
    try {
      const info = await safeHttpJson(`${baseUrl}/System/Info/Public`, {
        timeoutMs: 3_000,
        policy: POLICY_PUBLIC_OR_LAN,
        maxRedirects: 0,
      });
      if (info.status !== 200 || !info.data || !info.data.Id) return false;
      return normalizeId(info.data.Id) === normalizeId(serverConfig.id);
    } catch (_) {
      return false;
    }
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
      headers: { 'user-agent': source || 'companion-analytics-sync' },
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
        deviceName: session.DeviceName || null,
      },
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
      lastRefreshedAt: new Date().toISOString(),
    };
  }

  const JELLYFIN_METADATA_CACHE_TTL_MS = Math.max(60_000, Number(process.env.COMPANION_ITEM_METADATA_TTL_MS) || 30 * 60_000);
  const JELLYFIN_METADATA_NEGATIVE_TTL_MS = Math.max(30_000, Number(process.env.COMPANION_ITEM_METADATA_NEGATIVE_TTL_MS) || 5 * 60_000);
  const JELLYFIN_METADATA_CACHE_MAX = 2000;
  const jellyfinItemMetadataCache = new Map();

  function metadataCacheKey(serverId, itemId) {
    return `${serverId || 'server'}:${itemId}`;
  }
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
    jellyfinItemMetadataCache.set(key, { value, expiresAt: Date.now() + JELLYFIN_METADATA_CACHE_TTL_MS });
  }
  function setCachedItemMetadataNegative(serverConfig, itemId) {
    const key = metadataCacheKey(serverConfig && serverConfig.id, itemId);
    if (jellyfinItemMetadataCache.size >= JELLYFIN_METADATA_CACHE_MAX) {
      const firstKey = jellyfinItemMetadataCache.keys().next().value;
      if (firstKey) jellyfinItemMetadataCache.delete(firstKey);
    }
    jellyfinItemMetadataCache.set(key, { value: null, negative: true, expiresAt: Date.now() + JELLYFIN_METADATA_NEGATIVE_TTL_MS });
  }

  async function fetchJellyfinItemMetadata(serverConfig, userConfig, itemId) {
    const baseUrl = String((serverConfig.addresses && serverConfig.addresses[0]) || '').replace(/\/+$/, '');
    const token = userConfig && userConfig.access_token;
    if (!baseUrl || !token || !itemId) return null;
    const cached = getCachedItemMetadata(serverConfig, itemId);
    if (cached.hit) return cached.value;

    const encodedItemId = encodeURIComponent(itemId);
    const userId = userConfig.id ? encodeURIComponent(userConfig.id) : null;
    const itemPath = userId ? `/Users/${userId}/Items/${encodedItemId}` : `/Items/${encodedItemId}`;
    const query = 'Fields=Overview,PrimaryImageAspectRatio,PremiereDate,ProductionYear,CommunityRating,OfficialRating,Genres,RunTimeTicks,SeriesName,SeasonName,ImageTags,BackdropImageTags,ImageBlurHashes';
    const result = await safeHttpJson(`${baseUrl}${itemPath}?${query}`, {
      headers: buildJellyfinAuthHeaders(token),
      timeoutMs: 10_000,
    });
    if (result.status !== 200 || !result.data || typeof result.data !== 'object') {
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
    if (storage.isVacuumInFlight()) return { accepted: 0 };
    const list = Array.isArray(sessions) ? sessions.filter((s) => s && s.itemId) : [];
    if (!list.length) return { accepted: 0 };
    const unique = new Map();
    list.forEach((session) => {
      const key = `${serverConfig.id || 'server'}:${session.itemId}`;
      if (!unique.has(key)) unique.set(key, session.itemId);
    });
    const entries = [];
    for (const itemId of unique.values()) {
      if (getCachedItemMetadata(serverConfig, itemId).negative) continue;
      try {
        const metadata = await fetchJellyfinItemMetadata(serverConfig, userConfig, itemId);
        if (metadata) entries.push(metadata);
      } catch (error) {
        console.warn('Metadata enrichment failed:', serverConfig.name || serverConfig.id, itemId, scrubApiKeyFromText(error.message));
      }
    }
    if (storage.isVacuumInFlight() || entries.length === 0) return { accepted: 0 };
    return storage.upsertMediaItemMetadata(entries);
  }

  async function fetchJellyfinSessions(serverConfig, userConfig) {
    const addresses = Array.isArray(serverConfig.addresses) ? serverConfig.addresses.filter(Boolean) : [];
    const token = userConfig && userConfig.access_token;
    if (!addresses.length || !token) return [];

    let lastError = null;
    let saw401OnVerifiedServer = false;
    for (const rawAddr of addresses) {
      const baseUrl = String(rawAddr).replace(/\/+$/, '');
      try {
        const result = await safeHttpJson(`${baseUrl}/Sessions`, {
          headers: buildJellyfinAuthHeaders(token),
          timeoutMs: 10_000,
        });
        if (result.status === 200 && Array.isArray(result.data)) {
          return result.data
            .map((session) => normalizeJellyfinSession(serverConfig, userConfig, session))
            .filter(Boolean);
        }
        if (result.status === 401) {
          const confirmed = await verifyServerIdentityFor401(serverConfig, baseUrl);
          if (confirmed) saw401OnVerifiedServer = true;
          lastError = new Error(`Session fetch failed for ${serverConfig.name || baseUrl}: HTTP 401`);
          continue;
        }
        lastError = new Error(`Session fetch failed for ${serverConfig.name || baseUrl}: HTTP ${result.status}`);
      } catch (err) {
        lastError = err;
      }
    }

    if (saw401OnVerifiedServer) {
      scheduleMarkUserNeedsRelink(serverConfig.id, userConfig.id || userConfig.username, sha256Hex(token));
    }
    throw lastError || new Error(`Session fetch failed for ${serverConfig.name || serverConfig.id}`);
  }

  function buildJellyfinSocketKey(serverConfig, userConfig) {
    return `${serverConfig.id || serverConfig.name || 'server'}:${userConfig.id || userConfig.username || userConfig.name || 'user'}`;
  }

  function buildJellyfinSocketUrl(serverConfig, userConfig) {
    const baseUrl = String((serverConfig.addresses && serverConfig.addresses[0]) || '').replace(/\/+$/, '');
    const token = String((userConfig && userConfig.access_token) || '').trim();
    if (!baseUrl || !token) return null;
    const wsBase = baseUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
    const deviceId = encodeURIComponent(`spatialfin-companion-${storage.getInstanceId()}`);
    return `${wsBase}/socket?deviceId=${deviceId}`;
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
        lastError: entry.lastError ? scrubApiKeyFromText(entry.lastError) : null,
        url: entry.displayUrl || null,
      }))
      .sort((left, right) => {
        const connectedDelta = Number(right.connected) - Number(left.connected);
        if (connectedDelta !== 0) return connectedDelta;
        return String(left.serverName || left.serverId || left.key).localeCompare(
          String(right.serverName || right.serverId || right.key)
        );
      });
  }

  function canonicalizeAnalyticsServerId(rawServerId) {
    if (!rawServerId) return rawServerId;
    const match = findConfigServerById(rawServerId);
    return match ? match.id : rawServerId;
  }

  function canonicalizeAnalyticsSession(session) {
    if (!session || typeof session !== 'object') return session;
    const rawId = session.serverId || session.server_id || null;
    if (!rawId) return session;
    const canonicalId = canonicalizeAnalyticsServerId(rawId);
    if (!canonicalId || canonicalId === rawId) return session;
    const copy = { ...session };
    if (copy.serverId !== undefined) copy.serverId = canonicalId;
    if (copy.server_id !== undefined) copy.server_id = canonicalId;
    if (typeof copy.playbackSessionId === 'string' && copy.playbackSessionId.startsWith(`${rawId}:`)) {
      copy.playbackSessionId = `${canonicalId}:${copy.playbackSessionId.slice(rawId.length + 1)}`;
    }
    return copy;
  }

  function scheduleSocketScopeRefresh(entry, reason) {
    if (!entry || entry.aborted) return;
    if (entry.refreshTimer) clearTimeout(entry.refreshTimer);
    entry.refreshTimer = setTimeout(async () => {
      entry.refreshTimer = null;
      if (entry.aborted || storage.isVacuumInFlight()) return;
      try {
        const rawSessions = await fetchJellyfinSessions(entry.serverConfig, entry.userConfig);
        if (entry.aborted || storage.isVacuumInFlight()) return;
        const sessions = rawSessions.map(canonicalizeAnalyticsSession);
        const activePlaybackSessionIds = sessions.map((session) => session.playbackSessionId);
        let result = { accepted: 0, totalSessions: storage.getAnalyticsOverview().totalSessions };
        await enrichSessionsWithItemMetadata(entry.serverConfig, entry.userConfig, sessions);
        if (entry.aborted || storage.isVacuumInFlight()) return;
        if (sessions.length > 0) {
          result = storage.upsertPlaybackSessions({ sessions }, buildAnalyticsRequestContext('companion-analytics-websocket'));
        }
        const canonicalServerId = canonicalizeAnalyticsServerId(entry.serverConfig.id || null);
        const closedResult = storage.closeMissingPlaybackSessions({
          serverId: canonicalServerId,
          userId: entry.userConfig.id || null,
          username: entry.userConfig.username || entry.userConfig.name || null,
          activePlaybackSessionIds,
          endedAt: new Date().toISOString(),
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
          polledUsers: analyticsSyncState.polledUsers,
        });
        storage.recordEvent('analytics_websocket_refresh', null, {
          reason,
          serverId: canonicalServerId,
          username: entry.userConfig.username || entry.userConfig.name || null,
          accepted: analyticsSyncState.accepted,
          closed: analyticsSyncState.closed,
        });
      } catch (error) {
        console.warn('Analytics websocket refresh failed:', entry.serverConfig.name || entry.serverConfig.id, scrubApiKeyFromText(error.message));
      }
    }, 800);
    if (typeof entry.refreshTimer.unref === 'function') entry.refreshTimer.unref();
  }

  function looksLikePlaybackMessage(messageType) {
    const normalized = String(messageType || '').toLowerCase();
    return (
      normalized.includes('session') ||
      normalized.includes('play') ||
      normalized.includes('progress') ||
      normalized.includes('pause') ||
      normalized.includes('stop')
    );
  }

  function extractRealtimeSessionsFromMessage(serverConfig, userConfig, payload) {
    const sources = [];
    if (Array.isArray(payload)) sources.push(payload);
    if (Array.isArray(payload?.Data)) sources.push(payload.Data);
    if (Array.isArray(payload?.data)) sources.push(payload.data);
    if (Array.isArray(payload?.MessageData)) sources.push(payload.MessageData);
    if (payload?.Data && typeof payload.Data === 'object' && Array.isArray(payload.Data.Items)) sources.push(payload.Data.Items);
    if (payload?.data && typeof payload.data === 'object' && Array.isArray(payload.data.Items)) sources.push(payload.data.Items);
    if (payload?.Data && typeof payload.Data === 'object' && (payload.Data.NowPlayingItem || payload.Data.NowPlayingItemDto)) sources.push([payload.Data]);
    if (payload?.data && typeof payload.data === 'object' && (payload.data.NowPlayingItem || payload.data.NowPlayingItemDto)) sources.push([payload.data]);

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
    const displayUrl = buildJellyfinSocketUrl(serverConfig, userConfig);
    const key = buildJellyfinSocketKey(serverConfig, userConfig);
    if (!displayUrl) return;
    const tokenDigest = sha256Hex(userConfig.access_token || '');

    const existing = jellyfinRealtimeSockets.get(key);
    if (existing && existing.displayUrl === displayUrl && existing.tokenDigest === tokenDigest) return;
    if (existing) {
      existing.aborted = true;
      existing.closedManually = true;
      if (existing.refreshTimer) clearTimeout(existing.refreshTimer);
      if (existing.reconnectTimer) clearTimeout(existing.reconnectTimer);
      try { existing.socket && existing.socket.close(); } catch (_) {}
    }

    // Pre-validate initial URL and literal IPs against PUBLIC_OR_LAN before opening WebSocket
    const httpEquivalent = displayUrl.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:');
    let validated;
    try {
      validated = validateInitialUrl(httpEquivalent, POLICY_PUBLIC_OR_LAN, {
        allowLoopback: allowLoopbackUpstreams,
        legacyLoopbackAllowlist,
        selfPort: getActualPort(),
      });
    } catch (err) {
      const blockedEntry = {
        key,
        displayUrl,
        tokenDigest,
        serverConfig,
        userConfig,
        socket: null,
        connected: false,
        reconnectAttempt: 0,
        reconnectTimer: null,
        refreshTimer: null,
        closedManually: true,
        aborted: true,
        disabled: true,
        lastError: scrubApiKeyFromText(err.message),
        messageCount: 0,
        lastMessageAt: null,
      };
      jellyfinRealtimeSockets.set(key, blockedEntry);
      refreshRealtimeSocketSummary();
      return;
    }

    const entry = {
      key,
      displayUrl,
      tokenDigest,
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
      lastError: null,
      messageCount: 0,
      lastMessageAt: null,
    };
    jellyfinRealtimeSockets.set(key, entry);
    refreshRealtimeSocketSummary();

    const open = () => {
      if (entry.aborted || entry.disabled) return;
      if (jellyfinRealtimeSockets.get(key) !== entry) {
        entry.aborted = true;
        return;
      }
      const socket = new WebSocket(displayUrl, {
        lookup: createPinnedLookup({
          policy: POLICY_PUBLIC_OR_LAN,
          port: validated.port,
          hostname: validated.hostname,
          allowLoopback: validated.allowLoopback,
          selfPort: getActualPort(),
          dnsLookup,
        }),
        headers: buildJellyfinAuthHeaders(userConfig.access_token),
        followRedirects: false,
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
        if (entry.aborted) return;
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
        if (entry.aborted || storage.isVacuumInFlight()) return;

        const messageType = payload.MessageType || payload.messageType || payload.Type || payload.type || '';
        const rawSessions = extractRealtimeSessionsFromMessage(serverConfig, userConfig, payload);
        if (rawSessions.length > 0) {
          try {
            await enrichSessionsWithItemMetadata(serverConfig, userConfig, rawSessions);
          } catch (error) {
            console.warn('Realtime metadata enrichment failed:', serverConfig.name || serverConfig.id, scrubApiKeyFromText(error.message));
          }
          if (entry.aborted) return;
          const sessions = rawSessions.map(canonicalizeAnalyticsSession);
          if (!storage.isVacuumInFlight()) {
            try {
              const result = storage.upsertPlaybackSessions({ sessions }, buildAnalyticsRequestContext('companion-analytics-websocket'));
              analyticsSyncState.accepted = result.accepted || 0;
              analyticsSyncState.totalSessions = result.totalSessions || analyticsSyncState.totalSessions || 0;
              analyticsSyncState.lastSuccessAt = new Date().toISOString();
              broadcastAdminEvent({
                type: 'analytics_sessions_ingested',
                accepted: result.accepted || 0,
                totalSessions: analyticsSyncState.totalSessions,
              });
            } catch (error) {
              analyticsSyncState.lastError = scrubApiKeyFromText(error.message);
            }
          }
        }

        if (!entry.aborted && looksLikePlaybackMessage(messageType)) {
          scheduleSocketScopeRefresh(entry, `websocket:${messageType || 'message'}`);
        }
      });

      socket.on('unexpected-response', (_req, response) => {
        const status = response && response.statusCode;
        if (status === 401 || status === 403) {
          entry.disabled = true;
          entry.lastError = `WebSocket auth failed (HTTP ${status})`;
          refreshRealtimeSocketSummary();
          if (status === 401) {
            const baseUrl = String((serverConfig.addresses && serverConfig.addresses[0]) || '').replace(/\/+$/, '');
            verifyServerIdentityFor401(serverConfig, baseUrl).then((confirmed) => {
              if (confirmed) {
                scheduleMarkUserNeedsRelink(serverConfig.id, userConfig.id || userConfig.username, tokenDigest);
              }
            }).catch(() => {});
          }
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
        if (typeof entry.reconnectTimer.unref === 'function') entry.reconnectTimer.unref();
      });

      socket.on('error', (error) => {
        entry.connected = false;
        const cleanMsg = scrubApiKeyFromText(error.message);
        entry.lastError = cleanMsg;
        analyticsSyncState.lastError = cleanMsg;
        refreshRealtimeSocketSummary();
      });
    };

    open();
  }

  let reconcileInFlight = false;
  let reconcilePending = false;
  function reconcileJellyfinRealtimeSockets() {
    if (!enableBackgroundTasks) return;
    if (reconcileInFlight) {
      reconcilePending = true;
      return;
    }
    reconcileInFlight = true;
    try {
      const desiredKeys = new Set();
      const servers = Array.isArray(appConfig.servers) ? appConfig.servers : [];
      servers.forEach((server) => {
        const users = Array.isArray(server.users) ? server.users.filter((user) => user && user.access_token && !user.needs_relink) : [];
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
    if (storage.isVacuumInFlight()) {
      return { skipped: true, reason: 'maintenance-in-progress', state: analyticsSyncState };
    }
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
      const snapshotServers = Array.isArray(appConfig.servers) ? structuredClone(appConfig.servers) : [];
      for (const server of snapshotServers) {
        const users = Array.isArray(server.users) ? server.users.filter((user) => user && user.access_token && !user.needs_relink) : [];
        if (!users.length) continue;
        polledServers += 1;
        for (const user of users) {
          polledUsers += 1;
          try {
            const rawSessions = await fetchJellyfinSessions(server, user);
            if (storage.isVacuumInFlight()) {
              return { skipped: true, reason: 'maintenance-in-progress', state: analyticsSyncState };
            }
            await enrichSessionsWithItemMetadata(server, user, rawSessions);
            const sessions = rawSessions.map(canonicalizeAnalyticsSession);
            collectedSessions.push(...sessions);
            const activePlaybackSessionIds = sessions.map((session) => session.playbackSessionId);
            const closedResult = storage.closeMissingPlaybackSessions({
              serverId: canonicalizeAnalyticsServerId(server.id || null),
              userId: user.id || null,
              username: user.username || user.name || null,
              activePlaybackSessionIds,
              endedAt: new Date().toISOString(),
            });
            closedSessions += closedResult.closed || 0;
          } catch (error) {
            console.warn('Analytics sync user poll failed:', server.name || server.id, scrubApiKeyFromText(error.message));
          }
        }
      }

      if (storage.isVacuumInFlight()) {
        return { skipped: true, reason: 'maintenance-in-progress', state: analyticsSyncState };
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
        polledUsers,
      });

      broadcastAdminEvent({
        type: 'analytics_sync_completed',
        accepted: analyticsSyncState.accepted,
        closed: analyticsSyncState.closed,
        totalSessions: analyticsSyncState.totalSessions,
        polledServers,
        polledUsers,
      });

      return { skipped: false, state: analyticsSyncState };
    } catch (error) {
      const cleanMsg = scrubApiKeyFromText(error.message);
      analyticsSyncState.lastError = cleanMsg;
      storage.recordEvent('analytics_sync_failed', null, { reason, error: cleanMsg });
      return { skipped: false, state: analyticsSyncState, error };
    } finally {
      analyticsSyncState.running = false;
    }
  }

  // ---------------------------------------------------------------------------
  // SMB / NFS pinned probe & discovery helpers
  // ---------------------------------------------------------------------------
  function extractCommandErrorOutput(error) {
    if (!error) return '';
    return [error.stderr, error.stdout, error.message]
      .filter((value) => typeof value === 'string' && value.trim().length > 0)
      .join('\n')
      .trim();
  }

  function normalizeOptionalPort(value, fallbackPort) {
    const portNum = Number(value);
    if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) return fallbackPort;
    return portNum;
  }

  function validateSmbSafeField(value, fieldName, allowSlash = false) {
    const str = String(value || '');
    if (!str) return '';
    if (str.startsWith('-')) {
      throw new Error(`Invalid ${fieldName}: cannot start with '-'`);
    }
    const pattern = allowSlash ? /[;"'`$|\r\n\0]/ : /[/\\;"'`$|\r\n\0]/;
    if (pattern.test(str)) {
      throw new Error(`Invalid ${fieldName}: contains disallowed characters`);
    }
    return str;
  }

  function encodeIpv6UncServer(ipv6) {
    return `${stripBrackets(ipv6).replace(/:/g, '-')}.ipv6-literal.net`;
  }

  function buildSmbUncServer(pinned) {
    if (!pinned.isLiteral) return pinned.hostname;
    if (pinned.family === 6) return encodeIpv6UncServer(pinned.address);
    return pinned.address;
  }

  function createSmbAuthFile({ username, password, domain }) {
    if (/[\r\n\0]/.test(username) || /[\r\n\0]/.test(password) || /[\r\n\0]/.test(domain)) {
      throw new Error('SMB credentials contain invalid control characters.');
    }
    const authFile = path.join(storage.dataDir, `.smb-auth-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
    const lines = [`username=${username}`, `password=${password}`];
    if (domain) lines.push(`domain=${domain}`);
    fs.writeFileSync(authFile, `${lines.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
    return authFile;
  }

  async function testSmbShareConnectionWithSmbClient(share, pinned) {
    const shareName = validateSmbSafeField(share.shareName, 'shareName', false);
    const domain = validateSmbSafeField(share.domain || '', 'domain', false);
    const probePath = validateSmbSafeField(normalizeShareRelativePath(share.path), 'path', true);
    const username = String(share.username || '').trim();
    const password = String(share.password || '');
    const uncServer = buildSmbUncServer(pinned);

    const args = [`//${uncServer}/${shareName}`, '-I', pinned.address, '-g', '-c', 'ls'];
    let authFile = null;
    try {
      if (!username && !password) {
        args.push('-N');
      } else {
        authFile = createSmbAuthFile({ username, password, domain });
        args.push('--authentication-file', authFile);
      }
      if (domain && !authFile) {
        args.push('-W', domain);
      }
      if (share.port && share.port !== 445) {
        args.push('-p', String(share.port));
      }
      if (probePath) {
        args.push('-D', probePath);
      }

      const { stdout } = await execFileAsync('smbclient', args, { timeout: 15_000 });
      const files = parseSmbClientListing(stdout);
      return {
        targetPath: probePath || '\\',
        fileCount: files.length,
        sample: files.slice(0, 5),
      };
    } finally {
      if (authFile) {
        try { fs.unlinkSync(authFile); } catch (_) {}
      }
    }
  }

  async function testSmbShareConnectionViaProbe(share, pinned) {
    if (pinned.family === 6) {
      throw new Error('SMB fallback probe does not support IPv6 targets (smbclient is required).');
    }
    const probePath = normalizeShareRelativePath(share.path);
    const payload = JSON.stringify({
      host: pinned.address,
      shareName: share.shareName,
      username: share.username,
      password: share.password,
      domain: share.domain,
      port: share.port || 445,
      path: probePath,
    });

    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--openssl-legacy-provider', path.join(__dirname, 'smb-probe.js')],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      );
      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGKILL'); } catch (_) {}
        reject(new Error('SMB test timed out.'));
      }, 15_000);
      if (typeof timer.unref === 'function') timer.unref();

      child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
      child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
      child.once('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const trimmed = stdout.trim();
        let parsed = null;
        if (trimmed) {
          try { parsed = JSON.parse(trimmed); } catch (_) {}
        }
        if (code === 0 && parsed && parsed.ok) {
          resolve({
            targetPath: parsed.targetPath || '\\',
            fileCount: Number(parsed.fileCount) || 0,
            sample: Array.isArray(parsed.sample) ? parsed.sample : [],
          });
          return;
        }
        const err = new Error((parsed && parsed.message) || stderr.trim() || 'Unknown SMB error');
        if (parsed && parsed.code) err.code = parsed.code;
        reject(err);
      });

      child.stdin.end(payload);
    });
  }

  async function testSmbShareConnection(share) {
    const pinned = await validateLanHost(share.host, { port: share.port || 445, selfPort: getActualPort(), dnsLookup });
    let smbclientError = null;
    try {
      return await testSmbShareConnectionWithSmbClient(share, pinned);
    } catch (error) {
      if (error instanceof SsrfBlockedError) throw error;
      smbclientError = error;
    }

    if (pinned.family === 6) {
      throw smbclientError;
    }
    try {
      return await testSmbShareConnectionViaProbe(share, pinned);
    } catch (probeError) {
      if (smbclientError && smbclientError.code !== 'ENOENT') throw smbclientError;
      throw probeError;
    }
  }

  function checkTcpPort(pinnedIp, portNum, timeoutMs = 5_000) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: pinnedIp, port: portNum });
      const cleanup = () => {
        socket.removeAllListeners('connect');
        socket.removeAllListeners('timeout');
        socket.removeAllListeners('error');
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => { cleanup(); socket.end(); resolve(); });
      socket.once('timeout', () => { cleanup(); socket.destroy(); reject(new Error(`Connection to ${pinnedIp}:${portNum} timed out.`)); });
      socket.once('error', (error) => { cleanup(); socket.destroy(); reject(error); });
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

  async function queryNfsExports(host, pinnedOverride = null) {
    const pinned = pinnedOverride || (await validateLanHost(host, { port: 2049, selfPort: getActualPort(), dnsLookup }));
    try {
      const exportsList = await queryNfsExportsViaRpc(pinned.address, 12_000, { pinnedHost: pinned });
      if (exportsList.length > 0) {
        return {
          exports: exportsList.map((e) => normalizeNfsExportPath(e.path, { allowRoot: true })).filter(Boolean),
          warning: null,
        };
      }
    } catch (error) {
      if (error instanceof SsrfBlockedError) throw error;
      const detail = extractCommandErrorOutput(error);
      if (/Mount daemon is not registered/i.test(detail)) {
        return {
          exports: [],
          warning: 'Export discovery unavailable because this NFS server is reachable on port 2049 but does not expose mountd/rpcbind for export enumeration.',
        };
      }
    }

    try {
      const { stdout } = await execFileAsync('showmount', ['-e', pinned.address], { timeout: 12_000 });
      return { exports: parseShowmountExports(stdout), warning: null };
    } catch (error) {
      const fallbackExports = parseShowmountExports(error && error.stdout ? error.stdout : '');
      if (fallbackExports.length > 0) return { exports: fallbackExports, warning: null };
      if (error && error.code === 'ENOENT') {
        return { exports: [], warning: 'Export discovery unavailable because showmount is not installed.' };
      }
      const detail = extractCommandErrorOutput(error);
      if (/Program not registered|RPC:/i.test(detail)) {
        return {
          exports: [],
          warning: 'Export discovery unavailable because this NFS server is reachable on port 2049 but does not expose mountd/rpcbind for export enumeration.',
        };
      }
      if (/timed out/i.test(detail)) {
        return { exports: [], warning: 'Export discovery timed out. Verified the NFS service port only.' };
      }
      return { exports: [], warning: detail || 'Export discovery unavailable. Verified the NFS service port only.' };
    }
  }

  async function testNfsShareConnection(share) {
    const portNum = share.port || 2049;
    const pinned = await validateLanHost(share.host, { port: portNum, selfPort: getActualPort(), dnsLookup });
    const targetPath = buildNetworkShareTargetPath(share);
    const requestedExport = normalizeNfsExportPath(share.shareName, { allowRoot: true }) || '/';

    await checkTcpPort(pinned.address, portNum);
    const exportInfo = await queryNfsExports(share.host, pinned);
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
      exportVerified: exportInfo.exports.length > 0,
    };
  }

  async function listSmbServerShares(opts) {
    const host = String(opts && opts.host ? opts.host : '').trim();
    if (!host) throw new Error('SMB host is required.');
    const portNum = normalizeOptionalPort(opts && opts.port, 445);
    const pinned = await validateLanHost(host, { port: portNum, selfPort: getActualPort(), dnsLookup });

    const username = String(opts && opts.username ? opts.username : '').trim();
    const password = typeof (opts && opts.password) === 'string' ? opts.password : '';
    const domain = validateSmbSafeField(String(opts && opts.domain ? opts.domain : '').trim(), 'domain', false);
    const uncServer = buildSmbUncServer(pinned);
    const args = ['-g', '-L', `//${uncServer}`, '-I', pinned.address];

    let authFile = null;
    try {
      if (!username && !password) {
        args.push('-N');
      } else {
        authFile = createSmbAuthFile({ username, password, domain });
        args.push('--authentication-file', authFile);
      }
      if (domain && !authFile) args.push('-W', domain);
      if (portNum !== 445) args.push('-p', String(portNum));

      const { stdout } = await execFileAsync('smbclient', args, { timeout: NETWORK_SHARE_DISCOVERY_SMB_LIST_TIMEOUT_MS });
      return parseSmbClientShareList(stdout);
    } catch (error) {
      const fallbackShares = parseSmbClientShareList(error && error.stdout ? error.stdout : '');
      if (fallbackShares.length > 0) return fallbackShares;
      throw error;
    } finally {
      if (authFile) {
        try { fs.unlinkSync(authFile); } catch (_) {}
      }
    }
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

  function formatNfsShareTestError(error) {
    const message = String(error && error.message ? error.message : error || 'Unknown NFS error');
    if (/not advertised by the server/i.test(message)) return 'Export path not found on the NFS server.';
    if (/timed out|ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|ENETUNREACH/i.test(message)) return 'Unable to reach the NFS server.';
    return message;
  }

  function formatSmbShareDiscoveryError(error, username) {
    const message = extractCommandErrorOutput(error) || String(error && error.message ? error.message : error || 'Unknown SMB error');
    if (error && error.code === 'ENOENT') {
      return 'SMB share browsing is unavailable because smbclient is not installed in the companion runtime.';
    }
    if (/SMB1 disabled -- no workgroup available/i.test(message)) {
      return 'The SMB server responded, but workgroup enumeration failed after listing shares. Enter SMB credentials and browse directly.';
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
    if (/timed out|ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|ENETUNREACH/i.test(message)) return 'Unable to reach the NFS server.';
    return message;
  }

  async function runWithConcurrency(items, limit, worker) {
    const queue = Array.isArray(items) ? items : [];
    const concurrency = Math.max(1, Math.min(Number(limit) || 1, queue.length || 1));
    let index = 0;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (index < queue.length) {
          const currentIndex = index;
          index += 1;
          await worker(queue[currentIndex], currentIndex);
        }
      })
    );
  }

  async function resolveDiscoverySeedAddress(req) {
    const authorities = [];
    if (trustProxy && req?.headers?.['x-forwarded-host']) {
      authorities.push(req.headers['x-forwarded-host']);
    }
    if (req?.headers?.host) {
      authorities.push(req.headers.host);
    }

    for (const authority of authorities) {
      const host = extractHostFromAuthority(authority);
      if (!host || isSyntacticLoopbackHost(host)) continue;
      if (net.isIPv4(host)) {
        if (isPrivateIpv4(host)) return host;
        continue;
      }
      try {
        const resolved = await dnsPromises.lookup(host, { family: 4 });
        if (resolved && resolved.address && isPrivateIpv4(resolved.address)) return resolved.address;
      } catch (_) {}
    }
    return '';
  }

  async function discoverNetworkShareCandidates(req) {
    const seedAddress = await resolveDiscoverySeedAddress(req);
    const extraHosts = seedAddress ? [seedAddress] : [];
    const networkInterfaces = getScanNetworkInterfaces(getInterfaces());
    const targets = buildPrivateIpv4DiscoveryTargets(networkInterfaces, extraHosts);
    const scannedSubnets = describePrivateIpv4Subnets(networkInterfaces, extraHosts);

    if (targets.length === 0) {
      const err = new Error('Could not determine a private LAN subnet.');
      err.status = 503;
      err.errorCode = 'local_network_unavailable';
      throw err;
    }

    const warnings = [];
    const warningSet = new Set();
    const results = [];

    await runWithConcurrency(targets, NETWORK_SHARE_DISCOVERY_CONCURRENCY, async (ip) => {
      const [smbReachable, nfsReachable] = await Promise.all([
        checkTcpPort(ip, 445, NETWORK_SHARE_DISCOVERY_CONNECT_TIMEOUT_MS).then(() => true).catch(() => false),
        checkTcpPort(ip, 2049, NETWORK_SHARE_DISCOVERY_CONNECT_TIMEOUT_MS).then(() => true).catch(() => false),
      ]);

      if (smbReachable) {
        results.push({ protocol: 'smb', kind: 'server', host: ip, label: ip, description: 'SMB server' });
      }
      if (!nfsReachable) return;

      const exportInfo = await queryNfsExports(ip, { address: ip, family: 4, isLiteral: true, hostname: ip });
      if (Array.isArray(exportInfo.exports) && exportInfo.exports.length > 0) {
        exportInfo.exports.forEach((exportPath) => {
          results.push({ protocol: 'nfs', kind: 'share', host: ip, shareName: exportPath, label: exportPath, description: 'NFS export' });
        });
        return;
      }

      results.push({ protocol: 'nfs', kind: 'server', host: ip, label: ip, description: exportInfo.warning || 'NFS server' });
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
      scannedSubnets,
    };
  }

  // ---------------------------------------------------------------------------
  // Stage 1 TV / Device Pairing Discovery, Resolve & Handoff
  // ---------------------------------------------------------------------------
  async function fetchTvPairingCandidate(ip, receiverPort = TV_PAIRING_PORT, { timeoutMs = TV_PAIRING_DISCOVERY_TIMEOUT_MS, signal } = {}) {
    const infoUrl = buildTvInfoUrl(ip, receiverPort);
    const receiverUrl = buildTvReceiverUrl(ip, receiverPort);
    const result = await safeHttpJson(infoUrl, {
      policy: POLICY_RECEIVER_LAN_HTTP_ONLY,
      maxRedirects: 0,
      timeoutMs,
      signal,
    });
    if (result.status !== 200 || !result.data || typeof result.data !== 'object') {
      return { ok: false, status: result.status, data: result.data };
    }
    const validated = validateTvPairingInfo(result.data);
    if (!validated.ok) {
      return { ok: false, status: 502, data: { error: validated.issues[0] || 'Invalid device info' } };
    }
    return {
      ok: true,
      candidate: {
        ip,
        port: validated.info.port || receiverPort,
        receiver_url: buildTvReceiverUrl(ip, validated.info.port || receiverPort),
        device_name: validated.info.device_name || `SpatialFin (${ip})`,
        device_class: validated.info.device_class || 'tv',
        protocol_v: validated.info.protocol_v || 1,
        capabilities: validated.info.capabilities || [],
        expires_at_epoch_ms: validated.info.expires_at_epoch_ms,
      },
    };
  }

  async function browseMdnsTvCandidates(windowMs = 1_200) {
    if (!enableMdns) return [];
    const scanIfaces = getScanNetworkInterfaces(getInterfaces());
    const ifaceAddrs = [];
    for (const entries of Object.values(scanIfaces)) {
      for (const entry of entries) {
        if (entry.family === 'IPv4' && entry.address) {
          ifaceAddrs.push(entry.address);
        }
      }
    }
    if (ifaceAddrs.length === 0) return [];

    const discoveredServices = [];
    const instances = [];
    try {
      for (const addr of ifaceAddrs) {
        try {
          const b = new Bonjour({ interface: addr });
          instances.push(b);
          const browser = b.find({ type: 'spatialfin-tv' });
          browser.on('up', (svc) => discoveredServices.push(svc));
        } catch (_) {}
      }
      await new Promise((resolve) => {
        const t = setTimeout(resolve, windowMs);
        if (typeof t.unref === 'function') t.unref();
      });
    } finally {
      for (const b of instances) {
        try { b.destroy(); } catch (_) {}
      }
    }
    return extractMdnsCandidates(discoveredServices);
  }

  async function discoverTvCandidates(req) {
    // Phase 1: per-NIC mDNS (1.2 s)
    const mdnsRaw = await browseMdnsTvCandidates(1_200);
    if (mdnsRaw.length > 0) {
      const verified = [];
      await runWithConcurrency(mdnsRaw, 16, async (cand) => {
        try {
          const probe = await fetchTvPairingCandidate(cand.ip, cand.port, { timeoutMs: 1_200 });
          if (probe.ok && probe.candidate) verified.push(probe.candidate);
        } catch (_) {}
      });
      if (verified.length > 0) {
        return { candidates: verified, scannedCount: mdnsRaw.length, source: 'mdns' };
      }
    }

    // Phase 2: fallback /24 HTTP sweep (<= 4 s, concurrency 64, 500 ms connect timeout)
    const seedAddress = await resolveDiscoverySeedAddress(req);
    const extraHosts = seedAddress ? [seedAddress] : [];
    const networkInterfaces = getScanNetworkInterfaces(getInterfaces());
    const targets = buildPrivateIpv4DiscoveryTargets(networkInterfaces, extraHosts);
    if (targets.length === 0) {
      const err = new Error('No private local network was found on the companion host.');
      err.status = 503;
      err.errorCode = 'local_network_unavailable';
      throw err;
    }

    const sweepController = new AbortController();
    const sweepTimer = setTimeout(() => sweepController.abort(), 4_000);
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

    const found = [];
    try {
      await runWithConcurrency(targets, 64, async (ip) => {
        if (sweepController.signal.aborted) return;
        try {
          const probe = await fetchTvPairingCandidate(ip, TV_PAIRING_PORT, {
            timeoutMs: TV_PAIRING_DISCOVERY_TIMEOUT_MS,
            signal: sweepController.signal,
          });
          if (probe.ok && probe.candidate) {
            found.push(probe.candidate);
          }
        } catch (_) {}
      });
    } finally {
      clearTimeout(sweepTimer);
    }

    return {
      candidates: found,
      scannedCount: targets.length,
      source: found.length > 0 ? 'subnet_scan' : 'none',
    };
  }

  async function lookupTvCandidateByReceiverUrl({ host, port: reqPort, receiverUrl }) {
    let targetHost = '';
    let targetPort = TV_PAIRING_PORT;

    if (host) {
      targetHost = stripBrackets(String(host).trim());
      targetPort = normalizeOptionalPort(reqPort, TV_PAIRING_PORT);
      if (!targetHost || !net.isIP(targetHost)) {
        const err = new Error('Device host must be a literal private LAN IP address.');
        err.status = 400;
        err.errorCode = 'ssrf_blocked';
        throw err;
      }
    } else if (receiverUrl) {
      const normalized = normalizeTvReceiverInput(receiverUrl);
      if (!normalized.ok) {
        const err = new Error(normalized.issues[0] || 'Invalid receiver URL');
        err.status = 400;
        err.errorCode = 'invalid_request';
        throw err;
      }
      targetHost = normalized.host;
      targetPort = normalized.port;
    } else {
      const err = new Error('Provide host or receiverUrl.');
      err.status = 400;
      err.errorCode = 'invalid_request';
      throw err;
    }

    const infoUrl = buildTvInfoUrl(targetHost, targetPort);
    validateInitialUrl(infoUrl, POLICY_RECEIVER_LAN_HTTP_ONLY, { selfPort: getActualPort() });

    let probe;
    try {
      probe = await fetchTvPairingCandidate(targetHost, targetPort, { timeoutMs: 4_000 });
    } catch (error) {
      if (error instanceof SsrfBlockedError) throw error;
      if (error && error.name === 'AbortError') {
        const err = new Error('The device did not respond in time.');
        err.status = 504;
        err.errorCode = 'pairing_timeout';
        throw err;
      }
      const err = new Error('The device could not be reached on the local network.');
      err.status = 502;
      err.errorCode = 'server_unreachable';
      throw err;
    }

    if (!probe.ok) {
      const mapped = buildTvPairingError({ status: probe.status, data: probe.data }, false);
      const err = new Error(mapped.error);
      err.status = mapped.status;
      err.errorCode = mapped.error_code;
      throw err;
    }
    return { candidate: probe.candidate };
  }

  function recordRecentHandoffAttempt(key) {
    const now = Date.now();
    for (const [k, exp] of recentHandoffAttempts.entries()) {
      if (exp <= now) recentHandoffAttempts.delete(k);
    }
    if (recentHandoffAttempts.size >= MAX_RECENT_HANDOFF_ATTEMPTS) {
      const oldest = recentHandoffAttempts.keys().next().value;
      if (oldest !== undefined) recentHandoffAttempts.delete(oldest);
    }
    recentHandoffAttempts.set(key, now + RECENT_HANDOFF_TTL_MS);
  }

  function hasRecentHandoffAttempt(key) {
    const exp = recentHandoffAttempts.get(key);
    if (!exp) return false;
    if (exp <= Date.now()) {
      recentHandoffAttempts.delete(key);
      return false;
    }
    return true;
  }

  async function postTvPairingEnvelope({
    receiverUrl,
    companionUrl,
    pairingToken,
    usedManualCodeFallback,
    serverId,
    userId,
    shareOnly,
    handoffTimeoutMs,
    signal,
  }) {
    const envelope = buildTvPairingEnvelope(appConfig, companionUrl, {
      serverId,
      userId,
      shareOnly,
    });
    const headers = {
      'X-Pairing-Token': pairingToken,
      'X-Handoff-Timeout-Ms': String(handoffTimeoutMs),
    };
    let result;
    try {
      result = await safeHttpJson(receiverUrl, {
        method: 'POST',
        body: envelope,
        headers,
        policy: POLICY_RECEIVER_LAN_HTTP_ONLY,
        maxRedirects: 0,
        signal,
      });
    } catch (error) {
      if (error instanceof SsrfBlockedError) throw error;
      if (error && error.name === 'AbortError') {
        const err = new Error('The device did not respond in time.');
        err.status = 504;
        err.errorCode = 'pairing_timeout';
        throw err;
      }
      const err = new Error('The device could not be reached on the local network.');
      err.status = 502;
      err.errorCode = 'server_unreachable';
      throw err;
    }

    if (result.status < 200 || result.status >= 300) {
      const mapped = buildTvPairingError(result, Boolean(usedManualCodeFallback));
      const err = new Error(mapped.error);
      err.status = mapped.status;
      err.errorCode = mapped.error_code;
      throw err;
    }

    const body = result.data && typeof result.data === 'object' ? result.data : {};
    return {
      mode: 'v1',
      status: body.status || 'done',
      deviceName: body.device_name || body.deviceName || undefined,
      server_url: body.server_url || undefined,
      prefilled_username: body.prefilled_username || undefined,
      error: body.error || undefined,
      error_code: body.error_code || undefined,
    };
  }

  async function postCompanionHandoffV2({
    receiverUrl,
    companionUrl,
    pairingToken,
    usedManualCodeFallback,
    serverId,
    userId,
    shareOnly,
    handoffTimeoutMs,
    signal,
  }) {
    const handoffUrl = buildCompanionHandoffUrlFromReceiverUrl(receiverUrl);
    const effectiveShareOnly = serverId || userId ? false : Boolean(shareOnly || !(Array.isArray(appConfig.servers) && appConfig.servers.length > 0));
    const payload = buildCompanionHandoffPayload({
      companionUrl,
      setupToken: appConfig.setup_token,
      serverId: serverId || null,
      userId: userId || null,
      shareOnly: effectiveShareOnly,
    });
    const headers = {
      'X-Pairing-Token': pairingToken,
      'X-Handoff-Timeout-Ms': String(handoffTimeoutMs),
    };
    let result;
    try {
      result = await safeHttpJson(handoffUrl, {
        method: 'POST',
        body: payload,
        headers,
        policy: POLICY_RECEIVER_LAN_HTTP_ONLY,
        maxRedirects: 0,
        signal,
      });
    } catch (error) {
      if (error instanceof SsrfBlockedError) throw error;
      if (error && error.name === 'AbortError') {
        const err = new Error('The device did not respond in time.');
        err.status = 504;
        err.errorCode = 'pairing_timeout';
        throw err;
      }
      const err = new Error('The device could not be reached on the local network.');
      err.status = 502;
      err.errorCode = 'server_unreachable';
      throw err;
    }

    if (result.status < 200 || result.status >= 300) {
      const mapped = buildTvPairingError(result, Boolean(usedManualCodeFallback));
      const err = new Error(mapped.error);
      err.status = mapped.status;
      err.errorCode = mapped.error_code;
      err.rawStatus = result.status;
      err.rawErrorCode = result.data && typeof result.data === 'object' ? result.data.error_code : null;
      throw err;
    }

    const body = result.data && typeof result.data === 'object' ? result.data : {};
    return {
      mode: 'v2',
      status: body.status || 'done',
      deviceName: body.device_name || body.deviceName || undefined,
      server_url: body.server_url || undefined,
      prefilled_username: body.prefilled_username || undefined,
      error: body.error || undefined,
      error_code: body.error_code || undefined,
    };
  }

  /**
   * Resolve srv-* servers offline against liveConfig legacy_ids + matching address,
   * and probe remaining unresolved srv-* servers off-lock in bounded parallel (<= 3 s).
   */
  async function resolveSrvCanonicalCandidates(servers, liveConfig, maxDurationMs = 3_000) {
    const resolvedMap = new Map(); // srvId -> { canonicalId, serverName }
    const toProbe = [];
    const liveServers = Array.isArray(liveConfig?.servers) ? liveConfig.servers : [];

    for (const srv of Array.isArray(servers) ? servers : []) {
      if (!srv || !srv.id || !isLegacySyntheticServerId(srv.id)) continue;
      const srvAddrs = new Set((Array.isArray(srv.addresses) ? srv.addresses : []).map(normalizeUrl).filter(Boolean));
      const offlineMatch = liveServers.find((live) => {
        if (!live || !live.id || isLegacySyntheticServerId(live.id)) return false;
        const hasLegacy = Array.isArray(live.legacy_ids) && live.legacy_ids.includes(srv.id);
        if (!hasLegacy) return false;
        const liveAddrs = (Array.isArray(live.addresses) ? live.addresses : []).map(normalizeUrl).filter(Boolean);
        return liveAddrs.some((a) => srvAddrs.has(a));
      });
      if (offlineMatch) {
        resolvedMap.set(srv.id, { canonicalId: offlineMatch.id, serverName: offlineMatch.name || '' });
      } else if (srvAddrs.size > 0) {
        toProbe.push({ id: srv.id, addresses: Array.from(srvAddrs) });
      }
    }

    if (toProbe.length === 0) return resolvedMap;

    const overallController = new AbortController();
    const overallTimer = setTimeout(() => overallController.abort(), maxDurationMs);
    if (typeof overallTimer.unref === 'function') overallTimer.unref();

    try {
      await Promise.allSettled(
        toProbe.map(async (entry) => {
          for (const addr of entry.addresses) {
            if (overallController.signal.aborted) break;
            try {
              const info = await probePublicSystemInfo({
                baseUrl: addr,
                safeHttpJson,
                timeoutMs: maxDurationMs,
                signal: overallController.signal,
              });
              if (info && info.serverId) {
                resolvedMap.set(entry.id, { canonicalId: info.serverId, serverName: info.serverName || '' });
                break;
              }
            } catch (_) {}
          }
        })
      );
    } finally {
      clearTimeout(overallTimer);
    }

    return resolvedMap;
  }

  function applySafeAutomaticCanonicalizations(draft, resolvedMap) {
    const migrations = [];
    if (!resolvedMap || resolvedMap.size === 0 || !Array.isArray(draft.servers)) {
      return migrations;
    }
    const srvEntries = draft.servers.filter((s) => s && s.id && isLegacySyntheticServerId(s.id) && resolvedMap.has(s.id));
    for (const srv of srvEntries) {
      const target = resolvedMap.get(srv.id);
      if (!target || !target.canonicalId) continue;
      // Re-lookup inside draft because earlier merges may have mutated draft.servers
      const liveSrv = draft.servers.find((s) => s && s.id === srv.id);
      if (!liveSrv) continue;
      const existingCanon = draft.servers.find(
        (s) => s && s.id !== liveSrv.id && normalizeUuid(s.id) === normalizeUuid(target.canonicalId)
      );
      if (existingCanon) {
        const impact = evaluateServerAddressBindingImpact({
          sourceServer: liveSrv,
          canonicalServer: existingCanon,
        });
        if (!impact.safeToAutoMerge) {
          console.warn(
            `Skipping automatic canonical merge of ${liveSrv.id} into ${existingCanon.id}: Predicate 1 address expansion affects ${impact.affectedUsers.length} verified user(s).`
          );
          continue;
        }
      }
      const merged = mergeCanonicalServerInDraft(draft, {
        sourceServerId: liveSrv.id,
        canonicalId: target.canonicalId,
        probedServerName: target.serverName,
      });
      migrations.push(...merged.migrations);
    }
    return migrations;
  }

  // ---------------------------------------------------------------------------
  // Express App & Middleware Pipeline
  // ---------------------------------------------------------------------------
  const app = express();
  app.set('trust proxy', trustProxy ? 1 : false);

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
        upgradeInsecureRequests: null,
      },
    },
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: false,
  }));

  // 1. Side-effect-free health & meta probes (non-CORS, unauthenticated)
  app.get('/healthz', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true });
  });

  app.get('/api/meta', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      version: APP_VERSION,
      capabilities: {
        web_search: webSearchEnabled,
      },
    });
  });

  app.get('/api/auth/credentials', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(410).json({ error: 'Endpoint retired. Use /api/v1/config with X-Setup-Token.', error_code: 'gone' });
  });

  // 2. openCors strictly on TOKEN_CORS_PATHS BEFORE JSON parsers & rate limiters
  app.use((req, res, next) => {
    const normPath = normalizePathForMatch(req.path);
    if (!TOKEN_CORS_PATHS.has(normPath)) {
      return next();
    }

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, X-Setup-Token, X-SpatialFin-Capabilities, X-Companion-Device, X-Companion-Device-Name, X-Companion-App-Version'
      );
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.setHeader('Vary', 'Origin, Access-Control-Request-Private-Network');
      return res.status(204).end();
    }

    const hasTokenHeader = req.headers['x-setup-token'] !== undefined;
    const origWriteHead = res.writeHead.bind(res);
    res.writeHead = function patchedWriteHead(statusCode, ...rest) {
      const code = Number(statusCode) || res.statusCode;
      if (hasTokenHeader || [400, 401, 403, 413, 429].includes(code)) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
        res.setHeader('Vary', 'Origin, X-Setup-Token');
      }
      return origWriteHead(statusCode, ...rest);
    };
    return next();
  });

  // 3. Method+path scoped 64 KiB global JSON body parser (5 MiB routes parse AFTER auth)
  const smallJsonParser = bodyParser.json({ limit: '64kb' });
  const largeJsonParser = express.json({ limit: '5mb' });

  function isLargeBodyRoute(req) {
    const normPath = normalizePathForMatch(req.path);
    if (req.method === 'POST') {
      return (
        normPath === '/api/v1/device-logs' ||
        normPath === '/api/admin/config' ||
        normPath === '/api/admin/config/import'
      );
    }
    if (req.method === 'PUT') {
      return /^\/api\/admin\/device-preferences\/[^/]+$/.test(normPath);
    }
    return false;
  }

  app.use((req, res, next) => {
    if (isLargeBodyRoute(req)) return next();
    return smallJsonParser(req, res, next);
  });

  app.use(express.static(path.join(rootDir, 'public')));

  // ---------------------------------------------------------------------------
  // Rate Limiters (each with its own BoundedMemoryStore(4096))
  // ---------------------------------------------------------------------------
  const ipKeyGen = (req) => ipKeyGenerator(getEffectiveClientIp(req), 64);

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    skipSuccessfulRequests: true,
    store: new BoundedMemoryStore(4096),
    keyGenerator: ipKeyGen,
    validate: rateLimitValidate,
    message: { error: 'Too many login attempts, please try again later', error_code: 'pairing_rate_limited' },
  });

  const bootstrapLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skip: (req) => checkDirectLoopbackRequest(req).ok,
    store: new BoundedMemoryStore(4096),
    keyGenerator: ipKeyGen,
    validate: rateLimitValidate,
    message: { error: 'Too many bootstrap attempts, please try again later', error_code: 'pairing_rate_limited' },
  });

  const failedTokenLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req, res) => res.statusCode !== 401,
    store: new BoundedMemoryStore(4096),
    keyGenerator: ipKeyGen,
    validate: rateLimitValidate,
    message: { error: 'Too many invalid setup token attempts', error_code: 'pairing_rate_limited' },
  });

  const wsTicketLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    store: new BoundedMemoryStore(4096),
    keyGenerator: ipKeyGen,
    validate: rateLimitValidate,
    message: { error: 'Too many WebSocket ticket requests', error_code: 'pairing_rate_limited' },
  });

  const searchLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    store: new BoundedMemoryStore(4096),
    keyGenerator: ipKeyGen,
    validate: rateLimitValidate,
    message: { error: 'Too many search requests', error_code: 'pairing_rate_limited' },
  });

  const deviceLogsLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    store: new BoundedMemoryStore(4096),
    keyGenerator: ipKeyGen,
    validate: rateLimitValidate,
    message: { error: 'Too many device log batches', error_code: 'pairing_rate_limited' },
  });

  const analyticsSessionsLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    store: new BoundedMemoryStore(4096),
    keyGenerator: ipKeyGen,
    validate: rateLimitValidate,
    message: { error: 'Too many analytics session batches', error_code: 'pairing_rate_limited' },
  });

  // Stage 2: POST /api/v1/auth/authorize-quick-connect limiters (separate stores, zero ERR_ERL_*)
  const authorizePreAuthLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req, res) => res.statusCode !== 401,
    standardHeaders: true,
    legacyHeaders: false,
    store: new BoundedMemoryStore(4096),
    keyGenerator: ipKeyGen,
    validate: rateLimitValidate,
    message: { error: 'Too many failed token attempts', error_code: 'pairing_rate_limited' },
  });

  const authorizePostAuthIpLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    store: new BoundedMemoryStore(4096),
    keyGenerator: ipKeyGen,
    validate: rateLimitValidate,
    message: { error: 'Too many Quick Connect broker requests', error_code: 'pairing_rate_limited' },
  });

  const authorizePerUserWindow = new Map();
  function checkAndRecordAuthorizePerUserLimit(serverId, userId) {
    const key = `${normalizeUuid(serverId)}:${normalizeUuid(userId)}`;
    const now = Date.now();
    if (authorizePerUserWindow.size > 2048) {
      for (const [k, v] of authorizePerUserWindow.entries()) {
        if (now >= v.resetAt) authorizePerUserWindow.delete(k);
      }
    }
    let rec = authorizePerUserWindow.get(key);
    if (!rec || now >= rec.resetAt) {
      rec = { count: 0, resetAt: now + 60_000 };
    }
    rec.count += 1;
    authorizePerUserWindow.set(key, rec);
    return rec.count <= 60;
  }

  function requireSetupTokenOnly(req, res, next) {
    const rawHeader = req.headers['x-setup-token'];
    const provided = Array.isArray(rawHeader) ? rawHeader[0] : (rawHeader !== undefined ? String(rawHeader) : '');
    if (provided && appConfig.setup_token && timingSafeStringEqual(provided, appConfig.setup_token)) {
      req.companionAuthType = 'setup_token';
      return next();
    }
    return res.status(401).json({ error: 'Invalid or missing setup token', error_code: 'invalid_credentials' });
  }

  // Stage 2: Admin Quick Connect pending session registry (32-entry cap + 30 s tokenless drain cache)
  const MAX_PENDING_QC_SESSIONS = 32;
  const PENDING_QC_TTL_MS = 10 * 60_000;
  const QC_CONFIRM_TTL_MS = 120_000;
  const QC_DRAIN_TTL_MS = 30_000;
  const pendingQuickConnects = new Map();
  const qcDrainCache = new Map();

  function wipePendingQuickConnect(pendingId) {
    const entry = pendingQuickConnects.get(pendingId);
    if (!entry) return;
    if (entry.awaitingConfirmation) {
      if (entry.awaitingConfirmation.timer) clearTimeout(entry.awaitingConfirmation.timer);
      entry.awaitingConfirmation.accessToken = '';
      entry.awaitingConfirmation = null;
    }
    entry.secret = '';
    pendingQuickConnects.delete(pendingId);
  }

  function pruneExpiredPendingQuickConnects(now = Date.now()) {
    for (const [id, entry] of pendingQuickConnects.entries()) {
      if (entry.awaitingConfirmation) {
        if (now >= entry.awaitingConfirmation.expiresAt) {
          wipePendingQuickConnect(id);
        }
      } else if (now >= entry.expiresAt) {
        wipePendingQuickConnect(id);
      }
    }
    for (const [id, drain] of qcDrainCache.entries()) {
      if (now >= drain.expiresAt) qcDrainCache.delete(id);
    }
  }

  // ---------------------------------------------------------------------------
  // requireSetupTokenOrAdmin middleware
  // ---------------------------------------------------------------------------
  function requireSetupTokenOrAdmin(req, res, next) {
    const rawHeader = req.headers['x-setup-token'];
    if (rawHeader !== undefined) {
      const provided = Array.isArray(rawHeader) ? rawHeader[0] : String(rawHeader);
      if (provided && appConfig.setup_token && timingSafeStringEqual(provided, appConfig.setup_token)) {
        req.companionAuthType = 'setup_token';
        return next();
      }
      return res.status(401).json({ error: 'Invalid setup token', error_code: 'invalid_credentials' });
    }

    // Cookie/loopback fallback ONLY when Origin is absent or same-origin and Sec-Fetch-Site is safe
    const secFetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
      return res.status(401).json({ error: 'Setup token required for cross-site request', error_code: 'invalid_credentials' });
    }
    if (req.headers.origin && !isSameOriginHttpRequest(req)) {
      return res.status(401).json({ error: 'Setup token required for cross-origin request', error_code: 'invalid_credentials' });
    }

    if (hasConfiguredAdminPassword()) {
      const cookies = parseCookies(req);
      const token = cookies.session;
      if (token && storage.validateAdminSession(token)) {
        req.companionAuthType = 'session';
        return next();
      }
      return res.status(401).json({ error: 'Unauthorized', error_code: 'invalid_credentials' });
    }

    const loopback = checkDirectLoopbackRequest(req);
    if (loopback.ok) {
      req.companionAuthType = 'loopback_unconfigured';
      return next();
    }
    if (loopback.reason === 'host_rejected') {
      return res.status(403).json({ error: 'Invalid Host header for loopback access', error_code: 'host_rejected' });
    }
    return res.status(403).json({ error: 'Admin password required or provide X-Setup-Token', error_code: 'admin_password_required' });
  }

  // ---------------------------------------------------------------------------
  // Optimistic Locking (If-Match / configVersion)
  // ---------------------------------------------------------------------------
  function parseIfMatchHeader(raw) {
    if (raw === undefined || raw === null) return undefined;
    const str = String(raw).trim();
    if (!str) return undefined;
    // RFC 9110 weak/quoted ETag normalization: W/"42" or "42" or 42
    const stripped = str.replace(/^W\//i, '').replace(/^"(.*)"$/, '$1').trim();
    if (!/^\d+$/.test(stripped)) return NaN;
    return Number(stripped);
  }

  function resolveExpectedVersion(req) {
    const headerVal = parseIfMatchHeader(req.headers['if-match']);
    const bodyObj = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
    const rawBodyVer = bodyObj && bodyObj.configVersion !== undefined ? bodyObj.configVersion : undefined;
    const bodyVal = rawBodyVer !== undefined ? Number(rawBodyVer) : undefined;

    if (Number.isNaN(headerVal) || (bodyVal !== undefined && (!Number.isInteger(bodyVal) || bodyVal < 1))) {
      return { ok: false, status: 400, error: 'Invalid configVersion or If-Match header', error_code: 'invalid_request' };
    }
    if (headerVal === undefined && bodyVal === undefined) {
      return { ok: false, status: 428, error: 'Missing If-Match header or configVersion', error_code: 'precondition_required' };
    }
    if (headerVal !== undefined && bodyVal !== undefined && headerVal !== bodyVal) {
      return { ok: false, status: 400, error: 'If-Match header disagrees with body configVersion', error_code: 'invalid_request' };
    }
    const expected = headerVal !== undefined ? headerVal : bodyVal;
    const current = storage.getConfigVersion();
    if (expected !== current) {
      return {
        ok: false,
        status: 409,
        error: 'Configuration was modified in another session. Reload latest and retry.',
        error_code: 'conflict',
        configVersion: current,
      };
    }
    return { ok: true, expected };
  }

  function setConfigEtag(res, version = storage.getConfigVersion()) {
    res.setHeader('ETag', `"${version}"`);
  }

  // ---------------------------------------------------------------------------
  // Admin Router (/api/admin/*)
  // ---------------------------------------------------------------------------
  const adminRouter = express.Router();

  // Cache-Control: no-store on ALL /api/admin/* routes
  adminRouter.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Cross-origin / Sec-Fetch-Site rejection across ALL /api/admin/* routes
  adminRouter.use((req, res, next) => {
    const secFetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (secFetchSite === 'cross-site') {
      return res.status(403).json({ error: 'Cross-site requests are forbidden', error_code: 'csrf_rejected' });
    }
    if (req.headers.origin && !isSameOriginHttpRequest(req)) {
      return res.status(403).json({ error: 'Origin mismatch (check COMPANION_TRUST_PROXY=1 if behind a reverse proxy)', error_code: 'csrf_rejected' });
    }
    return next();
  });

  // HTTP CSRF middleware on all state-changing /api/admin/* routes (BEFORE adminAuth)
  adminRouter.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.headers['x-companion-admin'] !== '1') {
      return res.status(403).json({ error: 'Missing X-Companion-Admin header', error_code: 'csrf_rejected' });
    }
    if (req.headers.origin && !isSameOriginHttpRequest(req)) {
      return res.status(403).json({ error: 'Invalid Origin header', error_code: 'csrf_rejected' });
    }
    const contentLength = Number(req.headers['content-length'] || 0);
    const hasTransferEncoding = req.headers['transfer-encoding'] !== undefined;
    const hasContentType = req.headers['content-type'] !== undefined;
    const bodyIndicated =
      contentLength > 0 ||
      (req.method !== 'DELETE' && hasTransferEncoding) ||
      (req.method === 'DELETE' && hasContentType);

    if (bodyIndicated) {
      const mediaType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (mediaType !== 'application/json') {
        return res.status(415).json({ error: 'Content-Type must be application/json', error_code: 'unsupported_media_type' });
      }
    }
    return next();
  });

  // Vacuum serialization gate for SQLite-touching /api/admin/* routes
  // Exempt cache-backed routes (/auth-check, /config, /qr) and /database/vacuum (handles 503 immediately itself)
  const CACHE_BACKED_ADMIN_GET_PATHS = new Set(['/auth-check', '/config', '/qr']);
  adminRouter.use(async (req, res, next) => {
    if (req.method === 'GET' && CACHE_BACKED_ADMIN_GET_PATHS.has(req.path)) {
      return next();
    }
    if (req.method === 'POST' && req.path === '/database/vacuum') {
      return next();
    }
    if (!storage.isVacuumInFlight()) return next();
    try {
      await waitForVacuumIfNeeded(3_000);
      return next();
    } catch (_) {
      return sendMaintenance503(res);
    }
  });

  // requireSessionOrLoopback
  adminRouter.use((req, res, next) => {
    if (
      req.path === '/login' ||
      req.path === '/auth-check' ||
      req.path === '/logout' ||
      req.path === '/bootstrap-password'
    ) {
      return next();
    }
    if (hasConfiguredAdminPassword()) {
      const cookies = parseCookies(req);
      const token = cookies.session;
      if (token && storage.validateAdminSession(token)) {
        return next();
      }
      return res.status(401).json({ error: 'Unauthorized', error_code: 'invalid_credentials' });
    }
    const loopback = checkDirectLoopbackRequest(req);
    if (loopback.ok) return next();
    return res.status(403).json({
      error: loopback.reason === 'host_rejected' ? 'Invalid Host header for loopback access' : 'Admin password must be configured',
      error_code: loopback.reason,
    });
  });

  // Auth Check (cache-backed: zero SQLite statements during vacuumInFlight)
  adminRouter.get('/auth-check', (req, res) => {
    if (hasConfiguredAdminPassword()) {
      const cookies = parseCookies(req);
      const token = cookies.session;
      const authenticated = Boolean(token && storage.validateAdminSession(token));
      return res.json({
        authenticated,
        authRequired: true,
        wsAllowed: authenticated,
      });
    }

    const loopback = checkDirectLoopbackRequest(req);
    if (loopback.ok) {
      return res.json({
        authenticated: true,
        authRequired: false,
        wsAllowed: true,
      });
    }
    if (loopback.reason === 'host_rejected') {
      return res.status(403).json({
        error: 'Invalid Host header for direct loopback request',
        error_code: 'host_rejected',
      });
    }

    const bucket = normalizeClientIpBucket(getEffectiveClientIp(req));
    const now = Date.now();
    const ipCooldownUntil = getBootstrapCooldownUntil(bucket);
    if (now >= ipCooldownUntil && req.headers['x-companion-admin'] === '1') {
      maybeMintBootstrapPin();
    }
    const canBootstrapWithPin = Boolean(
      activeBootstrapPin && now < bootstrapPinExpiresAt && now >= ipCooldownUntil
    );
    return res.json({
      authenticated: false,
      authRequired: false,
      adminPasswordRequired: true,
      canBootstrapWithPin,
      bootstrapPinExpiresAt: canBootstrapWithPin ? bootstrapPinExpiresAt : null,
      wsAllowed: false,
    });
  });

  // Bootstrap Password (pre-gate BEFORE bootstrapLimiter so 403/409/401 are not masked by 429)
  adminRouter.post('/bootstrap-password', (req, res, next) => {
    const loopback = checkDirectLoopbackRequest(req);
    if (!loopback.ok && loopback.reason === 'host_rejected') {
      return res.status(403).json({ error: 'Invalid Host header', error_code: 'host_rejected' });
    }
    if (hasConfiguredAdminPassword()) {
      return res.status(409).json({
        error: 'Admin password is already configured',
        error_code: 'admin_password_already_configured',
      });
    }
    if (!loopback.ok) {
      const bucket = normalizeClientIpBucket(getEffectiveClientIp(req));
      const now = Date.now();
      if (now < getBootstrapCooldownUntil(bucket)) {
        return res.status(401).json({ error: 'Invalid or expired bootstrap PIN', error_code: 'invalid_credentials' });
      }
      if (!activeBootstrapPin || now >= bootstrapPinExpiresAt) {
        activeBootstrapPin = null;
        bootstrapPinExpiresAt = 0;
        return res.status(401).json({ error: 'Invalid or expired bootstrap PIN', error_code: 'invalid_credentials' });
      }
    }
    req._bootstrapDirectLoopback = loopback.ok;
    return next();
  }, bootstrapLimiter, async (req, res) => {
    try {
      const { newPassword, bootstrapPin, remember } = req.body || {};
      const pw = typeof newPassword === 'string' ? newPassword : '';
      const pwBytes = Buffer.byteLength(pw, 'utf8');
      if (pwBytes < MIN_BOOTSTRAP_PASSWORD_BYTES || pwBytes > MAX_PASSWORD_BYTES) {
        return res.status(400).json({
          error: `Password must be between ${MIN_BOOTSTRAP_PASSWORD_BYTES} and ${MAX_PASSWORD_BYTES} bytes`,
          error_code: 'invalid_request',
        });
      }

      if (!req._bootstrapDirectLoopback) {
        const providedPin = String(bootstrapPin || '').trim().toUpperCase().replace(/[\s-]+/g, '');
        const pinOk = Boolean(activeBootstrapPin && providedPin && timingSafeStringEqual(providedPin, activeBootstrapPin));
        if (!pinOk) {
          const bucket = normalizeClientIpBucket(getEffectiveClientIp(req));
          const now = Date.now();
          const prevFails = (bootstrapPinFailuresByIp.get(bucket) || 0) + 1;
          bootstrapPinFailuresByIp.set(bucket, prevFails);
          bootstrapPinFailedIps.add(bucket);
          bootstrapPinGlobalFailures += 1;

          if (bootstrapPinGlobalFailures >= 25) {
            activeBootstrapPin = null;
            bootstrapPinExpiresAt = 0;
            const cooldownEnd = now + 5 * 60_000;
            for (const b of bootstrapPinFailedIps) {
              recordBootstrapCooldown(b, cooldownEnd);
            }
            bootstrapPinFailedIps.clear();
            bootstrapPinFailuresByIp.clear();
            bootstrapPinGlobalFailures = 0;
            console.warn('[bootstrap] Bootstrap PIN wiped after 25 failed attempts. Set COMPANION_ADMIN_PASSWORD or use direct loopback.');
          } else if (prevFails >= 5) {
            const cooldownEnd = now + 5 * 60_000;
            const stored = recordBootstrapCooldown(bucket, cooldownEnd);
            bootstrapPinFailuresByIp.delete(bucket);
            if (!stored) {
              return res.status(429).json({ error: 'Too many bootstrap attempts', error_code: 'pairing_rate_limited' });
            }
          }
          return res.status(401).json({ error: 'Invalid bootstrap PIN', error_code: 'invalid_credentials' });
        }
      }

      const hash = await hashPasswordScrypt(pw);
      const result = storage.setAdminPasswordHashIfUnset(hash);
      if (!result.changed) {
        return res.status(409).json({
          error: 'Admin password is already configured',
          error_code: 'admin_password_already_configured',
        });
      }

      activeBootstrapPin = null;
      bootstrapPinExpiresAt = 0;
      bootstrapPinFailuresByIp.clear();
      bootstrapPinFailedIps.clear();
      bootstrapPinGlobalFailures = 0;

      revokeLoopbackUnconfiguredWebSockets();

      const token = crypto.randomBytes(32).toString('hex');
      const ttl = remember ? ADMIN_SESSION_REMEMBER_TTL_MS : ADMIN_SESSION_TTL_MS;
      storage.createAdminSession(token, ttl);
      storage.recordEvent('admin-password-bootstrapped', req, { remember: !!remember });
      res.setHeader('Set-Cookie', buildSessionCookie(token, ttl));
      return res.json({ authenticated: true, expiresInMs: ttl });
    } catch (err) {
      return handleSqliteOrMaintenanceError(res, err);
    }
  });

  // Login
  adminRouter.post('/login', loginLimiter, async (req, res) => {
    try {
      const { password, remember } = req.body || {};
      if (!hasConfiguredAdminPassword()) {
        const loopback = checkDirectLoopbackRequest(req);
        if (loopback.ok) {
          return res.json({ authenticated: true });
        }
        return res.status(403).json({
          error: loopback.reason === 'host_rejected' ? 'Invalid Host header' : 'Admin password must be configured',
          error_code: loopback.reason,
        });
      }

      const provided = typeof password === 'string' ? password : '';
      if (Buffer.byteLength(provided, 'utf8') > MAX_PASSWORD_BYTES) {
        return res.status(400).json({ error: 'Password exceeds maximum length', error_code: 'invalid_request' });
      }

      let match = false;
      if (adminPasswordEnv) {
        match = timingSafeStringEqual(provided, adminPasswordEnv);
      } else {
        const storedHash = storage.getAdminPasswordHash();
        match = await verifyPasswordScrypt(provided, storedHash);
      }

      if (!match) {
        storage.recordEvent('admin-login-failed', req, { ip: getEffectiveClientIp(req) });
        return res.status(401).json({ error: 'Invalid password', error_code: 'invalid_credentials' });
      }

      storage.pruneExpiredAdminSessions();
      const token = crypto.randomBytes(32).toString('hex');
      const ttl = remember ? ADMIN_SESSION_REMEMBER_TTL_MS : ADMIN_SESSION_TTL_MS;
      storage.createAdminSession(token, ttl);
      storage.recordEvent('admin-login-success', req, { remember: !!remember });
      res.setHeader('Set-Cookie', buildSessionCookie(token, ttl));
      return res.json({ authenticated: true, expiresInMs: ttl });
    } catch (err) {
      return handleSqliteOrMaintenanceError(res, err);
    }
  });

  // Logout
  adminRouter.post('/logout', (req, res) => {
    const cookies = parseCookies(req);
    const token = cookies.session;
    if (token) {
      storage.deleteAdminSession(token);
      revokeSessionWebSockets(token);
    }
    res.setHeader('Set-Cookie', buildLogoutCookie());
    res.json({ ok: true });
  });

  // GET /api/admin/config (cache-backed: zero SQLite statements during vacuumInFlight)
  adminRouter.get('/config', (_req, res) => {
    const version = storage.getConfigVersion();
    setConfigEtag(res, version);
    res.json({
      ...redactConfigForExport(appConfig),
      configVersion: version,
      setupTokenWeak: isSetupTokenWeakValue(appConfig.setup_token),
      preStage1BackupPresent: storage.hasPreStage1Backup(),
    });
  });

  // GET /api/admin/qr (cache-backed: zero SQLite statements during vacuumInFlight)
  adminRouter.get('/qr', async (req, res) => {
    let companionUrl;
    try {
      companionUrl = buildCompanionBaseUrl(req, null, { forHandoff: false });
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message, error_code: err.errorCode || 'invalid_request' });
    }
    const payload = JSON.stringify({
      version: 1,
      companion_url: companionUrl,
      setup_token: appConfig.setup_token,
    });
    try {
      const qrImage = await qrcode.toDataURL(payload);
      return res.json({ qr: qrImage, payload, setup_token: appConfig.setup_token });
    } catch (_) {
      return res.status(500).json({ error: 'QR generation failed', error_code: 'internal_error' });
    }
  });

  function validateConfigPatch(body) {
    const errors = [];
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { errors: ['Request body must be a JSON object.'] };
    }
    const { globalPreferences, devicePreferences, servers, networkShares } = body;
    if (globalPreferences !== undefined && (typeof globalPreferences !== 'object' || Array.isArray(globalPreferences) || globalPreferences === null)) {
      errors.push('globalPreferences must be an object.');
    }
    if (devicePreferences !== undefined) {
      if (typeof devicePreferences !== 'object' || Array.isArray(devicePreferences) || devicePreferences === null) {
        errors.push('devicePreferences must be an object keyed by deviceId.');
      } else {
        for (const [deviceId, overrides] of Object.entries(devicePreferences)) {
          if (!isValidMapKey(deviceId) || deviceId.length > 128) {
            errors.push(`Invalid deviceId key: "${deviceId}".`);
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

  // POST /api/admin/config (5 MiB body parsed AFTER auth)
  adminRouter.post('/config', largeJsonParser, async (req, res) => {
    try {
      const { errors } = validateConfigPatch(req.body);
      if (errors.length) {
        return res.status(400).json({ error: 'Invalid configuration payload', error_code: 'invalid_request', details: errors });
      }
      const confirmDropUnmatchedSecrets = req.body.confirmDropUnmatchedSecrets === true;
      const sanitizedBody = { ...req.body };
      delete sanitizedBody.configVersion;
      delete sanitizedBody.has_setup_token;
      delete sanitizedBody.setupTokenWeak;
      delete sanitizedBody.preStage1BackupPresent;
      delete sanitizedBody.confirmDropUnmatchedSecrets;

      const result = await withConfigLock(async () => {
        const verCheck = resolveExpectedVersion(req);
        if (!verCheck.ok) return { errorResponse: verCheck };

        const draft = structuredClone(appConfig);
        const presentSections = new Set();
        if (sanitizedBody.globalPreferences !== undefined) {
          draft.globalPreferences = { ...draft.globalPreferences, ...sanitizedBody.globalPreferences };
          for (const [k, v] of Object.entries(sanitizedBody.globalPreferences)) {
            if (v === null) delete draft.globalPreferences[k];
          }
          presentSections.add('globalPreferences');
        }
        if (sanitizedBody.devicePreferences !== undefined) {
          draft.devicePreferences = structuredClone(sanitizedBody.devicePreferences);
          presentSections.add('devicePreferences');
        }
        if (sanitizedBody.servers !== undefined) {
          draft.servers = structuredClone(sanitizedBody.servers);
          presentSections.add('servers');
        }
        if (sanitizedBody.networkShares !== undefined) {
          draft.networkShares = structuredClone(sanitizedBody.networkShares);
          presentSections.add('networkShares');
        }

        const redaction = restoreRedactedSecrets(draft, appConfig, {
          confirmDropUnmatchedSecrets,
          rawPatch: sanitizedBody,
        });
        if (!redaction.ok) {
          return {
            errorResponse: {
              status: 400,
              error: 'One or more redacted secrets do not match the updated target.',
              error_code: redaction.errorCode,
              unmatchedSecrets: redaction.unmatchedSecrets,
            },
          };
        }

        const normalizedDraft = storage.normalizeConfig(draft);
        try {
          validateConfigTargets(normalizedDraft, {
            legacyLoopbackAllowlist,
            allowLoopbackUpstreams,
            sections: presentSections,
            selfPort: getActualPort(),
          });
        } catch (err) {
          if (err instanceof SsrfBlockedError) {
            return { errorResponse: { status: 400, error: err.message, error_code: 'ssrf_blocked' } };
          }
          throw err;
        }

        const saved = storage.saveConfig(normalizedDraft, {
          reason: 'config-update',
          eventType: 'config_updated',
          req,
          details: {
            servers: Array.isArray(normalizedDraft.servers) ? normalizedDraft.servers.length : 0,
            networkShares: Array.isArray(normalizedDraft.networkShares) ? normalizedDraft.networkShares.length : 0,
          },
        });
        appConfig = saved;
        return { saved, droppedSecrets: redaction.droppedSecrets };
      });

      if (result.errorResponse) {
        const { status, ...payload } = result.errorResponse;
        return res.status(status).json(payload);
      }

      reconcileJellyfinRealtimeSockets();
      broadcastConfigChanged();
      const version = storage.getConfigVersion();
      setConfigEtag(res, version);
      const responseBody = {
        status: 'ok',
        config: redactConfigForExport(appConfig),
        configVersion: version,
      };
      if (result.droppedSecrets && result.droppedSecrets.length > 0) {
        responseBody.droppedSecrets = result.droppedSecrets;
      }
      return res.json(responseBody);
    } catch (err) {
      return handleSqliteOrMaintenanceError(res, err);
    }
  });

  // PUT /api/admin/device-preferences/:deviceId (5 MiB body parsed AFTER auth)
  adminRouter.put('/device-preferences/:deviceId', largeJsonParser, async (req, res) => {
    try {
      const deviceId = String(req.params.deviceId || '').trim();
      if (!isValidMapKey(deviceId) || deviceId.length > 128) {
        return res.status(400).json({ error: 'Invalid deviceId', error_code: 'invalid_request' });
      }
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'Body must be an object of preference key/value pairs', error_code: 'invalid_request' });
      }
      const confirmDropUnmatchedSecrets = body.confirmDropUnmatchedSecrets === true;

      const result = await withConfigLock(async () => {
        const verCheck = resolveExpectedVersion(req);
        if (!verCheck.ok) return { errorResponse: verCheck };

        const draft = structuredClone(appConfig);
        const currentMap = draft.devicePreferences || {};
        const existing = Object.prototype.hasOwnProperty.call(currentMap, deviceId)
          ? { ...currentMap[deviceId] }
          : {};

        const rawSubmitted = {};
        for (const [k, v] of Object.entries(body)) {
          if (k === 'configVersion' || k === 'confirmDropUnmatchedSecrets') continue;
          if (!isValidMapKey(k)) continue;
          rawSubmitted[k] = v;
          if (v === null || v === undefined) {
            delete existing[k];
          } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            existing[k] = String(v);
          }
        }

        if (Object.keys(existing).length === 0) {
          delete currentMap[deviceId];
        } else {
          currentMap[deviceId] = existing;
        }
        draft.devicePreferences = currentMap;

        const redaction = restoreRedactedSecrets(draft, appConfig, {
          confirmDropUnmatchedSecrets,
          rawPatch: rawSubmitted,
          devicePreferenceTargetId: deviceId,
        });
        if (!redaction.ok) {
          return {
            errorResponse: {
              status: 400,
              error: 'Redacted secret does not match the updated target.',
              error_code: redaction.errorCode,
              unmatchedSecrets: redaction.unmatchedSecrets,
            },
          };
        }

        const normalizedDraft = storage.normalizeConfig(draft);
        try {
          validateConfigTargets(normalizedDraft, {
            legacyLoopbackAllowlist,
            allowLoopbackUpstreams,
            devicePreferenceTargetId: deviceId,
            selfPort: getActualPort(),
          });
        } catch (err) {
          if (err instanceof SsrfBlockedError) {
            return { errorResponse: { status: 400, error: err.message, error_code: 'ssrf_blocked' } };
          }
          throw err;
        }

        const saved = storage.saveConfig(normalizedDraft, {
          reason: 'device-preferences-update',
          eventType: 'device_preferences_updated',
          req,
          details: { deviceId, keys: Object.keys(normalizedDraft.devicePreferences[deviceId] || {}) },
        });
        appConfig = saved;
        return { saved, droppedSecrets: redaction.droppedSecrets };
      });

      if (result.errorResponse) {
        const { status, ...payload } = result.errorResponse;
        return res.status(status).json(payload);
      }

      broadcastConfigChanged(deviceId);
      const version = storage.getConfigVersion();
      setConfigEtag(res, version);
      const redactedOverrides = redactConfigForExport(appConfig).devicePreferences[deviceId] || {};
      const responseBody = {
        status: 'ok',
        deviceId,
        overrides: redactedOverrides,
        configVersion: version,
      };
      if (result.droppedSecrets && result.droppedSecrets.length > 0) {
        responseBody.droppedSecrets = result.droppedSecrets;
      }
      return res.json(responseBody);
    } catch (err) {
      return handleSqliteOrMaintenanceError(res, err);
    }
  });

  // DELETE /api/admin/device-preferences/:deviceId (If-Match checked BEFORE early return)
  adminRouter.delete('/device-preferences/:deviceId', async (req, res) => {
    try {
      const deviceId = String(req.params.deviceId || '').trim();
      if (!isValidMapKey(deviceId) || deviceId.length > 128) {
        return res.status(400).json({ error: 'Invalid deviceId', error_code: 'invalid_request' });
      }

      const result = await withConfigLock(async () => {
        const verCheck = resolveExpectedVersion(req);
        if (!verCheck.ok) return { errorResponse: verCheck };

        const current = appConfig.devicePreferences || {};
        if (!Object.prototype.hasOwnProperty.call(current, deviceId)) {
          return { cleared: false };
        }
        const draft = structuredClone(appConfig);
        delete draft.devicePreferences[deviceId];
        const saved = storage.saveConfig(draft, {
          reason: 'device-preferences-clear',
          eventType: 'device_preferences_cleared',
          req,
          details: { deviceId },
        });
        appConfig = saved;
        return { cleared: true };
      });

      if (result.errorResponse) {
        const { status, ...payload } = result.errorResponse;
        return res.status(status).json(payload);
      }

      if (result.cleared) {
        broadcastConfigChanged(deviceId);
      }
      const version = storage.getConfigVersion();
      setConfigEtag(res, version);
      return res.json({ status: 'ok', deviceId, cleared: result.cleared, configVersion: version });
    } catch (err) {
      return handleSqliteOrMaintenanceError(res, err);
    }
  });

  // POST /api/admin/rotate-token
  adminRouter.post('/rotate-token', async (req, res) => {
    try {
      await withConfigLock(async () => {
        const draft = structuredClone(appConfig);
        draft.setup_token = generateSetupToken();
        appConfig = storage.saveConfig(draft, {
          reason: 'rotate-token',
          eventType: 'token_rotated',
          req,
        });
      });
      revokeSetupTokenWebSockets();
      reconcileJellyfinRealtimeSockets();
      broadcastConfigChanged();
      const version = storage.getConfigVersion();
      setConfigEtag(res, version);
      return res.json({ setup_token: appConfig.setup_token, configVersion: version });
    } catch (err) {
      return handleSqliteOrMaintenanceError(res, err);
    }
  });

  // GET /api/admin/diagnostics
  adminRouter.get('/diagnostics', (_req, res) => {
    try {
      return res.json(storage.getConfigPullStats());
    } catch (err) {
      return handleSqliteOrMaintenanceError(res, err);
    }
  });

  // GET /api/admin/config/snapshots
  adminRouter.get('/config/snapshots', (_req, res) => {
    try {
      return res.json(storage.getConfigSnapshots());
    } catch (err) {
      return handleSqliteOrMaintenanceError(res, err);
    }
  });

  // POST /api/admin/config/snapshots/restore (Stage 2: pre-check -> off-lock srv-* probe -> atomic migrate)
  adminRouter.post('/config/snapshots/restore', async (req, res) => {
    try {
      const rawId = req.body?.id ?? req.body?.snapshotId;
      const snapId = Number(rawId);
      if (!Number.isInteger(snapId) || snapId <= 0) {
        return res.status(400).json({ error: 'Invalid snapshot id', error_code: 'invalid_request' });
      }

      // Step 1: early If-Match pre-check + read-only snapshot load + pre-probe SSRF validation
      const earlyVerCheck = resolveExpectedVersion(req);
      if (!earlyVerCheck.ok) {
        const { status, ...payload } = earlyVerCheck;
        return res.status(status).json(payload);
      }
      const preSnapshot = storage.getConfigSnapshot(snapId);
      if (!preSnapshot) {
        return res.status(404).json({ error: 'Snapshot not found', error_code: 'snapshot_not_found' });
      }
      const preNormalized = storage.normalizeConfig({
        ...preSnapshot,
        setup_token: appConfig.setup_token,
      });
      try {
        validateConfigTargets(preNormalized, {
          legacyLoopbackAllowlist,
          allowLoopbackUpstreams,
          selfPort: getActualPort(),
        });
      } catch (err) {
        if (err instanceof SsrfBlockedError) {
          return res.status(400).json({ error: err.message, error_code: 'ssrf_blocked' });
        }
        throw err;
      }

      // Step 2: off-lock srv-* canonical resolution
      const resolvedSrvMap = await resolveSrvCanonicalCandidates(preNormalized.servers, appConfig, 3_000);

      // Step 3: single withConfigLock re-verify + safe merge + validateConfigTargets + migrate commit
      const result = await withConfigLock(async () => {
        const verCheck = resolveExpectedVersion(req);
        if (!verCheck.ok) return { errorResponse: verCheck };

        const snapshot = storage.getConfigSnapshot(snapId);
        if (!snapshot) {
          return { errorResponse: { status: 404, error: 'Snapshot not found', error_code: 'snapshot_not_found' } };
        }
        const restored = storage.normalizeConfig({
          ...snapshot,
          setup_token: appConfig.setup_token,
        });
        const migrations = applySafeAutomaticCanonicalizations(restored, resolvedSrvMap);
        const normalizedFinal = storage.normalizeConfig(restored);
        try {
          validateConfigTargets(normalizedFinal, {
            legacyLoopbackAllowlist,
            allowLoopbackUpstreams,
            selfPort: getActualPort(),
          });
        } catch (err) {
          if (err instanceof SsrfBlockedError) {
            return { errorResponse: { status: 400, error: err.message, error_code: 'ssrf_blocked' } };
          }
          throw err;
        }
        if (migrations.length > 0) {
          appConfig = storage.saveConfigAndMigrateServerIds(normalizedFinal, migrations, `restored-snapshot-${snapId}`);
        } else {
          appConfig = storage.saveConfig(normalizedFinal, {
            reason: `restored-snapshot-${snapId}`,
            eventType: 'snapshot_restored',
            req,
            details: { snapshotId: snapId },
          });
        }
        return { ok: true };
      });

      if (result.errorResponse) {
        const { status, ...payload } = result.errorResponse;
        return res.status(status).json(payload);
      }

      reconcileJellyfinRealtimeSockets();
      broadcastConfigChanged();
      const version = storage.getConfigVersion();
      setConfigEtag(res, version);
      return res.json({ status: 'ok', config: redactConfigForExport(appConfig), configVersion: version });
    } catch (err) {
      return handleSqliteOrMaintenanceError(res, err);
    }
  });

  // GET /api/admin/config/export (redacted unconditionally, ?includeSecrets removed)
  adminRouter.get('/config/export', (_req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="spatialfin-config.json"');
    res.json(redactConfigForExport(appConfig));
  });

  // POST /api/admin/config/import (5 MiB parsed AFTER auth; Stage 2 canonicalizes srv-* rows)
  adminRouter.post('/config/import', largeJsonParser, async (req, res) => {
    try {
      const imported = req.body;
      if (!imported || typeof imported !== 'object' || Array.isArray(imported)) {
        return res.status(400).json({ error: 'Invalid config: must be a JSON object', error_code: 'invalid_request' });
      }
      const { errors } = validateConfigPatch(imported);
      if (errors.length) {
        return res.status(400).json({ error: 'Invalid configuration payload', error_code: 'invalid_request', details: errors });
      }
      const confirmDropUnmatchedSecrets = imported.confirmDropUnmatchedSecrets === true;

      const buildImportDraft = (baseConfig) => {
        const draft = structuredClone(baseConfig);
        if (imported.globalPreferences) {
          draft.globalPreferences = { ...draft.globalPreferences, ...imported.globalPreferences };
          for (const [k, v] of Object.entries(imported.globalPreferences)) {
            if (v === null) delete draft.globalPreferences[k];
          }
        }
        if (imported.devicePreferences) {
          draft.devicePreferences = { ...draft.devicePreferences };
          for (const [devId, map] of Object.entries(imported.devicePreferences)) {
            if (!isValidMapKey(devId) || devId.length > 128) continue;
            const mergedDev = { ...(draft.devicePreferences[devId] || {}), ...map };
            for (const [k, v] of Object.entries(map)) {
              if (v === null) delete mergedDev[k];
            }
            if (Object.keys(mergedDev).length === 0) delete draft.devicePreferences[devId];
            else draft.devicePreferences[devId] = mergedDev;
          }
        }
        if (imported.servers !== undefined) draft.servers = structuredClone(imported.servers);
        if (imported.networkShares !== undefined) draft.networkShares = structuredClone(imported.networkShares);

        if (
          imported.setup_token === undefined ||
          imported.setup_token === null ||
          (typeof imported.setup_token === 'string' &&
            (imported.setup_token.trim() === '' || imported.setup_token === SECRET_PLACEHOLDER))
        ) {
          draft.setup_token = baseConfig.setup_token;
        } else if (typeof imported.setup_token === 'string' && STRONG_SETUP_TOKEN_REGEX.test(imported.setup_token.trim())) {
          draft.setup_token = imported.setup_token.trim();
        } else {
          return {
            errorResponse: {
              status: 400,
              error: 'Explicit setup_token in import must match sf-setup-<32+ lowercase hex>',
              error_code: 'invalid_request',
            },
          };
        }
        return { draft };
      };

      // Step 1: early If-Match pre-check + pre-probe redaction & SSRF gate
      const earlyVerCheck = resolveExpectedVersion(req);
      if (!earlyVerCheck.ok) {
        const { status, ...payload } = earlyVerCheck;
        return res.status(status).json(payload);
      }
      const preBuilt = buildImportDraft(appConfig);
      if (preBuilt.errorResponse) {
        const { status, ...payload } = preBuilt.errorResponse;
        return res.status(status).json(payload);
      }
      const preRedaction = restoreRedactedSecrets(preBuilt.draft, appConfig, {
        confirmDropUnmatchedSecrets,
        rawPatch: imported,
      });
      if (!preRedaction.ok) {
        return res.status(400).json({
          error: 'Imported config contains redacted secrets that do not match current targets.',
          error_code: preRedaction.errorCode,
          unmatchedSecrets: preRedaction.unmatchedSecrets,
        });
      }
      const preNormalized = storage.normalizeConfig(preBuilt.draft);
      try {
        validateConfigTargets(preNormalized, {
          legacyLoopbackAllowlist,
          allowLoopbackUpstreams,
          selfPort: getActualPort(),
        });
      } catch (err) {
        if (err instanceof SsrfBlockedError) {
          return res.status(400).json({ error: err.message, error_code: 'ssrf_blocked' });
        }
        throw err;
      }

      // Step 2: off-lock srv-* canonical resolution
      const resolvedSrvMap = await resolveSrvCanonicalCandidates(preNormalized.servers, appConfig, 3_000);

      // Step 3: single withConfigLock re-verify + redaction + safe canonical merge + SSRF check + migrate commit
      let prevSetupToken = null;
      const result = await withConfigLock(async () => {
        const verCheck = resolveExpectedVersion(req);
        if (!verCheck.ok) return { errorResponse: verCheck };

        prevSetupToken = appConfig.setup_token;
        const built = buildImportDraft(appConfig);
        if (built.errorResponse) return built;
        const { draft } = built;

        const redaction = restoreRedactedSecrets(draft, appConfig, {
          confirmDropUnmatchedSecrets,
          rawPatch: imported,
        });
        if (!redaction.ok) {
          return {
            errorResponse: {
              status: 400,
              error: 'Imported config contains redacted secrets that do not match current targets.',
              error_code: redaction.errorCode,
              unmatchedSecrets: redaction.unmatchedSecrets,
            },
          };
        }

        const migrations = applySafeAutomaticCanonicalizations(draft, resolvedSrvMap);
        const normalizedDraft = storage.normalizeConfig(draft);
        try {
          validateConfigTargets(normalizedDraft, {
            legacyLoopbackAllowlist,
            allowLoopbackUpstreams,
            selfPort: getActualPort(),
          });
        } catch (err) {
          if (err instanceof SsrfBlockedError) {
            return { errorResponse: { status: 400, error: err.message, error_code: 'ssrf_blocked' } };
          }
          throw err;
        }

        if (migrations.length > 0) {
          appConfig = storage.saveConfigAndMigrateServerIds(normalizedDraft, migrations, 'config-import');
        } else {
          appConfig = storage.saveConfig(normalizedDraft, {
            reason: 'config-import',
            eventType: 'config_imported',
            req,
            details: {
              importedServers: Array.isArray(normalizedDraft.servers) ? normalizedDraft.servers.length : 0,
              importedShares: Array.isArray(normalizedDraft.networkShares) ? normalizedDraft.networkShares.length : 0,
            },
          });
        }
        return { droppedSecrets: redaction.droppedSecrets };
      });

      if (result.errorResponse) {
        const { status, ...payload } = result.errorResponse;
        return res.status(status).json(payload);
      }

      if (prevSetupToken && prevSetupToken !== appConfig.setup_token) {
        revokeSetupTokenWebSockets();
      }
      reconcileJellyfinRealtimeSockets();
      broadcastConfigChanged();
      const version = storage.getConfigVersion();
      setConfigEtag(res, version);
      const responseBody = {
        status: 'ok',
        config: redactConfigForExport(appConfig),
        configVersion: version,
      };
      if (result.droppedSecrets && result.droppedSecrets.length > 0) {
        responseBody.droppedSecrets = result.droppedSecrets;
      }
      return res.json(responseBody);
    } catch (err) {
      return handleSqliteOrMaintenanceError(res, err);
    }
  });

  // POST /api/admin/verify-user (Stage 2: srv-* canonicalization + Predicate 1 confirmation)
  adminRouter.post('/verify-user', async (req, res) => {
    try {
      const { serverId, serverUrl, username, password, confirmDropUnmatchedSecrets } = req.body || {};
      const confirmedDrop = confirmDropUnmatchedSecrets === true;
      if (!serverId || typeof username !== 'string' || !username.trim() || typeof password !== 'string') {
        return res.status(400).json({ error: 'serverId, username, and password are required', error_code: 'invalid_request' });
      }
      if (confirmedDrop) {
        const earlyVerCheck = resolveExpectedVersion(req);
        if (!earlyVerCheck.ok) {
          const { status, ...payload } = earlyVerCheck;
          return res.status(status).json(payload);
        }
      }
      const serverSnapshot = findConfigServerById(serverId);
      if (!serverSnapshot) {
        return res.status(404).json({ error: 'Server not found', error_code: 'server_not_found' });
      }

      const addresses = Array.isArray(serverSnapshot.addresses) ? serverSnapshot.addresses.filter(Boolean) : [];
      let candidateUrls = addresses;
      if (serverUrl !== undefined && serverUrl !== null && String(serverUrl).trim() !== '') {
        const cleanRequested = String(serverUrl).trim().replace(/\/+$/, '');
        const allowed = addresses.some((a) => String(a).trim().replace(/\/+$/, '') === cleanRequested);
        if (!allowed) {
          return res.status(400).json({ error: 'serverUrl does not belong to the configured server', error_code: 'invalid_request' });
        }
        candidateUrls = [cleanRequested];
      }
      if (candidateUrls.length === 0) {
        return res.status(400).json({ error: 'Server has no configured addresses', error_code: 'invalid_request' });
      }

      for (const addr of candidateUrls) {
        validateInitialUrl(addr, POLICY_PUBLIC_OR_LAN, {
          allowLoopback: allowLoopbackUpstreams,
          legacyLoopbackAllowlist,
          selfPort: getActualPort(),
        });
      }

      // Phase 1: outbound auth OUTSIDE withConfigLock
      let authResponse = null;
      let winningUrl = null;
      let lastNetworkError = null;
      for (const addr of candidateUrls) {
        const cleanUrl = String(addr).trim().replace(/\/+$/, '');
        try {
          const result = await safeHttpJson(`${cleanUrl}/Users/AuthenticateByName`, {
            method: 'POST',
            body: { Username: username.trim(), Pw: password },
            headers: buildJellyfinAuthHeaders(null),
            timeoutMs: 10_000,
          });
          authResponse = result;
          winningUrl = cleanUrl;
          break;
        } catch (err) {
          if (err instanceof SsrfBlockedError) {
            return res.status(400).json({ error: err.message, error_code: 'ssrf_blocked' });
          }
          lastNetworkError = err;
        }
      }

      if (!authResponse) {
        const isTimeout = lastNetworkError && lastNetworkError.name === 'AbortError';
        return res.status(isTimeout ? 504 : 502).json({
          error: isTimeout ? 'Jellyfin server timed out' : 'Unable to reach Jellyfin server',
          error_code: isTimeout ? 'server_timeout' : 'server_unreachable',
        });
      }

      if (authResponse.status === 401 || authResponse.status === 403) {
        return res.json({ success: false, error: 'Invalid Jellyfin username or password', error_code: 'invalid_credentials' });
      }
      if (authResponse.status !== 200 || !authResponse.data || typeof authResponse.data !== 'object') {
        return res.json({ success: false, error: `Authentication failed with status ${authResponse.status}`, error_code: 'server_http_error' });
      }

      const accessToken = authResponse.data.AccessToken;
      const userId = authResponse.data.User ? authResponse.data.User.Id : authResponse.data.UserId;
      const returnedServerId = String(authResponse.data.ServerId || '').trim() || null;
      const resolvedUsername = authResponse.data.User?.Name || username.trim();

      if (!accessToken || !userId) {
        return res.json({ success: false, error: 'Jellyfin returned an incomplete auth response', error_code: 'server_http_error' });
      }

      const isSrvRow = isLegacySyntheticServerId(serverSnapshot.id);
      let probedNameForCanonical = '';
      if (!isSrvRow) {
        if (!returnedServerId || normalizeId(returnedServerId) !== normalizeId(serverSnapshot.id)) {
          return res.status(409).json({
            error: 'Authenticated Jellyfin server ID does not match configured server',
            error_code: 'conflict',
          });
        }
      } else {
        // Stage 2: cross-check returnedServerId against off-lock GET /System/Info/Public
        if (!returnedServerId) {
          return res.status(409).json({
            error: 'Jellyfin server did not return a canonical ServerId',
            error_code: 'conflict',
          });
        }
        try {
          const pubInfo = await probePublicSystemInfo({
            baseUrl: winningUrl,
            safeHttpJson,
            timeoutMs: 5_000,
          });
          if (normalizeUuid(pubInfo.serverId) !== normalizeUuid(returnedServerId)) {
            return res.status(409).json({
              error: 'Authenticated Jellyfin ServerId does not match public system info',
              error_code: 'conflict',
            });
          }
          probedNameForCanonical = pubInfo.serverName || '';
        } catch (err) {
          if (err instanceof SsrfBlockedError) {
            return res.status(400).json({ error: err.message, error_code: 'ssrf_blocked' });
          }
          return res.status(409).json({
            error: 'Failed to verify canonical Jellyfin server identity',
            error_code: 'conflict',
          });
        }
      }

      // Phase 2: commit inside withConfigLock
      const commit = await withConfigLock(async () => {
        if (confirmedDrop) {
          const verCheck = resolveExpectedVersion(req);
          if (!verCheck.ok) return { errorResponse: verCheck };
        }

        const draft = structuredClone(appConfig);
        const liveTarget = findConfigServerByIdInConfig(draft, serverId);
        if (!liveTarget) {
          return { errorResponse: { status: 404, error: 'Server not found', error_code: 'server_not_found' } };
        }

        let targetServer = liveTarget;
        let migrations = [];
        let droppedSecrets = [];

        if (isLegacySyntheticServerId(liveTarget.id) && returnedServerId) {
          const existingCanon = draft.servers.find(
            (s) => s && s.id !== liveTarget.id && normalizeUuid(s.id) === normalizeUuid(returnedServerId)
          );
          let dropUserIds = null;
          if (existingCanon) {
            const impact = evaluateServerAddressBindingImpact({
              sourceServer: liveTarget,
              canonicalServer: existingCanon,
              excludeUserId: userId,
            });
            if (impact.affectedUsers.length > 0) {
              if (!confirmedDrop) {
                return {
                  errorResponse: {
                    status: 400,
                    error: 'Canonicalizing this server expands addresses for other verified users; confirm to mark them for re-link.',
                    error_code: 'redacted_secret_mismatch',
                    unmatchedSecrets: impact.affectedUsers.map((u) => u.label),
                    configVersion: storage.getConfigVersion(),
                  },
                };
              }
              dropUserIds = impact.affectedUsers.map((u) => u.userId || u.username);
            }
          }
          const merged = mergeCanonicalServerInDraft(draft, {
            sourceServerId: liveTarget.id,
            canonicalId: returnedServerId,
            probedServerName: probedNameForCanonical,
            dropAffectedUserIds: dropUserIds,
          });
          targetServer = merged.targetServer;
          migrations = merged.migrations;
          droppedSecrets = merged.droppedSecrets;
          cancelPendingRelink(liveTarget.id, null);
        }

        if (!Array.isArray(targetServer.users)) targetServer.users = [];
        let user = targetServer.users.find(
          (u) =>
            u &&
            ((u.id && normalizeId(u.id) === normalizeId(userId)) ||
              String(u.username || u.name || '').toLowerCase() === resolvedUsername.toLowerCase() ||
              String(u.username || u.name || '').toLowerCase() === username.trim().toLowerCase())
        );
        if (user) {
          user.id = userId;
          user.username = resolvedUsername;
          user.access_token = accessToken;
          user.needs_relink = false;
          delete user.password;
        } else {
          user = {
            id: userId,
            username: resolvedUsername,
            access_token: accessToken,
            needs_relink: false,
            preferences: {},
          };
          targetServer.users.push(user);
        }

        if (migrations.length > 0) {
          appConfig = storage.saveConfigAndMigrateServerIds(draft, migrations, 'verify-user');
        } else {
          appConfig = storage.saveConfig(draft, {
            reason: 'verify-user',
            eventType: 'user_verified',
            req,
            details: { serverId: targetServer.id, userId, username: resolvedUsername },
          });
        }
        cancelPendingRelink(targetServer.id, userId);
        return { serverId: targetServer.id, userId, droppedSecrets };
      });

      if (commit.errorResponse) {
        const { status, ...payload } = commit.errorResponse;
        return res.status(status).json(payload);
      }

      reconcileJellyfinRealtimeSockets();
      broadcastConfigChanged();
      const version = storage.getConfigVersion();
      setConfigEtag(res, version);
      const redactedConfig = redactConfigForExport(appConfig);
      const redactedSrv = findConfigServerByIdInConfig(redactedConfig, commit.serverId);
      const redactedUser = (redactedSrv?.users || []).find((u) => u && normalizeId(u.id) === normalizeId(commit.userId));
      const cleanUser = redactedUser ? { ...redactedUser } : { id: userId, username: resolvedUsername, has_verified_token: true, needs_relink: false };
      delete cleanUser.access_token;

      const resp = {
        success: true,
        serverId: commit.serverId,
        user: cleanUser,
        config: redactedConfig,
        configVersion: version,
      };
      if (commit.droppedSecrets && commit.droppedSecrets.length > 0) {
        resp.droppedSecrets = commit.droppedSecrets;
      }
      return res.json(resp);
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        return res.status(400).json({ error: err.message, error_code: 'ssrf_blocked' });
      }
      return handleSqliteOrMaintenanceError(res, err);
    }
  });

  // ---------------------------------------------------------------------------
  // Stage 2: Admin Quick Connect User Linking (/quick-connect/initiate, /poll, /cancel)
  // ---------------------------------------------------------------------------
  adminRouter.post('/quick-connect/initiate', async (req, res) => {
    try {
      const { serverId, serverUrl, serverName } = req.body || {};
      const cleanServerId = typeof serverId === 'string' && serverId.trim() ? serverId.trim() : null;
      const cleanServerUrl = typeof serverUrl === 'string' && serverUrl.trim() ? normalizeUrl(serverUrl) : null;
      const cleanServerName = typeof serverName === 'string' && serverName.trim() ? serverName.trim() : '';

      pruneExpiredPendingQuickConnects();
      if (pendingQuickConnects.size >= MAX_PENDING_QC_SESSIONS) {
        return res.status(429).json({
          error: 'Too many active Quick Connect linking sessions.',
          error_code: 'pairing_rate_limited',
        });
      }

      let targetServer = null;
      let candidateAddresses = [];
      let expectedServerId = null;

      if (cleanServerId) {
        targetServer = findConfigServerById(cleanServerId);
        if (!targetServer) {
          return res.status(404).json({ error: 'Server not found', error_code: 'server_not_found' });
        }
        expectedServerId = targetServer.id;
        if (cleanServerUrl) {
          candidateAddresses = [cleanServerUrl];
        } else {
          candidateAddresses = (Array.isArray(targetServer.addresses) ? targetServer.addresses : [])
            .map(normalizeUrl)
            .filter(Boolean);
        }
      } else {
        if (!cleanServerUrl) {
          return res.status(400).json({ error: 'Provide serverId or serverUrl', error_code: 'invalid_request' });
        }
        candidateAddresses = [cleanServerUrl];
      }

      if (candidateAddresses.length === 0) {
        return res.status(400).json({ error: 'Server has no configured addresses', error_code: 'invalid_request' });
      }

      for (const addr of candidateAddresses) {
        validateInitialUrl(addr, POLICY_PUBLIC_OR_LAN, {
          allowLoopback: allowLoopbackUpstreams,
          legacyLoopbackAllowlist,
          selfPort: getActualPort(),
        });
      }

      const initiated = await initiateQuickConnect({
        addresses: candidateAddresses,
        expectedServerId,
        safeHttpJson,
        buildJellyfinAuthHeaders,
      });

      // Unsaved serverUrl guard: reject 409 if an existing server matches probedServerId without containing serverUrl
      if (!cleanServerId && cleanServerUrl) {
        const colliding = findConfigServerById(initiated.probedServerId);
        if (colliding) {
          const existingAddrs = new Set((Array.isArray(colliding.addresses) ? colliding.addresses : []).map(normalizeUrl));
          if (!existingAddrs.has(cleanServerUrl)) {
            return res.status(409).json({
              error: 'This server already exists under different addresses. Add this address explicitly to that server.',
              error_code: 'conflict',
            });
          }
        }
      }

      pruneExpiredPendingQuickConnects();
      if (pendingQuickConnects.size >= MAX_PENDING_QC_SESSIONS) {
        return res.status(429).json({
          error: 'Too many active Quick Connect linking sessions.',
          error_code: 'pairing_rate_limited',
        });
      }

      const pendingId = generatePendingId();
      const expiresAt = Date.now() + PENDING_QC_TTL_MS;
      pendingQuickConnects.set(pendingId, {
        pendingId,
        code: initiated.code,
        secret: initiated.secret,
        baseUrl: initiated.baseUrl,
        serverId: targetServer ? targetServer.id : null,
        explicitServerUrl: cleanServerUrl,
        serverName: cleanServerName || initiated.probedServerName || '',
        probedServerId: initiated.probedServerId,
        probedServerName: initiated.probedServerName || '',
        expiresAt,
        pollInFlight: null,
        confirmInFlight: null,
        awaitingConfirmation: null,
      });

      return res.json({
        pendingId,
        code: initiated.code,
        expiresAt,
      });
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        return res.status(400).json({ error: err.message, error_code: 'ssrf_blocked' });
      }
      if (err && err.errorCode) {
        return res.status(err.status || 503).json({
          error: err.message || 'Quick Connect initiation failed.',
          error_code: err.errorCode,
        });
      }
      return res.status(503).json({
        error: 'Unable to reach Jellyfin server for Quick Connect.',
        error_code: 'qc_broker_unreachable',
      });
    }
  });

  adminRouter.post('/quick-connect/poll', async (req, res) => {
    try {
      const { pendingId, confirmDropUnmatchedSecrets } = req.body || {};
      const cleanPendingId = typeof pendingId === 'string' ? pendingId.trim() : '';
      if (!cleanPendingId) {
        return res.status(400).json({ error: 'pendingId is required', error_code: 'invalid_request' });
      }
      const confirmDrop = confirmDropUnmatchedSecrets === true;

      pruneExpiredPendingQuickConnects();

      // Check 30 s tokenless drain cache first
      const drained = qcDrainCache.get(cleanPendingId);
      if (drained && Date.now() < drained.expiresAt) {
        if (drained.configVersion) setConfigEtag(res, drained.configVersion);
        return res.json(drained.response);
      }

      const pending = pendingQuickConnects.get(cleanPendingId);
      if (!pending) {
        return res.status(404).json({ error: 'Quick Connect session not found', error_code: 'session_not_found' });
      }

      // Helper to commit authenticated QC result inside withConfigLock
      const commitAuthenticatedQc = async ({ authResult, isConfirmedChallenge }) => {
        const commitRes = await withConfigLock(async () => {
          const draft = structuredClone(appConfig);
          const currentVersion = storage.getConfigVersion();

          if (isConfirmedChallenge) {
            const challenge = pending.awaitingConfirmation;
            if (!challenge || Date.now() >= challenge.expiresAt) {
              wipePendingQuickConnect(cleanPendingId);
              return { status: 200, body: { status: 'expired' } };
            }
            if (currentVersion !== challenge.configVersionAtChallenge) {
              wipePendingQuickConnect(cleanPendingId);
              return {
                status: 409,
                body: { error: 'Configuration changed while awaiting confirmation.', error_code: 'conflict' },
              };
            }
          }

          let liveTarget = null;
          if (pending.serverId) {
            liveTarget = findConfigServerByIdInConfig(draft, pending.serverId);
            if (!liveTarget) {
              wipePendingQuickConnect(cleanPendingId);
              return {
                status: 404,
                body: { error: 'Target server no longer exists', error_code: 'server_not_found' },
              };
            }
          } else if (pending.explicitServerUrl) {
            const colliding = findConfigServerByIdInConfig(draft, authResult.serverId);
            if (colliding) {
              const addrs = new Set((Array.isArray(colliding.addresses) ? colliding.addresses : []).map(normalizeUrl));
              if (!addrs.has(pending.explicitServerUrl)) {
                wipePendingQuickConnect(cleanPendingId);
                return {
                  status: 409,
                  body: { error: 'Server already exists under different addresses.', error_code: 'conflict' },
                };
              }
              liveTarget = colliding;
            }
          }

          const canonicalId = authResult.serverId;
          const existingCanon = draft.servers.find(
            (s) => s && (!liveTarget || s.id !== liveTarget.id) && normalizeUuid(s.id) === normalizeUuid(canonicalId)
          );
          const extraAddresses = pending.explicitServerUrl ? [pending.explicitServerUrl] : [pending.baseUrl];

          const impact = evaluateServerAddressBindingImpact({
            sourceServer: liveTarget,
            canonicalServer: existingCanon,
            extraAddresses,
            excludeUserId: authResult.userId,
          });

          if (impact.affectedUsers.length > 0) {
            const affectedLabels = impact.affectedUsers.map((u) => u.label);
            if (!isConfirmedChallenge) {
              // Enter awaitingConfirmation (120 s flat TTL, decoupled from pending.expiresAt)
              if (pending.awaitingConfirmation?.timer) clearTimeout(pending.awaitingConfirmation.timer);
              const confirmExpiresAt = Date.now() + QC_CONFIRM_TTL_MS;
              const timer = setTimeout(() => {
                wipePendingQuickConnect(cleanPendingId);
              }, QC_CONFIRM_TTL_MS);
              if (typeof timer.unref === 'function') timer.unref();
              pending.awaitingConfirmation = {
                accessToken: authResult.accessToken,
                userId: authResult.userId,
                username: authResult.username,
                serverId: authResult.serverId,
                configVersionAtChallenge: currentVersion,
                unmatchedSecrets: affectedLabels,
                affectedUserIds: impact.affectedUsers.map((u) => u.userId || u.username),
                expiresAt: confirmExpiresAt,
                timer,
              };
              return {
                status: 400,
                body: {
                  error: 'Expanding server addresses affects other verified users; confirm to mark them for re-link.',
                  error_code: 'redacted_secret_mismatch',
                  unmatchedSecrets: affectedLabels,
                },
              };
            }

            // Confirmed challenge: ensure no additional verified users beyond challenged set would be affected
            const challengedSet = new Set(pending.awaitingConfirmation.unmatchedSecrets);
            const hasExtraAffected = affectedLabels.some((lbl) => !challengedSet.has(lbl));
            if (hasExtraAffected) {
              wipePendingQuickConnect(cleanPendingId);
              return {
                status: 409,
                body: { error: 'Additional verified users would be affected; retry Quick Connect.', error_code: 'conflict' },
              };
            }
          }

          const dropUserIds = isConfirmedChallenge && impact.affectedUsers.length > 0
            ? impact.affectedUsers.map((u) => u.userId || u.username)
            : null;

          const merged = mergeCanonicalServerInDraft(draft, {
            sourceServerId: liveTarget ? liveTarget.id : null,
            canonicalId,
            probedServerName: pending.serverName || pending.probedServerName || '',
            extraAddresses,
            dropAffectedUserIds: dropUserIds,
          });
          const targetServer = merged.targetServer;
          if (!Array.isArray(targetServer.users)) targetServer.users = [];
          let user = targetServer.users.find(
            (u) =>
              u &&
              ((u.id && normalizeId(u.id) === normalizeId(authResult.userId)) ||
                (authResult.username && String(u.username || u.name || '').toLowerCase() === authResult.username.toLowerCase()))
          );
          if (user) {
            user.id = authResult.userId;
            if (authResult.username) user.username = authResult.username;
            user.access_token = authResult.accessToken;
            user.needs_relink = false;
            delete user.password;
          } else {
            user = {
              id: authResult.userId,
              username: authResult.username || authResult.userId,
              access_token: authResult.accessToken,
              needs_relink: false,
              preferences: {},
            };
            targetServer.users.push(user);
          }

          if (merged.migrations.length > 0) {
            appConfig = storage.saveConfigAndMigrateServerIds(draft, merged.migrations, 'quick-connect-link');
            for (const m of merged.migrations) cancelPendingRelink(m.oldId, null);
          } else {
            appConfig = storage.saveConfig(draft, {
              reason: 'quick-connect-link',
              eventType: 'user_linked_quick_connect',
              req,
              details: { serverId: targetServer.id, userId: authResult.userId, username: user.username },
            });
          }
          cancelPendingRelink(targetServer.id, authResult.userId);
          wipePendingQuickConnect(cleanPendingId);

          const nextVersion = storage.getConfigVersion();
          const responsePayload = {
            status: 'authenticated',
            serverId: targetServer.id,
            userId: authResult.userId,
            username: user.username,
            config: redactConfigForExport(appConfig),
            configVersion: nextVersion,
          };
          if (merged.droppedSecrets && merged.droppedSecrets.length > 0) {
            responsePayload.droppedSecrets = merged.droppedSecrets;
          }
          qcDrainCache.set(cleanPendingId, {
            expiresAt: Date.now() + QC_DRAIN_TTL_MS,
            configVersion: nextVersion,
            response: responsePayload,
          });
          return { status: 200, body: responsePayload, configVersion: nextVersion, committed: true };
        });

        if (commitRes.committed) {
          reconcileJellyfinRealtimeSockets();
          broadcastConfigChanged();
        }
        return commitRes;
      };

      // If a normal poll is in flight and this caller sends confirmDrop === true, await settlement
      // instead of coalescing onto the non-confirm result, then re-evaluate awaitingConfirmation / drain cache.
      if (confirmDrop && pending.pollInFlight) {
        try { await pending.pollInFlight; } catch (_) {}
        const postDrain = qcDrainCache.get(cleanPendingId);
        if (postDrain && Date.now() < postDrain.expiresAt) {
          if (postDrain.configVersion) setConfigEtag(res, postDrain.configVersion);
          return res.json(postDrain.response);
        }
        if (!pendingQuickConnects.has(cleanPendingId)) {
          return res.status(404).json({ error: 'Quick Connect session not found', error_code: 'session_not_found' });
        }
      }

      // Handle awaitingConfirmation branch
      if (pending.awaitingConfirmation) {
        if (Date.now() >= pending.awaitingConfirmation.expiresAt) {
          wipePendingQuickConnect(cleanPendingId);
          return res.json({ status: 'expired' });
        }
        if (!confirmDrop) {
          return res.status(400).json({
            error: 'Expanding server addresses affects other verified users; confirm to mark them for re-link.',
            error_code: 'redacted_secret_mismatch',
            unmatchedSecrets: pending.awaitingConfirmation.unmatchedSecrets,
          });
        }
        if (!pending.confirmInFlight) {
          const authSnapshot = {
            accessToken: pending.awaitingConfirmation.accessToken,
            userId: pending.awaitingConfirmation.userId,
            username: pending.awaitingConfirmation.username,
            serverId: pending.awaitingConfirmation.serverId,
          };
          pending.confirmInFlight = commitAuthenticatedQc({ authResult: authSnapshot, isConfirmedChallenge: true })
            .finally(() => {
              pending.confirmInFlight = null;
            });
        }
        const confirmOut = await pending.confirmInFlight;
        if (confirmOut.configVersion) setConfigEtag(res, confirmOut.configVersion);
        return res.status(confirmOut.status).json(confirmOut.body);
      }

      // Normal polling path (pre-emptive confirmDropUnmatchedSecrets is ignored while awaitingConfirmation == null)
      if (Date.now() >= pending.expiresAt) {
        wipePendingQuickConnect(cleanPendingId);
        return res.json({ status: 'expired' });
      }

      if (!pending.pollInFlight) {
        pending.pollInFlight = (async () => {
          const pollOut = await pollQuickConnect({
            baseUrl: pending.baseUrl,
            secret: pending.secret,
            safeHttpJson,
            buildJellyfinAuthHeaders,
          });
          if (pollOut.status === 'pending') {
            return { status: 200, body: { status: 'pending' } };
          }
          if (pollOut.status === 'expired' || pollOut.status === 'failed') {
            wipePendingQuickConnect(cleanPendingId);
            return { status: 200, body: pollOut };
          }

          // Authenticated -> exchange for AccessToken
          let authResult;
          try {
            authResult = await exchangeQuickConnect({
              baseUrl: pending.baseUrl,
              secret: pending.secret,
              safeHttpJson,
              buildJellyfinAuthHeaders,
            });
          } catch (err) {
            wipePendingQuickConnect(cleanPendingId);
            return {
              status: 200,
              body: {
                status: 'failed',
                error: err.message || 'Quick Connect exchange failed.',
                error_code: err.errorCode || 'server_http_error',
              },
            };
          }

          // Pin authResult.serverId (saved canonical vs srv-* / unsaved)
          const expectedCanonicalId =
            pending.serverId && !isLegacySyntheticServerId(pending.serverId)
              ? pending.serverId
              : pending.probedServerId;
          if (!authResult.serverId || normalizeUuid(authResult.serverId) !== normalizeUuid(expectedCanonicalId)) {
            wipePendingQuickConnect(cleanPendingId);
            return {
              status: 409,
              body: {
                error: 'Authenticated Jellyfin server ID does not match expected server.',
                error_code: 'conflict',
              },
            };
          }

          return await commitAuthenticatedQc({ authResult, isConfirmedChallenge: false });
        })().finally(() => {
          pending.pollInFlight = null;
        });
      }

      const pollOutcome = await pending.pollInFlight;
      if (pollOutcome.configVersion) setConfigEtag(res, pollOutcome.configVersion);
      return res.status(pollOutcome.status).json(pollOutcome.body);
    } catch (err) {
      return handleSqliteOrMaintenanceError(res, err);
    }
  });

  adminRouter.post('/quick-connect/cancel', (req, res) => {
    const { pendingId } = req.body || {};
    const cleanPendingId = typeof pendingId === 'string' ? pendingId.trim() : '';
    if (!cleanPendingId) {
      return res.status(400).json({ error: 'pendingId is required', error_code: 'invalid_request' });
    }
    wipePendingQuickConnect(cleanPendingId);
    return res.json({ cancelled: true });
  });

  // POST /api/admin/unlink-user
  adminRouter.post('/unlink-user', async (req, res) => {
    try {
      const { serverId, userId, username } = req.body || {};
      if (!serverId || (!userId && !username)) {
        return res.status(400).json({ error: 'serverId and userId or username are required', error_code: 'invalid_request' });
      }

      let revokedToken = null;
      let logoutBaseUrl = null;
      const result = await withConfigLock(async () => {
        const verCheck = resolveExpectedVersion(req);
        if (!verCheck.ok) return { errorResponse: verCheck };

        const draft = structuredClone(appConfig);
        const srv = findConfigServerByIdInConfig(draft, serverId);
        if (!srv) {
          return { errorResponse: { status: 404, error: 'Server not found', error_code: 'server_not_found' } };
        }
        const users = Array.isArray(srv.users) ? srv.users : [];
        const user = users.find((u) => {
          if (!u) return false;
          if (userId && u.id && normalizeId(u.id) === normalizeId(userId)) return true;
          if (username && String(u.username || u.name || '').toLowerCase() === String(username).toLowerCase()) return true;
          return false;
        });
        if (!user) {
          return { errorResponse: { status: 404, error: 'User not found', error_code: 'user_not_found' } };
        }

        revokedToken = user.access_token || null;
        logoutBaseUrl = (srv.addresses && srv.addresses[0]) ? String(srv.addresses[0]).replace(/\/+$/, '') : null;
        user.access_token = '';
        user.needs_relink = false;
        cancelPendingRelink(srv.id, user.id || user.username);

        appConfig = storage.saveConfig(draft, {
          reason: 'unlink-user',
          eventType: 'user_unlinked',
          req,
          details: { serverId: srv.id, userId: user.id || user.username },
        });
        return { ok: true };
      });

      if (result.errorResponse) {
        const { status, ...payload } = result.errorResponse;
        return res.status(status).json(payload);
      }

      // Best-effort off-lock /Sessions/Logout
      if (revokedToken && logoutBaseUrl) {
        safeHttpJson(`${logoutBaseUrl}/Sessions/Logout`, {
          method: 'POST',
          headers: buildJellyfinAuthHeaders(revokedToken),
          timeoutMs: 2_000,
        }).catch(() => {});
      }

      reconcileJellyfinRealtimeSockets();
      broadcastConfigChanged();
      const version = storage.getConfigVersion();
      setConfigEtag(res, version);
      return res.json({
        status: 'ok',
        config: redactConfigForExport(appConfig),
        configVersion: version,
      });
    } catch (err) {
      return handleSqliteOrMaintenanceError(res, err);
    }
  });

  // TV Pairing & Stage 1 Handoff routes
  adminRouter.get('/tv-pairing/subnet-hint', async (req, res) => {
    try {
      const seedAddress = await resolveDiscoverySeedAddress(req);
      const rawIfaces = getInterfaces();
      const networkInterfaces = getScanNetworkInterfaces(rawIfaces);
      const seeds = collectPrivateIpv4SeedAddresses(networkInterfaces, seedAddress ? [seedAddress] : []);
      const primaryWithIface = getPrimaryLanIpv4WithInterface(rawIfaces);
      const primary = primaryWithIface?.address || seeds[0] || '';
      const parts = primary.split('.');
      const prefix = parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.` : '';
      let defaultCompanionUrl = '';
      try {
        defaultCompanionUrl = buildCompanionBaseUrl(req, null, { forHandoff: true });
      } catch (_) {
        try { defaultCompanionUrl = buildCompanionBaseUrl(req, null, { forHandoff: false }); } catch (__) {}
      }

      const in172 = parts.length === 4 && Number(parts[0]) === 172 && Number(parts[1]) >= 16 && Number(parts[1]) <= 31;
      const hasDockerEnv = fs.existsSync('/.dockerenv');
      const ifaceIsDocker = Boolean(primaryWithIface?.name && /^(docker|br-)/i.test(primaryWithIface.name));
      const isLikelyDockerBridge = Boolean(in172 && (hasDockerEnv || ifaceIsDocker));

      return res.json({
        primary,
        prefix,
        port: TV_PAIRING_PORT,
        subnets: describePrivateIpv4Subnets(networkInterfaces, seedAddress ? [seedAddress] : []),
        defaultCompanionUrl,
        isLikelyDockerBridge,
      });
    } catch (error) {
      return res.status(500).json({ error: error.message, error_code: 'subnet_hint_failed' });
    }
  });

  adminRouter.post('/tv-pairing/discover', async (req, res) => {
    const now = Date.now();
    if (now - lastTvDiscoverAt < 10_000) {
      return res.status(429).json({
        error: 'Discovery was run recently. Wait 10 seconds before scanning again.',
        error_code: 'pairing_rate_limited',
      });
    }
    lastTvDiscoverAt = now;
    try {
      const result = await discoverTvCandidates(req);
      return res.json(result);
    } catch (err) {
      return res.status(err.status || 500).json({
        error: err.message || 'TV discovery failed.',
        error_code: err.errorCode || 'discovery_failed',
      });
    }
  });

  adminRouter.post('/tv-pairing/resolve', async (req, res) => {
    try {
      const { host, port: reqPort, receiverUrl } = req.body || {};
      const result = await lookupTvCandidateByReceiverUrl({ host, port: reqPort, receiverUrl });
      return res.json(result);
    } catch (err) {
      return res.status(err.status || 500).json({
        error: err.message || 'Device lookup failed.',
        error_code: err.errorCode || 'server_unreachable',
      });
    }
  });

  // POST /api/admin/device-setup/handoff (Stage 1: replaces pair-qr & pair-manual)
  adminRouter.post('/device-setup/handoff', async (req, res) => {
    const startMs = Date.now();
    const overallController = new AbortController();
    const overallTimer = setTimeout(() => overallController.abort(), 24_000);
    if (typeof overallTimer.unref === 'function') overallTimer.unref();

    try {
      const {
        host,
        port: reqPort,
        qrPayload,
        manualCode,
        serverId,
        userId,
        shareOnly,
        companionUrl: requestedCompanionUrl,
      } = req.body || {};

      if (shareOnly === true && (serverId || userId)) {
        return res.status(400).json({ error: 'shareOnly cannot be combined with serverId or userId', error_code: 'invalid_request' });
      }
      if (userId && !serverId) {
        return res.status(400).json({ error: 'userId requires serverId', error_code: 'invalid_request' });
      }

      if (serverId) {
        const srv = findConfigServerById(serverId);
        if (!srv) {
          return res.status(404).json({ error: 'Selected server not found', error_code: 'server_not_found' });
        }
        if (userId) {
          const exact = findExactUserForServer(serverId, userId);
          if (!exact.user) {
            return res.status(404).json({ error: 'Selected user not found on server', error_code: 'user_not_found' });
          }
          if (!exact.user.access_token) {
            return res.status(409).json({ error: 'Selected user does not have a verified token', error_code: 'no_verified_user' });
          }
        }
      }

      let targetReceiverUrl = '';
      let targetDeviceName = '';
      let pairingToken = '';
      let usedManualCodeFallback = false;

      if (qrPayload) {
        const setupUrlParsed = typeof qrPayload === 'string' ? parseSetupUrlQr(qrPayload) : { ok: false };
        if (setupUrlParsed.ok) {
          targetReceiverUrl = setupUrlParsed.receiver_url;
          pairingToken = setupUrlParsed.pairing_token;
        } else {
          let parsedQr;
          try {
            parsedQr = typeof qrPayload === 'string' ? JSON.parse(qrPayload) : qrPayload;
          } catch (_) {
            return res.status(400).json({ error: 'Invalid QR payload JSON or setup URL', error_code: 'invalid_request' });
          }
          const validatedQr = validateTvPairingPayload(parsedQr);
          if (!validatedQr.ok) {
            return res.status(400).json({ error: validatedQr.issues[0] || 'Invalid QR payload', error_code: 'invalid_request' });
          }
          targetReceiverUrl = validatedQr.payload.receiver_url;
          targetDeviceName = validatedQr.payload.device_name || '';
          pairingToken = validatedQr.payload.pairing_token;
        }
      } else {
        if (!host) {
          return res.status(400).json({ error: 'Provide either qrPayload or host + manualCode', error_code: 'invalid_request' });
        }
        const normCode = normalizeManualCode(manualCode);
        if (!normCode) {
          return res.status(400).json({ error: 'Enter a valid 6-character pairing code', error_code: 'pairing_code_format' });
        }
        const targetHost = stripBrackets(String(host).trim());
        const targetPort = normalizeOptionalPort(reqPort, TV_PAIRING_PORT);
        targetReceiverUrl = buildTvReceiverUrl(targetHost, targetPort);
        pairingToken = normCode;
        usedManualCodeFallback = true;
      }

      // Validate receiver URL under RECEIVER_LAN_HTTP_ONLY
      validateInitialUrl(targetReceiverUrl, POLICY_RECEIVER_LAN_HTTP_ONLY, { selfPort: getActualPort() });
      const companionUrl = buildCompanionBaseUrl(req, requestedCompanionUrl, { forHandoff: true });

      const parsedTarget = new URL(targetReceiverUrl);
      const attemptKey = [
        parsedTarget.origin.toLowerCase(),
        sha256Hex(pairingToken),
        serverId || '',
        userId || '',
        String(Boolean(shareOnly)),
      ].join('|');

      // Pre-handoff /info probe (4 s sub-timeout via AbortSignal.any)
      const infoUrl = buildTvInfoUrlFromReceiverUrl(targetReceiverUrl);
      const infoTimeoutController = new AbortController();
      const infoTimer = setTimeout(() => infoTimeoutController.abort(), 4_000);
      if (typeof infoTimer.unref === 'function') infoTimer.unref();

      let infoRes;
      try {
        infoRes = await safeHttpJson(infoUrl, {
          policy: POLICY_RECEIVER_LAN_HTTP_ONLY,
          maxRedirects: 0,
          signal: AbortSignal.any([overallController.signal, infoTimeoutController.signal]),
        });
      } catch (error) {
        clearTimeout(infoTimer);
        if (error instanceof SsrfBlockedError) {
          return res.status(400).json({ error: error.message, error_code: 'ssrf_blocked' });
        }
        if (error && error.name === 'AbortError') {
          return res.status(504).json({ error: 'Device did not respond to info check in time.', error_code: 'pairing_timeout' });
        }
        return res.status(502).json({ error: 'Device could not be reached on the local network.', error_code: 'server_unreachable' });
      } finally {
        clearTimeout(infoTimer);
      }

      let preferV2 = false;
      let fallbackToV1On404 = false;
      if (infoRes.status === 409) {
        // Fall through to v2 (and v1 only on 404 route_not_found) ONLY when matching a recent attempt
        if (!hasRecentHandoffAttempt(attemptKey)) {
          return res.status(409).json({
            error: 'The pairing code has expired. Start pairing again on the device.',
            error_code: 'pairing_code_expired',
          });
        }
        preferV2 = true;
        fallbackToV1On404 = true;
      } else if (infoRes.status !== 200) {
        const mapped = buildTvPairingError(infoRes, usedManualCodeFallback);
        return res.status(mapped.status).json({ error: mapped.error, error_code: mapped.error_code });
      } else if (infoRes.data && typeof infoRes.data === 'object') {
        if (infoRes.data.device_name && !targetDeviceName) {
          targetDeviceName = String(infoRes.data.device_name).trim();
        }
        const caps = Array.isArray(infoRes.data.capabilities) ? infoRes.data.capabilities : [];
        preferV2 = caps.includes('companion_handoff_v2');
      }

      const elapsed = Date.now() - startMs;
      const remaining = 24_000 - elapsed;
      if (remaining < 4_000) {
        return res.status(504).json({ error: 'Pairing handoff timed out.', error_code: 'pairing_timeout' });
      }
      recordRecentHandoffAttempt(attemptKey);

      let postResult;
      if (preferV2) {
        const v2TimeoutMs = Math.min(16_000, remaining - 3_000);
        try {
          postResult = await postCompanionHandoffV2({
            receiverUrl: targetReceiverUrl,
            companionUrl,
            pairingToken,
            usedManualCodeFallback,
            serverId,
            userId,
            shareOnly: Boolean(shareOnly),
            handoffTimeoutMs: v2TimeoutMs,
            signal: overallController.signal,
          });
        } catch (v2Err) {
          const isRouteNotFound = v2Err && v2Err.rawStatus === 404 && v2Err.rawErrorCode === 'route_not_found';
          if (fallbackToV1On404 && isRouteNotFound) {
            const remAfterV2 = 24_000 - (Date.now() - startMs);
            if (remAfterV2 < 4_000) {
              return res.status(504).json({ error: 'Pairing handoff timed out.', error_code: 'pairing_timeout' });
            }
            postResult = await postTvPairingEnvelope({
              receiverUrl: targetReceiverUrl,
              companionUrl,
              pairingToken,
              usedManualCodeFallback,
              serverId,
              userId,
              shareOnly: Boolean(shareOnly),
              handoffTimeoutMs: Math.min(14_000, remAfterV2 - 3_000),
              signal: overallController.signal,
            });
          } else {
            throw v2Err;
          }
        }
      } else {
        postResult = await postTvPairingEnvelope({
          receiverUrl: targetReceiverUrl,
          companionUrl,
          pairingToken,
          usedManualCodeFallback,
          serverId,
          userId,
          shareOnly: Boolean(shareOnly),
          handoffTimeoutMs: Math.min(14_000, remaining - 3_000),
          signal: overallController.signal,
        });
      }

      return res.json({
        ...postResult,
        deviceName: postResult.deviceName || targetDeviceName || parsedTarget.hostname,
      });
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        return res.status(400).json({ error: err.message, error_code: 'ssrf_blocked' });
      }
      return res.status(err.status || 500).json({
        error: err.message || 'Device setup handoff failed.',
        error_code: err.errorCode || 'storage_error',
      });
    } finally {
      clearTimeout(overallTimer);
    }
  });

  adminRouter.get('/servers/:serverId/quick-connect-status', async (req, res) => {
    const serverId = String(req.params.serverId || '').trim();
    const server = findConfigServerByIdInConfig(appConfig, serverId);
    if (!server) {
      return res.status(404).json({ error: 'Server not found', error_code: 'server_not_found' });
    }
    const status = await checkQuickConnectEnabled({
      serverConfig: server,
      safeHttpJson,
      buildJellyfinAuthHeaders,
    });
    return res.json({
      serverId: server.id,
      enabled: status.enabled,
      reachable: status.reachable,
      errorCode: status.errorCode || null,
    });
  });

  // Probe & discovery admin routes
  adminRouter.post('/test-jellyfin', async (req, res) => {
    const rawUrl = String((req.body && req.body.url) || '').trim();
    if (!rawUrl) {
      return res.status(400).json({ error: 'Server URL is required', error_code: 'invalid_request' });
    }
    const cleanUrl = rawUrl.replace(/\/+$/, '');
    try {
      validateInitialUrl(`${cleanUrl}/System/Info/Public`, POLICY_PUBLIC_OR_LAN, {
        allowLoopback: allowLoopbackUpstreams,
        legacyLoopbackAllowlist,
        selfPort: getActualPort(),
      });
    } catch (err) {
      return res.status(400).json({ error: err.message, error_code: 'ssrf_blocked' });
    }

    try {
      const result = await safeHttpJson(`${cleanUrl}/System/Info/Public`, { timeoutMs: 8_000 });
      if (result.status === 200 && result.data && typeof result.data === 'object') {
        return res.json({
          success: true,
          id: result.data.Id || null,
          serverName: result.data.ServerName,
          version: result.data.Version,
        });
      }
      return res.json({ success: false, error: `Unexpected status ${result.status}` });
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        return res.status(400).json({ error: err.message, error_code: 'ssrf_blocked' });
      }
      return res.json({ success: false, error: err.message });
    }
  });

  adminRouter.post('/test-seerr', async (req, res) => {
    const rawUrl = String((req.body && (req.body.url || req.body.seerrUrl)) || '').trim();
    if (!rawUrl) {
      return res.status(400).json({ error: 'Seerr URL is required', error_code: 'invalid_request' });
    }
    const cleanUrl = rawUrl.replace(/\/+$/, '');
    try {
      validateInitialUrl(`${cleanUrl}/api/v1/status`, POLICY_PUBLIC_OR_LAN, {
        allowLoopback: allowLoopbackUpstreams,
        legacyLoopbackAllowlist,
        selfPort: getActualPort(),
      });
    } catch (err) {
      return res.status(400).json({ error: err.message, error_code: 'ssrf_blocked' });
    }

    let apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey : '';
    if (apiKey === SECRET_PLACEHOLDER) {
      const stored = lookupStoredSeerrApiKey(cleanUrl, appConfig);
      if (!stored) {
        return res.status(400).json({
          error: 'No stored Seerr API key matches this URL.',
          error_code: 'redacted_secret_mismatch',
          unmatchedSecrets: ['seerr.apiKey'],
        });
      }
      apiKey = stored;
    }

    try {
      const result = await safeHttpJson(`${cleanUrl}/api/v1/status`, {
        headers: apiKey ? { 'X-Api-Key': apiKey } : {},
        timeoutMs: 8_000,
      });
      if (result.status === 200) {
        return res.json({ success: true, data: result.data });
      }
      return res.json({ success: false, error: `Unexpected status ${result.status}` });
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        return res.status(400).json({ error: err.message, error_code: 'ssrf_blocked' });
      }
      return res.json({ success: false, error: err.message });
    }
  });

  adminRouter.post('/test-network-share', async (req, res) => {
    const body = req.body || {};
    const validation = validateNetworkShareForTest(body);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.issues[0], error_code: 'invalid_request' });
    }

    const share = { ...validation.share };
    if (share.protocol === 'smb' && share.password === SECRET_PLACEHOLDER) {
      const stored = lookupStoredShareSecret(share, appConfig.networkShares, { matchShareName: true });
      if (!stored) {
        return res.status(400).json({
          error: 'No stored password matches this share target.',
          error_code: 'redacted_secret_mismatch',
          unmatchedSecrets: ['networkShare.password'],
        });
      }
      share.password = stored;
    }

    try {
      if (share.protocol === 'nfs') {
        const result = await testNfsShareConnection(share);
        return res.json({
          success: true,
          protocol: 'nfs',
          targetPath: result.targetPath,
          exportVerified: result.exportVerified,
          sample: result.sample,
          warning: result.warning,
        });
      }
      const result = await testSmbShareConnection(share);
      return res.json({
        success: true,
        protocol: 'smb',
        targetPath: result.targetPath,
        fileCount: result.fileCount,
        sample: result.sample,
      });
    } catch (error) {
      if (error instanceof SsrfBlockedError) {
        return res.status(400).json({ error: error.message, error_code: 'ssrf_blocked' });
      }
      return res.json({
        success: false,
        error: share.protocol === 'nfs' ? formatNfsShareTestError(error) : formatSmbShareTestError(error),
      });
    }
  });

  adminRouter.post('/discover-network-shares', async (req, res) => {
    const now = Date.now();
    if (now - lastShareDiscoverAt < 10_000) {
      return res.status(429).json({
        error: 'Network share discovery was run recently. Wait 10 seconds before scanning again.',
        error_code: 'pairing_rate_limited',
      });
    }
    lastShareDiscoverAt = now;
    try {
      const discovery = await discoverNetworkShareCandidates(req);
      return res.json({
        success: true,
        results: discovery.results,
        warnings: discovery.warnings,
        scannedSubnets: discovery.scannedSubnets,
      });
    } catch (error) {
      if (error.status === 503 || error.errorCode === 'local_network_unavailable') {
        return res.status(503).json({ error: error.message, error_code: 'local_network_unavailable' });
      }
      return res.json({
        success: false,
        error: error && error.message ? error.message : 'Network share discovery failed.',
      });
    }
  });

  adminRouter.post('/discover-smb-server-shares', async (req, res) => {
    const payload = { ...(req.body || {}) };
    const host = String(payload.host || '').trim();
    if (!host) {
      return res.status(400).json({ error: 'SMB host is required.', error_code: 'invalid_request' });
    }
    if (payload.password === SECRET_PLACEHOLDER) {
      const stored = lookupStoredShareSecret(
        { protocol: 'smb', host, port: payload.port, username: payload.username, domain: payload.domain },
        appConfig.networkShares,
        { matchShareName: false }
      );
      if (!stored) {
        return res.status(400).json({
          error: 'No stored SMB password matches this host and account.',
          error_code: 'redacted_secret_mismatch',
          unmatchedSecrets: ['smb.password'],
        });
      }
      payload.password = stored;
    }

    try {
      const shares = await listSmbServerShares(payload);
      return res.json({ success: true, host, shares });
    } catch (error) {
      if (error instanceof SsrfBlockedError) {
        return res.status(400).json({ error: error.message, error_code: 'ssrf_blocked' });
      }
      return res.json({ success: false, error: formatSmbShareDiscoveryError(error, payload.username) });
    }
  });

  adminRouter.post('/discover-nfs-exports', async (req, res) => {
    const payload = req.body || {};
    const host = String(payload.host || '').trim();
    if (!host) {
      return res.status(400).json({ error: 'NFS host is required.', error_code: 'invalid_request' });
    }
    try {
      const portNum = normalizeOptionalPort(payload.port, 2049);
      const pinned = await validateLanHost(host, { port: portNum, selfPort: getActualPort(), dnsLookup });
      await checkTcpPort(pinned.address, portNum);
      const exportInfo = await queryNfsExports(host, pinned);
      if ((!Array.isArray(exportInfo.exports) || exportInfo.exports.length === 0) && exportInfo.warning) {
        return res.json({ success: false, error: exportInfo.warning });
      }
      return res.json({ success: true, host, exports: exportInfo.exports, warning: exportInfo.warning });
    } catch (error) {
      if (error instanceof SsrfBlockedError) {
        return res.status(400).json({ error: error.message, error_code: 'ssrf_blocked' });
      }
      return res.json({ success: false, error: formatNfsExportDiscoveryError(error) });
    }
  });

  // Sync log, Device logs, Analytics, Artwork, Database admin routes
  function formatLogEntry(entry) {
    const timestamp = entry.timestamp || entry.receivedAt || new Date().toISOString();
    const level = entry.level || '?';
    const tag = entry.tag || 'SpatialFin';
    const message = entry.message || '';
    const header = `${timestamp} ${level}/${tag}: ${message}`;
    return entry.stack ? `${header}\n${entry.stack}` : header;
  }

  adminRouter.get('/sync-log', (_req, res) => res.json(storage.getSyncLog(100)));

  adminRouter.get('/device-logs', (_req, res) => {
    res.json({
      loggingEnabled: appConfig.globalPreferences.pref_logging_enabled === 'true',
      devices: storage.getDeviceSummaries(),
    });
  });

  adminRouter.get('/device-logs/:deviceId', (req, res) => {
    const requestedLimit = Number(req.query.limit) || 500;
    const limit = Math.max(1, Math.min(2000, requestedLimit));
    const result = storage.getDeviceWithLogs(req.params.deviceId, limit);
    if (!result) return res.status(404).json({ error: 'Device logs not found' });
    return res.json({ device: result.device, entries: result.entries });
  });

  adminRouter.get('/device-logs/:deviceId/download', (req, res) => {
    const result = storage.getDeviceWithLogs(req.params.deviceId, 1_000_000);
    if (!result) return res.status(404).json({ error: 'Device logs not found' });
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
      '',
    ];
    entries.forEach((entry) => { lines.push(formatLogEntry(entry)); lines.push(''); });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}-logs.txt"`);
    return res.send(lines.join('\n'));
  });

  adminRouter.delete('/device-logs/:deviceId', (req, res) => {
    storage.clearDeviceLogs(req.params.deviceId);
    res.json({ status: 'ok' });
  });

  adminRouter.patch('/devices/:deviceId', (req, res) => {
    const name = typeof (req.body && req.body.customName) === 'string' ? req.body.customName : '';
    if (name.length > 160) return res.status(400).json({ error: 'Name too long (max 160 characters)', error_code: 'invalid_request' });
    const result = storage.renameDevice(req.params.deviceId, name);
    if (!result.changes) return res.status(404).json({ error: 'Device not found' });
    return res.json({ status: 'ok', customName: result.customName });
  });

  adminRouter.delete('/devices/:deviceId', (req, res) => {
    const result = storage.deleteDevice(req.params.deviceId);
    if (!result.changes) return res.status(404).json({ error: 'Device not found' });
    return res.json({ status: 'ok' });
  });

  adminRouter.post('/device-logs/prune', (req, res) => {
    const days = Number(req.body && req.body.olderThanDays);
    if (!Number.isFinite(days) || days <= 0) {
      return res.status(400).json({ error: 'olderThanDays must be a positive number', error_code: 'invalid_request' });
    }
    try {
      return res.json({ status: 'ok', ...storage.pruneDeviceLogsOlderThan(days) });
    } catch (err) {
      return res.status(400).json({ error: err.message, error_code: 'invalid_request' });
    }
  });

  adminRouter.get('/analytics/overview', (req, res) => {
    const recentLimit = Math.max(1, Math.min(100, Number(req.query.recentLimit) || 10));
    const topLimit = Math.max(1, Math.min(100, Number(req.query.topLimit) || 10));
    const trendLimit = Math.max(1, Math.min(60, Number(req.query.trendLimit) || 14));
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    res.json({
      sync: { ...analyticsSyncState, lastError: scrubApiKeyFromText(analyticsSyncState.lastError) },
      realtimeSockets: getRealtimeSocketStatus(),
      rangeDays: days,
      overview: storage.getAnalyticsOverview({ days }),
      recentSessions: storage.getRecentPlaybackSessions(recentLimit, { days }),
      topUsers: storage.getTopPlaybackUsers(topLimit, { days }),
      topServers: storage.getTopPlaybackServers(topLimit, { days }),
      topLibraries: storage.getTopPlaybackLibraries(topLimit, { days }),
      trends: storage.getDailyPlaybackTrends(trendLimit, { days }),
      topItems: storage.getTopPlaybackItems(topLimit, { days }),
    });
  });

  adminRouter.get('/analytics/sync-status', (_req, res) => {
    res.json({
      sync: { ...analyticsSyncState, lastError: scrubApiKeyFromText(analyticsSyncState.lastError) },
      realtimeSockets: getRealtimeSocketStatus(),
      intervalMs: ANALYTICS_SYNC_INTERVAL_MS,
    });
  });

  adminRouter.get('/analytics/realtime-status', (_req, res) => {
    res.json({
      sync: { ...analyticsSyncState, lastError: scrubApiKeyFromText(analyticsSyncState.lastError) },
      sockets: getRealtimeSocketStatus(),
    });
  });

  adminRouter.get('/analytics/artwork/:serverId/:itemId', async (req, res) => {
    const itemId = String(req.params.itemId || '');
    if (!/^[0-9a-fA-F-]{1,64}$/.test(itemId)) {
      return res.status(400).json({ error: 'Invalid itemId', error_code: 'invalid_request' });
    }
    const lookup = findVerifiedUserForServer(req.params.serverId, null, null);
    if (!lookup.server || !lookup.user) {
      return res.status(404).json({ error: 'Artwork source not available', error_code: 'server_not_found' });
    }
    const baseUrl = String((lookup.server.addresses && lookup.server.addresses[0]) || '').replace(/\/+$/, '');
    const token = lookup.user.access_token;
    const url = `${baseUrl}/Items/${encodeURIComponent(itemId)}/Images/Primary?maxHeight=420&quality=90`;
    try {
      const upstream = await fetchImpl(url, {
        headers: buildJellyfinAuthHeaders(token),
        policy: POLICY_PUBLIC_OR_LAN,
        allowLoopback: allowLoopbackUpstreams,
        legacyLoopbackAllowlist,
        selfPort: getActualPort(),
        maxResponseBytes: 10 * 1024 * 1024,
        timeoutMs: 10_000,
        dnsLookup,
      });
      if (!upstream.ok) {
        return res.status(502).json({ error: `Artwork upstream HTTP ${upstream.status}`, error_code: 'server_http_error' });
      }
      const rawContentType = String(upstream.headers.get('content-type') || '');
      const mimeType = rawContentType.split(';')[0].trim().toLowerCase();
      if (!ALLOWED_ARTWORK_MIME_TYPES.has(mimeType)) {
        return res.status(502).json({ error: 'Unsupported artwork media type', error_code: 'server_http_error' });
      }
      const arrayBuffer = await upstream.arrayBuffer();
      // Inherits Cache-Control: no-store from adminRouter middleware
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.end(Buffer.from(arrayBuffer));
    } catch (error) {
      if (error instanceof SsrfBlockedError) {
        return res.status(400).json({ error: error.message, error_code: 'ssrf_blocked' });
      }
      return res.status(502).json({ error: scrubApiKeyFromText(error.message), error_code: 'server_http_error' });
    }
  });

  adminRouter.post('/analytics/sync-now', async (_req, res) => {
    const result = await runAnalyticsSync('manual');
    if (result.error) {
      return res.status(500).json({ success: false, error: scrubApiKeyFromText(result.error.message), sync: analyticsSyncState });
    }
    return res.json({ success: true, skipped: !!result.skipped, sync: analyticsSyncState });
  });

  adminRouter.get('/analytics/sessions', (req, res) => {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    res.json({ sessions: storage.getRecentPlaybackSessions(limit, { days }) });
  });

  adminRouter.get('/analytics/sessions/:playbackSessionId', (req, res) => {
    const limit = Math.max(1, Math.min(2000, Number(req.query.limit) || 500));
    const result = storage.getPlaybackSessionWithEvents(req.params.playbackSessionId, limit);
    if (!result) return res.status(404).json({ error: 'Playback session not found' });
    return res.json(result);
  });

  adminRouter.get('/analytics/users', (req, res) => {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25));
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    res.json({ users: storage.getTopPlaybackUsers(limit, { days }) });
  });

  adminRouter.get('/analytics/users/:userRef', (req, res) => {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 30));
    const result = storage.getPlaybackUserDetail(req.params.userRef, { limit });
    if (!result) return res.status(404).json({ error: 'User analytics not found' });
    return res.json(result);
  });

  adminRouter.get('/analytics/libraries', (req, res) => {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25));
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    res.json({ libraries: storage.getTopPlaybackLibraries(limit, { days }) });
  });

  adminRouter.get('/analytics/servers', (req, res) => {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25));
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    res.json({ servers: storage.getTopPlaybackServers(limit, { days }) });
  });

  adminRouter.get('/analytics/trends', (req, res) => {
    const limit = Math.max(1, Math.min(90, Number(req.query.limit) || 30));
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    res.json({ trends: storage.getDailyPlaybackTrends(limit, { days }) });
  });

  adminRouter.get('/analytics/items', (req, res) => {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25));
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    res.json({ items: storage.getTopPlaybackItems(limit, { days }) });
  });

  adminRouter.get('/analytics/items/:itemRef', (req, res) => {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 30));
    const result = storage.getPlaybackItemDetail(req.params.itemRef, { limit });
    if (!result) return res.status(404).json({ error: 'Item analytics not found' });
    return res.json(result);
  });

  adminRouter.get('/analytics/history', (req, res) => {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    res.json({
      history: storage.getWatchHistory({
        limit,
        days,
        user: req.query.user || null,
        item: req.query.item || null,
      }),
    });
  });

  adminRouter.delete('/analytics/history', (_req, res) => {
    res.json({ status: 'ok', ...storage.clearAllPlaybackSessions() });
  });

  adminRouter.delete('/analytics/sessions/:playbackSessionId', (req, res) => {
    const result = storage.deletePlaybackSession(req.params.playbackSessionId);
    if (!result.changes) return res.status(404).json({ error: 'Playback session not found' });
    return res.json({ status: 'ok' });
  });

  adminRouter.post('/analytics/prune', (req, res) => {
    const days = Number(req.body && req.body.olderThanDays);
    if (!Number.isFinite(days) || days <= 0) {
      return res.status(400).json({ error: 'olderThanDays must be a positive number', error_code: 'invalid_request' });
    }
    try {
      return res.json({ status: 'ok', ...storage.prunePlaybackSessionsOlderThan(days) });
    } catch (err) {
      return res.status(400).json({ error: err.message, error_code: 'invalid_request' });
    }
  });

  adminRouter.get('/database/stats', (_req, res) => {
    try {
      return res.json(storage.getDatabaseStats());
    } catch (err) {
      return handleSqliteOrMaintenanceError(res, err);
    }
  });

  adminRouter.post('/database/vacuum', async (_req, res) => {
    if (storage.isVacuumInFlight()) {
      return sendMaintenance503(res);
    }
    try {
      await withConfigLock(async () => {
        storage.enterVacuumInFlight();
        const runPromise = storage.runVacuumInWorker();
        activeVacuumPromise = runPromise;
        try {
          await runPromise;
        } finally {
          if (activeVacuumPromise === runPromise) activeVacuumPromise = null;
          storage.exitVacuumInFlight();
        }
      });
      return res.json({ status: 'ok', ...storage.getDatabaseStats() });
    } catch (err) {
      return handleSqliteOrMaintenanceError(res, err);
    }
  });

  app.use('/api/admin', adminRouter);

  // ---------------------------------------------------------------------------
  // Client & FCast API (requireSetupTokenOrAdmin)
  // ---------------------------------------------------------------------------
  function buildOperationalConfigResponse(req) {
    const capsHeader = String(req.headers['x-spatialfin-capabilities'] || '');
    const caps = new Set(capsHeader.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean));
    const isWebXr = caps.has('webxr_client_v1');
    const isQcBroker = caps.has('qc_broker_v1');
    const rawDeviceId = String(req.headers['x-companion-device'] || '').trim();
    const deviceId = isValidMapKey(rawDeviceId) && rawDeviceId.length <= 128 ? rawDeviceId : null;

    const cloned = structuredClone(appConfig);
    delete cloned.instance_id;

    // Enforce read-time Predicate 3 Seerr isolation when X-Companion-Device is present
    const seerrState = resolveEffectiveDevicePreferences(
      cloned.globalPreferences,
      cloned.devicePreferences,
      deviceId
    );
    if (deviceId) {
      cloned.globalPreferences = seerrState.effectivePrefs;
    }

    if (Array.isArray(cloned.servers)) {
      cloned.servers = cloned.servers.map((srv) => {
        if (!srv || typeof srv !== 'object') return srv;
        const projectedId =
          !isQcBroker && Array.isArray(srv.legacy_ids) && srv.legacy_ids.length > 0
            ? srv.legacy_ids[0]
            : srv.id;

        const users = Array.isArray(srv.users)
          ? srv.users.map((user) => {
              if (!user || typeof user !== 'object') return user;
              const u = { ...user };
              delete u.password;
              const hasToken = typeof u.access_token === 'string' && u.access_token.trim().length > 0;
              const tokenUsable = hasToken && u.needs_relink !== true;
              u.has_verified_token = tokenUsable;
              u.quick_connect_broker_enabled = u.quick_connect_broker_enabled !== false;
              if (isQcBroker || u.needs_relink === true) {
                delete u.access_token;
              }
              if (isWebXr && u.musicAssistant && typeof u.musicAssistant === 'object') {
                u.musicAssistant = { ...u.musicAssistant };
                delete u.musicAssistant.password;
              }
              if (deviceId && u.preferences) {
                u.preferences = isolateUserPreferencesForDevice(u.preferences, seerrState);
              }
              return u;
            })
          : [];
        return { ...srv, id: projectedId, users };
      });
    }

    if (isWebXr && Array.isArray(cloned.networkShares)) {
      cloned.networkShares = cloned.networkShares.map((sh) => {
        if (!sh || typeof sh !== 'object') return sh;
        const copy = { ...sh };
        delete copy.password;
        return copy;
      });
    }

    return { payload: cloned, isQcBroker, deviceId };
  }

  // Stage 2: POST /api/v1/auth/authorize-quick-connect (requireSetupTokenOnly, openCors, no withConfigLock)
  app.post(
    '/api/v1/auth/authorize-quick-connect',
    authorizePreAuthLimiter,
    requireSetupTokenOnly,
    authorizePostAuthIpLimiter,
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const { serverId, userId, code } = req.body || {};
      const cleanServerId = typeof serverId === 'string' ? serverId.trim() : '';
      const cleanUserId = typeof userId === 'string' ? userId.trim() : '';
      const cleanCode = normalizeSixDigitCode(code);
      if (!cleanServerId || !cleanUserId || !cleanCode) {
        return res.status(400).json({
          error: 'serverId, userId, and a 6-digit code are required',
          error_code: 'invalid_request',
        });
      }

      const { server, user } = findExactUserForServer(cleanServerId, cleanUserId);
      if (!server) {
        return res.status(404).json({ error: 'Server not found', error_code: 'server_not_found' });
      }
      if (!user) {
        return res.status(404).json({ error: 'User not found on server', error_code: 'user_not_found' });
      }
      if (!user.access_token || !String(user.access_token).trim() || user.needs_relink === true) {
        return res.status(409).json({ error: 'User does not have a verified token', error_code: 'no_verified_user' });
      }
      if (user.quick_connect_broker_enabled === false) {
        return res.status(403).json({ error: 'Quick Connect auto-approval is disabled for this user.', error_code: 'qc_broker_rejected' });
      }

      if (!checkAndRecordAuthorizePerUserLimit(server.id, user.id)) {
        return res.status(429).json({
          error: 'Too many Quick Connect approvals for this user',
          error_code: 'pairing_rate_limited',
        });
      }

      const attemptedToken = String(user.access_token);
      try {
        await authorizeQuickConnect({
          serverConfig: server,
          accessToken: attemptedToken,
          code: cleanCode,
          safeHttpJson,
          buildJellyfinAuthHeaders,
          verifyServerIdentityFor401,
        });
        return res.json({ authorized: true });
      } catch (err) {
        const errorCode = err && err.errorCode ? err.errorCode : 'qc_broker_unreachable';
        const status = err && err.status ? err.status : 503;
        if (errorCode === 'no_verified_user' && err.shouldMarkNeedsRelink === true) {
          scheduleMarkUserNeedsRelink(server.id, user.id, sha256Hex(attemptedToken));
        }
        return res.status(status).json({
          error: err.message || 'Quick Connect authorization failed.',
          error_code: errorCode,
        });
      }
    }
  );

  // GET /api/v1/config (zero SQLite statements during vacuumInFlight!)
  app.get('/api/v1/config', failedTokenLimiter, requireSetupTokenOrAdmin, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const { payload, isQcBroker, deviceId } = buildOperationalConfigResponse(req);
    if (!storage.isVacuumInFlight()) {
      if (deviceId) {
        try {
          storage.upsertDevice({
            deviceId,
            deviceName: req.headers['x-companion-device-name'] || deviceId,
            appVersion: req.headers['x-companion-app-version'] || null,
            lastIp: getEffectiveClientIp(req),
          });
        } catch (_) {}
      }
      try {
        storage.recordEvent('device_sync_pull', req, {
          setupTokenPrefix: String(appConfig.setup_token || '').slice(0, 12),
          qcBroker: isQcBroker,
        });
      } catch (_) {}
    }
    return res.json(payload);
  });

  // GET /api/preferences (zero SQLite statements during vacuumInFlight!)
  app.get('/api/preferences', failedTokenLimiter, requireSetupTokenOrAdmin, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const rawDeviceId = String(req.headers['x-companion-device'] || '').trim();
    const deviceId = isValidMapKey(rawDeviceId) && rawDeviceId.length <= 128 ? rawDeviceId : null;
    const { effectivePrefs } = resolveEffectiveDevicePreferences(
      appConfig.globalPreferences,
      appConfig.devicePreferences,
      deviceId
    );
    return res.json({
      seerr_enabled: effectivePrefs.pref_seerr_enabled === 'true',
      seerr_url: effectivePrefs.pref_seerr_url || '',
      seerr_api_key: effectivePrefs.pref_seerr_api_key || '',
    });
  });

  // POST /api/v1/device-logs (5 MiB body parsed AFTER auth, 30/min limit)
  app.post('/api/v1/device-logs', deviceLogsLimiter, failedTokenLimiter, requireSetupTokenOrAdmin, largeJsonParser, (req, res) => {
    if (storage.isVacuumInFlight()) return sendMaintenance503(res);
    const payload = req.body || {};
    const deviceId = typeof payload.deviceId === 'string' ? payload.deviceId.trim() : '';
    if (!deviceId || deviceId.length > 128 || !Array.isArray(payload.logs) || payload.logs.length === 0) {
      return res.status(400).json({ error: 'Invalid log payload', error_code: 'invalid_request' });
    }
    try {
      const device = storage.upsertDeviceLogs({ ...payload, deviceId }, req);
      const sanitizedSummary = payload.logs.slice(-50).map((entry) => ({
        timestamp: sanitizeText(entry?.timestamp || new Date().toISOString(), 80),
        level: sanitizeText(entry?.level || '?', 16),
        tag: sanitizeText(entry?.tag || 'SpatialFin', 120),
        message: sanitizeText(entry?.message || '', 500),
      }));
      broadcastAdminEvent({
        type: 'new_logs',
        deviceId: device.deviceId,
        accepted: payload.logs.length,
        totalEntries: device.entryCount,
        logs: sanitizedSummary,
      });
      return res.json({
        status: 'ok',
        deviceId: device.deviceId,
        accepted: payload.logs.length,
        totalEntries: device.entryCount,
      });
    } catch (err) {
      return handleSqliteOrMaintenanceError(res, err);
    }
  });

  // GET /api/v1/search
  app.get('/api/v1/search', searchLimiter, failedTokenLimiter, requireSetupTokenOrAdmin, async (req, res) => {
    if (!webSearchEnabled) {
      return res.status(503).json({ error: 'Web search is not configured' });
    }
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    try {
      const payload = await performWebSearch({ query, searxngUrl });
      if (!storage.isVacuumInFlight()) {
        storage.recordEvent('web_search', req, { queryLen: query.length, resultCount: payload.results.length });
      }
      return res.json(payload);
    } catch (err) {
      const status = typeof err.status === 'number' ? err.status : 500;
      return res.status(status).json({
        error: err.message || 'Search failed',
        ...(err.errorCode ? { error_code: err.errorCode } : {}),
      });
    }
  });

  // POST /api/v1/analytics/sessions (60/min limit)
  app.post('/api/v1/analytics/sessions', analyticsSessionsLimiter, failedTokenLimiter, requireSetupTokenOrAdmin, (req, res) => {
    if (storage.isVacuumInFlight()) return sendMaintenance503(res);
    const payload = req.body || {};
    const sessionCount = Array.isArray(payload.sessions)
      ? payload.sessions.length
      : (payload && typeof payload === 'object' && Object.keys(payload).length > 0 ? 1 : 0);
    if (sessionCount === 0) {
      return res.status(400).json({ error: 'Invalid analytics payload', error_code: 'invalid_request' });
    }
    try {
      const normalizedPayload = Array.isArray(payload.sessions)
        ? { ...payload, sessions: payload.sessions.map(canonicalizeAnalyticsSession) }
        : canonicalizeAnalyticsSession(payload);
      const result = storage.upsertPlaybackSessions(normalizedPayload, req);
      if (result.accepted > 0) {
        broadcastAdminEvent({
          type: 'analytics_sessions_ingested',
          accepted: result.accepted,
          totalSessions: result.totalSessions,
        });
      }
      return res.json({ status: 'ok', accepted: result.accepted, totalSessions: result.totalSessions });
    } catch (err) {
      return handleSqliteOrMaintenanceError(res, err);
    }
  });

  // FCast receiver registry & WS tickets
  function pruneExpiredFCastReceivers(now = Date.now()) {
    for (const [id, rec] of activeRegisteredFCastReceivers.entries()) {
      if (now - rec.lastSeen > 60_000) activeRegisteredFCastReceivers.delete(id);
    }
    for (const [id, rec] of activeMdnsFCastReceivers.entries()) {
      if (now - rec.lastSeen > 60_000) activeMdnsFCastReceivers.delete(id);
    }
  }

  function validateFCastReceiverEntry({ ip, port: portVal, name }) {
    const cleanIp = stripBrackets(String(ip || '').split('%')[0].trim());
    if (!net.isIP(cleanIp) || !isPrivateOrLanIp(cleanIp, { allowCgnat: true })) return null;
    const parsedPort = Number(portVal);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) return null;
    const cleanName = sanitizeText(name || '', 100);
    if (!cleanName) return null;
    return { ip: cleanIp, port: parsedPort, name: cleanName };
  }

  app.post('/api/fcast/register', failedTokenLimiter, requireSetupTokenOrAdmin, (req, res) => {
    const validated = validateFCastReceiverEntry(req.body || {});
    if (!validated) {
      return res.status(400).json({ error: 'Invalid FCast receiver ip, port, or name', error_code: 'invalid_request' });
    }
    pruneExpiredFCastReceivers();
    const id = `${validated.ip}:${validated.port}`;
    if (!activeRegisteredFCastReceivers.has(id) && activeRegisteredFCastReceivers.size >= MAX_REGISTERED_FCAST_RECEIVERS) {
      return res.status(429).json({ error: 'Maximum registered FCast receivers reached', error_code: 'pairing_rate_limited' });
    }
    activeRegisteredFCastReceivers.set(id, { ...validated, lastSeen: Date.now() });
    return res.json({ status: 'ok' });
  });

  app.get('/api/fcast/receivers', failedTokenLimiter, requireSetupTokenOrAdmin, (_req, res) => {
    pruneExpiredFCastReceivers();
    const merged = new Map();
    for (const [id, rec] of activeMdnsFCastReceivers.entries()) merged.set(id, rec);
    for (const [id, rec] of activeRegisteredFCastReceivers.entries()) merged.set(id, rec);
    return res.json(Array.from(merged.values()));
  });

  app.post('/api/fcast/ws-ticket', wsTicketLimiter, failedTokenLimiter, requireSetupTokenOrAdmin, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const now = Date.now();
    for (const [t, exp] of fcastWsTickets.entries()) {
      if (exp <= now) fcastWsTickets.delete(t);
    }
    if (fcastWsTickets.size >= MAX_FCAST_WS_TICKETS) {
      return res.status(429).json({ error: 'Too many active WebSocket tickets', error_code: 'pairing_rate_limited' });
    }
    const ticket = crypto.randomBytes(16).toString('hex');
    fcastWsTickets.set(ticket, now + 30_000);
    return res.json({ ticket, expiresInMs: 30_000 });
  });

  // Global error handler
  app.use((err, _req, res, _next) => {
    if (err && (err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413)) {
      return res.status(413).json({ error: 'Payload too large', error_code: 'payload_too_large' });
    }
    if (err && (err.type === 'entity.parse.failed' || err.status === 400 || err.statusCode === 400)) {
      return res.status(400).json({ error: 'Invalid JSON request body', error_code: 'invalid_request' });
    }
    if (err && (err.status === 503 || err.errorCode === 'maintenance_in_progress' || (storage.isVacuumInFlight() && isSqliteBusyError(err)))) {
      return sendMaintenance503(res);
    }
    const status = Number(err?.status || err?.statusCode) || 500;
    return res.status(status).json({
      error: err?.message || 'Internal Server Error',
      error_code: err?.errorCode || 'internal_error',
    });
  });

  // ---------------------------------------------------------------------------
  // HTTP Server & Split WebSocket Upgrade Isolation
  // ---------------------------------------------------------------------------
  const server = http.createServer(app);

  function writeRawHttpError(socket, statusLine) {
    try {
      socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    } catch (_) {}
    try { socket.destroy(); } catch (_) {}
  }

  server.on('upgrade', (req, socket, head) => {
    try {
      const clientIp = getEffectiveClientIp(req);
      const bucket = normalizeClientIpBucket(clientIp);
      if (isWsBucketThrottled(bucket)) {
        return writeRawHttpError(socket, '429 Too Many Requests');
      }

      let parsedUrl;
      try {
        parsedUrl = new URL(req.url || '/', 'http://localhost');
      } catch (_) {
        return writeRawHttpError(socket, '400 Bad Request');
      }

      const normPath = normalizePathForMatch(parsedUrl.pathname);

      // Pool 1: fcastWss (/api/fcast/receive?ticket=<ticket>)
      if (normPath === '/api/fcast/receive') {
        const ticket = parsedUrl.searchParams.get('ticket') || '';
        const now = Date.now();
        const exp = fcastWsTickets.get(ticket);
        if (!ticket || !exp || exp <= now) {
          fcastWsTickets.delete(ticket);
          recordWsRejection(bucket);
          return writeRawHttpError(socket, '401 Unauthorized');
        }
        fcastWsTickets.delete(ticket);

        const perIpCount = fcastConnCountByBucket.get(bucket) || 0;
        if (fcastWss.clients.size >= 8 || perIpCount >= 2) {
          return writeRawHttpError(socket, '429 Too Many Requests');
        }

        fcastWss.handleUpgrade(req, socket, head, (ws) => {
          ws._bucket = bucket;
          fcastConnCountByBucket.set(bucket, (fcastConnCountByBucket.get(bucket) || 0) + 1);
          fcastWss.emit('connection', ws, req);
        });
        return;
      }

      // Pool 2: adminSyncWss (/ or /ws)
      if (normPath === '/' || normPath === '/ws') {
        let authType = null;
        let sessionToken = null;

        if (req.headers['x-setup-token'] !== undefined) {
          const provided = Array.isArray(req.headers['x-setup-token'])
            ? req.headers['x-setup-token'][0]
            : String(req.headers['x-setup-token']);
          if (provided && appConfig.setup_token && timingSafeStringEqual(provided, appConfig.setup_token)) {
            authType = 'setup_token';
          } else {
            recordWsRejection(bucket);
            return writeRawHttpError(socket, '401 Unauthorized');
          }
        } else if (hasConfiguredAdminPassword()) {
          const cookies = parseCookies(req);
          const token = cookies.session;
          if (!token || !storage.isAdminSessionValid(token)) {
            recordWsRejection(bucket);
            return writeRawHttpError(socket, '401 Unauthorized');
          }
          if (!isSameOriginWsUpgrade(req)) {
            recordWsRejection(bucket);
            return writeRawHttpError(socket, '403 Forbidden');
          }
          authType = 'session';
          sessionToken = token;
        } else {
          const loopback = checkDirectLoopbackRequest(req);
          if (!loopback.ok || !isSameOriginWsUpgrade(req)) {
            recordWsRejection(bucket);
            return writeRawHttpError(socket, '403 Forbidden');
          }
          authType = 'loopback_unconfigured';
        }

        const perIpCount = adminConnCountByBucket.get(bucket) || 0;
        if (adminSyncWss.clients.size >= 64 || perIpCount >= 8) {
          return writeRawHttpError(socket, '429 Too Many Requests');
        }

        adminSyncWss.handleUpgrade(req, socket, head, (ws) => {
          ws._authType = authType;
          ws._sessionToken = sessionToken;
          ws._bucket = bucket;
          adminConnCountByBucket.set(bucket, (adminConnCountByBucket.get(bucket) || 0) + 1);
          adminSyncWss.emit('connection', ws, req);
        });
        return;
      }

      return writeRawHttpError(socket, '404 Not Found');
    } catch (_) {
      return writeRawHttpError(socket, '400 Bad Request');
    }
  });

  adminSyncWss.on('connection', (ws) => {
    ws.on('message', () => {
      // adminSyncWss is server-push only; close immediately on unexpected client frames
      closeWithTerminateFailsafe(ws, 1008, 1_000);
    });
    ws.on('close', () => {
      if (ws._bucket) {
        const next = Math.max(0, (adminConnCountByBucket.get(ws._bucket) || 1) - 1);
        if (next === 0) adminConnCountByBucket.delete(ws._bucket);
        else adminConnCountByBucket.set(ws._bucket, next);
      }
    });
  });

  fcastWss.on('connection', (ws) => {
    let tcpSocket = null;
    let mdnsService = null;
    let bonjourInstance = null;
    let closed = false;

    const cleanup = (closeCode = null) => {
      if (closed) return;
      closed = true;
      activeFcastConnections.delete(cleanup);
      if (mdnsService) {
        try { mdnsService.stop(); } catch (_) {}
        mdnsService = null;
      }
      if (bonjourInstance) {
        try { bonjourInstance.destroy(); } catch (_) {}
        bonjourInstance = null;
      }
      if (tcpSocket) {
        try { tcpSocket.destroy(); } catch (_) {}
        tcpSocket = null;
      }
      try { bridgeServer.close(); } catch (_) {}
      if (closeCode) {
        closeWithTerminateFailsafe(ws, closeCode, 1_000);
      }
      if (ws._bucket) {
        const next = Math.max(0, (fcastConnCountByBucket.get(ws._bucket) || 1) - 1);
        if (next === 0) fcastConnCountByBucket.delete(ws._bucket);
        else fcastConnCountByBucket.set(ws._bucket, next);
        ws._bucket = null;
      }
    };
    activeFcastConnections.add(cleanup);

    const bridgeServer = net.createServer((socket) => {
      const peerIp = stripBrackets(String(socket.remoteAddress || '').split('%')[0]);
      if (!peerIp || !isPrivateOrLanIp(peerIp, { allowCgnat: true })) {
        socket.destroy();
        return;
      }
      if (tcpSocket || closed) {
        socket.destroy();
        return;
      }
      tcpSocket = socket;
      let messageBuffer = Buffer.alloc(0);

      socket.setKeepAlive(true, 15_000);
      socket.setTimeout(60_000, () => socket.destroy());

      const sendFCastFrame = (opcode, jsonObj) => {
        const jsonBytes = Buffer.from(JSON.stringify(jsonObj), 'utf8');
        const size = 1 + jsonBytes.length;
        const frame = Buffer.alloc(4 + size);
        frame.writeUInt32LE(size, 0);
        frame[4] = opcode;
        jsonBytes.copy(frame, 5);
        socket.write(frame);
      };
      sendFCastFrame(11, { version: 4 });
      sendFCastFrame(14, { friendlyName: 'SpatialFin Web', appName: 'SpatialFin Web', appVersion: APP_VERSION || '1.0.0' });

      socket.on('data', (data) => {
        if (ws.bufferedAmount > MAX_FCAST_WS_BUFFER) {
          socket.destroy();
          return;
        }
        messageBuffer = Buffer.concat([messageBuffer, data]);
        while (messageBuffer.length >= 4) {
          const length = messageBuffer.readUInt32LE(0);
          if (length === 0 || length > MAX_FCAST_FRAME_BYTES) {
            messageBuffer = Buffer.alloc(0);
            socket.destroy();
            return;
          }
          if (messageBuffer.length >= 4 + length) {
            const payload = messageBuffer.subarray(4, 4 + length);
            messageBuffer = messageBuffer.subarray(4 + length);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(payload);
            }
          } else {
            break;
          }
        }
      });

      socket.on('close', () => {
        messageBuffer = Buffer.alloc(0);
        if (tcpSocket === socket) tcpSocket = null;
      });
      socket.on('error', () => {
        messageBuffer = Buffer.alloc(0);
        if (tcpSocket === socket) tcpSocket = null;
      });
    });

    bridgeServer.listen(0, '0.0.0.0', () => {
      if (closed) {
        try { bridgeServer.close(); } catch (_) {}
        return;
      }
      if (!enableMdns) return;
      try {
        const bridgePort = bridgeServer.address().port;
        const hostname = os.hostname();
        const uniqueId = crypto.randomBytes(2).toString('hex');
        const lanIp = getPrimaryLanIpv4(getInterfaces());
        bonjourInstance = new Bonjour();
        mdnsService = bonjourInstance.publish({
          name: `SpatialFin Web (${hostname}-${uniqueId})`,
          type: 'fcast',
          protocol: 'tcp',
          port: bridgePort,
          ...(lanIp ? { host: lanIp } : {}),
          txt: { txtvers: '1', appName: 'SpatialFin Web', appVersion: APP_VERSION || '1.0.0' },
        });
        mdnsService.on('error', (err) => console.warn('FCast mDNS error:', err.message));
      } catch (err) {
        console.warn('FCast mDNS publish failed:', err.message);
      }
    });

    ws.on('message', (data) => {
      if (tcpSocket && !tcpSocket.destroyed && tcpSocket.writable && Buffer.isBuffer(data)) {
        const lengthPrefix = Buffer.alloc(4);
        lengthPrefix.writeUInt32LE(data.length, 0);
        tcpSocket.write(Buffer.concat([lengthPrefix, data]));
      }
    });

    ws.on('close', () => cleanup());
    ws.on('error', () => cleanup());
  });

  // ---------------------------------------------------------------------------
  // Lifecycle: init(), start(), close()
  // ---------------------------------------------------------------------------
  const intervals = [];
  const timeouts = [];
  let bonjour = null;
  let fcastBrowser = null;

  async function backupDatabase() {
    storage.prunePreStage1Backup(14);
    const backupDir = storage.backupsDir;
    const backupFile = path.join(backupDir, `companion-${new Date().toISOString().split('T')[0]}.sqlite.bak`);
    await storage.runBackupInWorker(backupFile);
    try {
      const files = fs
        .readdirSync(backupDir)
        .filter((f) => f.endsWith('.sqlite.bak'))
        .map((f) => ({ name: f, time: fs.statSync(path.join(backupDir, f)).mtime.getTime() }));
      files.sort((a, b) => b.time - a.time);
      files.slice(7).forEach((f) => {
        try { fs.unlinkSync(path.join(backupDir, f.name)); } catch (_) {}
      });
    } catch (_) {}
  }

  async function init() {
    // Bounded 2 s async DNS pass on stage1_pending_loopback_dns_candidates
    const rawPending = storage.getStateValue('stage1_pending_loopback_dns_candidates');
    if (rawPending) {
      let candidates = [];
      try { candidates = JSON.parse(rawPending); } catch (_) {}
      if (Array.isArray(candidates) && candidates.length > 0) {
        const allowSet = new Set(legacyLoopbackAllowlist);
        const remaining = [];
        const deadline = Date.now() + 2_000;

        await Promise.allSettled(
          candidates.map(async (entry) => {
            const match = String(entry).match(/^(\[[^\]]+\]|[^:]+):(\d+)$/);
            if (!match) return;
            const host = stripBrackets(match[1]);
            const waitMs = Math.max(50, deadline - Date.now());
            try {
              const records = await Promise.race([
                new Promise((resolve, reject) => {
                  dnsLookup(host, { all: true, verbatim: true }, (err, res) => (err ? reject(err) : resolve(res)));
                }),
                new Promise((_, reject) => {
                  const t = setTimeout(() => reject(new Error('dns_timeout')), waitMs);
                  if (typeof t.unref === 'function') t.unref();
                }),
              ]);
              if (Array.isArray(records) && records.some((r) => r && r.address && isLoopbackIp(r.address))) {
                allowSet.add(entry);
              }
            } catch (err) {
              if (err && err.message === 'dns_timeout') {
                remaining.push(entry);
              }
            }
          })
        );

        legacyLoopbackAllowlist = Array.from(allowSet);
        storage.setStateValue('legacy_loopback_upstreams_allowlist', JSON.stringify(legacyLoopbackAllowlist));
        if (remaining.length > 0) {
          storage.setStateValue('stage1_pending_loopback_dns_candidates', JSON.stringify(remaining));
        } else {
          storage.deleteStateValue('stage1_pending_loopback_dns_candidates');
        }
      } else {
        storage.deleteStateValue('stage1_pending_loopback_dns_candidates');
      }
    }

    // Stage 2: bounded 3 s startup legacy server-ID canonicalization off-lock, then commit inside withConfigLock
    const hasSrvServers = Array.isArray(appConfig.servers) && appConfig.servers.some((s) => s && s.id && isLegacySyntheticServerId(s.id));
    if (hasSrvServers) {
      const resolvedSrvMap = await resolveSrvCanonicalCandidates(appConfig.servers, appConfig, 3_000);
      if (resolvedSrvMap.size > 0) {
        let migratedAny = false;
        await withConfigLock(async () => {
          const draft = structuredClone(appConfig);
          const migrations = applySafeAutomaticCanonicalizations(draft, resolvedSrvMap);
          if (migrations.length > 0) {
            const normalized = storage.normalizeConfig(draft);
            appConfig = storage.saveConfigAndMigrateServerIds(normalized, migrations, 'startup-canonicalize-servers');
            migratedAny = true;
          }
        });
        if (migratedAny) {
          broadcastConfigChanged();
        }
      }
    }
  }

  function startMdnsBrowser() {
    if (!enableMdns) return;
    try {
      bonjour = new Bonjour();
      fcastBrowser = bonjour.find({ type: 'fcast' });
      const extractValidMdnsService = (service) => {
        if (!service || !Array.isArray(service.addresses) || service.addresses.length === 0) return null;
        const validIps = service.addresses
          .map((a) => stripBrackets(String(a || '').split('%')[0].trim()))
          .filter((a) => net.isIP(a) && isPrivateOrLanIp(a, { allowCgnat: true }));
        if (validIps.length === 0) return null;
        const ip = validIps.find((a) => net.isIPv4(a)) || validIps[0];
        const rawName = (service.txt && service.txt.appName) ? `${service.txt.appName} (${service.name})` : service.name;
        return validateFCastReceiverEntry({ ip, port: service.port, name: rawName });
      };

      fcastBrowser.on('up', (service) => {
        const valid = extractValidMdnsService(service);
        if (!valid) return;
        const id = `${valid.ip}:${valid.port}`;
        if (!activeMdnsFCastReceivers.has(id) && activeMdnsFCastReceivers.size >= MAX_REGISTERED_FCAST_RECEIVERS) return;
        activeMdnsFCastReceivers.set(id, { ...valid, lastSeen: Date.now() });
      });

      fcastBrowser.on('down', (service) => {
        const valid = extractValidMdnsService(service);
        if (!valid) return;
        activeMdnsFCastReceivers.delete(`${valid.ip}:${valid.port}`);
      });

      const pollTimer = setInterval(() => {
        try {
          fcastBrowser.update();
          for (const service of fcastBrowser.services || []) {
            const valid = extractValidMdnsService(service);
            if (!valid) continue;
            const id = `${valid.ip}:${valid.port}`;
            if (activeMdnsFCastReceivers.has(id)) {
              activeMdnsFCastReceivers.get(id).lastSeen = Date.now();
            }
          }
        } catch (_) {}
      }, 30_000);
      if (typeof pollTimer.unref === 'function') pollTimer.unref();
      intervals.push(pollTimer);
    } catch (err) {
      console.warn('mDNS browser initialization failed:', err.message);
    }
  }

  async function start() {
    // Set vacuumInFlight + snapshot admin sessions + hold initial config lock BEFORE server.listen()
    let releaseStartupLock;
    const startupLockPromise = new Promise((resolve) => { releaseStartupLock = resolve; });
    configLockTail = configLockTail.then(() => startupLockPromise);
    storage.enterVacuumInFlight();

    let resolveVacuumDone;
    const startupVacuumPromise = new Promise((resolve) => { resolveVacuumDone = resolve; });
    activeVacuumPromise = startupVacuumPromise;

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, bindHost, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    console.log(`SpatialFin Companion on port ${getActualPort()}`);

    // Run Stage 1 pre-backup -> live scrub -> live VACUUM + wal_checkpoint(TRUNCATE) in worker BEFORE init/realtime
    try {
      await storage.runStage1UpgradeInWorker(JSON.stringify(appConfig));
    } catch (err) {
      console.error('[startup] Stage 1 storage upgrade worker failed:', err?.message || err);
    } finally {
      if (activeVacuumPromise === startupVacuumPromise) activeVacuumPromise = null;
      storage.exitVacuumInFlight();
      resolveVacuumDone();
      releaseStartupLock();
    }

    if (storage.hasPreStage1Backup()) {
      console.warn(
        '[security] Pre-Stage-1 SQLite backup exists at data/companion.sqlite.pre-stage1.bak (contains legacy plaintext passwords; auto-pruned after 14 days).'
      );
    }

    await init();

    if (enableBackgroundTasks) {
      updater.start({ onRestart: close });
      startMdnsBrowser();
      reconcileJellyfinRealtimeSockets();

      try {
        await storage.runScrubHistoricalBackupsInWorker();
      } catch (err) {
        console.warn('[startup] Historical backup scrub failed:', err?.message || err);
      }

      backupDatabase().catch((err) => console.warn('[backup] Initial backup failed:', err?.message || err));

      const backupInterval = setInterval(() => {
        backupDatabase().catch((err) => console.warn('[backup] Scheduled backup failed:', err?.message || err));
      }, 24 * 60 * 60 * 1000);
      if (typeof backupInterval.unref === 'function') backupInterval.unref();
      intervals.push(backupInterval);

      const analyticsInterval = setInterval(() => {
        runAnalyticsSync('interval').catch((err) => console.error('Analytics sync interval failed:', err.message));
      }, ANALYTICS_SYNC_INTERVAL_MS);
      if (typeof analyticsInterval.unref === 'function') analyticsInterval.unref();
      intervals.push(analyticsInterval);

      try { storage.pruneExpiredAdminSessions(); } catch (_) {}
      const pruneInterval = setInterval(() => {
        try { storage.pruneExpiredAdminSessions(); } catch (_) {}
      }, 60 * 60 * 1000);
      if (typeof pruneInterval.unref === 'function') pruneInterval.unref();
      intervals.push(pruneInterval);

      const startupSync = setTimeout(() => {
        runAnalyticsSync('startup').catch((err) => console.error('Analytics sync startup failed:', err.message));
      }, 5_000);
      if (typeof startupSync.unref === 'function') startupSync.unref();
      timeouts.push(startupSync);
    }

    return server;
  }

  async function close() {
    updater.stop();
    for (const id of intervals) clearInterval(id);
    intervals.length = 0;
    for (const id of timeouts) clearTimeout(id);
    timeouts.length = 0;
    for (const timer of relinkDebounceTimers.values()) clearTimeout(timer);
    relinkDebounceTimers.clear();
    for (const id of Array.from(pendingQuickConnects.keys())) {
      wipePendingQuickConnect(id);
    }
    qcDrainCache.clear();

    for (const entry of jellyfinRealtimeSockets.values()) {
      entry.aborted = true;
      entry.closedManually = true;
      if (entry.refreshTimer) clearTimeout(entry.refreshTimer);
      if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
      try { entry.socket && entry.socket.close(); } catch (_) {}
    }
    jellyfinRealtimeSockets.clear();

    for (const cleanup of Array.from(activeFcastConnections)) {
      try { cleanup(1001); } catch (_) {}
    }
    for (const client of adminSyncWss.clients) {
      try { client.terminate(); } catch (_) {}
    }
    for (const client of fcastWss.clients) {
      try { client.terminate(); } catch (_) {}
    }

    if (fcastBrowser) {
      try { fcastBrowser.stop(); } catch (_) {}
      fcastBrowser = null;
    }
    if (bonjour) {
      try { bonjour.destroy(); } catch (_) {}
      bonjour = null;
    }

    if (server.listening) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
    await storage.close();
  }

  return {
    app,
    server,
    storage,
    init,
    start,
    close,
    getConfig: () => appConfig,
    getActiveBootstrapPinForTest: () => activeBootstrapPin,
    reconcileJellyfinRealtimeSockets,
    scheduleMarkUserNeedsRelink,
    resolveDiscoverySeedAddress,
    buildCompanionBaseUrl,
  };
}

if (require.main === module) {
  const companion = createCompanionApp();
  companion.start().catch((err) => {
    console.error('Failed to start SpatialFin Companion:', err);
    process.exit(1);
  });
}

module.exports = {
  createCompanionApp,
  BoundedMemoryStore,
  normalizeClientIpBucket,
  parseCookies,
  validateConfigTargets,
  buildTvPairingError,
  buildJellyfinAuthHeadersForInstance,
  closeWithTerminateFailsafe,
};
