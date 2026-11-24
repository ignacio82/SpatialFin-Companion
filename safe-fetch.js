'use strict';

const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');

const POLICY_RECEIVER_LAN_HTTP_ONLY = 'RECEIVER_LAN_HTTP_ONLY';
const POLICY_PRIVATE_LAN_ONLY = 'PRIVATE_LAN_ONLY';
const POLICY_PUBLIC_OR_LAN = 'PUBLIC_OR_LAN';

const SENSITIVE_REDIRECT_HEADERS = new Set([
  'authorization',
  'x-emby-authorization',
  'x-emby-token',
  'x-mediabrowser-token',
  'x-setup-token',
  'x-pairing-token',
  'x-api-key',
  'proxy-authorization',
  'cookie',
]);

class SsrfBlockedError extends Error {
  constructor(message, details = {}) {
    super(message || 'Request target blocked by SSRF policy');
    this.name = 'SsrfBlockedError';
    this.code = 'ssrf_blocked';
    this.errorCode = 'ssrf_blocked';
    this.status = 400;
    Object.assign(this, details);
  }
}

function stripBrackets(host) {
  const s = String(host || '').trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    return s.slice(1, -1);
  }
  return s;
}

function normalizeHostForMatch(host) {
  return stripBrackets(host).toLowerCase().replace(/\.+$/, '');
}

function effectivePortForUrl(parsed) {
  if (parsed.port) return Number(parsed.port);
  return parsed.protocol === 'https:' ? 443 : 80;
}

function parseIpv4ToBytes(ip) {
  const parts = String(ip || '').split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    const part = parts[i];
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    bytes[i] = n;
  }
  return bytes;
}

