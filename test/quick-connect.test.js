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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sf-comp-qc-'));
}

async function startMockJellyfin(handler) {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c.toString('utf8'); });
    req.on('end', () => {
      let json = null;
      if (body) {
        try { json = JSON.parse(body); } catch (_) {}
      }
      handler(req, res, json);
    });
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const addr = srv.address();
  return {
    server: srv,
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((resolve) => srv.close(resolve)),
  };
}

async function startTestApp(seedConfig, extraOpts = {}) {
  const dir = createTempDir();
  const storage = createStorage({ rootDir: dir, defaultPreferences: {} });
  if (seedConfig) {
    storage.saveConfig(storage.normalizeConfig(seedConfig), { reason: 'test-seed' });
  }
  const instance = createCompanionApp({
    storage,
    rootDir: dir,
    port: 0,
    enableMdns: false,
    enableBackgroundTasks: false,
    enableUpdater: false,
    allowLoopbackUpstreams: true,
    ...extraOpts,
  });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const { port } = instance.server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    instance,
    storage,
    async close() {
      await instance.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function adminReq(baseUrl, method, p, body, extraHeaders = {}) {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers: {
      'X-Companion-Admin': '1',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) { data = text; }
  return { status: res.status, data, headers: res.headers };
}

test('Admin Quick Connect initiate, poll, cancel, drain cache, and srv-* canonicalization', async () => {
  let qcAuthenticated = false;
  let lastAuthServerId = '11111111222233334444555566667777';
  const jf = await startMockJellyfin((req, res) => {
    if (req.url === '/System/Info/Public') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ Id: '11111111222233334444555566667777', ServerName: 'Living Room JF', Version: '10.11.0' }));
      return;
    }
    if (req.url === '/QuickConnect/Initiate' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ Code: '123456', Secret: 'sec-abc-1' }));
      return;
    }
    if (req.url.startsWith('/QuickConnect/Connect')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ Authenticated: qcAuthenticated }));
      return;
    }
    if (req.url === '/Users/AuthenticateWithQuickConnect' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        AccessToken: 'tok-linked-qc',
        ServerId: lastAuthServerId,
        User: { Id: 'aaaaaaaabbbbccccddddeeeeeeeeeeee', Name: 'Alice' },
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const app = await startTestApp({
    servers: [
      { id: 'srv-legacy-1', name: 'My Custom Name', addresses: [jf.url], users: [] },
    ],
  });

  try {
    // 1. Initiate QC on srv-* row
    const init = await adminReq(app.baseUrl, 'POST', '/api/admin/quick-connect/initiate', {
      serverId: 'srv-legacy-1',
    });
    assert.equal(init.status, 200);
    assert.equal(init.data.code, '123456');
    assert.match(init.data.pendingId, /^[0-9a-f]{32}$/);

    // 2. Poll while pending
    const p1 = await adminReq(app.baseUrl, 'POST', '/api/admin/quick-connect/poll', {
      pendingId: init.data.pendingId,
    });
    assert.equal(p1.status, 200);
    assert.equal(p1.data.status, 'pending');

    // 3. Approve -> poll commits & canonicalizes srv-legacy-1 -> 11111111..., preserving custom server.name
    qcAuthenticated = true;
    const p2 = await adminReq(app.baseUrl, 'POST', '/api/admin/quick-connect/poll', {
      pendingId: init.data.pendingId,
    });
    assert.equal(p2.status, 200);
    assert.equal(p2.data.status, 'authenticated');
    assert.equal(p2.data.serverId, '11111111222233334444555566667777');
    assert.equal(p2.data.username, 'Alice');
    assert.ok(p2.headers.get('etag'));

    const savedCfg = app.instance.getConfig();
    assert.equal(savedCfg.servers.length, 1);
    assert.equal(savedCfg.servers[0].id, '11111111222233334444555566667777');
    assert.equal(savedCfg.servers[0].name, 'My Custom Name');
    assert.deepEqual(savedCfg.servers[0].legacy_ids, ['srv-legacy-1']);
    assert.equal(savedCfg.servers[0].users[0].access_token, 'tok-linked-qc');
    assert.equal(savedCfg.servers[0].users[0].needs_relink, false);

    // 4. Overlapping poll hits 30 s tokenless drain cache instead of 404
    const p3 = await adminReq(app.baseUrl, 'POST', '/api/admin/quick-connect/poll', {
      pendingId: init.data.pendingId,
    });
    assert.equal(p3.status, 200);
    assert.equal(p3.data.status, 'authenticated');
    assert.equal(p3.data.configVersion, p2.data.configVersion);

    // 5. Cancel is idempotent on unknown pendingId
    const cancel = await adminReq(app.baseUrl, 'POST', '/api/admin/quick-connect/cancel', {
      pendingId: '00000000000000000000000000000000',
    });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.data.cancelled, true);

    // 6. authResult.ServerId mismatch rejects 409 and wipes pending slot
    lastAuthServerId = '99999999999999999999999999999999';
    const init2 = await adminReq(app.baseUrl, 'POST', '/api/admin/quick-connect/initiate', {
      serverId: '11111111222233334444555566667777',
    });
    assert.equal(init2.status, 200);
    const pMismatch = await adminReq(app.baseUrl, 'POST', '/api/admin/quick-connect/poll', {
      pendingId: init2.data.pendingId,
    });
    assert.equal(pMismatch.status, 409);
    assert.equal(pMismatch.data.error_code, 'conflict');
    const pAfterMismatch = await adminReq(app.baseUrl, 'POST', '/api/admin/quick-connect/poll', {
      pendingId: init2.data.pendingId,
    });
    assert.equal(pAfterMismatch.status, 404);
  } finally {
    await app.close();
    await jf.close();
  }
});

