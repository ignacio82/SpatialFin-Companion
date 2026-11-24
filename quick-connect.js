'use strict';

const crypto = require('node:crypto');
const { SsrfBlockedError } = require('./safe-fetch');

function normalizeUuid(value) {
  return String(value || '').trim().toLowerCase().replace(/-/g, '');
}

function isCanonicalJellyfinServerId(value) {
  return /^[0-9a-f]{32}$/i.test(normalizeUuid(value));
}

function isLegacySyntheticServerId(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  return raw.startsWith('srv-') || !isCanonicalJellyfinServerId(raw);
}

function normalizeUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function normalizeSixDigitCode(raw) {
  const digits = String(raw || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(digits)) return '';
  return digits;
}

function createQcError(errorCode, message, status = 503, extra = {}) {
  const err = new Error(message || errorCode);
  err.errorCode = errorCode;
  err.status = status;
  Object.assign(err, extra);
  return err;
}

/**
 * Staggered Promise.any across candidate items.
 * Aborts losing branches immediately once the first branch succeeds.
 */
async function staggeredRace(items, fn, options = {}) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    throw new AggregateError([], 'No candidate addresses available');
  }
  const staggerMs = Number.isFinite(options.staggerMs) ? options.staggerMs : 150;
  const perItemTimeoutMs = Number.isFinite(options.perItemTimeoutMs) ? options.perItemTimeoutMs : 3_000;
  const outerSignal = options.signal || null;

  const controllers = list.map(() => new AbortController());
  const timers = [];

  const cleanupAll = (winnerIndex = -1) => {
    for (const t of timers) clearTimeout(t);
    controllers.forEach((ctrl, idx) => {
      if (idx !== winnerIndex) {
        try { ctrl.abort(); } catch (_) {}
      }
    });
  };

  let outerAbortHandler = null;
  if (outerSignal) {
    if (outerSignal.aborted) {
      cleanupAll();
      throw new AggregateError([createQcError('qc_broker_unreachable', 'Request aborted', 503)], 'Aborted');
    }
    outerAbortHandler = () => cleanupAll();
    outerSignal.addEventListener('abort', outerAbortHandler, { once: true });
  }

  try {
    const promises = list.map((item, idx) => {
      return new Promise((resolve, reject) => {
        const delayMs = idx * staggerMs;
        const startBranch = async () => {
          const ctrl = controllers[idx];
          if (ctrl.signal.aborted || (outerSignal && outerSignal.aborted)) {
            reject(createQcError('qc_broker_unreachable', 'Branch cancelled', 503));
            return;
          }
          const branchTimer = setTimeout(() => {
            try { ctrl.abort(); } catch (_) {}
          }, perItemTimeoutMs);
          if (typeof branchTimer.unref === 'function') branchTimer.unref();
          timers.push(branchTimer);

          try {
            const val = await fn(item, ctrl.signal, idx);
            clearTimeout(branchTimer);
            cleanupAll(idx);
            resolve(val);
          } catch (err) {
            clearTimeout(branchTimer);
            reject(err);
          }
        };

        if (delayMs <= 0) {
          startBranch();
        } else {
          const staggerTimer = setTimeout(startBranch, delayMs);
          if (typeof staggerTimer.unref === 'function') staggerTimer.unref();
          timers.push(staggerTimer);
        }
      });
    });

    return await Promise.any(promises);
  } finally {
    cleanupAll();
    if (outerSignal && outerAbortHandler) {
      outerSignal.removeEventListener('abort', outerAbortHandler);
    }
  }
}

