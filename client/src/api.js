// Thin wrapper around the SpatialFin Companion admin API.
// All endpoints live under /api/admin/* and rely on session cookies set by /api/admin/login.

async function request(method, path, body) {
  const opts = {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    credentials: 'same-origin',
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  let payload = null;
  const text = await res.text();
  if (text) {
    try { payload = JSON.parse(text); } catch (_) { payload = text; }
  }
  if (!res.ok) {
    const err = new Error((payload && payload.error) || res.statusText || `HTTP ${res.status}`);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

export const api = {
  // Meta + auth
  meta:        ()          => request('GET',  '/api/meta'),
  authCheck:   ()          => request('GET',  '/api/admin/auth-check'),
  login:       (password)  => request('POST', '/api/admin/login', { password }),
  logout:      ()          => request('POST', '/api/admin/logout'),

  // Config
  getConfig:   ()          => request('GET',  '/api/admin/config'),
  setConfig:   (cfg)       => request('POST', '/api/admin/config', cfg),

  // QR + token
  getQr:       (host)      => request('GET',  '/api/admin/qr' + (host ? '?host=' + encodeURIComponent(host) : '')),
  rotateToken: ()          => request('POST', '/api/admin/rotate-token'),

  // Snapshots, import/export
  listSnapshots:   ()      => request('GET',  '/api/admin/config/snapshots'),
  restoreSnapshot: (id)    => request('POST', '/api/admin/config/snapshots/restore', { id }),
  importConfig:    (cfg)   => request('POST', '/api/admin/config/import', cfg),
  exportConfigUrl: ()      => '/api/admin/config/export',

  // Sync log
  syncLog:     ()          => request('GET',  '/api/admin/sync-log'),

  // Devices
  patchDevice: (id, body)  => request('PATCH',  '/api/admin/devices/' + encodeURIComponent(id), body),
  deleteDevice:(id)        => request('DELETE', '/api/admin/devices/' + encodeURIComponent(id)),
  setDevicePrefs: (id, p)  => request('PUT',    '/api/admin/device-preferences/' + encodeURIComponent(id), p),
  clearDevicePrefs: (id)   => request('DELETE', '/api/admin/device-preferences/' + encodeURIComponent(id)),

  // Device logs
  deviceLogs:        ()           => request('GET',    '/api/admin/device-logs'),
  deviceLogLines:    (id, limit)  => request('GET',    '/api/admin/device-logs/' + encodeURIComponent(id) + (limit ? '?limit=' + limit : '')),
  clearDeviceLogs:   (id)         => request('DELETE', '/api/admin/device-logs/' + encodeURIComponent(id)),
  pruneDeviceLogs:   (days)       => request('POST',   '/api/admin/device-logs/prune', { days }),
  deviceLogDownloadUrl: (id)      => '/api/admin/device-logs/' + encodeURIComponent(id) + '/download',

  // Network shares
  testShare:         (body)       => request('POST', '/api/admin/test-network-share', body),
  discoverShares:    (body)       => request('POST', '/api/admin/discover-network-shares', body),
  discoverSmb:       (body)       => request('POST', '/api/admin/discover-smb-server-shares', body),
  discoverNfs:       (body)       => request('POST', '/api/admin/discover-nfs-exports', body),

  // Verification + tests
  verifyUser:        (body)       => request('POST', '/api/admin/verify-user', body),
  testJellyfin:      (body)       => request('POST', '/api/admin/test-jellyfin', body),
  testSeerr:         (body)       => request('POST', '/api/admin/test-seerr', body),

  // Analytics
  analyticsOverview: (opts = {}) => {
    const q = new URLSearchParams();
    if (opts.recentLimit != null) q.set('recentLimit', opts.recentLimit);
    if (opts.topLimit    != null) q.set('topLimit',    opts.topLimit);
    if (opts.trendLimit  != null) q.set('trendLimit',  opts.trendLimit);
    if (opts.days        != null) q.set('days',        opts.days);
    const qs = q.toString();
    return request('GET', '/api/admin/analytics/overview' + (qs ? '?' + qs : ''));
  },
  analyticsHistory:  (limit = 120) => request('GET',    '/api/admin/analytics/history?limit=' + limit),
  analyticsSession:  (id)          => request('GET',    '/api/admin/analytics/sessions/' + encodeURIComponent(id) + '?limit=200'),
  analyticsSyncNow:  ()            => request('POST',   '/api/admin/analytics/sync-now'),
  analyticsRealtimeStatus: ()      => request('GET',    '/api/admin/analytics/realtime-status'),
  analyticsSyncStatus:     ()      => request('GET',    '/api/admin/analytics/sync-status'),
  deleteAnalyticsSession:  (id)    => request('DELETE', '/api/admin/analytics/sessions/' + encodeURIComponent(id)),
  deleteAnalyticsHistory:  ()      => request('DELETE', '/api/admin/analytics/history'),
  pruneAnalytics:    (body)        => request('POST',   '/api/admin/analytics/prune', body),
  analyticsArtworkUrl: (serverId, itemId) =>
    '/api/admin/analytics/artwork/' + encodeURIComponent(serverId) + '/' + encodeURIComponent(itemId),

  // Database
  databaseStats:     ()            => request('GET',  '/api/admin/database/stats'),
  databaseVacuum:    ()            => request('POST', '/api/admin/database/vacuum'),

  // TV pairing
  tvSubnetHint:      ()            => request('GET',  '/api/admin/tv-pairing/subnet-hint'),
  tvDiscover:        (body)        => request('POST', '/api/admin/tv-pairing/discover', body),
  tvResolve:         (body)        => request('POST', '/api/admin/tv-pairing/resolve', body),
  tvPairQr:          (body)        => request('POST', '/api/admin/tv-pairing/pair-qr', body),
  tvPairManual:      (body)        => request('POST', '/api/admin/tv-pairing/pair-manual', body),
};