function parseIpv6ToBytes(ip) {
  const raw = stripBrackets(ip).toLowerCase();
  if (!raw || raw.includes('%') || net.isIPv6(raw) === false) return null;

  let working = raw;
  // Convert embedded IPv4 suffix (e.g., ::ffff:192.168.1.1) to two 16-bit hex groups
  const lastColon = working.lastIndexOf(':');
  if (lastColon !== -1 && working.slice(lastColon + 1).includes('.')) {
    const v4Bytes = parseIpv4ToBytes(working.slice(lastColon + 1));
    if (!v4Bytes) return null;
    const hi = ((v4Bytes[0] << 8) | v4Bytes[1]).toString(16);
    const lo = ((v4Bytes[2] << 8) | v4Bytes[3]).toString(16);
    working = `${working.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const sides = working.split('::');
  if (sides.length > 2) return null;
  const left = sides[0] ? sides[0].split(':').filter((p) => p.length > 0) : [];
  const right = sides.length === 2 && sides[1] ? sides[1].split(':').filter((p) => p.length > 0) : [];
  const missing = 8 - (left.length + right.length);
  if (sides.length === 1 && missing !== 0) return null;
  if (sides.length === 2 && missing < 0) return null;

  const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null;
    const val = parseInt(groups[i], 16);
    bytes[i * 2] = (val >> 8) & 0xff;
    bytes[i * 2 + 1] = val & 0xff;
  }
  return bytes;
}

function bytesToIpv4(b0, b1, b2, b3) {
  return `${b0}.${b1}.${b2}.${b3}`;
}

function isNonCanonicalIpv4Host(host) {
  const clean = normalizeHostForMatch(host);
  if (!clean) return false;
  if (net.isIPv6(clean)) return false;
  if (parseIpv4ToBytes(clean)) return false; // valid canonical dotted-quad

  const labels = clean.split('.').filter((l) => l.length > 0);
  if (labels.length === 0) return false;
  const lastLabel = labels[labels.length - 1];

  const isIntToken = (tok) =>
    /^0x[0-9a-f]+$/i.test(tok) ||
    /^0[0-7]+$/.test(tok) ||
    /^\d+$/.test(tok);

  if (isIntToken(lastLabel)) return true;
  if (labels.every((l) => isIntToken(l))) return true;
  return false;
}

function isSyntacticLoopbackHost(host) {
  const clean = normalizeHostForMatch(host);
  return (
    clean === 'localhost' ||
    clean.endsWith('.localhost') ||
    clean === 'ip6-localhost' ||
    clean === 'ip6-loopback'
  );
}

function isZeroPrefix(bytes, count) {
  for (let i = 0; i < count; i += 1) {
    if (bytes[i] !== 0) return false;
  }
  return true;
}

function unwrapIpv4InIpv6(ip) {
  const raw = stripBrackets(ip);
  if (net.isIPv4(raw)) return raw;
  const bytes = parseIpv6ToBytes(raw);
  if (!bytes) return raw;

  // ::ffff:0:0/96
  if (isZeroPrefix(bytes, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return bytesToIpv4(bytes[12], bytes[13], bytes[14], bytes[15]);
  }
  // RFC 6052 well-known NAT64 prefix 64:ff9b::/96
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes[4] === 0x00 &&
    bytes[5] === 0x00 &&
    bytes[6] === 0x00 &&
    bytes[7] === 0x00 &&
    bytes[8] === 0x00 &&
    bytes[9] === 0x00 &&
    bytes[10] === 0x00 &&
    bytes[11] === 0x00
  ) {
    return bytesToIpv4(bytes[12], bytes[13], bytes[14], bytes[15]);
  }
  return raw;
}

function isDeprecatedOrTunnelIpv6(bytes) {
  if (!bytes) return false;
  // ::/96 excluding :: (0) and ::1 (1)
  if (isZeroPrefix(bytes, 12)) {
    const isUnspecified = bytes[12] === 0 && bytes[13] === 0 && bytes[14] === 0 && bytes[15] === 0;
    const isLoopback = bytes[12] === 0 && bytes[13] === 0 && bytes[14] === 0 && bytes[15] === 1;
    if (!isUnspecified && !isLoopback) return true;
  }
  // ::ffff:0:0:0/96 (IPv4-translated: bytes[8..9] == 0xffff, bytes[0..7]==0, bytes[10..11]==0)
  if (
    isZeroPrefix(bytes, 8) &&
    bytes[8] === 0xff &&
    bytes[9] === 0xff &&
    bytes[10] === 0x00 &&
    bytes[11] === 0x00
  ) {
    return true;
  }
  // 64:ff9b:1::/48 (RFC 8215 local-use NAT64)
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes[4] === 0x00 &&
    bytes[5] === 0x01
  ) {
    return true;
  }
  // 2002::/16 (6to4)
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return true;
  // 2001::/32 (Teredo)
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return true;
  // ISATAP: bytes[8] in {0x00, 0x02} && bytes[9] == 0x00 && bytes[10] == 0x5e && bytes[11] == 0xfe
  if (
    (bytes[8] === 0x00 || bytes[8] === 0x02) &&
    bytes[9] === 0x00 &&
    bytes[10] === 0x5e &&
    bytes[11] === 0xfe
  ) {
    return true;
  }
  return false;
}

function isLinkLocalIpv6(ip) {
  const bytes = parseIpv6ToBytes(ip);
  if (!bytes) return false;
  return bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80;
}

function isLoopbackIp(ip) {
  const unwrapped = unwrapIpv4InIpv6(ip);
  const v4 = parseIpv4ToBytes(unwrapped);
  if (v4) return v4[0] === 127;
  const v6 = parseIpv6ToBytes(unwrapped);
  if (!v6) return false;
  return isZeroPrefix(v6, 15) && v6[15] === 1;
}

function isUniversallyProhibitedIp(ip) {
  const raw = stripBrackets(ip);
  const rawV6 = parseIpv6ToBytes(raw);
  if (rawV6 && isDeprecatedOrTunnelIpv6(rawV6)) return true;

  const unwrapped = unwrapIpv4InIpv6(raw);
  const v4 = parseIpv4ToBytes(unwrapped);
  if (v4) {
    const [a, b, c, d] = v4;
    if (a === 127) return true; // loopback 127.0.0.0/8
    if (a === 0) return true; // unspecified 0.0.0.0/8
    if (a === 169 && b === 254) return true; // link-local / IMDS 169.254.0.0/16
    if (a === 100 && b === 100 && c === 100 && d === 200) return true; // Alibaba IMDS
    if (a >= 224 && a <= 239) return true; // multicast 224.0.0.0/4
    if (a >= 240) return true; // Class E 240.0.0.0/4 + broadcast 255.255.255.255
    return false;
  }

  const v6 = parseIpv6ToBytes(unwrapped);
  if (!v6) return true;
  if (isDeprecatedOrTunnelIpv6(v6)) return true;
  // ::/128 unspecified
  if (isZeroPrefix(v6, 16)) return true;
  // ::1 loopback
  if (isZeroPrefix(v6, 15) && v6[15] === 1) return true;
  // fe80::/10 link-local
  if (v6[0] === 0xfe && (v6[1] & 0xc0) === 0x80) return true;
  // fec0::/10 deprecated site-local
  if (v6[0] === 0xfe && (v6[1] & 0xc0) === 0xc0) return true;
  // ff00::/8 multicast
  if (v6[0] === 0xff) return true;
  // AWS IPv6 IMDS fd00:ec2::254/128
  if (
    v6[0] === 0xfd &&
    v6[1] === 0x00 &&
    v6[2] === 0x0e &&
    v6[3] === 0xc2 &&
    v6[4] === 0 &&
    v6[5] === 0 &&
    v6[6] === 0 &&
    v6[7] === 0 &&
    v6[8] === 0 &&
    v6[9] === 0 &&
    v6[10] === 0 &&
    v6[11] === 0 &&
    v6[12] === 0 &&
    v6[13] === 0 &&
    v6[14] === 0x02 &&
    v6[15] === 0x54
  ) {
    return true;
  }
  return false;
}

function isRfc1918Ipv4(ip) {
  const v4 = parseIpv4ToBytes(unwrapIpv4InIpv6(ip));
  if (!v4) return false;
  if (v4[0] === 10) return true;
  if (v4[0] === 192 && v4[1] === 168) return true;
  return v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31;
}

function isCgnatIpv4(ip) {
  const v4 = parseIpv4ToBytes(unwrapIpv4InIpv6(ip));
  if (!v4) return false;
  if (v4[0] === 100 && v4[1] === 100 && v4[2] === 100 && v4[3] === 200) return false; // Alibaba IMDS
  return v4[0] === 100 && v4[1] >= 64 && v4[1] <= 127;
}

function isUlaIpv6(ip) {
  const raw = stripBrackets(ip);
  const v6 = parseIpv6ToBytes(raw);
  if (!v6) return false;
  if (isUniversallyProhibitedIp(raw)) return false;
  return (v6[0] & 0xfe) === 0xfc;
}

function isPrivateOrLanIp(ip, { allowCgnat = true } = {}) {
  const raw = stripBrackets(ip);
  if (isUniversallyProhibitedIp(raw)) return false;
  const unwrapped = unwrapIpv4InIpv6(raw);
  if (net.isIPv4(unwrapped)) {
    return isRfc1918Ipv4(unwrapped) || (allowCgnat && isCgnatIpv4(unwrapped));
  }
  return isUlaIpv6(unwrapped);
}

function isReceiverLanIp(ip) {
  return isPrivateOrLanIp(ip, { allowCgnat: false });
}

function getOwnLocalIps() {
  const ips = new Set();
  const ifaces = os.networkInterfaces();
  for (const entries of Object.values(ifaces || {})) {
    for (const entry of entries || []) {
      if (!entry || !entry.address) continue;
      const clean = stripBrackets(String(entry.address).split('%')[0]);
      ips.add(clean.toLowerCase());
      const unwrapped = unwrapIpv4InIpv6(clean);
      if (unwrapped) ips.add(unwrapped.toLowerCase());
    }
  }
  return ips;
}

function isSelfSsrfTarget(ip, port, selfPort) {
  const resolvedSelfPort = Number(selfPort !== undefined ? selfPort : process.env.PORT || 1982);
  if (!Number.isFinite(resolvedSelfPort) || Number(port) !== resolvedSelfPort) return false;
  if (isLoopbackIp(ip)) return true;
  const unwrapped = unwrapIpv4InIpv6(ip).toLowerCase();
  const clean = stripBrackets(ip).toLowerCase();
  const ownIps = getOwnLocalIps();
  return ownIps.has(clean) || ownIps.has(unwrapped);
}

function normalizeLoopbackAllowlistEntry(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') {
    const trimmed = entry.trim().toLowerCase();
    const match = trimmed.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/);
    if (!match) return null;
    return `${normalizeHostForMatch(match[1])}:${Number(match[2])}`;
  }
  if (typeof entry === 'object' && entry.host && entry.port) {
    return `${normalizeHostForMatch(entry.host)}:${Number(entry.port)}`;
  }
  return null;
}

function isInLoopbackAllowlist(hostname, port, allowlist) {
  if (!allowlist) return false;
  const target = `${normalizeHostForMatch(hostname)}:${Number(port)}`;
  const items = Array.isArray(allowlist) ? allowlist : Array.from(allowlist);
  for (const item of items) {
    if (normalizeLoopbackAllowlistEntry(item) === target) return true;
  }
  return false;
}

function validateIpForPolicy(ip, policy, { port, selfPort, allowLoopback = false } = {}) {
  const clean = stripBrackets(ip);
  if (!net.isIP(clean)) {
    throw new SsrfBlockedError(`Invalid IP address: ${ip}`);
  }
  if (port !== undefined && isSelfSsrfTarget(clean, port, selfPort)) {
    throw new SsrfBlockedError(`Refused self-SSRF target ${clean}:${port}`);
  }
  if (isLoopbackIp(clean)) {
    if (policy === POLICY_PUBLIC_OR_LAN && allowLoopback) {
      return;
    }
    throw new SsrfBlockedError(`Loopback target ${clean} is not permitted under ${policy}`);
  }
  if (isUniversallyProhibitedIp(clean)) {
    throw new SsrfBlockedError(`Prohibited IP target ${clean}`);
  }
  if (policy === POLICY_RECEIVER_LAN_HTTP_ONLY) {
    if (!isReceiverLanIp(clean)) {
      throw new SsrfBlockedError(`Receiver target ${clean} must be RFC 1918 IPv4 or ULA IPv6`);
    }
    return;
  }
  if (policy === POLICY_PRIVATE_LAN_ONLY) {
    if (!isPrivateOrLanIp(clean, { allowCgnat: true })) {
      throw new SsrfBlockedError(`Target ${clean} is outside PRIVATE_LAN_ONLY`);
    }
    return;
  }
  if (policy === POLICY_PUBLIC_OR_LAN) {
    return;
  }
  throw new SsrfBlockedError(`Unknown SSRF policy: ${policy}`);
}

function validateInitialUrl(rawUrl, policy = POLICY_PUBLIC_OR_LAN, options = {}) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch (_) {
    throw new SsrfBlockedError('Invalid URL');
  }

  if (parsed.username || parsed.password) {
    throw new SsrfBlockedError('URL userinfo is not allowed');
  }

  if (policy === POLICY_RECEIVER_LAN_HTTP_ONLY) {
    if (parsed.protocol !== 'http:') {
      throw new SsrfBlockedError('Receiver target must use http://');
    }
  } else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfBlockedError(`Unsupported URL scheme: ${parsed.protocol}`);
  }

  const rawHost = stripBrackets(parsed.hostname);
  if (!rawHost || rawHost.includes('%') || /\s/.test(rawHost)) {
    throw new SsrfBlockedError('Invalid URL host');
  }

  // Also check raw authority from the input string for non-canonical IPv4 forms
  // (WHATWG URL parser normalizes 127.1 or 0177.0.0.1 before exposing parsed.hostname!)
  const authorityMatch = String(rawUrl || '').trim().match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i);
  if (authorityMatch) {
    let rawAuthority = authorityMatch[1];
    if (rawAuthority.includes('@')) {
      throw new SsrfBlockedError('URL userinfo is not allowed');
    }
    let rawHostPart = rawAuthority;
    if (rawAuthority.startsWith('[')) {
      const close = rawAuthority.indexOf(']');
      if (close === -1) throw new SsrfBlockedError('Malformed IPv6 authority');
      rawHostPart = rawAuthority.slice(1, close);
      if (rawHostPart.includes('%')) throw new SsrfBlockedError('IPv6 zone IDs are not allowed');
    } else {
      const colonIdx = rawAuthority.lastIndexOf(':');
      if (colonIdx !== -1 && /^\d+$/.test(rawAuthority.slice(colonIdx + 1))) {
        rawHostPart = rawAuthority.slice(0, colonIdx);
      }
    }
    if (isNonCanonicalIpv4Host(rawHostPart)) {
      throw new SsrfBlockedError(`Non-canonical IPv4 host rejected: ${rawHostPart}`);
    }
  }

  if (isNonCanonicalIpv4Host(rawHost)) {
    throw new SsrfBlockedError(`Non-canonical IPv4 host rejected: ${rawHost}`);
  }

  const port = effectivePortForUrl(parsed);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SsrfBlockedError('Invalid port');
  }

  const allowLoopback =
    policy === POLICY_PUBLIC_OR_LAN &&
    Boolean(
      options.allowLoopback ||
      isInLoopbackAllowlist(rawHost, port, options.legacyLoopbackAllowlist)
    );

  const ipVersion = net.isIP(rawHost);
  if (policy === POLICY_RECEIVER_LAN_HTTP_ONLY && !ipVersion) {
    throw new SsrfBlockedError('Receiver target must be a literal RFC 1918 IPv4 or ULA IPv6 address');
  }

  if (ipVersion) {
    if (isLinkLocalIpv6(rawHost)) {
      throw new SsrfBlockedError('Literal IPv6 link-local targets are not allowed');
    }
    validateIpForPolicy(rawHost, policy, {
      port,
      selfPort: options.selfPort,
      allowLoopback,
    });
  } else if (isSyntacticLoopbackHost(rawHost)) {
    if (!allowLoopback) {
      throw new SsrfBlockedError(`Loopback hostname ${rawHost} is not allowed`);
    }
    if (isSelfSsrfTarget('127.0.0.1', port, options.selfPort)) {
      throw new SsrfBlockedError(`Refused self-SSRF target ${rawHost}:${port}`);
    }
  }

  return {
    parsed,
    hostname: rawHost,
    port,
    isLiteralIp: Boolean(ipVersion),
    isLoopbackOrigin: (Boolean(ipVersion) && isLoopbackIp(rawHost)) || isSyntacticLoopbackHost(rawHost),
    allowLoopback,
  };
}

function filterResolvedRecords(records, { policy, port, hostname, allowLoopback = false, selfPort }) {
  const list = Array.isArray(records) ? records : [];
  if (list.length === 0) {
    throw new SsrfBlockedError(`DNS returned no records for ${hostname}`);
  }

  // Step 1: strip fe80::/10 from multi-record answers; fail closed if empty
  const nonLinkLocal = list.filter((rec) => rec && rec.address && !isLinkLocalIpv6(rec.address));
  if (nonLinkLocal.length === 0) {
    throw new SsrfBlockedError(`DNS returned only link-local addresses for ${hostname}`);
  }

  // Step 2: fail closed immediately if ANY remaining record is universally prohibited or self-SSRF
  for (const rec of nonLinkLocal) {
    if (port !== undefined && isSelfSsrfTarget(rec.address, port, selfPort)) {
      throw new SsrfBlockedError(`Resolved self-SSRF target ${rec.address}:${port}`);
    }
    if (isLoopbackIp(rec.address)) {
      if (!(policy === POLICY_PUBLIC_OR_LAN && allowLoopback)) {
        throw new SsrfBlockedError(`Resolved loopback target ${rec.address} blocked under ${policy}`);
      }
      continue;
    }
    if (isUniversallyProhibitedIp(rec.address)) {
      throw new SsrfBlockedError(`Resolved prohibited IP ${rec.address} for ${hostname}`);
    }
  }

  // Step 3: .local / mDNS filtering under PRIVATE_LAN_ONLY; strict policy check otherwise
  const isMdns = normalizeHostForMatch(hostname).endsWith('.local');
  if (policy === POLICY_PRIVATE_LAN_ONLY && isMdns) {
    const lanOnly = nonLinkLocal.filter((rec) => isPrivateOrLanIp(rec.address, { allowCgnat: true }));
    if (lanOnly.length === 0) {
      throw new SsrfBlockedError(`mDNS host ${hostname} resolved no private LAN addresses`);
    }
    return lanOnly;
  }

  for (const rec of nonLinkLocal) {
    validateIpForPolicy(rec.address, policy, { port, selfPort, allowLoopback });
  }
  return nonLinkLocal;
}

function createPinnedLookup({
  policy = POLICY_PUBLIC_OR_LAN,
  port,
  hostname,
  allowLoopback = false,
  selfPort,
  dnsLookup = dns.lookup,
} = {}) {
  return function pinnedLookup(lookupHost, optionsOrCallback, maybeCallback) {
    const opts = typeof optionsOrCallback === 'function' ? {} : (optionsOrCallback || {});
    const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    const effectiveHostname = hostname || lookupHost;

    const cleanLookup = stripBrackets(lookupHost);
    if (net.isIP(cleanLookup)) {
      try {
        validateIpForPolicy(cleanLookup, policy, { port, selfPort, allowLoopback });
        const family = net.isIPv6(cleanLookup) ? 6 : 4;
        if (opts.all) {
          cb(null, [{ address: cleanLookup, family }]);
        } else {
          cb(null, cleanLookup, family);
        }
      } catch (err) {
        cb(err);
      }
      return;
    }

    dnsLookup(cleanLookup, { all: true, verbatim: true }, (err, addresses) => {
      if (err) {
        cb(err);
        return;
      }
      try {
        const filtered = filterResolvedRecords(addresses, {
          policy,
          port,
          hostname: effectiveHostname,
          allowLoopback,
          selfPort,
        });
        if (opts.all) {
          cb(null, filtered);
        } else {
          cb(null, filtered[0].address, filtered[0].family);
        }
      } catch (validationError) {
        cb(validationError);
      }
    });
  };
}

function validateLanHost(rawHost, options = {}) {
  const input = String(rawHost || '').trim();
  if (!input) {
    return Promise.reject(new SsrfBlockedError('Host is required'));
  }
  if (/[\r\n\0\s/\\;]/.test(input) || input.startsWith('-') || input.includes('%')) {
    return Promise.reject(new SsrfBlockedError(`Unsafe LAN host syntax: ${input}`));
  }
  const clean = stripBrackets(input);
  if (!clean || clean.startsWith('-') || clean.includes('%')) {
    return Promise.reject(new SsrfBlockedError(`Unsafe LAN host syntax: ${input}`));
  }
  if (isNonCanonicalIpv4Host(clean)) {
    return Promise.reject(new SsrfBlockedError(`Non-canonical IPv4 host rejected: ${clean}`));
  }
  if (isSyntacticLoopbackHost(clean)) {
    return Promise.reject(new SsrfBlockedError(`Loopback host rejected: ${clean}`));
  }

  const ipVersion = net.isIP(clean);
  if (ipVersion) {
    try {
      if (isLinkLocalIpv6(clean)) {
        throw new SsrfBlockedError('Link-local IPv6 host rejected');
      }
      validateIpForPolicy(clean, POLICY_PRIVATE_LAN_ONLY, {
        port: options.port,
        selfPort: options.selfPort,
        allowLoopback: false,
      });
      return Promise.resolve({
        address: clean,
        family: ipVersion,
        isLiteral: true,
        hostname: clean,
      });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  const dnsLookup = options.dnsLookup || dns.lookup;
  return new Promise((resolve, reject) => {
    dnsLookup(clean, { all: true, verbatim: true }, (err, records) => {
      if (err) {
        reject(err);
        return;
      }
      try {
        const filtered = filterResolvedRecords(records, {
          policy: POLICY_PRIVATE_LAN_ONLY,
          port: options.port,
          hostname: clean,
          allowLoopback: false,
          selfPort: options.selfPort,
        });
        // Prefer IPv4 when both IPv4 and ULA IPv6 exist for SMB/NFS compatibility
        const preferred = filtered.find((r) => r.family === 4) || filtered[0];
        resolve({
          address: preferred.address,
          family: preferred.family,
          isLiteral: false,
          hostname: clean,
        });
      } catch (validationError) {
        reject(validationError);
      }
    });
  });
}

function isSameOrigin(a, b) {
  return (
    a.protocol === b.protocol &&
    normalizeHostForMatch(a.hostname) === normalizeHostForMatch(b.hostname) &&
    effectivePortForUrl(a) === effectivePortForUrl(b)
  );
}

function isSameHostDefaultPortHttpsUpgrade(current, next) {
  return (
    current.protocol === 'http:' &&
    next.protocol === 'https:' &&
    normalizeHostForMatch(current.hostname) === normalizeHostForMatch(next.hostname) &&
    effectivePortForUrl(current) === 80 &&
    effectivePortForUrl(next) === 443
  );
}

function normalizeHeadersObject(headers) {
  const out = {};
  if (!headers) return out;
  if (typeof headers.forEach === 'function') {
    headers.forEach((value, key) => {
      out[String(key).toLowerCase()] = String(value);
    });
  } else if (typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined && value !== null) {
        out[String(key).toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
      }
    }
  }
  return out;
}

function materializeBody(body) {
  if (body === undefined || body === null) return null;
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  return Buffer.from(String(body), 'utf8');
}

function createResponseHeaders(rawHeaders) {
  const map = new Map();
  for (const [k, v] of Object.entries(rawHeaders || {})) {
    map.set(k.toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v));
  }
  return {
    get(name) {
      return map.get(String(name || '').toLowerCase()) ?? null;
    },
    has(name) {
      return map.has(String(name || '').toLowerCase());
    },
    entries() {
      return map.entries();
    },
    forEach(fn) {
      map.forEach((v, k) => fn(v, k));
    },
    [Symbol.iterator]() {
      return map.entries();
    },
  };
}

function executeSingleRequest({
  validated,
  method,
  headers,
  bodyBuffer,
  policy,
  selfPort,
  maxResponseBytes,
  signal,
  dnsLookup,
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const abortErr = new Error('The operation was aborted');
      abortErr.name = 'AbortError';
      reject(abortErr);
      return;
    }

    const { parsed, hostname, port, isLiteralIp, allowLoopback } = validated;
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const reqHeaders = { ...headers, 'accept-encoding': 'identity' };
    if (bodyBuffer !== null) {
      reqHeaders['content-length'] = String(bodyBuffer.length);
      delete reqHeaders['transfer-encoding'];
    } else if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      reqHeaders['content-length'] = '0';
      delete reqHeaders['transfer-encoding'];
    }

    const reqOptions = {
      protocol: parsed.protocol,
      hostname,
      port,
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers: reqHeaders,
      agent: false,
      lookup: createPinnedLookup({
        policy,
        port,
        hostname,
        allowLoopback,
        selfPort,
        dnsLookup,
      }),
    };
    if (isHttps) {
      reqOptions.servername = isLiteralIp ? undefined : hostname;
    }

    let settled = false;
    let activeRes = null;

    const cleanupSignal = () => {
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanupSignal();
      reject(err);
    };

    const succeed = (resObj) => {
      if (settled) return;
      settled = true;
      cleanupSignal();
      resolve(resObj);
    };

    const req = transport.request(reqOptions, (res) => {
      activeRes = res;
      const chunks = [];
      let totalBytes = 0;

      res.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > maxResponseBytes) {
          const err = new Error(`Response body exceeded limit of ${maxResponseBytes} bytes`);
          err.code = 'response_too_large';
          err.status = 502;
          res.destroy();
          req.destroy();
          fail(err);
          return;
        }
        chunks.push(chunk);
      });

      res.on('error', (err) => {
        fail(err);
      });

      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const status = res.statusCode || 0;
        const headersObj = createResponseHeaders(res.headers);
        succeed({
          ok: status >= 200 && status < 300,
          status,
          statusText: res.statusMessage || '',
          url: parsed.toString(),
          headers: headersObj,
          rawHeaders: res.headers,
          buffer: async () => buffer,
          arrayBuffer: async () =>
            buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
          text: async () => buffer.toString('utf8'),
          json: async () => JSON.parse(buffer.toString('utf8')),
        });
      });
    });

    const onAbort = () => {
      const abortErr = new Error('The operation was aborted');
      abortErr.name = 'AbortError';
      if (activeRes) activeRes.destroy();
      req.destroy();
      fail(abortErr);
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    req.on('error', (err) => {
      fail(err);
    });

    if (bodyBuffer !== null && bodyBuffer.length > 0) {
      req.write(bodyBuffer);
    }
    req.end();
  });
}

async function safeFetch(rawUrl, options = {}) {
  const policy = options.policy || POLICY_PUBLIC_OR_LAN;
  const maxRedirects =
    options.redirect === 'error'
      ? 0
      : options.maxRedirects !== undefined
        ? Number(options.maxRedirects)
        : policy === POLICY_RECEIVER_LAN_HTTP_ONLY
          ? 0
          : 5;
  const allowCrossOriginRedirects =
    options.allowCrossOriginRedirects !== undefined
      ? Boolean(options.allowCrossOriginRedirects)
      : policy === POLICY_PUBLIC_OR_LAN;
  const maxResponseBytes = Number(options.maxResponseBytes) || 1024 * 1024;
  const selfPort = options.selfPort;
  const dnsLookup = options.dnsLookup || dns.lookup;

  let timeoutController = null;
  let timeoutId = null;
  let effectiveSignal = options.signal || null;

  if (options.timeoutMs && Number(options.timeoutMs) > 0) {
    timeoutController = new AbortController();
    timeoutId = setTimeout(() => timeoutController.abort(), Number(options.timeoutMs));
    if (typeof timeoutId.unref === 'function') timeoutId.unref();
    effectiveSignal = options.signal
      ? AbortSignal.any([options.signal, timeoutController.signal])
      : timeoutController.signal;
  }

  let currentUrl = String(rawUrl || '').trim();
  let currentMethod = String(options.method || 'GET').toUpperCase();
  let currentHeaders = normalizeHeadersObject(options.headers);
  let currentBody = materializeBody(options.body);

  try {
    let currentValidated = validateInitialUrl(currentUrl, policy, {
      allowLoopback: options.allowLoopback,
      legacyLoopbackAllowlist: options.legacyLoopbackAllowlist,
      selfPort,
    });

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const response = await executeSingleRequest({
        validated: currentValidated,
        method: currentMethod,
        headers: currentHeaders,
        bodyBuffer: currentBody,
        policy,
        selfPort,
        maxResponseBytes,
        signal: effectiveSignal,
        dnsLookup,
      });

      const isRedirect = [301, 302, 303, 307, 308].includes(response.status);
      if (!isRedirect) {
        return response;
      }

      if (options.redirect === 'error') {
        throw new SsrfBlockedError(`Redirects are disabled (HTTP ${response.status})`);
      }
      if (maxRedirects === 0) {
        return response;
      }
      if (hop >= maxRedirects) {
        throw new SsrfBlockedError(`Exceeded maximum redirect hops (${maxRedirects})`);
      }

      const location = response.headers.get('location');
      if (!location) {
        return response;
      }

      let nextUrl;
      try {
        nextUrl = new URL(location, currentValidated.parsed).toString();
      } catch (_) {
        throw new SsrfBlockedError('Malformed redirect Location header');
      }

      const nextValidated = validateInitialUrl(nextUrl, policy, {
        allowLoopback: options.allowLoopback,
        legacyLoopbackAllowlist: options.legacyLoopbackAllowlist,
        selfPort,
      });

      // Block https -> http downgrade
      if (currentValidated.parsed.protocol === 'https:' && nextValidated.parsed.protocol === 'http:') {
        throw new SsrfBlockedError('Blocked HTTPS to HTTP redirect downgrade');
      }

      // Block non-loopback -> loopback redirect
      if (!currentValidated.isLoopbackOrigin && nextValidated.isLoopbackOrigin) {
        throw new SsrfBlockedError('Blocked redirect from non-loopback origin to loopback target');
      }

      const sameOrigin = isSameOrigin(currentValidated.parsed, nextValidated.parsed);
      const httpsUpgrade = isSameHostDefaultPortHttpsUpgrade(
        currentValidated.parsed,
        nextValidated.parsed
      );

      if (!sameOrigin && !allowCrossOriginRedirects) {
        throw new SsrfBlockedError('Blocked cross-origin redirect');
      }

      // Rewrite method and drop body on 303 (non-GET/HEAD -> GET) and 301/302 (POST -> GET)
      let methodRewritten = false;
      if (response.status === 303 && currentMethod !== 'GET' && currentMethod !== 'HEAD') {
        currentMethod = 'GET';
        methodRewritten = true;
      } else if ((response.status === 301 || response.status === 302) && currentMethod === 'POST') {
        currentMethod = 'GET';
        methodRewritten = true;
      }

      if (methodRewritten) {
        currentBody = null;
        delete currentHeaders['content-length'];
        delete currentHeaders['content-type'];
        delete currentHeaders['content-encoding'];
        delete currentHeaders['transfer-encoding'];
      }

      // Under PUBLIC_OR_LAN, reject cross-origin 301/302/307/308 with retained body unless same-host default-port HTTPS upgrade
      if (
        !sameOrigin &&
        currentBody !== null &&
        [301, 302, 307, 308].includes(response.status) &&
        !httpsUpgrade
      ) {
        throw new SsrfBlockedError('Blocked cross-origin redirect preserving request body');
      }

      // Strip sensitive headers on origin change except same-host default-port HTTPS upgrade under PUBLIC_OR_LAN
      if (!sameOrigin && !(policy === POLICY_PUBLIC_OR_LAN && httpsUpgrade)) {
        for (const h of SENSITIVE_REDIRECT_HEADERS) {
          delete currentHeaders[h];
        }
      }

      currentValidated = nextValidated;
      currentUrl = nextUrl;
    }

    throw new SsrfBlockedError(`Exceeded maximum redirect hops (${maxRedirects})`);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

module.exports = {
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
  isLinkLocalIpv6,
  isLoopbackIp,
  isUniversallyProhibitedIp,
  isRfc1918Ipv4,
  isCgnatIpv4,
  isUlaIpv6,
  isPrivateOrLanIp,
  isReceiverLanIp,
  isSelfSsrfTarget,
  isInLoopbackAllowlist,
  validateIpForPolicy,
  validateInitialUrl,
  filterResolvedRecords,
  createPinnedLookup,
  validateLanHost,
  isSameOrigin,
  isSameHostDefaultPortHttpsUpgrade,
  safeFetch,
};
