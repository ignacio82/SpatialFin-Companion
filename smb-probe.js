'use strict';

const net = require('node:net');
const SMB2 = require('smb2');

function exitJson(code, payload) {
  try {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } finally {
    process.exit(code);
  }
}

function readStdinJson() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    const maxBytes = 64 * 1024;
    process.stdin.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        reject(new Error('SMB probe stdin payload too large.'));
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.once('error', reject);
    process.stdin.once('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

function buildOptions(parsed) {
  const host = String(parsed.host || '').trim();
  if (net.isIP(host) !== 4) {
    throw new Error('SMB probe requires a pinned IPv4 address.');
  }
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
}

let client = null;
let finished = false;
let timeout = null;

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
  if (timeout) clearTimeout(timeout);
  closeClient();
  exitJson(1, {
    ok: false,
    message: error && error.message ? error.message : String(error || 'Unknown SMB error'),
    code: error && error.code ? error.code : null
  });
}

process.once('uncaughtException', fail);
process.once('unhandledRejection', fail);

timeout = setTimeout(() => {
  fail(new Error('SMB test timed out.'));
}, 12000);

readStdinJson()
  .then((parsed) => {
    const options = buildOptions(parsed);
    client = new SMB2(options.client);
    client.readdir(options.targetPath, (error, files) => {
      if (finished) return;
      if (timeout) clearTimeout(timeout);
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
  })
  .catch(fail);
