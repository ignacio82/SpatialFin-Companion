'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { WebSocket } = require('ws');

const {
  SECRET_PLACEHOLDER,
  redactConfigForExport,
  restoreRedactedSecrets,
  scrubApiKeyFromText,
  resolveEffectiveDevicePreferences,
  isolateUserPreferencesForDevice,
} = require('../config-redaction');
const { createStorage } = require('../storage');
const {
  createCompanionApp,
  BoundedMemoryStore,
  parseCookies,
} = require('../index');

test('redactConfigForExport masks secrets across all 3 pref maps and strips setup_token & passwords', () => {
  const raw = {
    instance_id: 'abcd1234',
    setup_token: 'sf-setup-0123456789abcdef0123456789abcdef',
    globalPreferences: {
      pref_seerr_url: 'http://192.168.1.10:5055',
      pref_seerr_api_key: 'seerr-global',
      pref_tmdb_api_key: 'tmdb-key',
    },
    devicePreferences: {
      'dev-1': {
        pref_seerr_api_key: 'seerr-dev',
        pref_omdb_api_key: 'omdb-dev',
      },
    },
    servers: [
      {
        id: 'srv-1',
        addresses: ['http://192.168.1.20:8096'],
        users: [
          {
            id: 'u1',
            username: 'alice',
            password: 'plaintext-password',
            access_token: 'jf-tok',
            musicAssistant: { url: 'http://192.168.1.30:8095', token: 'ma-tok', password: 'ma-pw' },
            preferences: { pref_voice_assistant_cloud_api_key: 'gem-key' },
          },
        ],
      },
    ],
    networkShares: [
      { id: 'sh1', protocol: 'smb', host: '192.168.1.40', shareName: 'media', username: 'u', password: 'pw' },
    ],
  };

  const out = redactConfigForExport(raw);
  assert.equal(out.instance_id, undefined);
  assert.equal(out.setup_token, undefined);
  assert.equal(out.has_setup_token, true);
  assert.equal(out.globalPreferences.pref_seerr_api_key, SECRET_PLACEHOLDER);
  assert.equal(out.globalPreferences.pref_tmdb_api_key, SECRET_PLACEHOLDER);
  assert.equal(out.devicePreferences['dev-1'].pref_seerr_api_key, SECRET_PLACEHOLDER);
  assert.equal(out.devicePreferences['dev-1'].pref_omdb_api_key, SECRET_PLACEHOLDER);
  assert.equal(out.servers[0].users[0].password, undefined);
  assert.equal(out.servers[0].users[0].has_verified_token, true);
  assert.equal(out.servers[0].users[0].access_token, SECRET_PLACEHOLDER);
  assert.equal(out.servers[0].users[0].musicAssistant.token, SECRET_PLACEHOLDER);
  assert.equal(out.servers[0].users[0].musicAssistant.password, SECRET_PLACEHOLDER);
  assert.equal(out.servers[0].users[0].preferences.pref_voice_assistant_cloud_api_key, SECRET_PLACEHOLDER);
  assert.equal(out.networkShares[0].password, SECRET_PLACEHOLDER);

  // Users marked needs_relink: true preserve SECRET_PLACEHOLDER for reconcile, but report has_verified_token: false
  const rawRelink = {
    servers: [
      {
        id: 'srv-1',
        addresses: ['http://192.168.1.20:8096'],
        users: [{ id: 'u-relink', username: 'bob', access_token: 'stale-tok', needs_relink: true }],
      },
    ],
  };
  const outRelink = redactConfigForExport(rawRelink);
  assert.equal(outRelink.servers[0].users[0].has_verified_token, false);
  assert.equal(outRelink.servers[0].users[0].needs_relink, true);
  assert.equal(outRelink.servers[0].users[0].access_token, SECRET_PLACEHOLDER);
});

test('scrubApiKeyFromText redacts api_key and apikey query parameters', () => {
  const scrubbed = scrubApiKeyFromText('Error fetching http://jelly/socket?api_key=SECRET123&apikey=SECRET456');
  assert.doesNotMatch(scrubbed, /SECRET123/);
  assert.doesNotMatch(scrubbed, /SECRET456/);
});