async function probePublicSystemInfo({ baseUrl, safeHttpJson, expectedServerId = null, timeoutMs = 3_000, signal }) {
  const cleanUrl = normalizeUrl(baseUrl);
  const res = await safeHttpJson(`${cleanUrl}/System/Info/Public`, {
    method: 'GET',
    maxRedirects: 0,
    timeoutMs,
    signal,
  });
  if (res.status !== 200 || !res.data || typeof res.data !== 'object') {
    throw createQcError('server_http_error', `Unexpected Jellyfin status ${res.status}`, 502);
  }
  const serverId = String(res.data.Id || '').trim();
  const serverName = String(res.data.ServerName || '').trim();
  if (!serverId) {
    throw createQcError('server_http_error', 'Jellyfin server did not return a valid server ID', 502);
  }
  if (expectedServerId && !isLegacySyntheticServerId(expectedServerId)) {
    if (normalizeUuid(serverId) !== normalizeUuid(expectedServerId)) {
      throw createQcError('conflict', 'Server ID mismatch on probed address', 409);
    }
  }
  return { baseUrl: cleanUrl, serverId, serverName, version: res.data.Version || null };
}

async function initiateQuickConnect({
  addresses,
  expectedServerId = null,
  safeHttpJson,
  buildJellyfinAuthHeaders,
  signal,
  perAddressTimeoutMs = 3_000,
}) {
  const cleanAddresses = (Array.isArray(addresses) ? addresses : [])
    .map(normalizeUrl)
    .filter(Boolean);

  try {
    return await staggeredRace(
      cleanAddresses,
      async (baseUrl, branchSignal) => {
        const info = await probePublicSystemInfo({
          baseUrl,
          safeHttpJson,
          expectedServerId,
          timeoutMs: perAddressTimeoutMs,
          signal: branchSignal,
        });

        const initRes = await safeHttpJson(`${info.baseUrl}/QuickConnect/Initiate`, {
          method: 'POST',
          headers: buildJellyfinAuthHeaders(null),
          maxRedirects: 0,
          timeoutMs: perAddressTimeoutMs,
          signal: branchSignal,
        });

        if (initRes.status === 401 || initRes.status === 403) {
          throw createQcError('qc_disabled', 'Quick Connect is disabled on this Jellyfin server.', 409);
        }
        if (initRes.status !== 200 || !initRes.data || typeof initRes.data !== 'object') {
          throw createQcError('qc_broker_unreachable', `Quick Connect initiate failed (HTTP ${initRes.status})`, 503);
        }
        const code = String(initRes.data.Code || '').trim();
        const secret = String(initRes.data.Secret || '').trim();
        if (!code || !secret) {
          throw createQcError('qc_broker_unreachable', 'Jellyfin returned an incomplete Quick Connect response.', 503);
        }
        return {
          baseUrl: info.baseUrl,
          probedServerId: info.serverId,
          probedServerName: info.serverName,
          code,
          secret,
        };
      },
      { staggerMs: 150, perItemTimeoutMs: perAddressTimeoutMs, signal }
    );
  } catch (err) {
    const errors = err instanceof AggregateError ? err.errors : [err];
    for (const e of errors) {
      if (e instanceof SsrfBlockedError) throw e;
    }
    const precedence = ['conflict', 'qc_disabled', 'qc_broker_unreachable'];
    for (const code of precedence) {
      const match = errors.find((e) => e && e.errorCode === code);
      if (match) throw match;
    }
    throw createQcError('qc_broker_unreachable', 'Unable to reach Jellyfin server for Quick Connect.', 503);
  }
}

