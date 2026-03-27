const SMB2 = require('smb2');

function exitJson(code, payload) {
  try {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } finally {
    process.exit(code);
  }
}

function getOptions() {
  try {
    const parsed = JSON.parse(process.env.SMB_TEST_OPTIONS || '{}');
    const host = String(parsed.host || '').trim();
    const shareName = String(parsed.shareName || '').trim();
    const username = String(parsed.username || '').trim();
    const password = String(parsed.password || '');
    const domain = String(parsed.domain || '').trim();
    const port = Number(parsed.port) || 445;
    const targetPath = String(parsed.path || '').trim();

    return {
      client: {
        share: `\\\\${host}\\${shareName}`,
        domain,
        username,
        password,
        port,
        autoCloseTimeout: 2000
      },
      targetPath
    };
  } catch (error) {
    exitJson(1, {
      ok: false,
      message: error.message || 'Invalid SMB probe configuration.'
    });
  }
}

const options = getOptions();
let client = null;
let finished = false;

function closeClient() {
  if (!client) return;
  try {
    client.close();
  } catch (_) {
    // Ignore close failures after probe completion.
  }
}

function fail(error) {
  if (finished) return;
  finished = true;
  closeClient();
  exitJson(1, {
    ok: false,
    message: error && error.message ? error.message : String(error || 'Unknown SMB error'),
    code: error && error.code ? error.code : null
  });
}

process.once('uncaughtException', fail);
process.once('unhandledRejection', fail);

const timeout = setTimeout(() => {
  fail(new Error('SMB test timed out.'));
}, 12000);

client = new SMB2(options.client);
client.readdir(options.targetPath, (error, files) => {
  if (finished) return;
  clearTimeout(timeout);
  if (error) {
    return fail(error);
  }
  finished = true;
  closeClient();
  exitJson(0, {
    ok: true,
    targetPath: options.targetPath || '\\',
    fileCount: Array.isArray(files) ? files.length : 0,
    sample: Array.isArray(files) ? files.slice(0, 5) : []
  });
});
