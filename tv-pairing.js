'use strict';

const net = require('node:net');
const { isReceiverLanIp, stripBrackets } = require('./safe-fetch');

const TV_PAIRING_PORT = 41230;
const TV_PAIRING_CONFIG_PATH = '/api/v1/tv-pairing/config';
const TV_PAIRING_INFO_PATH = '/api/v1/tv-pairing/info';
const DEVICE_SETUP_HANDOFF_PATH = '/api/v1/device-setup/companion-handoff';
const DEVICE_SETUP_PAGE_PATH = '/setup';
const CROCKFORD_CODE_REGEX = /^[0-9A-HJKMNP-TV-Z]{6}$/;
const HEX_PAIRING_TOKEN_REGEX = /^[0-9a-f]{32}$/i;

function normalizeManualCode(value) {
  const stripped = String(value || '')
    .toUpperCase()
    .replace(/[\s-]+/g, '');
  if (!CROCKFORD_CODE_REGEX.test(stripped)) {
    return '';
  }
  return stripped;
}

function isPrivateIpv4(address) {
  const parts = String(address || '').split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  if (parts[0] === 10) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
}

function formatHostAuthority(host) {
  const clean = stripBrackets(String(host || '').trim());
  if (net.isIPv6(clean)) {
    return `[${clean}]`;
  }
  return clean;
}

function resolvePort(port) {
  const parsed = Number(port);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
    return parsed;
  }
  return TV_PAIRING_PORT;
}

function buildTvReceiverUrl(host, port = TV_PAIRING_PORT) {
  const authority = formatHostAuthority(host);
  return `http://${authority}:${resolvePort(port)}${TV_PAIRING_CONFIG_PATH}`;
}

function buildTvInfoUrl(host, port = TV_PAIRING_PORT) {
  const authority = formatHostAuthority(host);
  return `http://${authority}:${resolvePort(port)}${TV_PAIRING_INFO_PATH}`;
}

function buildTvInfoUrlFromReceiverUrl(receiverUrl) {
  const parsed = new URL(String(receiverUrl || '').trim());
  parsed.pathname = TV_PAIRING_INFO_PATH;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function buildCompanionHandoffUrl(host, port = TV_PAIRING_PORT) {
  const authority = formatHostAuthority(host);
  return `http://${authority}:${resolvePort(port)}${DEVICE_SETUP_HANDOFF_PATH}`;
}

function buildCompanionHandoffUrlFromReceiverUrl(receiverUrl) {
  const parsed = new URL(String(receiverUrl || '').trim());
  parsed.pathname = DEVICE_SETUP_HANDOFF_PATH;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function normalizeTvReceiverPath(pathname) {
  const rawPath = String(pathname || '').trim();
  if (!rawPath || rawPath === '/') {
    return {
      ok: true,
      receiverPath: TV_PAIRING_CONFIG_PATH
    };
  }

  const normalizedPath = rawPath.replace(/\/+$/, '') || '/';
  if (
    normalizedPath === TV_PAIRING_CONFIG_PATH ||
    normalizedPath === TV_PAIRING_INFO_PATH ||
    normalizedPath === DEVICE_SETUP_HANDOFF_PATH ||
    normalizedPath === DEVICE_SETUP_PAGE_PATH
  ) {
    return {
      ok: true,
      receiverPath: TV_PAIRING_CONFIG_PATH
    };
  }

  return {
    ok: false,
    message: `Device setup URL must use ${TV_PAIRING_CONFIG_PATH}, ${TV_PAIRING_INFO_PATH}, ${DEVICE_SETUP_HANDOFF_PATH}, or ${DEVICE_SETUP_PAGE_PATH}`
  };
}

function normalizeTvReceiverInput(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    return {
      ok: false,
      issues: ['Missing TV receiver URL'],
      receiverUrl: '',
      infoUrl: '',
      host: '',
      port: TV_PAIRING_PORT
    };
  }

  let withProtocol = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    if (net.isIPv6(raw)) {
      withProtocol = `http://[${raw}]`;
    } else {
      withProtocol = `http://${raw}`;
    }
  }
  let parsed;
  try {
    parsed = new URL(withProtocol);
  } catch (_) {
    return {
      ok: false,
      issues: ['TV receiver URL is invalid'],
      receiverUrl: '',
      infoUrl: '',
      host: '',
      port: TV_PAIRING_PORT
    };
  }

  const issues = [];
  if (!/^https?:$/i.test(parsed.protocol)) {
    issues.push('TV receiver URL must use HTTP or HTTPS');
  }
  if (!parsed.port) {
    parsed.port = String(TV_PAIRING_PORT);
  }

  const normalizedPath = normalizeTvReceiverPath(parsed.pathname);
  if (!normalizedPath.ok) {
    issues.push(normalizedPath.message);
  } else {
    parsed.pathname = normalizedPath.receiverPath;
  }
  parsed.search = '';
  parsed.hash = '';

  const receiverUrl = parsed.toString();
  return {
    ok: issues.length === 0,
    issues,
    receiverUrl,
    infoUrl: issues.length === 0 ? buildTvInfoUrlFromReceiverUrl(receiverUrl) : '',
    host: stripBrackets(parsed.hostname),
    port: Number(parsed.port) || TV_PAIRING_PORT
  };
}

