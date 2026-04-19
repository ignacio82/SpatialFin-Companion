const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DEFAULT_PREFERENCES } = require('../default-preferences');
const { createStorage } = require('../storage');

test('default preferences include AI defaults and seed new companion configs', () => {
  assert.equal(DEFAULT_PREFERENCES.pref_omdb_api_key, null);
  assert.equal(DEFAULT_PREFERENCES.pref_voice_assistant_gemma_enabled, 'false');

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-companion-config-'));

  try {
    const storage = createStorage({
      rootDir,
      defaultPreferences: DEFAULT_PREFERENCES
    });
    const config = storage.getConfig();

    assert.equal(config.globalPreferences.pref_omdb_api_key, null);
    assert.equal(config.globalPreferences.pref_tmdb_api_key, null);
    assert.equal(config.globalPreferences.pref_voice_assistant_gemma_enabled, 'false');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
