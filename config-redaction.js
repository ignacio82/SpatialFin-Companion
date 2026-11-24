'use strict';

const { normalizeNetworkShare } = require('./network-shares');

const SECRET_PLACEHOLDER = '***REDACTED***';

const SECRET_PREF_KEYS = new Set([
  'pref_seerr_api_key',
  'pref_tmdb_api_key',
  'pref_omdb_api_key',
  'pref_voice_assistant_cloud_api_key',
]);

const SCOPED_ONLY_SECRET_PREF_KEYS = new Set([
  'pref_tmdb_api_key',
  'pref_omdb_api_key',
  'pref_voice_assistant_cloud_api_key',
]);

const LOCAL_ONLY_PREF_KEYS = new Set([
  'pref_app_lock_mode',
  'pref_app_lock_enabled',
  'pref_app_lock_pin_hash',
  'pref_app_lock_pin_salt',
  'pref_app_lock_pin_kdf_params',
  'pref_content_encryption_enabled',
]);

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isValidMapKey(key) {
  return typeof key === 'string' && key.length > 0 && !FORBIDDEN_KEYS.has(key);
}

function normalizeId(value) {
  return String(value || '').trim().toLowerCase().replace(/-/g, '');
}

function normalizeUrlForBinding(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    const scheme = parsed.protocol.toLowerCase();
    const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
    const port = parsed.port || (scheme === 'https:' ? '443' : scheme === 'http:' ? '80' : '');
    const pathname = (parsed.pathname || '/').replace(/\/+$/, '') || '/';
    return `${scheme}//${host}:${port}${pathname}`;
  } catch (_) {
    return trimmed.replace(/\/+$/, '').toLowerCase();
  }
}

