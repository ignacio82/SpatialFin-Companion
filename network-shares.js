function trimText(value, maxLength = 1024) {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, maxLength);
}

function parsePort(value) {
  if (value === null || value === undefined || value === '') return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

function parseHostPort(value) {
  const raw = trimText(value, 512);
  if (!raw || raw.startsWith('[')) {
    return { host: raw, port: null };
  }
  const match = raw.match(/^([^:]+):(\d+)$/);
  if (!match) {
    return { host: raw, port: null };
  }
  return {
    host: match[1],
    port: parsePort(match[2])
  };
}

function normalizeShareRelativePath(value) {
  return trimText(value, 1024)
    .replace(/[\\/]+/g, '\\')
    .replace(/^\\+|\\+$/g, '');
}

function normalizeNfsExportPath(value, options = {}) {
  const raw = trimText(value, 1024).replace(/\\/g, '/');
  const collapsed = raw.replace(/\/+/g, '/');
  const trimmed = collapsed.replace(/^\/+|\/+$/g, '');
  if (!trimmed) {
    return options.allowRoot && /\/+/.test(collapsed) ? '/' : '';
  }
  return `/${trimmed}`;
}

function normalizeNfsRelativePath(value) {
  return trimText(value, 1024)
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

function parseSmbReference(value) {
  const raw = trimText(value, 1024);
  if (!raw) return null;

  const normalized = raw.replace(/\\/g, '/');
  if (/^(smb|cifs):\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized);
      const parts = url.pathname.split('/').filter(Boolean);
      return {
        host: url.hostname || '',
        port: parsePort(url.port),
        shareName: parts[0] || '',
        path: parts.slice(1).join('\\')
      };
    } catch (_) {
      return null;
    }
  }

  if (normalized.startsWith('//')) {
    const parts = normalized.split('/').filter(Boolean);
    return {
      host: parts[0] || '',
      port: null,
      shareName: parts[1] || '',
      path: parts.slice(2).join('\\')
    };
  }

  return null;
}

function parseNfsReference(value) {
  const raw = trimText(value, 1024);
  if (!raw) return null;

  const normalized = raw.replace(/\\/g, '/');
  if (/^nfs:\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized);
      return {
        host: url.hostname || '',
        port: parsePort(url.port),
        shareName: normalizeNfsExportPath(url.pathname, { allowRoot: true })
      };
    } catch (_) {
      return null;
    }
  }

  const ipv6Match = normalized.match(/^\[([^\]]+)\]:(\/.*)$/);
  if (ipv6Match) {
    return {
      host: ipv6Match[1],
      port: null,
      shareName: normalizeNfsExportPath(ipv6Match[2], { allowRoot: true })
    };
  }

  const match = normalized.match(/^([^:]+):(\/.*)$/);
  if (match) {
    return {
      host: match[1],
      port: null,
      shareName: normalizeNfsExportPath(match[2], { allowRoot: true })
    };
  }

  return null;
}

function splitShareNameAndPath(value) {
  const raw = trimText(value, 512);
  if (!raw || !/[\\/]/.test(raw)) return null;
  const parts = raw.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length === 0) return null;
  return {
    shareName: parts[0] || '',
    path: parts.slice(1).join('\\')
  };
}

function normalizeSmbShare(input = {}) {
  const normalized = {
    ...input,
    protocol: 'smb',
    host: trimText(input.host, 512),
    shareName: trimText(input.shareName, 512),
    path: trimText(input.path, 1024),
    username: trimText(input.username, 255),
    password: trimText(input.password, 255),
    domain: trimText(input.domain, 255),
    port: parsePort(input.port)
  };

  const hostReference = parseSmbReference(normalized.host);
  const shareReference = parseSmbReference(normalized.shareName);

  if (hostReference) {
    normalized.host = hostReference.host || normalized.host;
    if (hostReference.port && !normalized.port) normalized.port = hostReference.port;
    if (hostReference.shareName && !normalized.shareName) normalized.shareName = hostReference.shareName;
    if (hostReference.path && !normalized.path) normalized.path = hostReference.path;
  }

  if (shareReference) {
    normalized.host = shareReference.host || normalized.host;
    if (shareReference.port && !normalized.port) normalized.port = shareReference.port;
    normalized.shareName = shareReference.shareName || normalized.shareName;
    if (shareReference.path && !normalized.path) normalized.path = shareReference.path;
  }

  if (!hostReference && !normalized.shareName && /[\\/]/.test(normalized.host)) {
    const hostParts = normalized.host.replace(/\\/g, '/').split('/').filter(Boolean);
    if (hostParts.length > 1) {
      normalized.host = hostParts[0] || normalized.host;
      normalized.shareName = hostParts[1] || '';
      if (!normalized.path && hostParts.length > 2) {
        normalized.path = hostParts.slice(2).join('\\');
      }
    }
  }

  if (!shareReference) {
    const shareParts = splitShareNameAndPath(normalized.shareName);
    if (shareParts) {
      normalized.shareName = shareParts.shareName;
      if (!normalized.path && shareParts.path) {
        normalized.path = shareParts.path;
      }
    }
  }

  const parsedHost = parseHostPort(normalized.host);
  normalized.host = parsedHost.host;
  if (parsedHost.port && !normalized.port) normalized.port = parsedHost.port;
  normalized.path = normalizeShareRelativePath(normalized.path);

  return normalized;
}

