const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENTRYPOINT_PATH = path.join(__dirname, '..', 'entrypoint.sh');

test('entrypoint.sh passes POSIX sh syntax check and excludes prerelease tags in git fallback', () => {
  execFileSync('sh', ['-n', ENTRYPOINT_PATH], { stdio: 'pipe' });

  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-tags-'));
  try {
    const git = (...args) =>
      execFileSync('git', ['-C', tmpRepo, ...args], {
        stdio: 'pipe',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
        },
      }).toString().trim();

    git('init');
    fs.writeFileSync(path.join(tmpRepo, 'README.md'), 'init\n');
    git('add', 'README.md');
    git('commit', '-m', 'init');
    git('tag', 'v2.6.0');
    git('tag', 'v2.7.0');
    git('tag', 'v2.8.0-rc1');
    git('tag', 'v2.8.0-beta.1');

    // Run the exact git fallback tag filter pipeline from entrypoint.sh
    const selected = execFileSync(
      'sh',
      [
        '-c',
        `git -C "$1" tag --list --sort=-v:refname 'v*' | grep -E '^v[0-9]+\\.[0-9]+\\.[0-9]+$' | head -n 1 || true`,
        'sh',
        tmpRepo,
      ],
      { stdio: 'pipe' }
    ).toString().trim();

    assert.equal(selected, 'v2.7.0');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});
