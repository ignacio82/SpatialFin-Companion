import { useEffect, useMemo, useState, useCallback } from 'react';
import Icon from '../components/Icon.jsx';
import StatTile from '../components/StatTile.jsx';
import QrPaper from '../components/QrPaper.jsx';
import Sparkline from '../components/Sparkline.jsx';
import { api } from '../api.js';
import { useWebSocketEvent } from '../ws.js';
import { fmtBytes, fmtMinutes, ago, shortAgo, fmtTime } from '../format.js';

export default function Dashboard({ config, version, onNavigate, onToast }) {
  const [tokenVisible, setTokenVisible] = useState(false);
  const [qr, setQr] = useState(null);
  const [overview, setOverview] = useState(null);
  const [trend, setTrend] = useState([]);
  const [recentSessions, setRecentSessions] = useState([]);
  const [realtimeSockets, setRealtimeSockets] = useState([]);
  const [sync, setSync] = useState(null);
  const [history, setHistory] = useState([]);
  const [dbStats, setDbStats] = useState(null);
  const [devices, setDevices] = useState([]);

  const reloadAnalytics = useCallback(async () => {
    try {
      const data = await api.analyticsOverview({ recentLimit: 8, topLimit: 5, trendLimit: 14, days: 30 });
      setOverview(data.overview || null);
      setTrend(Array.isArray(data.trends) ? data.trends : []);
      setRecentSessions(Array.isArray(data.recentSessions) ? data.recentSessions : []);
      setRealtimeSockets(Array.isArray(data.realtimeSockets) ? data.realtimeSockets : []);
      setSync(data.sync || null);
    } catch (_) {
      /* leave previous state */
    }
  }, []);

  useEffect(() => {
    api.getQr(window.location.hostname).then(setQr).catch(() => {});
    api.syncLog().then((d) => setHistory(Array.isArray(d) ? d : (d?.entries || []))).catch(() => setHistory([]));
    api.databaseStats().then(setDbStats).catch(() => {});
    api.deviceLogs().then((d) => setDevices(Array.isArray(d?.devices) ? d.devices : (Array.isArray(d) ? d : []))).catch(() => {});
    reloadAnalytics();
  }, [reloadAnalytics]);

  useWebSocketEvent('analytics_sessions_ingested', reloadAnalytics);
  useWebSocketEvent('analytics_sync_completed', reloadAnalytics);

  const setupToken = config?.setup_token || '';
  const sparkSessions = useMemo(() => {
    if (!trend.length) return [0, 0];
    return trend.map((d) => Number(d.sessions || d.sessionCount || 0));
  }, [trend]);
  const sparkMinutes = useMemo(() => {
    if (!trend.length) return [0, 0];
    return trend.map((d) => Math.round(Number(d.minutes || (d.totalPlayDurationMs ? d.totalPlayDurationMs / 60000 : 0))));
  }, [trend]);

  const serverList = Array.isArray(config?.servers) ? config.servers : [];
  const verifiedUsers = serverList.reduce(
    (acc, s) => acc + (Array.isArray(s.users) ? s.users.filter((u) => u && u.access_token).length : 0),
    0
  );
  const onlineServers = serverList.filter((s) => s && s.online !== false).length;
  const shareList = Array.isArray(config?.networkShares) ? config.networkShares : [];
  const sharesCount = shareList.length;
  const mountedShares = shareList.filter((s) => s && s.status === 'mounted').length;
  const liveSockets = realtimeSockets.filter((s) => (s.state || s.status) === 'connected' || s.connected === true).length;
  const totalSockets = realtimeSockets.length;

  async function rotateToken() {
    try {
      await api.rotateToken();
      onToast?.('Setup token rotated', 'success');
    } catch (e) {
      onToast?.('Failed to rotate token: ' + e.message, 'error');
    }
  }

  async function copyToken() {
    try {
      await navigator.clipboard.writeText(setupToken);
      onToast?.('Token copied', 'success');
    } catch (_) {
      onToast?.('Copy failed', 'error');
    }
  }

  const nowPlaying = recentSessions.find((s) => s.completed === 0 || s.completed === false) || null;
  const npProgress = nowPlaying && nowPlaying.runtimeTicks
    ? Math.max(0, Math.min(1, Number(nowPlaying.positionTicks || 0) / Number(nowPlaying.runtimeTicks)))
    : 0;

  return (
    <div className="col" style={{ gap: 14 }} data-screen-label="01 Dashboard">

      {/* ── Hero ────────────────────────────────────────────────────────── */}
      <div className="hero">
        <div
          className="hero-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) 260px minmax(0, 1fr)',
            gap: 28,
            alignItems: 'center',
          }}
        >
          {/* Left — status, env */}
          <div className="col" style={{ gap: 14, position: 'relative', zIndex: 1 }}>
            <div className="eyebrow">Companion Status</div>
            <div className="row" style={{ gap: 10 }}>
              <span className="dot ok" style={{ width: 9, height: 9 }}/>
              <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--t-0)' }}>Online</span>
              {version && <span className="chip ghost">v{version}</span>}
            </div>
            <div style={{ fontSize: 12, color: 'var(--t-2)', maxWidth: 280, lineHeight: 1.5 }}>
              Listening on{' '}
              <span className="mono" style={{ color: 'var(--t-0)' }}>
                {typeof window !== 'undefined' ? window.location.host : 'companion.lan:1982'}
              </span>{' '}
              {onlineServers > 0 && <>· <span className="tnum">{onlineServers}</span> servers paired · </>}
              {totalSockets > 0 ? (
                <span style={{ color: liveSockets === totalSockets ? 'var(--ok)' : 'var(--warn)' }}>
                  {liveSockets} of {totalSockets} sockets live
                </span>
              ) : (
                <span style={{ color: 'var(--t-3)' }}>no live sockets yet</span>
              )}
            </div>
            <div className="divider"/>

            <div className="eyebrow">Setup Token</div>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <div
                className="mono"
                style={{
                  padding: '8px 12px',
                  background: 'rgba(0,0,0,0.35)',
                  border: '1px solid var(--stroke-1)',
                  borderRadius: 8,
                  fontSize: 11.5,
                  color: tokenVisible ? 'var(--teal-bright)' : 'var(--t-2)',
                  letterSpacing: '0.04em',
                  flex: '1 1 auto',
                  minWidth: 0,
                  wordBreak: 'break-all',
                }}
              >
                {tokenVisible
                  ? (setupToken || 'no token configured')
                  : (setupToken ? setupToken.slice(0, 6) + '•'.repeat(Math.max(0, setupToken.length - 6)) : '—')}
              </div>
              <button className="btn icon-only sm" onClick={() => setTokenVisible((v) => !v)} title="Reveal token">
                <Icon name="eye" size={13}/>
              </button>
              <button className="btn icon-only sm" onClick={copyToken} title="Copy token" disabled={!setupToken}>
                <Icon name="copy" size={13}/>
              </button>
              <button className="btn sm" onClick={rotateToken} title="Rotate token">
                <Icon name="rotate" size={13}/> Rotate
              </button>
            </div>
          </div>

          {/* Center — QR */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 12,
              position: 'relative',
              zIndex: 2,
            }}
          >
            <div className="qr-shell">
              <QrPaper dataUrl={qr?.qr || qr?.dataUrl}/>
            </div>
            <div className="row" style={{ gap: 6 }}>
              <span className="chip teal uc">
                <span className="dot"/> Scanning Open
              </span>
            </div>
            <div
              className="mono"
              style={{
                fontSize: 10.5,
                color: 'var(--t-3)',
                textAlign: 'center',
                maxWidth: 240,
                lineHeight: 1.45,
                wordBreak: 'break-all',
              }}
            >
              {qr?.payload || 'spatialfin://pair?…'}
            </div>
          </div>

          {/* Right — quick actions */}
          <div className="col" style={{ gap: 14, position: 'relative', zIndex: 1 }}>
            <div className="eyebrow">Pair Device</div>
            <div style={{ fontSize: 12.5, color: 'var(--t-1)', lineHeight: 1.5, maxWidth: 280 }}>
              Open SpatialFin on a headset and scan the code, or pair a Google TV by code from this companion.
            </div>
            <div className="col" style={{ gap: 8 }}>
              <button className="btn primary" onClick={() => onNavigate?.('servers')}>
                <Icon name="headset" size={14}/> XR Headset
              </button>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn" style={{ flex: 1 }} onClick={() => onNavigate?.('servers')}>
                  <Icon name="tv" size={14}/> TV Pairing
                </button>
                <button className="btn" style={{ flex: 1 }} onClick={() => onNavigate?.('settings')}>
                  <Icon name="settings" size={14}/> Settings
                </button>
              </div>
            </div>
            <div className="divider"/>
            <div className="row between">
              <div>
                <div style={{ fontSize: 11.5, color: 'var(--t-2)' }}>Last sync</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-0)' }}>
                  {history[0]?.timestamp || history[0]?.at ? ago(history[0].timestamp || history[0].at) : '—'}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11.5, color: 'var(--t-2)', textAlign: 'right' }}>Paired devices</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-0)', textAlign: 'right' }}>
                  <span className="tnum">{devices.length}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Stats ───────────────────────────────────────────────────────── */}
      <div className="grid cols-5">
        <StatTile
          label="Servers"
          icon="server"
          value={onlineServers || (config?.servers ? Object.keys(config.servers).length : 0)}
          hint={onlineServers ? 'all online' : 'configure under Servers'}
          spark={[onlineServers, onlineServers, onlineServers, onlineServers, onlineServers, onlineServers, onlineServers]}
          sparkColor="rgba(0,164,220,0.85)"
        />
        <StatTile
          label="Users"
          icon="users"
          value={verifiedUsers}
          hint="verified"
          spark={[verifiedUsers, verifiedUsers, verifiedUsers, verifiedUsers, verifiedUsers, verifiedUsers, verifiedUsers]}
          sparkColor="rgba(95,209,255,0.85)"
        />
        <StatTile
          label="Shares"
          icon="share"
          value={sharesCount}
          hint={`${mountedShares} mounted`}
          spark={[sharesCount, sharesCount, sharesCount, sharesCount, sharesCount, sharesCount, sharesCount]}
          sparkColor="rgba(180,160,255,0.85)"
        />
        <StatTile
          label="Devices"
          icon="headset"
          value={devices.length}
          hint={devices.filter((d) => (d.status || d.lastStatus) === 'stale').length ? 'some stale' : 'all healthy'}
          spark={[devices.length, devices.length, devices.length, devices.length, devices.length, devices.length, devices.length]}
          sparkColor="rgba(160,230,200,0.85)"
        />
        <StatTile
          label="Sessions"
          icon="play"
          value={overview?.totalSessions ?? 0}
          hint="last 30d"
          spark={sparkSessions}
          sparkColor="rgba(255,186,111,0.85)"
        />
      </div>

      {/* ── Now playing strip ───────────────────────────────────────────── */}
      {nowPlaying && (
        <div className="card elev-2" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'stretch', gap: 0 }}>
            <div style={{ width: 8, background: 'linear-gradient(180deg, #5fd1ff, transparent)' }}/>
            <div
              style={{
                padding: '14px 18px',
                display: 'flex',
                alignItems: 'center',
                gap: 18,
                flex: 1,
                flexWrap: 'wrap',
              }}
            >
              <div className="row" style={{ gap: 10 }}>
                <Icon name="play" size={14} style={{ color: 'var(--teal-bright)' }}/>
                <span className="eyebrow" style={{ color: 'var(--teal-bright)' }}>Now Playing</span>
              </div>
              <div className="row" style={{ gap: 12, flex: 1, minWidth: 220 }}>
                <div
                  className="poster"
                  style={{
                    width: 28,
                    height: 42,
                    background: 'linear-gradient(135deg, #4a6fa5, #1c2a45)',
                  }}
                >
                  {(nowPlaying.itemName || '').split(' ').map((w) => w[0]).slice(0, 2).join('')}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      fontSize: 13.5,
                      fontWeight: 600,
                      color: 'var(--t-0)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {nowPlaying.itemName}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--t-2)' }}>
                    {nowPlaying.username || '?'} · {nowPlaying.clientName || '?'} · {nowPlaying.playbackMethod || '?'}
                  </div>
                </div>
              </div>
              <div style={{ width: 220 }}>
                <div
                  className="row between"
                  style={{ marginBottom: 4, fontSize: 10.5, color: 'var(--t-2)' }}
                >
                  <span className="tnum">{Math.round(npProgress * 100)}%</span>
                  <span className="tnum">{fmtMinutes((nowPlaying.playDurationMs || 0) / 60000)}</span>
                </div>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: (npProgress * 100) + '%' }}/>
                </div>
              </div>
              <button className="btn sm" onClick={() => onNavigate?.('analytics')}>
                Inspect →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Sync history + DB ──────────────────────────────────────────── */}
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, 1fr)' }}>
        <div className="card">
          <div className="card-head">
            <div className="titlewrap">
              <span className="eyebrow">Live</span>
              <span className="title">Sync History</span>
            </div>
            <div className="right">
              <span className="chip">{history.length} events</span>
              <button
                className="btn sm icon-only"
                title="Refresh"
                onClick={() => api.syncLog().then((d) => setHistory(Array.isArray(d) ? d : (d?.entries || []))).catch(() => {})}
              >
                <Icon name="refresh" size={13}/>
              </button>
            </div>
          </div>
          {history.length === 0 ? (
            <div className="empty">No sync events yet — pair a headset to start the conversation.</div>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 110 }}>Time</th>
                  <th>Device · User Agent</th>
                  <th style={{ width: 140 }}>IP</th>
                </tr>
              </thead>
              <tbody>
                {history.slice(0, 8).map((row, i) => (
                  <tr key={i}>
                    <td className="mono muted">{fmtTime(row.timestamp || row.at)}</td>
                    <td>
                      <div className="row" style={{ gap: 8 }}>
                        <span className="dot teal"/>
                        <span>{row.userAgent || row.agent || row.deviceName || 'unknown'}</span>
                      </div>
                    </td>
                    <td className="mono muted">{row.ip || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="col" style={{ gap: 14 }}>
          <div className="card">
            <div className="card-head">
              <div className="titlewrap">
                <span className="eyebrow">Backup</span>
                <span className="title">Config Management</span>
              </div>
            </div>
            <div className="col" style={{ gap: 10 }}>
              <div className="row" style={{ gap: 8 }}>
                <a className="btn sm" href={api.exportConfigUrl()} style={{ flex: 1, textDecoration: 'none' }}>
                  <Icon name="download" size={13}/> Export
                </a>
                <button className="btn sm" style={{ flex: 1 }} onClick={() => onNavigate?.('settings')}>
                  <Icon name="upload" size={13}/> Import
                </button>
              </div>
              <div className="row between" style={{ fontSize: 11, color: 'var(--t-2)' }}>
                <span>Last sync</span>
                <span className="mono">{sync?.lastSuccessAt ? ago(sync.lastSuccessAt) : '—'}</span>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <div className="titlewrap">
                <span className="eyebrow">Storage</span>
                <span className="title">Database</span>
              </div>
              <div className="right">
                <span className="chip">SQLite</span>
              </div>
            </div>
            <div className="col" style={{ gap: 10 }}>
              <div className="row between">
                <span className="muted">File size</span>
                <span className="tnum" style={{ fontWeight: 600 }}>{fmtBytes(dbStats?.fileSizeBytes)}</span>
              </div>
              <div className="bar-track">
                <div
                  className="bar-fill green"
                  style={{
                    width: Math.min(100, Math.round((Number(dbStats?.fileSizeBytes || 0) / (1024 * 1024 * 1024)) * 100)) + '%',
                  }}
                />
              </div>
              <div className="row between" style={{ fontSize: 11, color: 'var(--t-3)' }}>
                <span>Sessions: {(dbStats?.counts?.playbackSessions ?? 0).toLocaleString()}</span>
                <span>Events: {(dbStats?.counts?.playbackSessionEvents ?? 0).toLocaleString()}</span>
                <span>Logs: {(dbStats?.counts?.deviceLogs ?? 0).toLocaleString()}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Trend strip (compact) ───────────────────────────────────────── */}
      <div className="card">
        <div className="card-head">
          <div className="titlewrap">
            <span className="eyebrow">14-day trend</span>
            <span className="title">Daily watch minutes</span>
          </div>
          <div className="right">
            <button className="btn sm ghost" onClick={() => onNavigate?.('analytics')}>
              Open Analytics →
            </button>
          </div>
        </div>
        {sparkMinutes.length > 1 ? (
          <Sparkline data={sparkMinutes} w={1200} h={56} color="#5fd1ff" fill="rgba(95,209,255,0.18)" stroke={2}/>
        ) : (
          <div className="empty">Trend will appear once you have a few sessions.</div>
        )}
      </div>
    </div>
  );
}
