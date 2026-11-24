'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tvPairing = require('../tv-pairing');
const {
  normalizeManualCode,
  normalizeTvReceiverInput,
  validateTvPairingPayload,
  validateTvPairingInfo,
  buildTvReceiverUrl,
  buildTvInfoUrlFromReceiverUrl,
  extractMdnsCandidates,
  buildTvPairingEnvelope,
} = tvPairing;
const { getScanNetworkInterfaces } = require('../share-discovery');
const {
  POLICY_PUBLIC_OR_LAN,
  POLICY_PRIVATE_LAN_ONLY,
  POLICY_RECEIVER_LAN_HTTP_ONLY,
  SsrfBlockedError,
  validateInitialUrl,
  createPinnedLookup,
  validateLanHost,
  safeFetch,
} = require('../safe-fetch');
const {
  createCompanionApp,
  buildTvPairingError,
  buildJellyfinAuthHeadersForInstance,
} = require('../index');

test('normalizeManualCode enforces strict 6-char Crockford Base32', () => {
  assert.equal(normalizeManualCode('k7p-9m2'), 'K7P9M2');
  assert.equal(normalizeManualCode(' K7P 9M2 '), 'K7P9M2');
  assert.equal(normalizeManualCode('ab-12c!'), '');
  assert.equal(normalizeManualCode('ILOU12'), ''); // I, L, O, U excluded from Crockford Base32
  assert.equal(normalizeManualCode('ABCDEFG'), '');
});

test('getPrivateIpv4ScanTargets is removed from tv-pairing exports', () => {
  assert.equal(tvPairing.getPrivateIpv4ScanTargets, undefined);
});

test('buildTvReceiverUrl brackets IPv6 and honors non-default ports', () => {
  assert.equal(buildTvReceiverUrl('192.168.1.25'), 'http://192.168.1.25:41230/api/v1/tv-pairing/config');
  assert.equal(buildTvReceiverUrl('192.168.1.25', 45000), 'http://192.168.1.25:45000/api/v1/tv-pairing/config');
  assert.equal(buildTvReceiverUrl('fd00::42', 41230), 'http://[fd00::42]:41230/api/v1/tv-pairing/config');
});

test('validateTvPairingPayload and validateTvPairingInfo treat expires_at_epoch_ms as advisory only', () => {
  const payloadRes = validateTvPairingPayload({
    version: 1,
    receiver_url: 'http://192.168.1.25:41230/api/v1/tv-pairing/config',
    pairing_token: '0123456789abcdef0123456789abcdef',
    device_name: 'Living Room TV',
    expires_at_epoch_ms: 1, // in the past, still accepted as advisory
  });
  assert.equal(payloadRes.ok, true);

  const infoRes = validateTvPairingInfo({
    version: 1,
    port: 41230,
    device_name: 'Bedroom TV',
    device_class: 'xr',
    protocol_v: 1,
    capabilities: [],
    expires_at_epoch_ms: 1,
  });
  assert.equal(infoRes.ok, true);
  assert.equal(infoRes.info.manual_code, null);
  assert.equal(infoRes.info.device_class, 'xr');
});

test('extractMdnsCandidates accepts RFC1918 and ULA IPv6 only', () => {
  const candidates = extractMdnsCandidates([
    { name: 'TV-1', port: 41230, addresses: ['fe80::1', '192.168.1.50'], txt: { device_name: 'Living TV', device_class: 'tv' } },
    { name: 'XR-1', port: 45555, addresses: ['fd12:3456::1'], txt: { device_name: 'Galaxy XR', device_class: 'xr' } },
    { name: 'Public', port: 41230, addresses: ['8.8.8.8', '100.64.0.1'], txt: { device_name: 'Bad' } },
  ]);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].ip, '192.168.1.50');
  assert.equal(candidates[0].receiver_url, 'http://192.168.1.50:41230/api/v1/tv-pairing/config');
  assert.equal(candidates[1].ip, 'fd12:3456::1');
  assert.equal(candidates[1].receiver_url, 'http://[fd12:3456::1]:45555/api/v1/tv-pairing/config');
});

