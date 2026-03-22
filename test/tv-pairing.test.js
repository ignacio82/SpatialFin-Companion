const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeManualCode,
  validateTvPairingPayload,
  validateTvPairingInfo,
  getPrivateIpv4ScanTargets,
  buildTvReceiverUrl,
  buildTvPairingEnvelope
} = require('../tv-pairing');

test('normalizeManualCode uppercases and strips punctuation', () => {
  assert.equal(normalizeManualCode(' ab-12c! '), 'AB12C');
  assert.equal(normalizeManualCode('abcdefg'), 'ABCDEF');
});

test('validateTvPairingPayload accepts a valid unexpired payload', () => {
  const result = validateTvPairingPayload({
    version: 1,
    receiver_url: 'http://192.168.1.25:41230/api/v1/tv-pairing/config',
    pairing_token: 'secret-token',
    manual_code: 'abc123',
    device_name: 'Living Room TV',
    expires_at_epoch_ms: 2_000_000
  }, { now: 1_000_000 });

  assert.equal(result.ok, true);
  assert.equal(result.payload.manual_code, 'ABC123');
});

test('validateTvPairingPayload rejects expired or invalid payloads', () => {
  const expired = validateTvPairingPayload({
    version: 1,
    receiver_url: 'ftp://bad.example/path',
    pairing_token: '',
    expires_at_epoch_ms: 999
  }, { now: 1_000 });

  assert.equal(expired.ok, false);
  assert.match(expired.issues.join(' '), /expired/i);
  assert.match(expired.issues.join(' '), /HTTP or HTTPS/i);
  assert.match(expired.issues.join(' '), /pairing token/i);
});

test('validateTvPairingInfo accepts optional pairing token extension', () => {
  const result = validateTvPairingInfo({
    version: 1,
    manual_code: 'q1w2e3',
    device_name: 'Bedroom TV',
    expires_at_epoch_ms: 5_000,
    pairing_token: 'optional-secret'
  }, { now: 1_000 });

  assert.equal(result.ok, true);
  assert.equal(result.info.manual_code, 'Q1W2E3');
  assert.equal(result.info.pairing_token, 'optional-secret');
});

test('getPrivateIpv4ScanTargets expands private /24 ranges and skips self', () => {
  const targets = getPrivateIpv4ScanTargets({
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    wlan0: [{ family: 'IPv4', internal: false, address: '192.168.1.20' }],
    eth0: [{ family: 'IPv4', internal: false, address: '10.0.0.8' }]
  });

  assert.equal(targets.some((entry) => entry.ip === '192.168.1.20'), false);
  assert.equal(targets.some((entry) => entry.ip === '192.168.1.21'), true);
  assert.equal(targets.some((entry) => entry.ip === '10.0.0.9'), true);
  assert.equal(targets.length, 506);
});

test('buildTvPairingEnvelope reuses the existing config payload', () => {
  const config = {
    version: 1,
    setup_token: 'sf-setup-123',
    globalPreferences: {},
    servers: [],
    networkShares: []
  };
  const envelope = buildTvPairingEnvelope(config, 'http://companion.local:1982');

  assert.equal(envelope.setup_token, 'sf-setup-123');
  assert.equal(envelope.companion_url, 'http://companion.local:1982');
  assert.equal(envelope.config, config);
  assert.equal(buildTvReceiverUrl('192.168.1.25'), 'http://192.168.1.25:41230/api/v1/tv-pairing/config');
});