async function pollQuickConnect({ baseUrl, secret, safeHttpJson, buildJellyfinAuthHeaders, timeoutMs = 4_000, signal }) {
  const cleanUrl = normalizeUrl(baseUrl);
  const qs = new URLSearchParams({ secret: String(secret || '') }).toString();
  try {
    const res = await safeHttpJson(`${cleanUrl}/QuickConnect/Connect?${qs}`, {
      method: 'GET',
      headers: buildJellyfinAuthHeaders(null),
      maxRedirects: 0,
      timeoutMs,
      signal,
    });
    if (res.status === 404) {
      return { status: 'expired' };
    }
    if (res.status === 401 || res.status === 403) {
      return { status: 'failed', error: 'Quick Connect is disabled on this Jellyfin server.', error_code: 'qc_disabled' };
    }
    if (res.status >= 500) {
      return { status: 'pending' };
    }
    if (res.status !== 200 || !res.data || typeof res.data !== 'object') {
      return { status: 'failed', error: `Unexpected Quick Connect status ${res.status}`, error_code: 'server_http_error' };
    }
    if (res.data.Authenticated === true) {
      return { status: 'authenticated' };
    }
    return { status: 'pending' };
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      return { status: 'failed', error: err.message, error_code: 'ssrf_blocked' };
    }
    // Transient network error keeps polling until expiresAt
    return { status: 'pending' };
  }
}

async function exchangeQuickConnect({ baseUrl, secret, safeHttpJson, buildJellyfinAuthHeaders, timeoutMs = 8_000, signal }) {
  const cleanUrl = normalizeUrl(baseUrl);
  const res = await safeHttpJson(`${cleanUrl}/Users/AuthenticateWithQuickConnect`, {
    method: 'POST',
    body: { Secret: String(secret || '') },
    headers: buildJellyfinAuthHeaders(null),
    maxRedirects: 0,
    timeoutMs,
    signal,
  });
  if (res.status === 401 || res.status === 403) {
    throw createQcError('qc_disabled', 'Quick Connect authentication was rejected by Jellyfin.', 409);
  }
  if (res.status !== 200 || !res.data || typeof res.data !== 'object') {
    throw createQcError('server_http_error', `Quick Connect authentication failed (HTTP ${res.status})`, 502);
  }
  const accessToken = String(res.data.AccessToken || '').trim();
  const userId = String(res.data.User?.Id || res.data.UserId || '').trim();
  const username = String(res.data.User?.Name || '').trim();
  const serverId = String(res.data.ServerId || '').trim();
  if (!accessToken || !userId) {
    throw createQcError('server_http_error', 'Jellyfin returned an incomplete Quick Connect auth response.', 502);
  }
  return { accessToken, userId, username, serverId };
}

/**
 * Authorize a Quick Connect code on Jellyfin across server.addresses using 150 ms staggered Promise.any.
 * Deterministic AggregateError precedence:
 *   qc_disabled > no_verified_user > qc_authorize_false > qc_broker_unreachable
 */
