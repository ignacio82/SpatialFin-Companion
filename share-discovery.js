const { isPrivateIpv4 } = require('./tv-pairing');

function extractHostFromAuthority(authority) {
  const value = String(authority || '')
    .split(',')
    .map((part) => part.trim())
    .find(Boolean) || '';

  if (!value) return '';
  if (value.startsWith('[')) {
    const endIndex = value.indexOf(']');
    return endIndex >= 0 ? value.slice(1, endIndex) : value.slice(1);
  }

  const colonCount = (value.match(/:/g) || []).length;
  if (colonCount === 1) {
    return value.split(':')[0].trim();
  }
  return value.trim();
}

function collectPrivateIpv4SeedAddresses(networkInterfaces, extraHosts = []) {
  const seen = new Set();
  const seeds = [];
  const interfaces = networkInterfaces && typeof networkInterfaces === 'object' ? networkInterfaces : {};

  Object.keys(interfaces).forEach((name) => {
    (interfaces[name] || []).forEach((iface) => {
      if (!iface || iface.internal || iface.family !== 'IPv4' || !isPrivateIpv4(iface.address)) return;
      if (seen.has(iface.address)) return;
      seen.add(iface.address);
      seeds.push(iface.address);
    });
  });

  extraHosts.forEach((host) => {
    const normalized = String(host || '').trim();
    if (!normalized || !isPrivateIpv4(normalized) || seen.has(normalized)) return;
    seen.add(normalized);
    seeds.push(normalized);
  });

  return seeds.sort(compareIpv4);
}

function buildPrivateIpv4DiscoveryTargets(networkInterfaces, extraHosts = []) {
  const seeds = collectPrivateIpv4SeedAddresses(networkInterfaces, extraHosts);
  const seen = new Set();
  const targets = [];

  seeds.forEach((seed) => {
    const parts = seed.split('.');
    if (parts.length !== 4) return;
    const prefix = `${parts[0]}.${parts[1]}.${parts[2]}.`;
    for (let host = 1; host <= 254; host += 1) {
      const ip = `${prefix}${host}`;
      if (seen.has(ip)) continue;
      seen.add(ip);
      targets.push(ip);
    }
  });

  return targets.sort(compareIpv4);
}

function describePrivateIpv4Subnets(networkInterfaces, extraHosts = []) {
  const seen = new Set();
  return collectPrivateIpv4SeedAddresses(networkInterfaces, extraHosts)
    .map((address) => `${address.split('.').slice(0, 3).join('.')}.*`)
    .filter((subnet) => {
      if (seen.has(subnet)) return false;
      seen.add(subnet);
      return true;
    });
}

function parseSmbClientShareList(stdout) {
  const seen = new Set();
  const shares = [];

  String(stdout || '')
    .split(/\r?\n/)
    .forEach((line) => {
      const parts = line.split('|').map((part) => part.trim());
      if (parts.length < 2) return;
      if (!/^Disk$/i.test(parts[0])) return;

      const name = parts[1];
      if (!name) return;

      const key = name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);

      shares.push({
        name,
        description: parts.slice(2).join(' | ').trim() || null
      });
    });

  return shares.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
}

function sortAndDedupeDiscoveryResults(results) {
  const seen = new Set();
  const items = [];

  (Array.isArray(results) ? results : []).forEach((item) => {
    if (!item || !item.protocol || !item.host) return;
    const normalized = {
      protocol: String(item.protocol).toLowerCase() === 'nfs' ? 'nfs' : 'smb',
      kind: String(item.kind || '').toLowerCase() === 'share' ? 'share' : 'server',
      host: String(item.host || '').trim(),
      shareName: item.shareName ? String(item.shareName).trim() : '',
      label: item.label ? String(item.label).trim() : '',
      description: item.description ? String(item.description).trim() : ''
    };

    if (!normalized.host) return;
    const key = [
      normalized.protocol,
      normalized.kind,
      normalized.host.toLowerCase(),
      normalized.shareName.toLowerCase()
    ].join(':');
    if (seen.has(key)) return;
    seen.add(key);
    items.push(normalized);
  });

  return items.sort((left, right) => {
    if (left.protocol !== right.protocol) return left.protocol.localeCompare(right.protocol);
    if (left.kind !== right.kind) return left.kind === 'share' ? -1 : 1;
    const hostCompare = compareIpv4(left.host, right.host);
    if (hostCompare !== 0) return hostCompare;
    return (left.shareName || left.label).localeCompare(right.shareName || right.label, undefined, { sensitivity: 'base' });
  });
}

function compareIpv4(left, right) {
  const leftParts = String(left || '').split('.').map(Number);
  const rightParts = String(right || '').split('.').map(Number);
  const maxLength = Math.max(leftParts.length, rightParts.length, 4);

  for (let index = 0; index < maxLength; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

module.exports = {
  buildPrivateIpv4DiscoveryTargets,
  collectPrivateIpv4SeedAddresses,
  describePrivateIpv4Subnets,
  extractHostFromAuthority,
  parseSmbClientShareList,
  sortAndDedupeDiscoveryResults
};