test('buildTvPairingEnvelope filters server/user, strips passwords, projects legacy_ids, and supports shareOnly', () => {
  const cfg = {
    version: 1,
    setup_token: 'sf-setup-0123456789abcdef0123456789abcdef',
    globalPreferences: {},
    servers: [
      {
        id: 'canon-1',
        legacy_ids: ['srv-legacy-1'],
        name: 'Home',
        addresses: ['http://192.168.1.10:8096'],
        users: [
          { id: 'u1', username: 'alice', access_token: 'tok-a', password: 'secret' },
          { id: 'u2', username: 'bob', access_token: 'tok-b' },
        ],
      },
      { id: 'canon-2', name: 'Other', addresses: ['http://192.168.1.20:8096'], users: [] },
    ],
    networkShares: [],
  };

  const filtered = buildTvPairingEnvelope(cfg, 'http://192.168.1.5:1982', {
    serverId: 'canon-1',
    userId: 'u1',
  });
  assert.equal(filtered.server_id, 'srv-legacy-1');
  assert.equal(filtered.user_id, 'u1');
  assert.equal(filtered.config.servers.length, 1);
  assert.equal(filtered.config.servers[0].id, 'srv-legacy-1');
  assert.equal(filtered.config.servers[0].users.length, 1);
  assert.equal(filtered.config.servers[0].users[0].username, 'alice');
  assert.equal(filtered.config.servers[0].users[0].password, undefined);

  const shareOnly = buildTvPairingEnvelope(cfg, 'http://192.168.1.5:1982', { shareOnly: true });
  assert.deepEqual(shareOnly.config.servers, []);
  assert.equal(shareOnly.server_id, undefined);
});

