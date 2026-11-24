'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStorage } = require('../storage');
const { createCompanionApp } = require('../index');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sf-comp-broker-'));
}

async function startMockJellyfin(handler) {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c.toString('utf8'); });
    req.on('end', () => handler(req, res, body));
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => srv.close(resolve)),
  };
}

async function startTestApp(seedConfig) {
  const dir = createTempDir();
  const storage = createStorage({ rootDir: dir, defaultPreferences: {} });
  storage.saveConfig(storage.normalizeConfig(seedConfig), { reason: 'test-seed' });
  const instance = createCompanionApp({
    storage,
    rootDir: dir,
    port: 0,
    enableMdns: false,
    enableBackgroundTasks: false,
    enableUpdater: false,
    allowLoopbackUpstreams: true,
  });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const { port } = instance.server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    setupToken: instance.getConfig().setup_token,
    instance,
    storage,
    async close() {
      await instance.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('POST /api/v1/auth/authorize-quick-connect enforces requireSetupTokenOnly, openCors, exact UUID match, and error precedence', async () => {
  let authorizeMode = 'ok';
  const jf = await startMockJellyfin((req, res) => {
    if (req.url === '/System/Info/Public') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ Id: '11111111-2222-3333-4444-555566667777', ServerName: 'JF' }));
      return;
    }
    if (req.url === '/QuickConnect/Enabled') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(authorizeMode !== 'qc_disabled'));
      return;
    }
    if (req.url.startsWith('/QuickConnect/Authorize')) {
      if (authorizeMode === 'ok') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('true');
        return;
      }
      if (authorizeMode === 'false') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('false');
        return;
      }
      if (authorizeMode === 'qc_disabled' || authorizeMode === 'bad_token') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }
    res.writeHead(404);
    res.end();
  });

  const app = await startTestApp({
    servers: [
      {
        id: '11111111-2222-3333-4444-555566667777',
        legacy_ids: ['srv-old-1'],
        name: 'JF',
        addresses: [jf.url],
        users: [
          { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', username: 'Alice', access_token: 'tok-alice' },
          { id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff', username: 'Bob', access_token: '' },
        ],
      },
    ],
  });

  try {
    // 1. OPTIONS preflight succeeds via openCors with PNA header
    const preflight = await fetch(`${app.baseUrl}/api/v1/auth/authorize-quick-connect`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://webxr.example.com', 'Access-Control-Request-Private-Network': 'true' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');

    // 2. Missing X-Setup-Token fails 401 even from loopback (no loopback/cookie fallback!)
    const noTok = await fetch(`${app.baseUrl}/api/v1/auth/authorize-quick-connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: 'srv-old-1', userId: 'aaaaaaaabbbbccccddddeeeeeeeeeeee', code: '123456' }),
    });
    assert.equal(noTok.status, 401);
    assert.equal((await noTok.json()).error_code, 'invalid_credentials');

    // 3. Valid token + legacy_ids server match + hyphenless UUID succeeds
    const ok = await fetch(`${app.baseUrl}/api/v1/auth/authorize-quick-connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Setup-Token': app.setupToken },
      body: JSON.stringify({ serverId: 'srv-old-1', userId: 'aaaaaaaabbbbccccddddeeeeeeeeeeee', code: '123 456' }),
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await ok.json(), { authorized: true });

    // 4. Unknown userId returns 404 user_not_found (no candidates[0] fallback!)
    const badUser = await fetch(`${app.baseUrl}/api/v1/auth/authorize-quick-connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Setup-Token': app.setupToken },
      body: JSON.stringify({ serverId: 'srv-old-1', userId: '00000000000000000000000000000000', code: '123456' }),
    });
    assert.equal(badUser.status, 404);
    assert.equal((await badUser.json()).error_code, 'user_not_found');

    // 5. Unverified user returns 409 no_verified_user
    const unverified = await fetch(`${app.baseUrl}/api/v1/auth/authorize-quick-connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Setup-Token': app.setupToken },
      body: JSON.stringify({ serverId: 'srv-old-1', userId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff', code: '123456' }),
    });
    assert.equal(unverified.status, 409);
    assert.equal((await unverified.json()).error_code, 'no_verified_user');

    // 6. Upstream 200 false -> 409 qc_authorize_false
    authorizeMode = 'false';
    const rFalse = await fetch(`${app.baseUrl}/api/v1/auth/authorize-quick-connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Setup-Token': app.setupToken },
      body: JSON.stringify({ serverId: 'srv-old-1', userId: 'aaaaaaaabbbbccccddddeeeeeeeeeeee', code: '123456' }),
    });
    assert.equal(rFalse.status, 409);
    assert.equal((await rFalse.json()).error_code, 'qc_authorize_false');

    // 7. Upstream 401 with /QuickConnect/Enabled == false -> 409 qc_disabled (never 401!)
    authorizeMode = 'qc_disabled';
    const rDis = await fetch(`${app.baseUrl}/api/v1/auth/authorize-quick-connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Setup-Token': app.setupToken },
      body: JSON.stringify({ serverId: 'srv-old-1', userId: 'aaaaaaaabbbbccccddddeeeeeeeeeeee', code: '123456' }),
    });
    assert.equal(rDis.status, 409);
    assert.equal((await rDis.json()).error_code, 'qc_disabled');

    // 8. Upstream 401 with /QuickConnect/Enabled == true -> 409 no_verified_user (never 401!)
    authorizeMode = 'bad_token';
    const rBadTok = await fetch(`${app.baseUrl}/api/v1/auth/authorize-quick-connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Setup-Token': app.setupToken },
      body: JSON.stringify({ serverId: 'srv-old-1', userId: 'aaaaaaaabbbbccccddddeeeeeeeeeeee', code: '123456' }),
    });
    assert.equal(rBadTok.status, 409);
    assert.equal((await rBadTok.json()).error_code, 'no_verified_user');

    // 9. GET /api/v1/config with qc_broker_v1 omits access_token; without qc_broker_v1 projects legacy_ids[0]
    const cfgBroker = await fetch(`${app.baseUrl}/api/v1/config`, {
      headers: { 'X-Setup-Token': app.setupToken, 'X-SpatialFin-Capabilities': 'qc_broker_v1' },
    });
    const brokerJson = await cfgBroker.json();
    assert.equal(brokerJson.servers[0].id, '11111111-2222-3333-4444-555566667777');
    assert.equal(brokerJson.servers[0].users[0].access_token, undefined);
    assert.equal(brokerJson.servers[0].users[0].has_verified_token, true);

    const cfgLegacy = await fetch(`${app.baseUrl}/api/v1/config`, {
      headers: { 'X-Setup-Token': app.setupToken },
    });
    const legacyJson = await cfgLegacy.json();
    assert.equal(legacyJson.servers[0].id, 'srv-old-1');
    assert.equal(legacyJson.servers[0].users[0].access_token, 'tok-alice');
  } finally {
    await app.close();
    await jf.close();
  }
});
