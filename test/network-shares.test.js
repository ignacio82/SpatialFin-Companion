const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildNetworkShareTargetPath,
  buildNfsTarget,
  buildSmbConnectionOptions,
  isPathWithinExport,
  normalizeNetworkShare,
  normalizeNfsExportPath,
  normalizeShareRelativePath,
  validateNetworkShareForTest
} = require('../network-shares');

test('normalizeNetworkShare extracts host, share, path, and port from smb URL input', () => {
  const result = normalizeNetworkShare({
    protocol: 'smb',
    host: 'smb://192.168.1.50:1445/media/movies/anime',
    username: 'ignacio'
  });

  assert.equal(result.host, '192.168.1.50');
  assert.equal(result.port, 1445);
  assert.equal(result.shareName, 'media');
  assert.equal(result.path, 'movies\\anime');
  assert.equal(result.username, 'ignacio');
});

test('normalizeNetworkShare extracts share and path from UNC input', () => {
  const result = normalizeNetworkShare({
    protocol: 'smb',
    shareName: '\\\\nas\\library\\Kids\\Movies'
  });

  assert.equal(result.host, 'nas');
  assert.equal(result.shareName, 'library');
  assert.equal(result.path, 'Kids\\Movies');
});

test('normalizeShareRelativePath collapses separators and trims edges', () => {
  assert.equal(normalizeShareRelativePath('/Movies//Anime/'), 'Movies\\Anime');
  assert.equal(normalizeShareRelativePath('\\\\Shows\\\\Sci-Fi\\\\'), 'Shows\\Sci-Fi');
});

test('normalizeNetworkShare extracts host and export path from nfs URL input', () => {
  const result = normalizeNetworkShare({
    protocol: 'nfs',
    host: 'nfs://192.168.1.60/media/library',
    path: '/Kids/Movies/'
  });

  assert.equal(result.host, '192.168.1.60');
  assert.equal(result.shareName, '/media/library');
  assert.equal(result.path, 'Kids/Movies');
});

test('normalizeNetworkShare extracts host and export path from host:path nfs input', () => {
  const result = normalizeNetworkShare({
    protocol: 'nfs',
    host: 'nas:/srv/exports/media'
  });

  assert.equal(result.host, 'nas');
  assert.equal(result.shareName, '/srv/exports/media');
});

test('validateNetworkShareForTest rejects incomplete smb shares', () => {
  const result = validateNetworkShareForTest({
    protocol: 'smb',
    host: '192.168.1.10'
  });

  assert.equal(result.ok, false);
  assert.match(result.issues.join(' '), /Share Name is required/i);
});

test('validateNetworkShareForTest rejects incomplete nfs shares', () => {
  const result = validateNetworkShareForTest({
    protocol: 'nfs',
    host: '192.168.1.20'
  });

  assert.equal(result.ok, false);
  assert.match(result.issues.join(' '), /Export Path is required/i);
});

test('buildSmbConnectionOptions formats an smb2 client config', () => {
  const options = buildSmbConnectionOptions({
    host: '192.168.1.10',
    shareName: 'media',
    username: 'guest',
    password: '',
    domain: '',
    port: 1445
  });

  assert.equal(options.share, '\\\\192.168.1.10\\media');
  assert.equal(options.port, 1445);
  assert.equal(options.username, 'guest');
});

test('buildNfsTarget formats an nfs mount target', () => {
  assert.equal(buildNfsTarget({
    host: '192.168.1.20',
    shareName: '/srv/media'
  }), '192.168.1.20:/srv/media');
});

test('buildNetworkShareTargetPath formats the nfs export and subpath', () => {
  assert.equal(buildNetworkShareTargetPath({
    protocol: 'nfs',
    host: '192.168.1.20',
    shareName: '/srv/media',
    path: 'Kids/Movies'
  }), '/srv/media/Kids/Movies');
});

test('normalizeNfsExportPath preserves root exports and trims separators', () => {
  assert.equal(normalizeNfsExportPath('/srv//media/'), '/srv/media');
  assert.equal(normalizeNfsExportPath('/', { allowRoot: true }), '/');
});

test('isPathWithinExport matches exact and nested exports', () => {
  assert.equal(isPathWithinExport('/srv/media', '/srv/media'), true);
  assert.equal(isPathWithinExport('/srv/media/movies', '/srv/media'), true);
  assert.equal(isPathWithinExport('/srv/other', '/srv/media'), false);
});

test('isPathWithinExport rejects traversal segments', () => {
  assert.equal(isPathWithinExport('/srv/media/../etc', '/srv/media'), false);
  assert.equal(isPathWithinExport('/srv/..', '/srv'), false);
  assert.equal(isPathWithinExport('/srv/media/../../secret', '/srv/media'), false);
});