function normalizeNfsShare(input = {}) {
  const normalized = {
    ...input,
    protocol: 'nfs',
    host: trimText(input.host, 512),
    shareName: trimText(input.shareName, 1024),
    path: trimText(input.path, 1024),
    username: '',
    password: '',
    domain: '',
    port: parsePort(input.port)
  };

  const hostReference = parseNfsReference(normalized.host);
  const shareReference = parseNfsReference(normalized.shareName);

  if (hostReference) {
    normalized.host = hostReference.host || normalized.host;
    if (hostReference.port && !normalized.port) normalized.port = hostReference.port;
    if (hostReference.shareName && !normalized.shareName) normalized.shareName = hostReference.shareName;
  }

  if (shareReference) {
    normalized.host = shareReference.host || normalized.host;
    if (shareReference.port && !normalized.port) normalized.port = shareReference.port;
    normalized.shareName = shareReference.shareName || normalized.shareName;
  }

  const parsedHost = parseHostPort(normalized.host);
  normalized.host = parsedHost.host;
  if (parsedHost.port && !normalized.port) normalized.port = parsedHost.port;
  normalized.shareName = normalizeNfsExportPath(normalized.shareName, { allowRoot: true });
  normalized.path = normalizeNfsRelativePath(normalized.path);

  return normalized;
}

function normalizeNetworkShare(input = {}) {
  const protocol = trimText(input.protocol || 'smb', 16).toLowerCase() === 'nfs' ? 'nfs' : 'smb';
  return protocol === 'nfs' ? normalizeNfsShare(input) : normalizeSmbShare(input);
}

function validateNetworkShareForTest(input = {}) {
  const share = normalizeNetworkShare(input);
  const issues = [];

  if (!share.host) {
    issues.push('Host / IP is required.');
  }
  if (!share.shareName) {
    issues.push(share.protocol === 'nfs' ? 'Export Path is required.' : 'Share Name is required.');
  }
  if (input.port !== undefined && input.port !== null && input.port !== '' && share.port === null) {
    issues.push('Port must be between 1 and 65535.');
  }

  return {
    ok: issues.length === 0,
    share,
    issues
  };
}

function buildSmbConnectionOptions(share) {
  return {
    share: `\\\\${share.host}\\${share.shareName}`,
    domain: share.domain || '',
    username: share.username || '',
    password: share.password || '',
    port: share.port || 445,
    autoCloseTimeout: 2000
  };
}

function buildNfsTarget(share) {
  return `${share.host}:${normalizeNfsExportPath(share.shareName, { allowRoot: true }) || '/'}`;
}

function buildNetworkShareTargetPath(share) {
  const normalized = normalizeNetworkShare(share);
  if (normalized.protocol === 'nfs') {
    const exportPath = normalizeNfsExportPath(normalized.shareName, { allowRoot: true }) || '/';
    const subpath = normalizeNfsRelativePath(normalized.path);
    return subpath ? `${exportPath}/${subpath}` : exportPath;
  }
  const base = normalized.shareName || '';
  const subpath = normalizeShareRelativePath(normalized.path);
  return subpath ? `${base}\\${subpath}` : base;
}

function isPathWithinExport(requestedPath, exportPath) {
  const requested = normalizeNfsExportPath(requestedPath, { allowRoot: true });
  const exported = normalizeNfsExportPath(exportPath, { allowRoot: true });
  if (!requested || !exported) return false;
  // Reject traversal segments to keep path semantics well-defined for clients
  // (SMB/NFS servers vary in whether they collapse '..').
  if (requested.split('/').some((segment) => segment === '..')) return false;
  if (exported === '/') return requested.startsWith('/');
  return requested === exported || requested.startsWith(`${exported}/`);
}

module.exports = {
  buildNetworkShareTargetPath,
  buildNfsTarget,
  buildSmbConnectionOptions,
  isPathWithinExport,
  normalizeNetworkShare,
  normalizeNfsExportPath,
  normalizeNfsRelativePath,
  normalizeShareRelativePath,
  validateNetworkShareForTest
};