test('safe-fetch blocks non-canonical IPv4, syntactic loopback, self-SSRF, and validates pinned DNS', async () => {
  for (const bad of [
    'http://127.1:8096/',
    'http://0177.0.0.1:8096/',
    'http://2130706433:8096/',
    'http://0xa9fea9fe/latest/meta-data',
    'http://localhost:8096/',
    'http://foo.localhost:8096/',
    'http://169.254.169.254/latest/meta-data',
    'http://[fe80::1]:8096/',
  ]) {
    assert.throws(() => validateInitialUrl(bad, POLICY_PUBLIC_OR_LAN, { selfPort: 1982 }), SsrfBlockedError);
  }

  // Self-SSRF blocked even when allowLoopback = true
  assert.throws(
    () => validateInitialUrl('http://127.0.0.1:1982/api/admin/config', POLICY_PUBLIC_OR_LAN, { allowLoopback: true, selfPort: 1982 }),
    SsrfBlockedError
  );

  // Multi-record DNS strips fe80::/10 and fails closed on prohibited record
  const lookupOk = createPinnedLookup({
    policy: POLICY_PRIVATE_LAN_ONLY,
    port: 8096,
    hostname: 'nas.local',
    dnsLookup: (_h, _o, cb) => cb(null, [
      { address: 'fe80::1', family: 6 },
      { address: '192.168.1.50', family: 4 },
    ]),
  });
  const resolved = await new Promise((resolve, reject) => lookupOk('nas.local', {}, (err, addr, fam) => (err ? reject(err) : resolve({ addr, fam }))));
  assert.deepEqual(resolved, { addr: '192.168.1.50', fam: 4 });

  const lookupFail = createPinnedLookup({
    policy: POLICY_PUBLIC_OR_LAN,
    port: 8096,
    hostname: 'evil.example',
    dnsLookup: (_h, _o, cb) => cb(null, [
      { address: '192.168.1.50', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]),
  });
  await assert.rejects(
    () => new Promise((resolve, reject) => lookupFail('evil.example', {}, (err, addr) => (err ? reject(err) : resolve(addr)))),
    SsrfBlockedError
  );

  // validateLanHost rejects public IPs & shell-injection chars
  await assert.rejects(() => validateLanHost('8.8.8.8'), SsrfBlockedError);
  await assert.rejects(() => validateLanHost('-oProxyCommand=evil'), SsrfBlockedError);
  const pinnedLan = await validateLanHost('[fd00::1]');
  assert.deepEqual(pinnedLan, { address: 'fd00::1', family: 6, isLiteral: true, hostname: 'fd00::1' });
});

test('safeFetch materializes Content-Length and strips sensitive headers across redirects', async () => {
  const seenRequests = [];
  const targetServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seenRequests.push({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (req.url === '/start') {
        res.writeHead(303, { Location: '/final' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise((r) => targetServer.listen(0, '127.0.0.1', r));
  const targetPort = targetServer.address().port;
  try {
    const res = await safeFetch(`http://127.0.0.1:${targetPort}/start`, {
      method: 'POST',
      body: JSON.stringify({ hello: 'world' }),
      headers: { 'Content-Type': 'application/json', 'X-Pairing-Token': 'secret-tok' },
      policy: POLICY_PUBLIC_OR_LAN,
      allowLoopback: true,
      selfPort: 1982,
    });
    assert.equal(res.status, 200);
    assert.equal(seenRequests.length, 2);
    assert.equal(seenRequests[0].method, 'POST');
    assert.equal(seenRequests[0].headers['content-length'], String(Buffer.byteLength('{"hello":"world"}')));
    assert.equal(seenRequests[1].method, 'GET'); // 303 rewrote POST -> GET
    assert.equal(seenRequests[1].body, '');
  } finally {
    await new Promise((r) => targetServer.close(r));
  }
});

test('buildTvPairingError maps pairing_cancelled and pairing_token_invalid cleanly', () => {
  const errCancel = buildTvPairingError({ status: 409, data: { error_code: 'pairing_cancelled' } }, false);
  assert.equal(errCancel.status, 409);
  assert.equal(errCancel.error_code, 'pairing_cancelled');

  const errTok = buildTvPairingError({ status: 401, data: { error: 'invalid_pairing_token' } }, true);
  assert.equal(errTok.status, 401);
  assert.equal(errTok.error_code, 'pairing_token_invalid');
});

test('buildJellyfinAuthHeadersForInstance omits X-Emby-Token and Token when blank', () => {
  const unauthed = buildJellyfinAuthHeadersForInstance('abcd1234abcd1234', null);
  assert.equal(unauthed['X-Emby-Token'], undefined);
  assert.match(unauthed['X-Emby-Authorization'], /DeviceId="spatialfin-companion-abcd1234abcd1234"/);
  assert.doesNotMatch(unauthed['X-Emby-Authorization'], /Token=/);

  const authed = buildJellyfinAuthHeadersForInstance('abcd1234abcd1234', 'tok-xyz');
  assert.equal(authed['X-Emby-Token'], 'tok-xyz');
  assert.match(authed['X-Emby-Authorization'], /Token="tok-xyz"/);
});

test('getScanNetworkInterfaces filters virtual NICs when physical LAN NIC exists', () => {
  const result = getScanNetworkInterfaces({
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    docker0: [{ family: 'IPv4', address: '172.17.0.1', internal: false }],
    eth0: [{ family: 'IPv4', address: '192.168.1.40', internal: false }],
  });
  assert.deepEqual(Object.keys(result), ['eth0']);
  assert.equal(result.eth0[0].address, '192.168.1.40');
});

test('Stage 1 handoff route validates inputs, rejects unsolicited /info 409, and honors recent-attempt retry', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-handoff-test-'));
  let infoStatus = 200;
  let postCount = 0;

  const mockFetch = async (url, opts) => {
    if (String(url).includes('/api/v1/tv-pairing/info')) {
      return {
        ok: infoStatus === 200,
        status: infoStatus,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => JSON.stringify(
          infoStatus === 200
            ? { version: 1, port: 41230, device_name: 'Living Room TV', device_class: 'tv', protocol_v: 1, capabilities: [] }
            : { error: 'Expired', error_code: 'pairing_code_expired' }
        ),
      };
    }
    if (String(url).includes('/api/v1/device-setup/companion-handoff')) {
      return {
        ok: false,
        status: 404,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => JSON.stringify({ error: 'Not found', error_code: 'route_not_found' }),
      };
    }
    if (String(url).includes('/api/v1/tv-pairing/config')) {
      postCount += 1;
      assert.equal(opts.headers['X-Pairing-Token'] || opts.headers['x-pairing-token'], 'K7P9M2');
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => JSON.stringify({ ok: true }), // missing status defaults to "done"
      };
    }
    throw new Error(`Unexpected mockFetch URL: ${url}`);
  };

  const companion = createCompanionApp({
    rootDir: tmpDir,
    port: 0,
    enableBackgroundTasks: false,
    enableMdns: false,
    fetchImpl: mockFetch,
    getInterfaces: () => ({
      eth0: [{ family: 'IPv4', address: '192.168.1.10', internal: false }],
    }),
  });

  await companion.start();
  const basePort = companion.server.address().port;
  const baseUrl = `http://127.0.0.1:${basePort}`;
  const adminHeaders = {
    'X-Companion-Admin': '1',
    'Content-Type': 'application/json',
  };

  try {
    // Invalid combination: shareOnly + serverId -> 400
    const badCombo = await fetch(`${baseUrl}/api/admin/device-setup/handoff`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ host: '192.168.1.50', manualCode: 'K7P9M2', shareOnly: true, serverId: 's1' }),
    });
    assert.equal(badCombo.status, 400);

    // Unsolicited /info 409 -> rejects with 409 without calling POST /config
    infoStatus = 409;
    const unsolicited = await fetch(`${baseUrl}/api/admin/device-setup/handoff`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ host: '192.168.1.50', manualCode: 'K7P9M2' }),
    });
    assert.equal(unsolicited.status, 409);
    assert.equal(postCount, 0);

    // Normal /info 200 -> succeeds and defaults missing status to "done"
    infoStatus = 200;
    const first = await fetch(`${baseUrl}/api/admin/device-setup/handoff`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ host: '192.168.1.50', manualCode: 'K7P-9M2' }),
    });
    assert.equal(first.status, 200);
    const firstJson = await first.json();
    assert.equal(firstJson.status, 'done');
    assert.equal(firstJson.deviceName, 'Living Room TV');
    assert.equal(postCount, 1);

    // Subsequent retry where /info returns 409 (drain state) -> matches recent attempt and posts
    infoStatus = 409;
    const retry = await fetch(`${baseUrl}/api/admin/device-setup/handoff`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ host: '192.168.1.50', manualCode: 'K7P-9M2' }),
    });
    assert.equal(retry.status, 200);
    assert.equal(postCount, 2);

    // Subnet hint returns primary, prefix, port, defaultCompanionUrl, isLikelyDockerBridge
    const hintRes = await fetch(`${baseUrl}/api/admin/tv-pairing/subnet-hint`, {
      headers: { 'X-Companion-Admin': '1' },
    });
    assert.equal(hintRes.status, 200);
    const hintJson = await hintRes.json();
    assert.equal(hintJson.primary, '192.168.1.10');
    assert.equal(hintJson.prefix, '192.168.1.');
    assert.equal(hintJson.port, 41230);
    assert.equal(hintJson.isLikelyDockerBridge, false);

    // Discover enforces 10s cooldown (429 on immediate second call)
    const d1 = await fetch(`${baseUrl}/api/admin/tv-pairing/discover`, {
      method: 'POST',
      headers: adminHeaders,
      body: '{}',
    });
    assert.equal(d1.status, 200);
    const d2 = await fetch(`${baseUrl}/api/admin/tv-pairing/discover`, {
      method: 'POST',
      headers: adminHeaders,
      body: '{}',
    });
    assert.equal(d2.status, 429);
  } finally {
    await companion.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('normalizeTvReceiverInput handles bare host and info endpoint', () => {
  const bare = normalizeTvReceiverInput('192.168.1.25');
  assert.equal(bare.ok, true);
  assert.equal(bare.receiverUrl, 'http://192.168.1.25:41230/api/v1/tv-pairing/config');
  assert.equal(buildTvInfoUrlFromReceiverUrl(bare.receiverUrl), bare.infoUrl);
});

test('Stage 2 parseSetupUrlQr, buildCompanionHandoffPayload, and v2 handoff with /setup#t= QR', async () => {
  const { parseSetupUrlQr, buildCompanionHandoffPayload, formatDeviceClass } = require('../tv-pairing');

  const parsed = parseSetupUrlQr('http://192.168.1.77:41230/setup#t=0123456789abcdef0123456789abcdef');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.host, '192.168.1.77');
  assert.equal(parsed.port, 41230);
  assert.equal(parsed.pairing_token, '0123456789abcdef0123456789abcdef');
  assert.equal(formatDeviceClass('xr'), 'Android XR');

  const bad = parseSetupUrlQr('http://192.168.1.77:41230/setup#t=short');
  assert.equal(bad.ok, false);

  const payload = buildCompanionHandoffPayload({
    companionUrl: 'http://192.168.1.10:1982/',
    setupToken: 'sf-setup-0123456789abcdef0123456789abcdef',
    serverId: 'srv-1',
    userId: 'user-1',
    shareOnly: false,
  });
  assert.deepEqual(payload, {
    companion_url: 'http://192.168.1.10:1982',
    setup_token: 'sf-setup-0123456789abcdef0123456789abcdef',
    server_id: 'srv-1',
    user_id: 'user-1',
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-v2-handoff-'));
  let v2Calls = 0;
  const mockFetch = async (url, opts) => {
    if (String(url).includes('/api/v1/tv-pairing/info')) {
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => JSON.stringify({
          version: 1,
          port: 41230,
          device_name: 'Galaxy XR',
          device_class: 'xr',
          protocol_v: 2,
          capabilities: ['companion_handoff_v2', 'setup_page_v1'],
        }),
      };
    }
    if (String(url).includes('/api/v1/device-setup/companion-handoff')) {
      v2Calls += 1;
      assert.equal(opts.headers['X-Pairing-Token'], '0123456789abcdef0123456789abcdef');
      const sent = JSON.parse(opts.body);
      assert.equal(sent.share_only, true);
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => JSON.stringify({ ok: true, status: 'done', device_name: 'Galaxy XR' }),
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const companion = createCompanionApp({
    rootDir: tmpDir,
    port: 0,
    enableBackgroundTasks: false,
    enableMdns: false,
    fetchImpl: mockFetch,
    getInterfaces: () => ({
      eth0: [{ family: 'IPv4', address: '192.168.1.10', internal: false }],
    }),
  });
  await companion.start();
  const baseUrl = `http://127.0.0.1:${companion.server.address().port}`;
  try {
    const res = await fetch(`${baseUrl}/api/admin/device-setup/handoff`, {
      method: 'POST',
      headers: { 'X-Companion-Admin': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        qrPayload: 'http://192.168.1.77:41230/setup#t=0123456789abcdef0123456789abcdef',
      }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.mode, 'v2');
    assert.equal(json.status, 'done');
    assert.equal(json.deviceName, 'Galaxy XR');
    assert.equal(v2Calls, 1);
  } finally {
    await companion.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