test('Admin Quick Connect Predicate 1 address expansion requires confirmation and honors TOCTOU', async () => {
  const jf1 = await startMockJellyfin((req, res) => {
    if (req.url === '/System/Info/Public') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ Id: '22222222333344445555666677778888', ServerName: 'JF Main', Version: '10.11.0' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const jf2 = await startMockJellyfin((req, res) => {
    if (req.url === '/System/Info/Public') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ Id: '22222222333344445555666677778888', ServerName: 'JF Main', Version: '10.11.0' }));
      return;
    }
    if (req.url === '/QuickConnect/Initiate' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ Code: '654321', Secret: 'sec-new-addr' }));
      return;
    }
    if (req.url.startsWith('/QuickConnect/Connect')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ Authenticated: true }));
      return;
    }
    if (req.url === '/Users/AuthenticateWithQuickConnect' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        AccessToken: 'tok-bob',
        ServerId: '22222222333344445555666677778888',
        User: { Id: 'bbbbbbbbccccddddeeeeffffffffffff', Name: 'Bob' },
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const app = await startTestApp({
    servers: [
      {
        id: '22222222333344445555666677778888',
        name: 'JF Main',
        addresses: [jf1.url],
        users: [
          { id: 'aaaaaaaabbbbccccddddeeeeeeeeeeee', username: 'Alice', access_token: 'tok-alice', needs_relink: false },
        ],
      },
    ],
  });

  try {
    // Unsaved serverUrl matching existing server rejects 409
    const unsavedConflict = await adminReq(app.baseUrl, 'POST', '/api/admin/quick-connect/initiate', {
      serverUrl: jf2.url,
    });
    assert.equal(unsavedConflict.status, 409);

    // Explicit { serverId, serverUrl } succeeds
    const init = await adminReq(app.baseUrl, 'POST', '/api/admin/quick-connect/initiate', {
      serverId: '22222222333344445555666677778888',
      serverUrl: jf2.url,
    });
    assert.equal(init.status, 200);

    // Pre-emptive confirmDropUnmatchedSecrets: true is ignored while awaitingConfirmation == null -> 400
    const p1 = await adminReq(app.baseUrl, 'POST', '/api/admin/quick-connect/poll', {
      pendingId: init.data.pendingId,
      confirmDropUnmatchedSecrets: true,
    });
    assert.equal(p1.status, 400);
    assert.equal(p1.data.error_code, 'redacted_secret_mismatch');
    assert.equal(p1.data.unmatchedSecrets.length, 1);

    // Subsequent confirmDropUnmatchedSecrets: true commits, drops Alice's token with needs_relink: true, adds jf2.url and Bob
    const p2 = await adminReq(app.baseUrl, 'POST', '/api/admin/quick-connect/poll', {
      pendingId: init.data.pendingId,
      confirmDropUnmatchedSecrets: true,
    });
    assert.equal(p2.status, 200);
    assert.equal(p2.data.status, 'authenticated');
    assert.ok(Array.isArray(p2.data.droppedSecrets) && p2.data.droppedSecrets.length === 1);

    const cfg = app.instance.getConfig();
    assert.deepEqual(cfg.servers[0].addresses.sort(), [jf1.url, jf2.url].sort());
    const alice = cfg.servers[0].users.find((u) => u.username === 'Alice');
    const bob = cfg.servers[0].users.find((u) => u.username === 'Bob');
    assert.equal(alice.access_token, '');
    assert.equal(alice.needs_relink, true);
    assert.equal(bob.access_token, 'tok-bob');
  } finally {
    await app.close();
    await jf1.close();
    await jf2.close();
  }
});