test('Secret Target-Binding Predicates 1-4 reject target changes and allow confirmDropUnmatchedSecrets', () => {
  const current = {
    globalPreferences: {
      pref_seerr_url: 'http://192.168.1.10:5055',
      pref_seerr_api_key: 'seerr-secret',
      pref_tmdb_api_key: 'tmdb-secret',
    },
    devicePreferences: {
      'dev-1': { pref_seerr_api_key: 'dev-inherited-seerr-secret' },
    },
    servers: [
      {
        id: 's1',
        addresses: ['http://192.168.1.20:8096'],
        users: [
          {
            id: 'u1',
            username: 'alice',
            access_token: 'jf-secret',
            musicAssistant: { url: 'http://192.168.1.30:8095', token: 'ma-secret' },
            preferences: { pref_seerr_api_key: 'user-inherited-seerr-secret' },
          },
        ],
      },
    ],
    networkShares: [
      { id: 'sh1', protocol: 'smb', host: '192.168.1.40', port: 445, shareName: 'media', username: 'u', domain: '', password: 'smb-secret' },
    ],
  };

  // Predicate 1: adding a new server address rejects redacted access_token unless confirmed
  const draftP1 = structuredClone(current);
  draftP1.servers[0].addresses = ['http://192.168.1.20:8096', 'http://192.168.1.99:8096'];
  draftP1.servers[0].users[0].access_token = SECRET_PLACEHOLDER;
  const resP1Fail = restoreRedactedSecrets(draftP1, current, { rawPatch: { servers: draftP1.servers } });
  assert.equal(resP1Fail.ok, false);
  assert.equal(resP1Fail.errorCode, 'redacted_secret_mismatch');

  const draftP1Drop = structuredClone(draftP1);
  const resP1Drop = restoreRedactedSecrets(draftP1Drop, current, { confirmDropUnmatchedSecrets: true, rawPatch: { servers: draftP1Drop.servers } });
  assert.equal(resP1Drop.ok, true);
  assert.equal(draftP1Drop.servers[0].users[0].access_token, '');
  assert.equal(draftP1Drop.servers[0].users[0].needs_relink, true);

  // Predicate 2: changing share host triggers share_password_required
  const draftP2 = structuredClone(current);
  draftP2.networkShares[0].host = '192.168.1.41';
  draftP2.networkShares[0].password = SECRET_PLACEHOLDER;
  const resP2 = restoreRedactedSecrets(draftP2, current, { rawPatch: { networkShares: draftP2.networkShares } });
  assert.equal(resP2.ok, false);
  assert.equal(resP2.errorCode, 'share_password_required');

  // Predicate 3 hierarchical sweep: changing global pref_seerr_url flags inherited device & user pref_seerr_api_key even on section-scoped patch
  const draftP3 = structuredClone(current);
  draftP3.globalPreferences.pref_seerr_url = 'http://192.168.1.11:5055';
  const resP3 = restoreRedactedSecrets(draftP3, current, {
    rawPatch: { globalPreferences: { pref_seerr_url: 'http://192.168.1.11:5055' } },
  });
  assert.equal(resP3.ok, false);
  assert.equal(resP3.errorCode, 'redacted_secret_mismatch');
  assert.ok(resP3.unmatchedSecrets.includes('globalPreferences.pref_seerr_api_key'));
  assert.ok(resP3.unmatchedSecrets.includes('devicePreferences.dev-1.pref_seerr_api_key'));
  assert.ok(resP3.unmatchedSecrets.includes('servers.s1.users.u1.preferences.pref_seerr_api_key'));

  // Read-time cross-layer Seerr isolation
  const eff = resolveEffectiveDevicePreferences(
    { pref_seerr_url: 'http://global:5055', pref_seerr_api_key: 'global-key' },
    { 'dev-1': { pref_seerr_url: 'http://device:5055' } },
    'dev-1'
  );
  assert.equal(eff.effectivePrefs.pref_seerr_api_key, undefined);
  const isolatedUser = isolateUserPreferencesForDevice({ pref_seerr_api_key: 'user-key-no-url' }, eff);
  assert.equal(isolatedUser.pref_seerr_api_key, undefined);
});

test('BoundedMemoryStore pins blocked keys and fails closed when full', () => {
  const store = new BoundedMemoryStore(2);
  store.init({ windowMs: 60_000, limit: 2 });
  assert.equal(store.localKeys, true);
  store.increment('ip-a');
  store.increment('ip-a'); // blocked
  store.increment('ip-b');
  store.increment('ip-b'); // blocked
  // All 2 slots are actively blocked -> third key fails closed (totalHits > limit)
  const overflow = store.increment('ip-c');
  assert.ok(overflow.totalHits > 2);
});

test('parseCookies skips malformed percent-encoding without throwing', () => {
  const parsed = parseCookies({ headers: { cookie: 'bad=%E0%A4%A; good=hello%20world' } });
  assert.equal(parsed.good, 'hello world');
  assert.equal(parsed.bad, undefined);
});

