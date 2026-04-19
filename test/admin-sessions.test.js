const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createStorage } = require('../storage');

function freshStorage() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spatialfin-companion-test-'));
  return {
    rootDir,
    storage: createStorage({
      rootDir,
      defaultPreferences: {}
    })
  };
}

test('createAdminSession + validateAdminSession round-trips', () => {
  const { storage } = freshStorage();
  storage.createAdminSession('tok-1', 60_000);
  assert.equal(storage.validateAdminSession('tok-1'), true);
});

test('validateAdminSession rejects unknown tokens', () => {
  const { storage } = freshStorage();
  assert.equal(storage.validateAdminSession('nope'), false);
  assert.equal(storage.validateAdminSession(''), false);
  assert.equal(storage.validateAdminSession(null), false);
});

test('validateAdminSession rejects expired tokens and deletes them', () => {
  const { storage } = freshStorage();
  storage.createAdminSession('tok-expired', -1000); // already expired
  assert.equal(storage.validateAdminSession('tok-expired'), false);
  // Subsequent lookup should still be false (row was pruned).
  assert.equal(storage.validateAdminSession('tok-expired'), false);
});

test('deleteAdminSession invalidates a valid token', () => {
  const { storage } = freshStorage();
  storage.createAdminSession('tok-2', 60_000);
  assert.equal(storage.validateAdminSession('tok-2'), true);
  storage.deleteAdminSession('tok-2');
  assert.equal(storage.validateAdminSession('tok-2'), false);
});

test('sessions without a TTL never expire', () => {
  const { storage } = freshStorage();
  storage.createAdminSession('tok-3'); // no ttl
  assert.equal(storage.validateAdminSession('tok-3'), true);
});

test('pruneExpiredAdminSessions removes expired rows', () => {
  const { storage } = freshStorage();
  storage.createAdminSession('keep', 60_000);
  storage.createAdminSession('drop', -1);
  storage.pruneExpiredAdminSessions();
  assert.equal(storage.validateAdminSession('keep'), true);
  assert.equal(storage.validateAdminSession('drop'), false);
});