function scrubApiKeyFromText(text) {
  if (text === null || text === undefined) return text;
  return String(text).replace(
    /([?&](?:api_key|apikey|token)=)([^&\s'"#]+)/gi,
    '$1[REDACTED]'
  );
}

function redactPreferenceMap(prefs) {
  const out = {};
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return out;
  for (const [k, v] of Object.entries(prefs)) {
    if (!isValidMapKey(k)) continue;
    if (SECRET_PREF_KEYS.has(k)) {
      if (typeof v === 'string' && v.trim().length > 0) {
        out[k] = SECRET_PLACEHOLDER;
      } else {
        out[k] = '';
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

function redactConfigForExport(config) {
  const cloned = structuredClone(config || {});
  delete cloned.instance_id;

  const hasSetupToken = typeof cloned.setup_token === 'string' && cloned.setup_token.trim().length > 0;
  delete cloned.setup_token;
  cloned.has_setup_token = hasSetupToken;

  cloned.globalPreferences = redactPreferenceMap(cloned.globalPreferences);

  const redactedDevicePrefs = {};
  if (cloned.devicePreferences && typeof cloned.devicePreferences === 'object') {
    for (const [deviceId, prefs] of Object.entries(cloned.devicePreferences)) {
      if (!isValidMapKey(deviceId)) continue;
      redactedDevicePrefs[deviceId] = redactPreferenceMap(prefs);
    }
  }
  cloned.devicePreferences = redactedDevicePrefs;

  if (Array.isArray(cloned.servers)) {
    cloned.servers = cloned.servers.map((srv) => {
      if (!srv || typeof srv !== 'object') return srv;
      const users = Array.isArray(srv.users)
        ? srv.users.map((user) => {
            if (!user || typeof user !== 'object') return user;
            const u = { ...user };
            delete u.password;
            const hasToken = typeof u.access_token === 'string' && u.access_token.trim().length > 0;
            u.has_verified_token = hasToken;
            u.access_token = hasToken ? SECRET_PLACEHOLDER : '';
            u.needs_relink = Boolean(u.needs_relink);
            if (u.musicAssistant && typeof u.musicAssistant === 'object') {
              u.musicAssistant = { ...u.musicAssistant };
              if (typeof u.musicAssistant.token === 'string' && u.musicAssistant.token.trim().length > 0) {
                u.musicAssistant.token = SECRET_PLACEHOLDER;
              }
              if (typeof u.musicAssistant.password === 'string' && u.musicAssistant.password.trim().length > 0) {
                u.musicAssistant.password = SECRET_PLACEHOLDER;
              }
            }
            if (u.preferences && typeof u.preferences === 'object') {
              u.preferences = redactPreferenceMap(u.preferences);
            }
            return u;
          })
        : [];
      return { ...srv, users };
    });
  }

  if (Array.isArray(cloned.networkShares)) {
    cloned.networkShares = cloned.networkShares.map((sh) => {
      if (!sh || typeof sh !== 'object') return sh;
      const copy = { ...sh };
      if (typeof copy.password === 'string' && copy.password.trim().length > 0) {
        copy.password = SECRET_PLACEHOLDER;
      }
      return copy;
    });
  }

  return cloned;
}

function shareTargetKey(share, { includeShareName = true } = {}) {
  const norm = normalizeNetworkShare(share || {});
  const parts = [
    String(norm.protocol || 'smb').toLowerCase(),
    String(norm.host || '').trim().toLowerCase(),
    String(norm.port || (norm.protocol === 'nfs' ? 2049 : 445)),
  ];
  if (includeShareName) {
    parts.push(String(norm.shareName || '').trim().toLowerCase());
  }
  parts.push(
    String(norm.username || '').trim().toLowerCase(),
    String(norm.domain || '').trim().toLowerCase()
  );
  return parts.join('|');
}

function indexExistingServers(servers) {
  const byId = new Map();
  for (const srv of Array.isArray(servers) ? servers : []) {
    if (!srv || typeof srv !== 'object') continue;
    if (srv.id) {
      byId.set(srv.id, srv);
      byId.set(normalizeId(srv.id), srv);
    }
    if (Array.isArray(srv.legacy_ids)) {
      for (const lid of srv.legacy_ids) {
        if (!lid) continue;
        byId.set(lid, srv);
        byId.set(normalizeId(lid), srv);
      }
    }
  }
  return byId;
}

function findMatchingServer(incomingServer, serverIndex) {
  if (!incomingServer) return null;
  if (incomingServer.id) {
    const direct = serverIndex.get(incomingServer.id) || serverIndex.get(normalizeId(incomingServer.id));
    if (direct) return direct;
  }
  if (Array.isArray(incomingServer.legacy_ids)) {
    for (const lid of incomingServer.legacy_ids) {
      const found = serverIndex.get(lid) || serverIndex.get(normalizeId(lid));
      if (found) return found;
    }
  }
  return null;
}

function findMatchingUser(incomingUser, existingServer) {
  if (!incomingUser || !existingServer || !Array.isArray(existingServer.users)) return null;
  const targetId = incomingUser.id ? normalizeId(incomingUser.id) : '';
  if (targetId) {
    const byId = existingServer.users.find((u) => u && u.id && normalizeId(u.id) === targetId);
    if (byId) return byId;
  }
  const targetName = String(incomingUser.username || incomingUser.name || '').trim().toLowerCase();
  if (targetName) {
    return (
      existingServer.users.find(
        (u) => u && String(u.username || u.name || '').trim().toLowerCase() === targetName
      ) || null
    );
  }
  return null;
}

function serverAddressesAreSubset(incomingAddresses, existingAddresses) {
  const existingSet = new Set(
    (Array.isArray(existingAddresses) ? existingAddresses : [])
      .map(normalizeUrlForBinding)
      .filter(Boolean)
  );
  const incomingList = (Array.isArray(incomingAddresses) ? incomingAddresses : [])
    .map(normalizeUrlForBinding)
    .filter(Boolean);
  if (incomingList.length === 0 || existingSet.size === 0) return false;
  return incomingList.every((addr) => existingSet.has(addr));
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function reconcilePreferenceMapSecrets({
  targetPrefs,
  existingPrefs,
  rawSubmittedPrefs,
  prevEffectiveSeerrUrl,
  nextEffectiveSeerrUrl,
  mapLabel,
  confirmDropUnmatchedSecrets,
  unmatchedSecrets,
  droppedSecrets,
  checkCarriedOverSeerr = true,
}) {
  if (!targetPrefs || typeof targetPrefs !== 'object') return;
  const prevMap = existingPrefs && typeof existingPrefs === 'object' ? existingPrefs : {};
  const submitted = rawSubmittedPrefs && typeof rawSubmittedPrefs === 'object' ? rawSubmittedPrefs : null;

  // Predicate 4: preference-map scoped secrets (tmdb, omdb, voice cloud api key)
  for (const key of SCOPED_ONLY_SECRET_PREF_KEYS) {
    if (targetPrefs[key] === SECRET_PLACEHOLDER) {
      if (isNonEmptyString(prevMap[key])) {
        targetPrefs[key] = prevMap[key];
      } else {
        const label = `${mapLabel}.${key}`;
        if (confirmDropUnmatchedSecrets) {
          delete targetPrefs[key];
          droppedSecrets.push(label);
        } else {
          unmatchedSecrets.push(label);
        }
      }
    }
  }

  // Predicate 3: pref_seerr_api_key bound to effective pref_seerr_url
  const submittedHasNewPlaintextKey =
    submitted !== null &&
    Object.prototype.hasOwnProperty.call(submitted, 'pref_seerr_api_key') &&
    isNonEmptyString(submitted.pref_seerr_api_key) &&
    submitted.pref_seerr_api_key !== SECRET_PLACEHOLDER;

  const urlUnchanged =
    Boolean(prevEffectiveSeerrUrl) &&
    Boolean(nextEffectiveSeerrUrl) &&
    prevEffectiveSeerrUrl === nextEffectiveSeerrUrl;

  if (targetPrefs.pref_seerr_api_key === SECRET_PLACEHOLDER) {
    if (urlUnchanged && isNonEmptyString(prevMap.pref_seerr_api_key)) {
      targetPrefs.pref_seerr_api_key = prevMap.pref_seerr_api_key;
    } else {
      const label = `${mapLabel}.pref_seerr_api_key`;
      if (confirmDropUnmatchedSecrets) {
        delete targetPrefs.pref_seerr_api_key;
        droppedSecrets.push(label);
      } else {
        unmatchedSecrets.push(label);
      }
    }
  } else if (
    checkCarriedOverSeerr &&
    !submittedHasNewPlaintextKey &&
    isNonEmptyString(targetPrefs.pref_seerr_api_key) &&
    prevEffectiveSeerrUrl !== nextEffectiveSeerrUrl
  ) {
    const label = `${mapLabel}.pref_seerr_api_key`;
    if (confirmDropUnmatchedSecrets) {
      delete targetPrefs.pref_seerr_api_key;
      droppedSecrets.push(label);
    } else {
      unmatchedSecrets.push(label);
    }
  }
}

/**
 * Restores "***REDACTED***" secrets on a merged config draft against `current`,
 * enforcing Secret Target-Binding Predicates 1–4.
 *
 * `rawPatch` is the incoming request body (before merging with `current`), used
 * to distinguish newly submitted plaintext keys from carried-over/omitted keys.
 */
function restoreRedactedSecrets(mergedDraft, current, options = {}) {
  const {
    confirmDropUnmatchedSecrets = false,
    rawPatch = null,
    devicePreferenceTargetId = null,
  } = options;

  const unmatchedSecrets = [];
  const unmatchedShareSecrets = [];
  const droppedSecrets = [];

  const prevGlobalPrefs = (current && current.globalPreferences) || {};
  const nextGlobalPrefs = (mergedDraft && mergedDraft.globalPreferences) || {};
  const prevGlobalSeerrUrl = normalizeUrlForBinding(prevGlobalPrefs.pref_seerr_url);
  const nextGlobalSeerrUrl = normalizeUrlForBinding(nextGlobalPrefs.pref_seerr_url);
  const globalSeerrUrlChanged = prevGlobalSeerrUrl !== nextGlobalSeerrUrl;

  // 1. Global preferences (unless this is a single-device PUT)
  if (!devicePreferenceTargetId) {
    reconcilePreferenceMapSecrets({
      targetPrefs: nextGlobalPrefs,
      existingPrefs: prevGlobalPrefs,
      rawSubmittedPrefs: rawPatch && rawPatch.globalPreferences ? rawPatch.globalPreferences : null,
      prevEffectiveSeerrUrl: prevGlobalSeerrUrl,
      nextEffectiveSeerrUrl: nextGlobalSeerrUrl,
      mapLabel: 'globalPreferences',
      confirmDropUnmatchedSecrets,
      unmatchedSecrets,
      droppedSecrets,
    });
  }

  // 2. Device preferences
  const prevDeviceMap = (current && current.devicePreferences) || {};
  const nextDeviceMap = (mergedDraft && mergedDraft.devicePreferences) || {};
  const rawDeviceMap = rawPatch && rawPatch.devicePreferences ? rawPatch.devicePreferences : null;

  const deviceIdsToCheck = devicePreferenceTargetId
    ? [devicePreferenceTargetId]
    : Object.keys(nextDeviceMap);

  for (const deviceId of deviceIdsToCheck) {
    if (!isValidMapKey(deviceId)) continue;
    const nextPrefs = nextDeviceMap[deviceId];
    if (!nextPrefs || typeof nextPrefs !== 'object') continue;
    const prevPrefs = Object.prototype.hasOwnProperty.call(prevDeviceMap, deviceId)
      ? prevDeviceMap[deviceId]
      : {};
    const prevEffective = normalizeUrlForBinding(prevPrefs?.pref_seerr_url) || prevGlobalSeerrUrl;
    const nextEffective = normalizeUrlForBinding(nextPrefs?.pref_seerr_url) || nextGlobalSeerrUrl;

    const rawSubmitted = devicePreferenceTargetId
      ? rawPatch
      : rawDeviceMap && Object.prototype.hasOwnProperty.call(rawDeviceMap, deviceId)
        ? rawDeviceMap[deviceId]
        : null;

    // Only check carried-over seerr if this device map was mutated OR global Seerr URL changed and device inherits global URL
    const deviceHasOwnUrl = isNonEmptyString(nextPrefs.pref_seerr_url);
    const shouldCheckCarriedOver =
      Boolean(rawSubmitted) || (globalSeerrUrlChanged && !deviceHasOwnUrl);

    reconcilePreferenceMapSecrets({
      targetPrefs: nextPrefs,
      existingPrefs: prevPrefs,
      rawSubmittedPrefs: rawSubmitted,
      prevEffectiveSeerrUrl: prevEffective,
      nextEffectiveSeerrUrl: nextEffective,
      mapLabel: `devicePreferences.${deviceId}`,
      confirmDropUnmatchedSecrets,
      unmatchedSecrets,
      droppedSecrets,
      checkCarriedOverSeerr: shouldCheckCarriedOver,
    });
  }

  if (devicePreferenceTargetId) {
    return {
      ok: unmatchedSecrets.length === 0,
      errorCode: unmatchedSecrets.length > 0 ? 'redacted_secret_mismatch' : null,
      unmatchedSecrets,
      droppedSecrets,
    };
  }

  // 3. Servers & Users (Predicates 1, 3, 4)
  const serverIndex = indexExistingServers(current && current.servers);
  const rawServers = Array.isArray(rawPatch && rawPatch.servers) ? rawPatch.servers : null;

  for (let sIdx = 0; sIdx < (Array.isArray(mergedDraft.servers) ? mergedDraft.servers.length : 0); sIdx += 1) {
    const srv = mergedDraft.servers[sIdx];
    if (!srv || typeof srv !== 'object') continue;
    const existingServer = findMatchingServer(srv, serverIndex);
    const rawSrv = rawServers
      ? rawServers.find((r) => r && r.id && srv.id && normalizeId(r.id) === normalizeId(srv.id)) ||
        rawServers[sIdx]
      : null;

    const addressesSubsetOk = existingServer
      ? serverAddressesAreSubset(srv.addresses, existingServer.addresses)
      : false;

    const users = Array.isArray(srv.users) ? srv.users : [];
    for (let uIdx = 0; uIdx < users.length; uIdx += 1) {
      const user = users[uIdx];
      if (!user || typeof user !== 'object') continue;
      const existingUser = findMatchingUser(user, existingServer);
      const rawUser =
        rawSrv && Array.isArray(rawSrv.users)
          ? rawSrv.users.find(
              (ru) =>
                ru &&
                ((user.id && ru.id && normalizeId(ru.id) === normalizeId(user.id)) ||
                  (user.username &&
                    ru.username &&
                    ru.username.toLowerCase() === user.username.toLowerCase()))
            ) || rawSrv.users[uIdx]
          : null;
      const userLabel = `servers.${srv.id || sIdx}.users.${user.id || user.username || uIdx}`;

      // Predicate 1: access_token
      if (user.access_token === SECRET_PLACEHOLDER) {
        if (addressesSubsetOk && existingUser && isNonEmptyString(existingUser.access_token)) {
          user.access_token = existingUser.access_token;
        } else {
          const label = `${userLabel}.access_token`;
          if (confirmDropUnmatchedSecrets) {
            user.access_token = '';
            user.needs_relink = true;
            droppedSecrets.push(label);
          } else {
            unmatchedSecrets.push(label);
          }
        }
      }

      // Predicate 3: musicAssistant.token & musicAssistant.password
      if (user.musicAssistant && typeof user.musicAssistant === 'object') {
        const prevMa = (existingUser && existingUser.musicAssistant) || {};
        const prevMaUrl = normalizeUrlForBinding(prevMa.url);
        const nextMaUrl = normalizeUrlForBinding(user.musicAssistant.url);
        const maUrlUnchanged = Boolean(prevMaUrl) && Boolean(nextMaUrl) && prevMaUrl === nextMaUrl;
        const rawMa = rawUser && rawUser.musicAssistant ? rawUser.musicAssistant : null;

        for (const field of ['token', 'password']) {
          const val = user.musicAssistant[field];
          const submittedPlaintext =
            rawMa &&
            Object.prototype.hasOwnProperty.call(rawMa, field) &&
            isNonEmptyString(rawMa[field]) &&
            rawMa[field] !== SECRET_PLACEHOLDER;

          if (val === SECRET_PLACEHOLDER) {
            if (maUrlUnchanged && isNonEmptyString(prevMa[field])) {
              user.musicAssistant[field] = prevMa[field];
            } else {
              const label = `${userLabel}.musicAssistant.${field}`;
              if (confirmDropUnmatchedSecrets) {
                user.musicAssistant[field] = '';
                droppedSecrets.push(label);
              } else {
                unmatchedSecrets.push(label);
              }
            }
          } else if (
            !submittedPlaintext &&
            isNonEmptyString(val) &&
            prevMaUrl !== nextMaUrl
          ) {
            const label = `${userLabel}.musicAssistant.${field}`;
            if (confirmDropUnmatchedSecrets) {
              user.musicAssistant[field] = '';
              droppedSecrets.push(label);
            } else {
              unmatchedSecrets.push(label);
            }
          }
        }
      }

      // Predicates 3 & 4: user.preferences
      if (user.preferences && typeof user.preferences === 'object') {
        const prevUserPrefs = (existingUser && existingUser.preferences) || {};
        const prevEffective = normalizeUrlForBinding(prevUserPrefs.pref_seerr_url) || prevGlobalSeerrUrl;
        const nextEffective = normalizeUrlForBinding(user.preferences.pref_seerr_url) || nextGlobalSeerrUrl;
        const userHasOwnUrl = isNonEmptyString(user.preferences.pref_seerr_url);
        const rawUserPrefs = rawUser && rawUser.preferences ? rawUser.preferences : null;
        const shouldCheckCarriedOver =
          Boolean(rawUserPrefs) || (globalSeerrUrlChanged && !userHasOwnUrl);

        reconcilePreferenceMapSecrets({
          targetPrefs: user.preferences,
          existingPrefs: prevUserPrefs,
          rawSubmittedPrefs: rawUserPrefs,
          prevEffectiveSeerrUrl: prevEffective,
          nextEffectiveSeerrUrl: nextEffective,
          mapLabel: `${userLabel}.preferences`,
          confirmDropUnmatchedSecrets,
          unmatchedSecrets,
          droppedSecrets,
          checkCarriedOverSeerr: shouldCheckCarriedOver,
        });
      }
    }
  }

  // 4. Network Shares (Predicate 2)
  const existingShareByTarget = new Map();
  for (const sh of Array.isArray(current && current.networkShares) ? current.networkShares : []) {
    if (!sh || typeof sh !== 'object') continue;
    if (isNonEmptyString(sh.password)) {
      const key = shareTargetKey(sh, { includeShareName: true });
      if (!existingShareByTarget.has(key)) {
        existingShareByTarget.set(key, sh.password);
      }
    }
  }

  const shares = Array.isArray(mergedDraft.networkShares) ? mergedDraft.networkShares : [];
  for (let idx = 0; idx < shares.length; idx += 1) {
    const sh = shares[idx];
    if (!sh || typeof sh !== 'object') continue;
    if (sh.password === SECRET_PLACEHOLDER) {
      const key = shareTargetKey(sh, { includeShareName: true });
      const stored = existingShareByTarget.get(key);
      if (stored) {
        sh.password = stored;
      } else {
        const label = `networkShares.${sh.id || idx}.password`;
        if (confirmDropUnmatchedSecrets) {
          sh.password = '';
          droppedSecrets.push(label);
        } else {
          unmatchedShareSecrets.push(label);
          unmatchedSecrets.push(label);
        }
      }
    }
  }

  const errorCode =
    unmatchedShareSecrets.length > 0
      ? 'share_password_required'
      : unmatchedSecrets.length > 0
        ? 'redacted_secret_mismatch'
        : null;

  return {
    ok: unmatchedSecrets.length === 0,
    errorCode,
    unmatchedSecrets,
    droppedSecrets,
  };
}

function lookupStoredShareSecret(incomingShare, currentShares, { matchShareName = true } = {}) {
  const targetKey = shareTargetKey(incomingShare, { includeShareName: matchShareName });
  for (const sh of Array.isArray(currentShares) ? currentShares : []) {
    if (!sh || typeof sh !== 'object' || !isNonEmptyString(sh.password)) continue;
    if (shareTargetKey(sh, { includeShareName: matchShareName }) === targetKey) {
      return sh.password;
    }
  }
  return null;
}

function lookupStoredSeerrApiKey(incomingUrl, currentConfig) {
  const targetNorm = normalizeUrlForBinding(incomingUrl);
  if (!targetNorm || !currentConfig) return null;

  const globalPrefs = currentConfig.globalPreferences || {};
  const globalUrl = normalizeUrlForBinding(globalPrefs.pref_seerr_url);
  if (globalUrl === targetNorm && isNonEmptyString(globalPrefs.pref_seerr_api_key)) {
    return globalPrefs.pref_seerr_api_key;
  }

  const devicePrefs = currentConfig.devicePreferences || {};
  for (const prefs of Object.values(devicePrefs)) {
    if (!prefs || typeof prefs !== 'object') continue;
    const effUrl = normalizeUrlForBinding(prefs.pref_seerr_url) || globalUrl;
    if (effUrl === targetNorm && isNonEmptyString(prefs.pref_seerr_api_key)) {
      return prefs.pref_seerr_api_key;
    }
  }

  for (const srv of Array.isArray(currentConfig.servers) ? currentConfig.servers : []) {
    for (const user of Array.isArray(srv?.users) ? srv.users : []) {
      const prefs = user?.preferences;
      if (!prefs || typeof prefs !== 'object') continue;
      const effUrl = normalizeUrlForBinding(prefs.pref_seerr_url) || globalUrl;
      if (effUrl === targetNorm && isNonEmptyString(prefs.pref_seerr_api_key)) {
        return prefs.pref_seerr_api_key;
      }
    }
  }

  return null;
}

/**
 * Enforces Read-Time Cross-Layer pref_seerr_api_key Isolation (Predicate 3).
 * Computes effective preferences for (globalPreferences -> devicePreferences[deviceId])
 * and projects `servers[].users[].preferences` safely for that device.
 */
function resolveEffectiveDevicePreferences(globalPreferences = {}, devicePreferences = {}, deviceId = null) {
  const globalPrefs = { ...(globalPreferences || {}) };
  if (!deviceId || !isValidMapKey(deviceId) || !Object.prototype.hasOwnProperty.call(devicePreferences || {}, deviceId)) {
    return {
      effectivePrefs: globalPrefs,
      deviceOverrodeSeerrUrl: false,
      globalSeerrUrl: normalizeUrlForBinding(globalPrefs.pref_seerr_url),
      effectiveSeerrUrl: normalizeUrlForBinding(globalPrefs.pref_seerr_url),
    };
  }

  const devOverrides = devicePreferences[deviceId] || {};
  const globalSeerrUrl = normalizeUrlForBinding(globalPrefs.pref_seerr_url);
  const devOwnUrl = normalizeUrlForBinding(devOverrides.pref_seerr_url);
  const devHasOwnKey = isNonEmptyString(devOverrides.pref_seerr_api_key);
  const deviceOverrodeSeerrUrl = Boolean(devOwnUrl) && devOwnUrl !== globalSeerrUrl;

  const merged = { ...globalPrefs, ...devOverrides };
  if (deviceOverrodeSeerrUrl && !devHasOwnKey) {
    delete merged.pref_seerr_api_key;
  }

  return {
    effectivePrefs: merged,
    deviceOverrodeSeerrUrl,
    globalSeerrUrl,
    effectiveSeerrUrl: normalizeUrlForBinding(merged.pref_seerr_url),
  };
}

function isolateUserPreferencesForDevice(userPreferences, { deviceOverrodeSeerrUrl, effectiveSeerrUrl }) {
  if (!userPreferences || typeof userPreferences !== 'object') return userPreferences;
  const out = { ...userPreferences };
  const userOwnUrl = normalizeUrlForBinding(out.pref_seerr_url);
  const userHasOwnKey = isNonEmptyString(out.pref_seerr_api_key);

  // If device overrode Seerr URL away from global, suppress any user-level key that lacks its own explicit URL
  if (deviceOverrodeSeerrUrl && !userOwnUrl && userHasOwnKey) {
    delete out.pref_seerr_api_key;
  }
  return out;
}

module.exports = {
  SECRET_PLACEHOLDER,
  SECRET_PREF_KEYS,
  LOCAL_ONLY_PREF_KEYS,
  FORBIDDEN_KEYS,
  isValidMapKey,
  normalizeId,
  normalizeUrlForBinding,
  scrubApiKeyFromText,
  redactPreferenceMap,
  redactConfigForExport,
  restoreRedactedSecrets,
  lookupStoredShareSecret,
  lookupStoredSeerrApiKey,
  resolveEffectiveDevicePreferences,
  isolateUserPreferencesForDevice,
};
