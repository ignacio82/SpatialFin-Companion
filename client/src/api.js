// Thin wrapper around the SpatialFin Companion admin API.
// All endpoints live under /api/admin/* and rely on session cookies set by /api/admin/login
// plus CSRF header `X-Companion-Admin: 1` and RFC 9110 `If-Match` optimistic locking.

async function request(method, path, body, options = {}) {
  const upperMethod = String(method || 'GET').toUpperCase();
  const headers = {
    'X-Companion-Admin': '1',
    ...(options.headers || {}),
  };

  if (options.expectedVersion !== undefined && options.expectedVersion !== null) {
    headers['If-Match'] = `"${options.expectedVersion}"`;
  }

  let serializedBody;
  if (upperMethod === 'DELETE') {
    // Truly bodyless DELETE: omit Content-Type so Express 5 / H2->H1 proxies never 415/400.
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      serializedBody = JSON.stringify(body);
    }
  } else if (upperMethod !== 'GET' && upperMethod !== 'HEAD' && upperMethod !== 'OPTIONS') {
    headers['Content-Type'] = 'application/json';
    serializedBody = body !== undefined ? JSON.stringify(body) : '{}';
  }

  const opts = {
    method: upperMethod,
    headers,
    credentials: 'same-origin',
  };
  if (serializedBody !== undefined) opts.body = serializedBody;
  if (options.signal) opts.signal = options.signal;

  const res = await fetch(path, opts);
  let payload = null;
  const text = await res.text();
  if (text) {
    try { payload = JSON.parse(text); } catch (_) { payload = text; }
  }
  if (!res.ok) {
    const err = new Error((payload && (payload.error || payload.message)) || res.statusText || `HTTP ${res.status}`);
    err.status = res.status;
    err.errorCode = (payload && payload.error_code) || null;
    err.payload = payload;
    throw err;
  }
  return payload;
}

export const api = {
  // Meta + auth
  meta:              ()                      => request('GET',  '/api/meta'),
  authCheck:         ()                      => request('GET',  '/api/admin/auth-check'),
  login:             (password, remember = false) => request('POST', '/api/admin/login', { password, remember }),
  logout:            ()                      => request('POST', '/api/admin/logout'),
  bootstrapPassword: (body)                  => request('POST', '/api/admin/bootstrap-password', body),

  // Config
  getConfig:         ()                      => request('GET',  '/api/admin/config'),
  setConfig:         (patch, expectedVersion) => request('POST', '/api/admin/config', patch, { expectedVersion }),
  diagnostics:       ()                      => request('GET',  '/api/admin/diagnostics'),

  // QR + token
  getQr:             ()                      => request('GET',  '/api/admin/qr'),
  rotateToken:       ()                      => request('POST', '/api/admin/rotate-token'),

  // Snapshots, import/export
  listSnapshots:     ()                      => request('GET',  '/api/admin/config/snapshots'),
  restoreSnapshot:   (id, expectedVersion)   => request('POST', '/api/admin/config/snapshots/restore', { id }, { expectedVersion }),
  importConfig:      (cfg, expectedVersion)  => request('POST', '/api/admin/config/import', cfg, { expectedVersion }),
  exportConfigUrl:   ()                      => '/api/admin/config/export',

  // Sync log
  syncLog:           ()                      => request('GET',  '/api/admin/sync-log'),

  // Devices
  patchDevice:       (id, body)              => request('PATCH',  '/api/admin/devices/' + encodeURIComponent(id), body),
  deleteDevice:      (id)                    => request('DELETE', '/api/admin/devices/' + encodeURIComponent(id)),
  setDevicePrefs:    (id, p, expectedVersion) => request('PUT',   '/api/admin/device-preferences/' + encodeURIComponent(id), p, { expectedVersion }),
  clearDevicePrefs:  (id, expectedVersion)   => request('DELETE', '/api/admin/device-preferences/' + encodeURIComponent(id), undefined, { expectedVersion }),

  // Device logs
  deviceLogs:        ()                      => request('GET',    '/api/admin/device-logs'),
  deviceLogLines:    (id, limit)             => request('GET',    '/api/admin/device-logs/' + encodeURIComponent(id) + (limit ? '?limit=' + limit : '')),
  clearDeviceLogs:   (id)                    => request('DELETE', '/api/admin/device-logs/' + encodeURIComponent(id)),
  pruneDeviceLogs:   (olderThanDays)         => request('POST',   '/api/admin/device-logs/prune', { olderThanDays }),
  deviceLogDownloadUrl: (id)                 => '/api/admin/device-logs/' + encodeURIComponent(id) + '/download',

  // Network shares
  testShare:         (body)                  => request('POST', '/api/admin/test-network-share', body),
  discoverShares:    (body = {})             => request('POST', '/api/admin/discover-network-shares', body),
  discoverSmb:       (body)                  => request('POST', '/api/admin/discover-smb-server-shares', body),
  discoverNfs:       (body)                  => request('POST', '/api/admin/discover-nfs-exports', body),

  // Verification + Quick Connect + tests
  verifyUser:        (body, expectedVersion) => request('POST', '/api/admin/verify-user', body, { expectedVersion }),
  unlinkUser:        (body, expectedVersion) => request('POST', '/api/admin/unlink-user', body, { expectedVersion }),
  quickConnectInitiate: (body)               => request('POST', '/api/admin/quick-connect/initiate', body),
  quickConnectPoll:     (body)               => request('POST', '/api/admin/quick-connect/poll', body),
  quickConnectCancel:   (pendingId)          => request('POST', '/api/admin/quick-connect/cancel', { pendingId }),
  testJellyfin:      (body)                  => request('POST', '/api/admin/test-jellyfin', body),
  testSeerr:         (body)                  => request('POST', '/api/admin/test-seerr', body),

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
  analyticsHistory:  (limit = 120)           => request('GET',    '/api/admin/analytics/history?limit=' + limit),
  analyticsSession:  (id)                    => request('GET',    '/api/admin/analytics/sessions/' + encodeURIComponent(id) + '?limit=200'),
  analyticsSyncNow:  ()                      => request('POST',   '/api/admin/analytics/sync-now'),
  analyticsRealtimeStatus: ()                => request('GET',    '/api/admin/analytics/realtime-status'),
  analyticsSyncStatus:     ()                => request('GET',    '/api/admin/analytics/sync-status'),
  deleteAnalyticsSession:  (id)              => request('DELETE', '/api/admin/analytics/sessions/' + encodeURIComponent(id)),
  deleteAnalyticsHistory:  ()                => request('DELETE', '/api/admin/analytics/history'),
  pruneAnalytics:    (body)                  => request('POST',   '/api/admin/analytics/prune', body),
  analyticsArtworkUrl: (serverId, itemId)    =>
    '/api/admin/analytics/artwork/' + encodeURIComponent(serverId) + '/' + encodeURIComponent(itemId),

  // Database
  databaseStats:     ()                      => request('GET',  '/api/admin/database/stats'),
  databaseVacuum:    ()                      => request('POST', '/api/admin/database/vacuum'),

  // Device setup & TV pairing
  tvSubnetHint:      ()                      => request('GET',  '/api/admin/tv-pairing/subnet-hint'),
  tvDiscover:        (body = {})             => request('POST', '/api/admin/tv-pairing/discover', body),
  tvResolve:         (body)                  => request('POST', '/api/admin/tv-pairing/resolve', body),
  deviceSetupHandoff: (payload)              => request('POST', '/api/admin/device-setup/handoff', payload, {
    signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(32_000)
      : undefined,
  }),
};