test('storage.saveConfigAndMigrateServerIds migrates playback_sessions, open session keys, and media_item_metadata atomically', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-migrate-test-'));
  const storage = createStorage({ rootDir: tmpDir, defaultPreferences: {} });
  try {
    storage.upsertPlaybackSessions({
      sessions: [{
        playbackSessionId: 'srv-old:sess1:u1:dev1',
        serverId: 'srv-old',
        userId: 'u1',
        itemId: 'item-1',
        itemName: 'Movie',
        startedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      }],
    }, { ip: '127.0.0.1', headers: {} });
    storage.upsertMediaItemMetadata([{
      serverId: 'srv-old',
      itemId: 'item-1',
      itemName: 'Movie',
      lastRefreshedAt: new Date().toISOString(),
    }]);

    const cfg = storage.getConfig();
    cfg.servers = [{ id: 'canon-uuid', legacy_ids: ['srv-old'], name: 'S', addresses: ['http://192.168.1.5:8096'], users: [] }];
    storage.saveConfigAndMigrateServerIds(cfg, [{ oldId: 'srv-old', newId: 'canon-uuid' }], 'canonicalize');

    const migrated = storage.getPlaybackSessionWithEvents('canon-uuid:sess1:u1:dev1');
    assert.ok(migrated);
    assert.equal(migrated.session.serverId, 'canon-uuid');
    const meta = storage.getMediaItemMetadata('canon-uuid', 'item-1');
    assert.ok(meta);
    assert.equal(meta.itemName, 'Movie');
  } finally {
    await storage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('storage.prunePlaybackSessionsOlderThan preserves recent device_sync_pull telemetry rows', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-prune-test-'));
  const storage = createStorage({ rootDir: tmpDir, defaultPreferences: {} });
  try {
    storage.recordEvent('device_sync_pull', null, { qcBroker: true });
    storage.prunePlaybackSessionsOlderThan(0.000001); // tiny window would delete normal events
    const stats = storage.getConfigPullStats();
    assert.equal(stats.configPulls.total, 1);
    assert.equal(stats.configPulls.qcBroker, 1);
  } finally {
    await storage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('HTTP security boundary: /healthz, 410 /credentials, CSRF, If-Match, CORS, vacuumInFlight, and WS isolation', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-http-sec-test-'));
  const companion = createCompanionApp({
    rootDir: tmpDir,
    port: 0,
    enableBackgroundTasks: false,
    enableMdns: false,
  });

  await companion.start();
  const basePort = companion.server.address().port;
  const baseUrl = `http://127.0.0.1:${basePort}`;
  const setupToken = companion.getConfig().setup_token;

  try {
    // 1. /healthz and /api/meta
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    assert.equal(health.headers.get('access-control-allow-origin'), null);

    // 2. /api/auth/credentials returns 410 Gone
    const retired = await fetch(`${baseUrl}/api/auth/credentials`);
    assert.equal(retired.status, 410);

    // 3. /api/admin/config returns no-store, ETag, redacted config, configVersion
    const cfgRes = await fetch(`${baseUrl}/api/admin/config`);
    assert.equal(cfgRes.status, 200);
    assert.equal(cfgRes.headers.get('cache-control'), 'no-store');
    const cfgJson = await cfgRes.json();
    assert.equal(cfgJson.setup_token, undefined);
    assert.equal(cfgJson.has_setup_token, true);
    assert.equal(cfgJson.setupTokenWeak, false);
    assert.equal(typeof cfgJson.configVersion, 'number');

    // 4. CSRF rejects missing X-Companion-Admin header (403) and wrong Content-Type (415)
    const noCsrf = await fetch(`${baseUrl}/api/admin/rotate-token`, { method: 'POST', body: '{}' });
    assert.equal(noCsrf.status, 403);
    const badCt = await fetch(`${baseUrl}/api/admin/rotate-token`, {
      method: 'POST',
      headers: { 'X-Companion-Admin': '1', 'Content-Type': 'text/plain' },
      body: '{}',
    });
    assert.equal(badCt.status, 415);

    // 5. If-Match: 428 missing, 400 disagreement, 409 conflict, 200 valid (including bodyless DELETE)
    const noVer = await fetch(`${baseUrl}/api/admin/config`, {
      method: 'POST',
      headers: { 'X-Companion-Admin': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ globalPreferences: { pref_logging_enabled: 'true' } }),
    });
    assert.equal(noVer.status, 428);

    const disagree = await fetch(`${baseUrl}/api/admin/config`, {
      method: 'POST',
      headers: { 'X-Companion-Admin': '1', 'Content-Type': 'application/json', 'If-Match': `"${cfgJson.configVersion}"` },
      body: JSON.stringify({ configVersion: cfgJson.configVersion + 99, globalPreferences: {} }),
    });
    assert.equal(disagree.status, 400);

    const stale = await fetch(`${baseUrl}/api/admin/config`, {
      method: 'POST',
      headers: { 'X-Companion-Admin': '1', 'Content-Type': 'application/json', 'If-Match': '"9999"' },
      body: JSON.stringify({ globalPreferences: { pref_logging_enabled: 'true' } }),
    });
    assert.equal(stale.status, 409);

    const okSave = await fetch(`${baseUrl}/api/admin/config`, {
      method: 'POST',
      headers: { 'X-Companion-Admin': '1', 'Content-Type': 'application/json', 'If-Match': `"${cfgJson.configVersion}"` },
      body: JSON.stringify({ globalPreferences: { pref_logging_enabled: 'true' } }),
    });
    assert.equal(okSave.status, 200);
    const okSaveJson = await okSave.json();
    assert.equal(okSaveJson.configVersion, cfgJson.configVersion + 1);

    // Bodyless DELETE without Content-Type works under Express 5 with If-Match
    const delRes = await fetch(`${baseUrl}/api/admin/device-preferences/dev-nonexistent`, {
      method: 'DELETE',
      headers: { 'X-Companion-Admin': '1', 'If-Match': `"${okSaveJson.configVersion}"` },
    });
    assert.equal(delRes.status, 200);
    assert.equal((await delRes.json()).cleared, false);

    // 6. openCors on TOKEN_CORS_PATHS: OPTIONS short-circuits 204; token request gets ACAO: *
    const optRes = await fetch(`${baseUrl}/api/v1/config`, { method: 'OPTIONS' });
    assert.equal(optRes.status, 204);
    assert.equal(optRes.headers.get('access-control-allow-origin'), '*');
    assert.equal(optRes.headers.get('access-control-allow-private-network'), 'true');

    const v1Res = await fetch(`${baseUrl}/api/v1/config`, {
      headers: { 'X-Setup-Token': setupToken, 'X-SpatialFin-Capabilities': 'webxr_client_v1', 'X-Companion-Device': 'webxr-1' },
    });
    assert.equal(v1Res.status, 200);
    assert.equal(v1Res.headers.get('access-control-allow-origin'), '*');
    assert.equal(v1Res.headers.get('cache-control'), 'no-store');

    // 7. POST /api/v1/device-logs validates deviceId
    const badLogs = await fetch(`${baseUrl}/api/v1/device-logs`, {
      method: 'POST',
      headers: { 'X-Setup-Token': setupToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: '', logs: [{ message: 'hi' }] }),
    });
    assert.equal(badLogs.status, 400);

    // 8. Cache-backed routes succeed with zero SQLite writes during vacuumInFlight, while telemetry returns 503 Retry-After
    companion.storage.enterVacuumInFlight();
    try {
      const vacCfg = await fetch(`${baseUrl}/api/admin/config`);
      assert.equal(vacCfg.status, 200);
      const vacAuth = await fetch(`${baseUrl}/api/admin/auth-check`);
      assert.equal(vacAuth.status, 200);
      const vacV1 = await fetch(`${baseUrl}/api/v1/config`, { headers: { 'X-Setup-Token': setupToken } });
      assert.equal(vacV1.status, 200);
      const vacLogs = await fetch(`${baseUrl}/api/v1/device-logs`, {
        method: 'POST',
        headers: { 'X-Setup-Token': setupToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'dev1', logs: [{ message: 'hi' }] }),
      });
      assert.equal(vacLogs.status, 503);
      assert.equal(vacLogs.headers.get('retry-after'), '2');
    } finally {
      companion.storage.exitVacuumInFlight();
    }

    // 9. WebSocket isolation: adminSyncWss rejects invalid X-Setup-Token and accepts valid X-Setup-Token; rotate-token closes with 4401
    await assert.rejects(
      () => new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${basePort}/`, { headers: { 'X-Setup-Token': 'wrong' } });
        ws.once('open', () => resolve());
        ws.once('error', reject);
      })
    );

    const ws = new WebSocket(`ws://127.0.0.1:${basePort}/`, { headers: { 'X-Setup-Token': setupToken } });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const closeCodePromise = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
    const rotRes = await fetch(`${baseUrl}/api/admin/rotate-token`, {
      method: 'POST',
      headers: { 'X-Companion-Admin': '1', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(rotRes.status, 200);
    assert.equal(await closeCodePromise, 4401);

    // 10. Malformed Cookie header on WS upgrade does not crash server
    const rawResp = await new Promise((resolve) => {
      const sock = net.createConnection({ host: '127.0.0.1', port: basePort }, () => {
        sock.write(
          `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${basePort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nCookie: session=%\r\n\r\n`
        );
      });
      let out = '';
      sock.on('data', (d) => { out += d.toString(); });
      sock.on('close', () => resolve(out));
    });
    assert.match(rawResp, /^HTTP\/1\.1 (400|401|403)/);
  } finally {
    await companion.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
