'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStorage } = require('../storage');
const { createCompanionApp } = require('../index');
const { buildTvPairingEnvelope } = require('../tv-pairing');

async function startTestApp(seedConfig, appOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-legacy-compat-'));
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
    ...appOptions,
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

test('GET /api/v1/config without capabilities projects legacy fields and strips unusable tokens for v2.7.70 clients', async () => {
  const app = await startTestApp({
    version: 1,
    servers: [
      {
        id: 'canon-11112222333344445555666677778888',
        legacy_ids: ['srv-legacy-1'],
        // name intentionally missing to verify non-null backfill
        addresses: ['http://192.168.1.10:8096', ''],
        users: [
          {
            id: 'user-valid',
            username: 'alice',
            access_token: 'tok-valid-alice',
            password: 'should-be-stripped',
            needs_relink: false,
          },
          {
            id: 'user-relink',
            name: 'Bob Display',
            // username intentionally omitted to verify backfill from name
            access_token: 'tok-stale-bob',
            needs_relink: true,
          },
          {
            id: 'user-blank-token',
            // username & name intentionally omitted to verify backfill from id
            access_token: '   ',
            needs_relink: false,
          },
        ],
      },
      {
        id: 'canon-nonarray-addrs',
        name: 'NoAddrs',
        addresses: 'not-an-array',
        users: [],
      },
    ],
    networkShares: [
      {
        // id intentionally omitted
        protocol: 'smb',
        host: '192.168.1.50',
        shareName: 'media',
        username: 'shareuser',
        password: 'sharepassword',
      },
    ],
  });

  try {
    const res = await fetch(`${app.baseUrl}/api/v1/config`, {
      headers: { 'X-Setup-Token': app.setupToken },
    });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(typeof body.version, 'number');
    assert.equal(typeof body.setup_token, 'string');
    assert.equal(body.instance_id, undefined);
    assert.ok(body.globalPreferences && typeof body.globalPreferences === 'object');
    assert.ok(body.devicePreferences && typeof body.devicePreferences === 'object');

    assert.equal(body.servers.length, 2);
    const srv0 = body.servers[0];
    assert.equal(srv0.id, 'srv-legacy-1');
    assert.equal(typeof srv0.name, 'string');
    assert.ok(srv0.name.length > 0);
    assert.deepEqual(srv0.addresses, ['http://192.168.1.10:8096']);

    const alice = srv0.users.find((u) => u.id === 'user-valid');
    assert.equal(alice.username, 'alice');
    assert.equal(alice.access_token, 'tok-valid-alice');
    assert.equal(alice.password, undefined);
    assert.equal(alice.has_verified_token, true);

    const bob = srv0.users.find((u) => u.id === 'user-relink');
    assert.equal(bob.username, 'Bob Display');
    assert.equal(bob.access_token, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(bob, 'access_token'), false);
    assert.equal(bob.has_verified_token, false);

    const blankUser = srv0.users.find((u) => u.id === 'user-blank-token');
    assert.equal(blankUser.username, 'user-blank-token');
    assert.equal(blankUser.access_token, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(blankUser, 'access_token'), false);
    assert.equal(blankUser.has_verified_token, false);

    const srv1 = body.servers[1];
    assert.deepEqual(srv1.addresses, []);

    assert.equal(body.networkShares.length, 1);
    const sh0 = body.networkShares[0];
    assert.equal(typeof sh0.id, 'string');
    assert.ok(sh0.id.length > 0);
    assert.equal(sh0.protocol, 'smb');
    assert.equal(sh0.host, '192.168.1.50');
    assert.equal(sh0.shareName, 'media');
    // Non-WebXR Android legacy client still receives share password
    assert.equal(sh0.password, 'sharepassword');
  } finally {
    await app.close();
  }
});

test('buildTvPairingEnvelope coerces required v2.7.70 fields and strips dead/blank tokens and instance_id', () => {
  const envelope = buildTvPairingEnvelope(
    {
      instance_id: 'secret-instance-id',
      setup_token: 'sf-setup-0123456789abcdef0123456789abcdef',
      globalPreferences: {},
      servers: [
        {
          id: 'canon-uuid-1234',
          legacy_ids: ['srv-old-tv'],
          addresses: ['http://192.168.1.10:8096', null],
          users: [
            { id: 'u1', username: 'alice', access_token: 'tok-a', password: 'pw', needs_relink: false },
            { id: 'u2', name: 'Bob', access_token: 'tok-dead', needs_relink: true },
            { id: 'u3', access_token: '   ', needs_relink: false },
          ],
        },
      ],
      networkShares: [
        { protocol: 'smb', host: '192.168.1.50', shareName: 'movies', password: 'pw' },
      ],
    },
    'http://192.168.1.5:1982'
  );

  assert.equal(envelope.version, 1);
  assert.equal(envelope.config.version, 1);
  assert.equal(envelope.config.instance_id, undefined);
  assert.equal(envelope.config.setup_token, 'sf-setup-0123456789abcdef0123456789abcdef');

  const srv = envelope.config.servers[0];
  assert.equal(srv.id, 'srv-old-tv');
  assert.equal(typeof srv.name, 'string');
  assert.ok(srv.name.length > 0);
  assert.deepEqual(srv.addresses, ['http://192.168.1.10:8096']);

  const [u1, u2, u3] = srv.users;
  assert.equal(u1.username, 'alice');
  assert.equal(u1.access_token, 'tok-a');
  assert.equal(u1.password, undefined);

  assert.equal(u2.username, 'Bob');
  assert.equal(u2.access_token, undefined);

  assert.equal(u3.username, 'u3');
  assert.equal(u3.access_token, undefined);

  const sh = envelope.config.networkShares[0];
  assert.equal(typeof sh.id, 'string');
  assert.ok(sh.id.length > 0);
  assert.equal(sh.protocol, 'smb');
  assert.equal(sh.host, '192.168.1.50');
  assert.equal(sh.shareName, 'movies');
});

test('Legacy unauthenticated POST /api/fcast/register returns 401 without exhausting failedTokenLimiter for valid /api/v1/config calls', async () => {
  const app = await startTestApp(
    { servers: [], networkShares: [] },
    { adminPassword: 'test-admin-password-123' }
  );

  try {
    // 25 headerless/cookieless pings like legacy v2.7.70 FCastReceiverService
    for (let i = 0; i < 25; i += 1) {
      const regRes = await fetch(`${app.baseUrl}/api/fcast/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: '192.168.1.77', port: 46899, name: 'Legacy XR' }),
      });
      assert.equal(regRes.status, 401);
    }

    // Valid setup-token GET /api/v1/config from same IP must NOT be rate-limited (429)
    const cfgRes = await fetch(`${app.baseUrl}/api/v1/config`, {
      headers: { 'X-Setup-Token': app.setupToken },
    });
    assert.equal(cfgRes.status, 200);

    // Invalid X-Setup-Token brute-force attempts MUST still trip failedTokenLimiter at >20
    for (let i = 0; i < 20; i += 1) {
      const badRes = await fetch(`${app.baseUrl}/api/v1/config`, {
        headers: { 'X-Setup-Token': 'wrong-setup-token' },
      });
      assert.equal(badRes.status, 401);
    }
    const throttledRes = await fetch(`${app.baseUrl}/api/v1/config`, {
      headers: { 'X-Setup-Token': 'wrong-setup-token' },
    });
    assert.equal(throttledRes.status, 429);
  } finally {
    await app.close();
  }
});