async function authorizeQuickConnect({
  serverConfig,
  accessToken,
  code,
  safeHttpJson,
  buildJellyfinAuthHeaders,
  verifyServerIdentityFor401,
  signal,
  perAddressTimeoutMs = 3_000,
}) {
  const cleanCode = normalizeSixDigitCode(code);
  if (!cleanCode) {
    throw createQcError('invalid_request', 'Quick Connect code must be 6 digits.', 400);
  }
  const addresses = (Array.isArray(serverConfig?.addresses) ? serverConfig.addresses : [])
    .map(normalizeUrl)
    .filter(Boolean);
  if (addresses.length === 0) {
    throw createQcError('qc_broker_unreachable', 'Server has no configured addresses.', 503);
  }

  const qs = new URLSearchParams({ code: cleanCode }).toString();

  try {
    const winner = await staggeredRace(
      addresses,
      async (baseUrl, branchSignal) => {
        const res = await safeHttpJson(`${baseUrl}/QuickConnect/Authorize?${qs}`, {
          method: 'POST',
          headers: buildJellyfinAuthHeaders(accessToken),
          maxRedirects: 0,
          timeoutMs: perAddressTimeoutMs,
          signal: branchSignal,
        });

        if (res.status === 200) {
          if (res.data === true || String(res.data).trim().toLowerCase() === 'true') {
            return { authorized: true, baseUrl };
          }
          throw createQcError('qc_authorize_false', 'Jellyfin did not accept the Quick Connect code.', 409, { baseUrl });
        }

        if (res.status === 404) {
          throw createQcError('qc_authorize_false', 'Quick Connect code was not found on Jellyfin.', 409, { baseUrl });
        }

        if (res.status === 401 || res.status === 403) {
          // Distinguish Quick Connect disabled vs invalid Companion user token
          let qcEnabled = true;
          try {
            const enabledRes = await safeHttpJson(`${baseUrl}/QuickConnect/Enabled`, {
              method: 'GET',
              maxRedirects: 0,
              timeoutMs: Math.min(2_000, perAddressTimeoutMs),
              signal: branchSignal,
            });
            if (enabledRes.status === 200 && (enabledRes.data === false || String(enabledRes.data).trim().toLowerCase() === 'false')) {
              qcEnabled = false;
            }
          } catch (_) {}

          if (!qcEnabled) {
            throw createQcError('qc_disabled', 'Quick Connect is disabled on this Jellyfin server.', 409, { baseUrl });
          }

          let confirmedIdentity = false;
          if (res.status === 401 && typeof verifyServerIdentityFor401 === 'function') {
            try {
              confirmedIdentity = await verifyServerIdentityFor401(serverConfig, baseUrl);
            } catch (_) {
              confirmedIdentity = false;
            }
          }
          throw createQcError('no_verified_user', 'Companion user credentials were rejected by Jellyfin.', 409, {
            baseUrl,
            upstreamStatus: res.status,
            confirmedIdentity,
          });
        }

        throw createQcError('qc_broker_unreachable', `Jellyfin returned HTTP ${res.status}`, 503, { baseUrl });
      },
      { staggerMs: 150, perItemTimeoutMs: perAddressTimeoutMs, signal }
    );

    return winner;
  } catch (err) {
    const errors = err instanceof AggregateError ? err.errors : [err];
    for (const e of errors) {
      if (e instanceof SsrfBlockedError) {
        throw createQcError('ssrf_blocked', e.message, 400);
      }
    }
    const precedence = ['qc_disabled', 'no_verified_user', 'qc_authorize_false', 'qc_broker_unreachable'];
    for (const errCode of precedence) {
      const match = errors.find((e) => e && e.errorCode === errCode);
      if (match) {
        // Carry whether any 401 branch confirmed canonical server identity for post-settlement needs_relink
        if (errCode === 'no_verified_user') {
          const confirmed = errors.some((e) => e && e.errorCode === 'no_verified_user' && e.upstreamStatus === 401 && e.confirmedIdentity === true);
          match.shouldMarkNeedsRelink = confirmed;
        }
        throw match;
      }
    }
    throw createQcError('qc_broker_unreachable', 'Unable to reach Jellyfin server.', 503);
  }
}

/**
 * Evaluate Predicate 1 (Server-Address Token Binding) when appending new addresses
 * or merging a srv-* server into an existing canonical server S_canon.
 *
 * Returns { affectedUsers: [{ serverId, userId, username }], newAddressesIntroduced: string[] }.
 */
