const test = require('node:test');
const assert = require('node:assert/strict');

const { parseSmbClientListing } = require('../share-test-utils');

test('parseSmbClientListing handles classic smbclient ls output', () => {
  const stdout = [
    '  .                                  DA        0  Sat Mar 14 18:33:31 2026',
    '  ..                                  D        0  Tue Mar 24 16:09:18 2026',
    '  Big Buck Bunny (2008) [4K UHD 2160p].mp4      A 673223862  Sat Mar 14 00:45:45 2026',
    '  Big Buck Bunny (2008) [4K UHD 2160p].nfo      A     2961  Thu Mar 26 21:51:06 2026',
    '',
    '\t\t17790731552 blocks of size 1024. 6302956920 blocks available'
  ].join('\n');

  assert.deepEqual(parseSmbClientListing(stdout), [
    'Big Buck Bunny (2008) [4K UHD 2160p].mp4',
    'Big Buck Bunny (2008) [4K UHD 2160p].nfo'
  ]);
});

test('parseSmbClientListing handles pipe-delimited smbclient output', () => {
  const stdout = [
    'A|movie.mkv|12345|Sat Mar 14 00:45:45 2026',
    'D|Anime|0|Sat Mar 14 00:45:45 2026',
    'D|.|0|Sat Mar 14 00:45:45 2026',
    'D|..|0|Sat Mar 14 00:45:45 2026'
  ].join('\n');

  assert.deepEqual(parseSmbClientListing(stdout), ['movie.mkv', 'Anime']);
});