test('Startup init() canonicalizes safe srv-* rows and skips unsafe Predicate 1 merges', async () => {
  const jfSafe = await startMockJellyfin((req, res) => {
    if (req.url === '/System/Info/Public') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ Id: 'cccccccc111122223333444455556666', ServerName: 'Safe JF', Version: '10.11.0' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const jfUnsafe = await startMockJellyfin((req, res) => {
    if (req.url === '/System/Info/Public') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ Id: 'dddddddd111122223333444455556666', ServerName: 'Unsafe JF', Version: '10.11.0' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const app = await startTestApp({
    servers: [
      { id: 'srv-safe', name: 'Safe Custom', addresses: [jfSafe.url], users: [] },
      {
        id: 'dddddddd111122223333444455556666',
        name: 'Existing Canon',
        addresses: ['http://192.168.1.50:8096'],
        users: [{ id: 'u1', username: 'u1', access_token: 'tok-u1' }],
      },
      { id: 'srv-unsafe', name: 'Shadow', addresses: [jfUnsafe.url], users: [] },
    ],
  });

  try {
    await app.instance.init();
    const cfg = app.instance.getConfig();
    assert.ok(cfg.servers.some((s) => s.id === 'cccccccc111122223333444455556666' && s.name === 'Safe Custom'));
    // Unsafe merge must be skipped (srv-unsafe remains separate so tok-u1 is not exposed to jfUnsafe.url)
    assert.ok(cfg.servers.some((s) => s.id === 'srv-unsafe'));

    // Also check POST /api/v1/analytics/sessions canonicalizes srv-safe -> cccccccc...
    const token = cfg.setup_token;
    const ing = await fetch(`${app.baseUrl}/api/v1/analytics/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Setup-Token': token },
      body: JSON.stringify({
        sessions: [
          {
            playbackSessionId: 'srv-safe:u1:item1',
            serverId: 'srv-safe',
            userId: 'u1',
            username: 'u1',
            itemId: 'item1',
            itemName: 'Test',
          },
        ],
      }),
    });
    assert.equal(ing.status, 200);
    const sessions = app.storage.getAnalyticsOverview();
    assert.ok(sessions.totalSessions >= 1);
  } finally {
    await app.close();
    await jfSafe.close();
    await jfUnsafe.close();
  }
});

test('Legacy non-srv server IDs canonicalize on startup and needs_relink omits dead tokens for legacy clients', async () => {
  const jf = await startMockJellyfin((req, res) => {
    if (req.url === '/System/Info/Public') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ Id: 'fd6ec3df44f74b4cb2d7cd721991de1b', ServerName: 'Jellyfin', Version: '12.4.0' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const app = await startTestApp({
    servers: [
      {
        id: 'v2jznc7ko',
        name: 'Jellyfin',
        addresses: [jf.url],
        users: [
          {
            id: '08ca5a75f757417c9899608f579bd705',
            username: 'expired_user',
            access_token: 'dead-401-token',
            needs_relink: true,
          },
          {
            id: 'de9300dae7d64c6194ba5261e9efba83',
            username: 'healthy_user',
            access_token: 'fresh-valid-token',
            needs_relink: false,
          },
        ],
      },
    ],
  });

  try {
    await app.instance.init();
    const cfg = app.instance.getConfig();
    assert.equal(cfg.servers.length, 1);
    assert.equal(cfg.servers[0].id, 'fd6ec3df44f74b4cb2d7cd721991de1b');
    assert.deepEqual(cfg.servers[0].legacy_ids, ['v2jznc7ko']);

    // Legacy client (no qc_broker_v1 capability) gets projected legacy_ids[0], valid token, and NO dead token
    const legacyRes = await fetch(`${app.baseUrl}/api/v1/config`, {
      headers: { 'X-Setup-Token': cfg.setup_token },
    });
    assert.equal(legacyRes.status, 200);
    const legacyBody = await legacyRes.json();
    assert.equal(legacyBody.servers[0].id, 'v2jznc7ko');
    const expiredOut = legacyBody.servers[0].users.find((u) => u.username === 'expired_user');
    const healthyOut = legacyBody.servers[0].users.find((u) => u.username === 'healthy_user');
    assert.equal(expiredOut.access_token, undefined);
    assert.equal(expiredOut.has_verified_token, false);
    assert.equal(healthyOut.access_token, 'fresh-valid-token');
    assert.equal(healthyOut.has_verified_token, true);
  } finally {
    await app.close();
    await jf.close();
  }
});

test('runAnalyticsSync skips needs_relink users and quick-connect-status reports enabled/disabled/unreachable', async () => {
  const { checkQuickConnectEnabled } = require('../quick-connect');
  let sessionPolls = 0;
  let qcEnabledMode = 'true';
  const jf = await startMockJellyfin((req, res) => {
    if (req.url.startsWith('/Sessions')) {
      sessionPolls += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
      return;
    }
    if (req.url === '/QuickConnect/Enabled') {
      if (qcEnabledMode === 'true') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('true');
      } else if (qcEnabledMode === 'false') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('false');
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Disabled' }));
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const app = await startTestApp({
    servers: [
      {
        id: '11111111222233334444555566667777',
        name: 'JF',
        addresses: [jf.url],
        users: [
          { id: 'u-expired', username: 'Expired', access_token: 'dead-token', needs_relink: true },
        ],
      },
      {
        id: '99999999888877776666555544443333',
        name: 'UnreachableJF',
        addresses: ['http://127.0.0.1:1'],
        users: [],
      },
    ],
  });

  try {
    const syncRes = await adminReq(app.baseUrl, 'POST', '/api/admin/analytics/sync-now', {});
    assert.equal(syncRes.status, 200);
    assert.equal(sessionPolls, 0, 'needs_relink users must be skipped during analytics sync');

    // Enabled -> { enabled: true, reachable: true }
    qcEnabledMode = 'true';
    const rEnabled = await adminReq(app.baseUrl, 'GET', '/api/admin/servers/11111111222233334444555566667777/quick-connect-status');
    assert.equal(rEnabled.status, 200);
    assert.equal(rEnabled.data.enabled, true);
    assert.equal(rEnabled.data.reachable, true);

    // 200 false -> { enabled: false, reachable: true }
    qcEnabledMode = 'false';
    const rFalse = await adminReq(app.baseUrl, 'GET', '/api/admin/servers/11111111222233334444555566667777/quick-connect-status');
    assert.equal(rFalse.status, 200);
    assert.equal(rFalse.data.enabled, false);
    assert.equal(rFalse.data.reachable, true);

    // 401 -> { enabled: false, reachable: true }
    qcEnabledMode = '401';
    const r401 = await adminReq(app.baseUrl, 'GET', '/api/admin/servers/11111111222233334444555566667777/quick-connect-status');
    assert.equal(r401.status, 200);
    assert.equal(r401.data.enabled, false);
    assert.equal(r401.data.reachable, true);

    // Unreachable -> { enabled: null, reachable: false }
    const rUnreach = await adminReq(app.baseUrl, 'GET', '/api/admin/servers/99999999888877776666555544443333/quick-connect-status');
    assert.equal(rUnreach.status, 200);
    assert.equal(rUnreach.data.enabled, null);
    assert.equal(rUnreach.data.reachable, false);

    // Unknown server -> 404
    const rMissing = await adminReq(app.baseUrl, 'GET', '/api/admin/servers/nonexistent/quick-connect-status');
    assert.equal(rMissing.status, 404);

    // Direct helper check with empty addresses
    const emptyRes = await checkQuickConnectEnabled({
      serverConfig: { addresses: [] },
      safeHttpJson: async () => ({ status: 200, data: true }),
      buildJellyfinAuthHeaders: () => ({}),
    });
    assert.equal(emptyRes.enabled, null);
    assert.equal(emptyRes.reachable, false);
  } finally {
    await app.close();
    await jf.close();
  }
});