function evaluateServerAddressBindingImpact({ sourceServer = null, canonicalServer = null, extraAddresses = [], excludeUserId = null }) {
  const sourceAddrs = new Set((Array.isArray(sourceServer?.addresses) ? sourceServer.addresses : []).map(normalizeUrl).filter(Boolean));
  const canonAddrs = new Set((Array.isArray(canonicalServer?.addresses) ? canonicalServer.addresses : []).map(normalizeUrl).filter(Boolean));
  const mergedAddrs = new Set([...sourceAddrs, ...canonAddrs, ...(Array.isArray(extraAddresses) ? extraAddresses.map(normalizeUrl).filter(Boolean) : [])]);

  const excludeNorm = excludeUserId ? normalizeUuid(excludeUserId) : '';
  const affectedUsers = [];
  const seenKeys = new Set();

  const collectAffected = (server, ownAddrs) => {
    if (!server || !Array.isArray(server.users)) return;
    let introducesNewAddr = false;
    for (const addr of mergedAddrs) {
      if (!ownAddrs.has(addr)) {
        introducesNewAddr = true;
        break;
      }
    }
    if (!introducesNewAddr) return;
    for (const u of server.users) {
      if (!u || !u.access_token || !String(u.access_token).trim()) continue;
      const uid = String(u.id || '').trim();
      if (excludeNorm && uid && normalizeUuid(uid) === excludeNorm) continue;
      const key = `${server.id}:${normalizeUuid(uid || u.username || u.name)}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      affectedUsers.push({
        serverId: server.id,
        userId: uid || null,
        username: u.username || u.name || '',
        label: `server:${server.id}:user:${uid || u.username || u.name}`,
      });
    }
  };

  collectAffected(sourceServer, sourceAddrs);
  if (canonicalServer && canonicalServer !== sourceServer) {
    collectAffected(canonicalServer, canonAddrs);
  }

  return {
    affectedUsers,
    mergedAddresses: Array.from(mergedAddrs),
    safeToAutoMerge: affectedUsers.length === 0,
  };
}

/**
 * Deterministically merge a srv-* server (or canonical server update) into a canonical server row inside draft.servers.
 * Returns { targetServer, migrations: Array<{ oldServerId, newServerId }> }.
 */
function mergeCanonicalServerInDraft(draft, {
  sourceServerId = null,
  canonicalId,
  probedServerName = '',
  extraAddresses = [],
  dropAffectedUserIds = null,
}) {
  if (!Array.isArray(draft.servers)) draft.servers = [];
  const normCanon = normalizeUuid(canonicalId);

  const sourceIdx = sourceServerId
    ? draft.servers.findIndex((s) => s && (s.id === sourceServerId || normalizeUuid(s.id) === normalizeUuid(sourceServerId)))
    : -1;
  const sourceServer = sourceIdx >= 0 ? draft.servers[sourceIdx] : null;

  const existingCanonIdx = draft.servers.findIndex(
    (s, idx) => s && idx !== sourceIdx && (s.id === canonicalId || normalizeUuid(s.id) === normCanon)
  );
  const existingCanon = existingCanonIdx >= 0 ? draft.servers[existingCanonIdx] : null;

  const migrations = [];
  const legacyIds = new Set();
  const addLegacy = (id) => {
    const clean = String(id || '').trim();
    if (clean && normalizeUuid(clean) !== normCanon) legacyIds.add(clean);
  };
  if (existingCanon && Array.isArray(existingCanon.legacy_ids)) existingCanon.legacy_ids.forEach(addLegacy);
  if (sourceServer && Array.isArray(sourceServer.legacy_ids)) sourceServer.legacy_ids.forEach(addLegacy);
  if (sourceServer && sourceServer.id && normalizeUuid(sourceServer.id) !== normCanon) {
    addLegacy(sourceServer.id);
    migrations.push({ oldId: sourceServer.id, newId: canonicalId });
  }

  const addressSet = new Set();
  const addAddr = (a) => {
    const norm = normalizeUrl(a);
    if (norm) addressSet.add(norm);
  };
  if (existingCanon && Array.isArray(existingCanon.addresses)) existingCanon.addresses.forEach(addAddr);
  if (sourceServer && Array.isArray(sourceServer.addresses)) sourceServer.addresses.forEach(addAddr);
  (Array.isArray(extraAddresses) ? extraAddresses : []).forEach(addAddr);

  // Merge users: prefer canonical row's order, deduplicate by normalized id then lowercase username
  const dropSet = dropAffectedUserIds
    ? new Set(Array.from(dropAffectedUserIds).map((v) => normalizeUuid(v)))
    : null;
  const droppedSecrets = [];

  const mergedUsers = [];
  const upsertUserIntoMerged = (rawUser) => {
    if (!rawUser || typeof rawUser !== 'object') return;
    const u = structuredClone(rawUser);
    delete u.password;
    const normId = u.id ? normalizeUuid(u.id) : '';
    const lowerName = String(u.username || u.name || '').trim().toLowerCase();

    if (dropSet && u.access_token && ((normId && dropSet.has(normId)) || (lowerName && dropSet.has(normalizeUuid(lowerName))))) {
      u.access_token = '';
      u.needs_relink = true;
      droppedSecrets.push(u.id || u.username || u.name || '');
    }

    const existing = mergedUsers.find((m) => {
      if (normId && m.id && normalizeUuid(m.id) === normId) return true;
      if (lowerName && String(m.username || m.name || '').trim().toLowerCase() === lowerName) return true;
      return false;
    });

    if (!existing) {
      mergedUsers.push(u);
      return;
    }

    if (!existing.id && u.id) existing.id = u.id;
    if (!existing.username && u.username) existing.username = u.username;
    if (!existing.access_token && u.access_token) {
      existing.access_token = u.access_token;
      existing.needs_relink = Boolean(u.needs_relink);
    } else if (existing.access_token && dropSet && normId && dropSet.has(normId)) {
      existing.access_token = '';
      existing.needs_relink = true;
    }
    if (u.preferences && typeof u.preferences === 'object') {
      existing.preferences = { ...u.preferences, ...(existing.preferences || {}) };
    }
    if (!existing.musicAssistant && u.musicAssistant) {
      existing.musicAssistant = structuredClone(u.musicAssistant);
    }
    if (Array.isArray(u.plugins) && u.plugins.length > 0) {
      const existingPlugins = Array.isArray(existing.plugins) ? existing.plugins : [];
      const seen = new Set(existingPlugins.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))));
      for (const p of u.plugins) {
        const key = typeof p === 'string' ? p : JSON.stringify(p);
        if (!seen.has(key)) {
          existingPlugins.push(p);
          seen.add(key);
        }
      }
      existing.plugins = existingPlugins;
    }
  };

  if (existingCanon && Array.isArray(existingCanon.users)) {
    existingCanon.users.forEach(upsertUserIntoMerged);
  }
  if (sourceServer && Array.isArray(sourceServer.users)) {
    sourceServer.users.forEach(upsertUserIntoMerged);
  }

  const resolvedName =
    (existingCanon && String(existingCanon.name || '').trim()) ||
    (sourceServer && String(sourceServer.name || '').trim()) ||
    String(probedServerName || '').trim() ||
    'Jellyfin Server';

  const targetServer = {
    ...(existingCanon || sourceServer || {}),
    id: canonicalId,
    name: resolvedName,
    addresses: Array.from(addressSet),
    users: mergedUsers,
  };
  if (legacyIds.size > 0) {
    targetServer.legacy_ids = Array.from(legacyIds);
  } else {
    delete targetServer.legacy_ids;
  }

  if (existingCanonIdx >= 0) {
    draft.servers[existingCanonIdx] = targetServer;
    if (sourceIdx >= 0 && sourceIdx !== existingCanonIdx) {
      draft.servers.splice(sourceIdx, 1);
    }
  } else if (sourceIdx >= 0) {
    draft.servers[sourceIdx] = targetServer;
  } else {
    draft.servers.push(targetServer);
  }

  return { targetServer, migrations, droppedSecrets };
}

function generatePendingId() {
  return crypto.randomBytes(16).toString('hex');
}

module.exports = {
  normalizeUuid,
  isCanonicalJellyfinServerId,
  isLegacySyntheticServerId,
  normalizeUrl,
  normalizeSixDigitCode,
  createQcError,
  staggeredRace,
  probePublicSystemInfo,
  initiateQuickConnect,
  pollQuickConnect,
  exchangeQuickConnect,
  authorizeQuickConnect,
  evaluateServerAddressBindingImpact,
  mergeCanonicalServerInDraft,
  generatePendingId,
};