function normalizeTvPairingPayload(input) {
  const payload = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const rawManual = payload.manual_code !== undefined && payload.manual_code !== null
    ? normalizeManualCode(payload.manual_code)
    : '';
  return {
    version: Number(payload.version),
    receiver_url: String(payload.receiver_url || '').trim(),
    pairing_token: String(payload.pairing_token || '').trim(),
    manual_code: rawManual || null,
    device_name: String(payload.device_name || '').trim(),
    device_class: String(payload.device_class || '').trim() || undefined,
    expires_at_epoch_ms: Number.isFinite(Number(payload.expires_at_epoch_ms))
      ? Number(payload.expires_at_epoch_ms)
      : null
  };
}

function validateTvPairingPayload(input) {
  const payload = normalizeTvPairingPayload(input);
  const issues = [];
  let receiverUrl = null;

  if (payload.version !== 1) issues.push('Unsupported pairing version');
  if (!payload.receiver_url) {
    issues.push('Missing TV receiver URL');
  } else {
    try {
      receiverUrl = new URL(payload.receiver_url);
      if (!/^http:$/i.test(receiverUrl.protocol)) {
        issues.push('TV receiver URL must use HTTP');
      }
    } catch (_) {
      issues.push('TV receiver URL is invalid');
    }
  }
  if (!payload.pairing_token) issues.push('Missing pairing token');
  // Advisory-only expires_at_epoch_ms: LanSetupServer enforces authoritative expiry.

  return {
    ok: issues.length === 0,
    issues,
    payload,
    receiverUrl
  };
}

function normalizeTvPairingInfo(input, txt = null) {
  const info = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const txtObj = txt && typeof txt === 'object' ? txt : {};
  const rawPort = info.port ?? txtObj.port ?? TV_PAIRING_PORT;
  const port = resolvePort(rawPort);
  const rawManual = info.manual_code !== undefined && info.manual_code !== null && String(info.manual_code).trim() !== ''
    ? normalizeManualCode(info.manual_code)
    : null;
  const rawCapabilities = Array.isArray(info.capabilities)
    ? info.capabilities.map((c) => String(c || '').trim()).filter(Boolean)
    : typeof txtObj.capabilities === 'string'
      ? txtObj.capabilities.split(',').map((c) => c.trim()).filter(Boolean)
      : [];
  const rawProtocolV = Number(info.protocol_v ?? txtObj.protocol_v ?? 1);
  const expiresAt = Number(info.expires_at_epoch_ms);
  return {
    version: Number(info.version ?? txtObj.version ?? 1),
    port,
    manual_code: rawManual,
    device_name: String(info.device_name || txtObj.device_name || '').trim(),
    device_class: String(info.device_class || txtObj.device_class || 'tv').trim().toLowerCase(),
    protocol_v: Number.isInteger(rawProtocolV) && rawProtocolV >= 1 ? rawProtocolV : 1,
    capabilities: rawCapabilities,
    expires_at_epoch_ms: Number.isFinite(expiresAt) ? expiresAt : null
  };
}

