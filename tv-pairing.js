const TV_PAIRING_PORT = 41230;
const TV_PAIRING_CONFIG_PATH = '/api/v1/tv-pairing/config';
const TV_PAIRING_INFO_PATH = '/api/v1/tv-pairing/info';

function normalizeManualCode(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
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

function buildTvReceiverUrl(host) {
  return `http://${host}:${TV_PAIRING_PORT}${TV_PAIRING_CONFIG_PATH}`;
}

function buildTvInfoUrl(host) {
  return `http://${host}:${TV_PAIRING_PORT}${TV_PAIRING_INFO_PATH}`;
}

function buildTvInfoUrlFromReceiverUrl(receiverUrl) {
  const parsed = new URL(String(receiverUrl || '').trim());
  parsed.pathname = TV_PAIRING_INFO_PATH;
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
  if (normalizedPath === TV_PAIRING_CONFIG_PATH) {
    return {
      ok: true,
      receiverPath: TV_PAIRING_CONFIG_PATH
    };
  }
  if (normalizedPath === TV_PAIRING_INFO_PATH) {
    return {
      ok: true,
      receiverPath: TV_PAIRING_CONFIG_PATH
    };
  }

  return {
    ok: false,
    message: `TV receiver URL must use ${TV_PAIRING_CONFIG_PATH} or ${TV_PAIRING_INFO_PATH}`
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
      host: ''
    };
  }

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let parsed;
  try {
    parsed = new URL(withProtocol);
  } catch (_) {
    return {
      ok: false,
      issues: ['TV receiver URL is invalid'],
      receiverUrl: '',
      infoUrl: '',
      host: ''
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
    host: parsed.hostname
  };
}

function normalizeTvPairingPayload(input) {
  const payload = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    version: Number(payload.version),
    receiver_url: String(payload.receiver_url || '').trim(),
    pairing_token: String(payload.pairing_token || '').trim(),
    manual_code: normalizeManualCode(payload.manual_code),
    device_name: String(payload.device_name || '').trim(),
    expires_at_epoch_ms: Number(payload.expires_at_epoch_ms)
  };
}

function validateTvPairingPayload(input, options = {}) {
  const now = Number(options.now) || Date.now();
  const payload = normalizeTvPairingPayload(input);
  const issues = [];
  let receiverUrl = null;

  if (payload.version !== 1) issues.push('Unsupported pairing version');
  if (!payload.receiver_url) {
    issues.push('Missing TV receiver URL');
  } else {
    try {
      receiverUrl = new URL(payload.receiver_url);
      if (!/^https?:$/i.test(receiverUrl.protocol)) {
        issues.push('TV receiver URL must use HTTP or HTTPS');
      }
    } catch (_) {
      issues.push('TV receiver URL is invalid');
    }
  }
  if (!payload.pairing_token) issues.push('Missing pairing token');
  if (!Number.isFinite(payload.expires_at_epoch_ms)) issues.push('Missing expiration time');
  if (Number.isFinite(payload.expires_at_epoch_ms) && payload.expires_at_epoch_ms <= now) issues.push('Pairing code has expired');

  return {
    ok: issues.length === 0,
    issues,
    payload,
    receiverUrl
  };
}

function normalizeTvPairingInfo(input) {
  const info = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    version: Number(info.version),
    manual_code: normalizeManualCode(info.manual_code),
    device_name: String(info.device_name || '').trim(),
    expires_at_epoch_ms: Number(info.expires_at_epoch_ms),
    pairing_token: typeof info.pairing_token === 'string' ? String(info.pairing_token).trim() : ''
  };
}

function validateTvPairingInfo(input, options = {}) {
  const now = Number(options.now) || Date.now();
  const info = normalizeTvPairingInfo(input);
  const issues = [];

  if (info.version !== 1) issues.push('Unsupported pairing version');
  if (!info.manual_code || info.manual_code.length !== 6) issues.push('Manual code is invalid');
  if (!Number.isFinite(info.expires_at_epoch_ms)) issues.push('Missing expiration time');
  if (Number.isFinite(info.expires_at_epoch_ms) && info.expires_at_epoch_ms <= now) issues.push('Pairing code has expired');

  return {
    ok: issues.length === 0,
    issues,
    info
  };
}

function getPrivateIpv4ScanTargets(networkInterfaces) {
  const targets = [];
  const seen = new Set();
  const interfaces = networkInterfaces && typeof networkInterfaces === 'object' ? networkInterfaces : {};

  Object.keys(interfaces).forEach((name) => {
    (interfaces[name] || []).forEach((iface) => {
      if (!iface || iface.internal || iface.family !== 'IPv4' || !isPrivateIpv4(iface.address)) return;
      const parts = iface.address.split('.');
      const prefix = `${parts[0]}.${parts[1]}.${parts[2]}.`;
      for (let host = 1; host <= 254; host += 1) {
        const ip = `${prefix}${host}`;
        if (ip === iface.address || seen.has(ip)) continue;
        seen.add(ip);
        targets.push({
          interfaceName: name,
          sourceAddress: iface.address,
          ip
        });
      }
    });
  });

  return targets;
}

function buildTvPairingEnvelope(config, companionUrl) {
  return {
    version: 1,
    companion_url: companionUrl,
    setup_token: config.setup_token,
    config
  };
}

module.exports = {
  TV_PAIRING_PORT,
  TV_PAIRING_CONFIG_PATH,
  TV_PAIRING_INFO_PATH,
  normalizeManualCode,
  isPrivateIpv4,
  buildTvReceiverUrl,
  buildTvInfoUrl,
  buildTvInfoUrlFromReceiverUrl,
  normalizeTvReceiverInput,
  normalizeTvPairingPayload,
  validateTvPairingPayload,
  normalizeTvPairingInfo,
  validateTvPairingInfo,
  getPrivateIpv4ScanTargets,
  buildTvPairingEnvelope
};
