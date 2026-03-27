const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPrivateIpv4DiscoveryTargets,
  collectPrivateIpv4SeedAddresses,
  describePrivateIpv4Subnets,
  extractHostFromAuthority,
  parseSmbClientShareList,
  sortAndDedupeDiscoveryResults
} = require('../share-discovery');

test('extractHostFromAuthority handles host headers and forwarded hosts', () => {
  assert.equal(extractHostFromAuthority('192.168.1.92:1982'), '192.168.1.92');
  assert.equal(extractHostFromAuthority('companion.local:1982'), 'companion.local');
  assert.equal(extractHostFromAuthority('192.168.1.92:1982, 10.0.0.2:1982'), '192.168.1.92');
  assert.equal(extractHostFromAuthority('[fe80::1]:1982'), 'fe80::1');
});

test('collectPrivateIpv4SeedAddresses merges interface and request-host seeds', () => {
  const seeds = collectPrivateIpv4SeedAddresses({
    eth0: [
      { family: 'IPv4', address: '172.17.0.2', internal: false },
      { family: 'IPv4', address: '192.168.1.92', internal: false }
    ],
    lo: [
      { family: 'IPv4', address: '127.0.0.1', internal: true }
    ]
  }, ['192.168.1.50']);

  assert.deepEqual(seeds, ['172.17.0.2', '192.168.1.50', '192.168.1.92']);
});

test('buildPrivateIpv4DiscoveryTargets expands each discovered subnet once', () => {
  const targets = buildPrivateIpv4DiscoveryTargets({
    eth0: [
      { family: 'IPv4', address: '192.168.1.92', internal: false }
    ]
  }, ['192.168.1.50']);

  assert.equal(targets[0], '192.168.1.1');
  assert.equal(targets[targets.length - 1], '192.168.1.254');
  assert.equal(targets.length, 254);
});

test('describePrivateIpv4Subnets lists the unique scanned /24 ranges', () => {
  const subnets = describePrivateIpv4Subnets({
    eth0: [
      { family: 'IPv4', address: '172.17.0.2', internal: false },
      { family: 'IPv4', address: '192.168.1.92', internal: false }
    ]
  }, ['192.168.1.50']);

  assert.deepEqual(subnets, ['172.17.0.*', '192.168.1.*']);
});

test('parseSmbClientShareList keeps Disk shares and discards IPC entries', () => {
  const stdout = [
    'Disk|Media|Primary media library',
    'IPC|IPC$|IPC Service (Samba 4.18.0)',
    'Disk|Backups|Nightly backups',
    'Disk|Media|Duplicate entry'
  ].join('\n');

  assert.deepEqual(parseSmbClientShareList(stdout), [
    { name: 'Backups', description: 'Nightly backups' },
    { name: 'Media', description: 'Primary media library' }
  ]);
});

test('sortAndDedupeDiscoveryResults prefers stable ordering and removes duplicates', () => {
  const results = sortAndDedupeDiscoveryResults([
    { protocol: 'smb', kind: 'server', host: '192.168.1.92', label: '192.168.1.92' },
    { protocol: 'nfs', kind: 'share', host: '192.168.1.20', shareName: '/srv/media', label: '/srv/media' },
    { protocol: 'smb', kind: 'server', host: '192.168.1.92', label: 'duplicate' },
    { protocol: 'nfs', kind: 'server', host: '192.168.1.10', label: '192.168.1.10' }
  ]);

  assert.deepEqual(results, [
    {
      protocol: 'nfs',
      kind: 'share',
      host: '192.168.1.20',
      shareName: '/srv/media',
      label: '/srv/media',
      description: ''
    },
    {
      protocol: 'nfs',
      kind: 'server',
      host: '192.168.1.10',
      shareName: '',
      label: '192.168.1.10',
      description: ''
    },
    {
      protocol: 'smb',
      kind: 'server',
      host: '192.168.1.92',
      shareName: '',
      label: '192.168.1.92',
      description: ''
    }
  ]);
});