function validateTvPairingInfo(input, txt = null) {
  const info = normalizeTvPairingInfo(input, txt);
  const issues = [];

  if (info.version !== 1) issues.push('Unsupported pairing version');
  if (info.manual_code !== null && info.manual_code.length !== 6) {
    issues.push('Manual code is invalid');
  }
  // Advisory-only expires_at_epoch_ms: LanSetupServer enforces authoritative expiry.

  return {
    ok: issues.length === 0,
    issues,
    info
  };
}

function extractMdnsCandidates(services) {
  const list = Array.isArray(services) ? services : [];
  const seen = new Set();
  const candidates = [];

  for (const svc of list) {
    if (!svc || typeof svc !== 'object') continue;
    const rawAddresses = [];
    if (Array.isArray(svc.addresses)) rawAddresses.push(...svc.addresses);
    if (svc.referer && svc.referer.address) rawAddresses.push(svc.referer.address);

    const validIps = rawAddresses
      .map((addr) => stripBrackets(String(addr || '').split('%')[0].trim()))
      .filter((addr) => net.isIP(addr) && isReceiverLanIp(addr));

    if (validIps.length === 0) continue;
    // Prefer RFC 1918 IPv4 over ULA IPv6 when both are advertised
    validIps.sort((a, b) => {
      const aV4 = net.isIPv4(a) ? 0 : 1;
      const bV4 = net.isIPv4(b) ? 0 : 1;
      if (aV4 !== bV4) return aV4 - bV4;
      return a.localeCompare(b);
    });

    const ip = validIps[0];
    const port = resolvePort(svc.port || (svc.txt && svc.txt.port) || TV_PAIRING_PORT);
    const key = `${ip.toLowerCase()}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const txt = svc.txt && typeof svc.txt === 'object' ? svc.txt : {};
    const rawCapabilities = typeof txt.capabilities === 'string'
      ? txt.capabilities.split(',').map((c) => c.trim()).filter(Boolean)
      : [];
    const protocolV = Number(txt.protocol_v);
    candidates.push({
      ip,
      port,
      receiver_url: buildTvReceiverUrl(ip, port),
      device_name: String(txt.device_name || svc.name || '').trim() || 'SpatialFin Device',
      device_class: String(txt.device_class || 'tv').trim().toLowerCase(),
      protocol_v: Number.isInteger(protocolV) && protocolV >= 1 ? protocolV : 1,
      capabilities: rawCapabilities,
      expires_at_epoch_ms: null
    });
  }

  return candidates;
}

function normalizeServerIdForMatch(id) {
  return String(id || '').trim().toLowerCase().replace(/-/g, '');
}

function buildTvPairingEnvelope(config, companionUrl, options = {}) {
  const clonedConfig = structuredClone(config || {});
  const shareOnly = Boolean(options.shareOnly);
  const requestedServerId = options.serverId ? String(options.serverId).trim() : null;
  const requestedUserId = options.userId ? String(options.userId).trim() : null;

  let projectedServers = Array.isArray(clonedConfig.servers) ? clonedConfig.servers : [];

  if (shareOnly) {
    projectedServers = [];
  } else if (requestedServerId) {
    const reqNorm = normalizeServerIdForMatch(requestedServerId);
    projectedServers = projectedServers.filter((srv) => {
      if (!srv) return false;
      if (srv.id === requestedServerId || normalizeServerIdForMatch(srv.id) === reqNorm) return true;
      if (Array.isArray(srv.legacy_ids)) {
        return srv.legacy_ids.some(
          (lid) => lid === requestedServerId || normalizeServerIdForMatch(lid) === reqNorm
        );
      }
      return false;
    });
  }

  let remappedServerId = requestedServerId;
  projectedServers = projectedServers.map((srv) => {
    const legacyId = Array.isArray(srv.legacy_ids) && srv.legacy_ids.length > 0 ? srv.legacy_ids[0] : null;
    const projectedId = legacyId || srv.id;
    if (requestedServerId) {
      const reqNorm = normalizeServerIdForMatch(requestedServerId);
      const matches =
        srv.id === requestedServerId ||
        normalizeServerIdForMatch(srv.id) === reqNorm ||
        (Array.isArray(srv.legacy_ids) &&
          srv.legacy_ids.some((lid) => lid === requestedServerId || normalizeServerIdForMatch(lid) === reqNorm));
      if (matches) {
        remappedServerId = projectedId;
      }
    }

    let users = Array.isArray(srv.users) ? srv.users : [];
    if (requestedUserId) {
      const userNorm = normalizeServerIdForMatch(requestedUserId);
      users = users.filter((u) => {
        if (!u) return false;
        if (u.id && (u.id === requestedUserId || normalizeServerIdForMatch(u.id) === userNorm)) return true;
        if (u.username && u.username.toLowerCase() === requestedUserId.toLowerCase()) return true;
        return false;
      });
    }

    return {
      ...srv,
      id: projectedId,
      users: users.map((u) => {
        const copy = { ...u };
        delete copy.password;
        return copy;
      })
    };
  });

  clonedConfig.servers = projectedServers;

  const envelope = {
    version: 1,
    companion_url: companionUrl,
    setup_token: clonedConfig.setup_token,
    config: clonedConfig
  };
  if (remappedServerId && !shareOnly) {
    envelope.server_id = remappedServerId;
  }
  if (requestedUserId && !shareOnly) {
    envelope.user_id = requestedUserId;
  }
  return envelope;
}

function buildCompanionHandoffPayload({ companionUrl, setupToken, serverId = null, userId = null, shareOnly = false }) {
  const payload = {
    companion_url: String(companionUrl || '').trim().replace(/\/+$/, ''),
    setup_token: String(setupToken || '').trim(),
  };
  if (shareOnly) {
    payload.share_only = true;
  } else {
    if (serverId) payload.server_id = String(serverId).trim();
    if (userId) payload.user_id = String(userId).trim();
  }
  return payload;
}

function parseSetupUrlQr(rawInput) {
  const raw = String(rawInput || '').trim();
  if (!raw) {
    return { ok: false, issues: ['Empty setup URL'] };
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    return { ok: false, issues: ['Not a valid URL'] };
  }
  if (!/^http:$/i.test(parsed.protocol)) {
    return { ok: false, issues: ['Setup URL must use HTTP'] };
  }
  const normPath = parsed.pathname.replace(/\/+$/, '') || '/';
  if (normPath !== DEVICE_SETUP_PAGE_PATH) {
    return { ok: false, issues: [`Setup URL path must be ${DEVICE_SETUP_PAGE_PATH}`] };
  }
  const hash = String(parsed.hash || '').replace(/^#/, '');
  const hashParams = new URLSearchParams(hash);
  const token = String(hashParams.get('t') || '').trim();
  if (!HEX_PAIRING_TOKEN_REGEX.test(token)) {
    return { ok: false, issues: ['Missing or invalid 32-hex pairing token in #t= fragment'] };
  }
  const host = stripBrackets(parsed.hostname);
  const port = resolvePort(parsed.port || TV_PAIRING_PORT);
  return {
    ok: true,
    isSetupUrl: true,
    host,
    port,
    pairing_token: token.toLowerCase(),
    receiver_url: buildTvReceiverUrl(host, port),
    info_url: buildTvInfoUrl(host, port),
    handoff_url: buildCompanionHandoffUrl(host, port),
  };
}

function formatDeviceClass(deviceClass) {
  switch (String(deviceClass || '').trim().toLowerCase()) {
    case 'xr':
      return 'Android XR';
    case 'tv':
      return 'Android TV';
    case 'phone':
      return 'Phone';
    default:
      return 'SpatialFin Device';
  }
}

module.exports = {
  TV_PAIRING_PORT,
  TV_PAIRING_CONFIG_PATH,
  TV_PAIRING_INFO_PATH,
  DEVICE_SETUP_HANDOFF_PATH,
  DEVICE_SETUP_PAGE_PATH,
  normalizeManualCode,
  isPrivateIpv4,
  buildTvReceiverUrl,
  buildTvInfoUrl,
  buildTvInfoUrlFromReceiverUrl,
  buildCompanionHandoffUrl,
  buildCompanionHandoffUrlFromReceiverUrl,
  normalizeTvReceiverInput,
  normalizeTvPairingPayload,
  validateTvPairingPayload,
  normalizeTvPairingInfo,
  validateTvPairingInfo,
  extractMdnsCandidates,
  buildTvPairingEnvelope,
  buildCompanionHandoffPayload,
  parseSetupUrlQr,
  formatDeviceClass
};
