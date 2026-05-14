import { useCallback, useEffect, useMemo, useState } from 'react';
import Icon from '../components/Icon.jsx';
import Segmented from '../components/Segmented.jsx';
import Sparkline from '../components/Sparkline.jsx';
import Donut from '../components/Donut.jsx';
import TrendChart from '../components/TrendChart.jsx';
import StatusDot from '../components/StatusDot.jsx';
import { api } from '../api.js';
import { useWebSocketEvent } from '../ws.js';
import { fmtMinutes, ago, hashColor, initials } from '../format.js';

function normalizeTrend(trends) {
  if (!Array.isArray(trends)) return [];
  return trends.map((t) => ({
    date: t.date || t.day || '',
    minutes: Math.round(Number(t.minutes ?? (t.totalPlayDurationMs ? t.totalPlayDurationMs / 60000 : 0))),
    sessions: Number(t.sessions ?? t.sessionCount ?? 0),
  }));
}

export default function Analytics({ onToast }) {
  const [range, setRange] = useState('30');
  const [data, setData] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyQ, setHistoryQ] = useState('');
  const [historyUser, setHistoryUser] = useState('');
  const [pruneDays, setPruneDays] = useState(90);
  const [dbStats, setDbStats] = useState(null);

  const load = useCallback(async () => {
    try {
      const overview = await api.analyticsOverview({
        recentLimit: 30,
        topLimit: 8,
        trendLimit: 30,
        days: Number(range),
      });
      setData(overview);
      if (!selectedId && overview.recentSessions && overview.recentSessions[0]) {
        setSelectedId(overview.recentSessions[0].playbackSessionId);
      }
    } catch (e) {
      setData((prev) => prev || { error: e.message });
    }
  }, [range, selectedId]);

  const loadHistory = useCallback(async () => {
    try {
      const url = `/api/admin/analytics/history?limit=120&days=${encodeURIComponent(range)}&user=${encodeURIComponent(historyUser)}&item=${encodeURIComponent(historyQ)}`;
      const res = await fetch(url, { credentials: 'same-origin' });
      const json = await res.json();
      setHistory(Array.isArray(json.history) ? json.history : []);
    } catch (_) { /* ignore */ }
  }, [range, historyQ, historyUser]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadHistory(); }, [loadHistory]);
  useEffect(() => { api.databaseStats().then(setDbStats).catch(() => {}); }, []);

  useWebSocketEvent('analytics_sessions_ingested', load);
  useWebSocketEvent('analytics_sync_completed', load);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    api.analyticsSession(selectedId).then(setDetail).catch(() => setDetail(null));
  }, [selectedId]);

  const overview = data?.overview;
  const trend = useMemo(() => normalizeTrend(data?.trends), [data]);
  const recent = Array.isArray(data?.recentSessions) ? data.recentSessions : [];
  const sockets = Array.isArray(data?.realtimeSockets) ? data.realtimeSockets : [];
  const topUsers = Array.isArray(data?.topUsers) ? data.topUsers : [];
  const topLibraries = Array.isArray(data?.topLibraries) ? data.topLibraries : [];
  const topItems = Array.isArray(data?.topItems) ? data.topItems : [];
  const topServers = Array.isArray(data?.topServers) ? data.topServers : [];

  const totalMinutes = overview ? Math.round((overview.totalPlayDurationMs || 0) / 60000) : 0;
  const completion = overview && overview.totalSessions
    ? (overview.completedSessions || 0) / overview.totalSessions
    : 0;

  async function syncNow() {
    try {
      await api.analyticsSyncNow();
      onToast?.('Analytics sync started', 'success');
      setTimeout(load, 800);
    } catch (e) {
      onToast?.('Sync failed: ' + e.message, 'error');
    }
  }

  async function deleteHistoryEntry(id) {
    if (!confirm('Delete this history entry?')) return;
    try {
      await api.deleteAnalyticsSession(id);
      loadHistory();
      load();
    } catch (e) { onToast?.('Delete failed: ' + e.message, 'error'); }
  }

  async function prunePlayback() {
    if (!confirm(`Prune playback older than ${pruneDays} days?`)) return;
    try {
      await api.pruneAnalytics({ days: Number(pruneDays) });
      onToast?.('Playback pruned', 'success');
      load();
      api.databaseStats().then(setDbStats).catch(() => {});
    } catch (e) { onToast?.('Prune failed: ' + e.message, 'error'); }
  }

  async function pruneLogs() {
    if (!confirm(`Prune device logs older than ${pruneDays} days?`)) return;
    try {
      await api.pruneDeviceLogs(Number(pruneDays));
      onToast?.('Device logs pruned', 'success');
      api.databaseStats().then(setDbStats).catch(() => {});
    } catch (e) { onToast?.('Prune failed: ' + e.message, 'error'); }
  }

  async function vacuum() {
    if (!confirm('Run VACUUM on the database? This locks the DB briefly.')) return;
    try {
      await api.databaseVacuum();
      onToast?.('Reclaimed unused space', 'success');
      api.databaseStats().then(setDbStats).catch(() => {});
    } catch (e) { onToast?.('Vacuum failed: ' + e.message, 'error'); }
  }

  return (
    <div className="col" style={{ gap: 14 }} data-screen-label="02 Analytics">

      {/* Top bar */}
      <div className="card elev-2" style={{ padding: 16 }}>
        <div className="row between wrap" style={{ gap: 14 }}>
          <div className="row" style={{ gap: 14 }}>
            <Segmented
              value={range}
              onChange={setRange}
              options={[
                { value: '7', label: '7d' },
                { value: '30', label: '30d' },
                { value: '90', label: '90d' },
                { value: '365', label: '1y' },
              ]}
            />
            <div className="chip ok">
              <span className="dot"/> Auto-sync · {sockets.length} live socket{sockets.length === 1 ? '' : 's'}
            </div>
            {data?.sync?.lastSuccessAt && (
              <span className="muted" style={{ fontSize: 11.5 }}>
                Last update <span className="tnum">{ago(data.sync.lastSuccessAt)}</span>
              </span>
            )}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn sm" onClick={syncNow}><Icon name="refresh" size={13}/> Sync Now</button>
          </div>
        </div>
      </div>

      {/* Hero metrics */}
      <div
        className="grid"
        style={{ gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)' }}
      >
        <div
          className="card elev-2"
          style={{ background: 'linear-gradient(135deg, rgba(0,164,220,0.16), rgba(10,16,24,0.65))' }}
        >
          <div className="eyebrow">Watch Time · last {range}d</div>
          <div className="row" style={{ alignItems: 'baseline', gap: 10, marginTop: 6 }}>
            <div
              className="tnum"
              style={{ fontSize: 38, fontWeight: 700, color: 'var(--t-0)', letterSpacing: '-0.02em' }}
            >
              {fmtMinutes(totalMinutes)}
            </div>
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
            <span className="tnum">{overview?.totalSessions ?? 0}</span> sessions ·{' '}
            <span className="tnum">
              {overview?.totalSessions
                ? Math.round(totalMinutes / overview.totalSessions) + 'm'
                : '—'}
            </span>{' '}
            avg
          </div>
          <div style={{ marginTop: 12 }}>
            {trend.length > 1 ? (
              <Sparkline data={trend.map((d) => d.minutes)} w={420} h={50} color="#5fd1ff" fill="rgba(95,209,255,0.22)" stroke={2}/>
            ) : (
              <div className="muted" style={{ fontSize: 11 }}>Not enough data for a trend yet.</div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="eyebrow">Completion Rate</div>
          <div className="row" style={{ alignItems: 'center', gap: 12, marginTop: 6 }}>
            <Donut value={completion} size={62} stroke={6} color="#5fd1ff" label={Math.round(completion * 100) + '%'}/>
            <div>
              <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
                {overview?.completedSessions ?? 0} of {overview?.totalSessions ?? 0} finished
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="eyebrow">Active Users</div>
          <div
            className="tnum"
            style={{ fontSize: 28, fontWeight: 700, color: 'var(--t-0)', letterSpacing: '-0.02em', marginTop: 6 }}
          >
            {overview?.uniqueUsers ?? 0}
          </div>
          <div className="row" style={{ marginTop: 8, gap: 6 }}>
            {topUsers.slice(0, 4).map((u, i) => (
              <div
                key={u.userId || u.username || i}
                title={u.username || u.userId}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 50,
                  border: '1px solid var(--stroke-2)',
                  background: `linear-gradient(135deg, ${hashColor(u.username || u.userId)}, hsl(0, 0%, 18%))`,
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: 9.5,
                  fontWeight: 700,
                  color: '#fff',
                  textTransform: 'uppercase',
                }}
              >
                {(u.username || u.userId || '?').slice(0, 1)}
              </div>
            ))}
          </div>
          {topUsers[0] && (
            <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
              <span style={{ color: 'var(--t-1)' }}>{topUsers[0].username || topUsers[0].userId}</span> leads with{' '}
              <span className="tnum">
                {fmtMinutes(Math.round((topUsers[0].totalPlayDurationMs || 0) / 60000))}
              </span>
            </div>
          )}
        </div>

        <div className="card">
          <div className="eyebrow">Coverage</div>
          <div className="col" style={{ gap: 6, marginTop: 6 }}>
            <div className="row between">
              <span className="muted">Servers</span>
              <span className="tnum" style={{ fontWeight: 600 }}>{topServers.length}</span>
            </div>
            <div className="row between">
              <span className="muted">Libraries</span>
              <span className="tnum" style={{ fontWeight: 600 }}>{overview?.uniqueLibraries ?? 0}</span>
            </div>
            <div className="row between">
              <span className="muted">Items</span>
              <span className="tnum" style={{ fontWeight: 600 }}>{overview?.uniqueItems ?? 0}</span>
            </div>
            <div className="row between">
              <span className="muted">Devices</span>
              <span className="tnum" style={{ fontWeight: 600 }}>{overview?.uniqueDevices ?? 0}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Trend chart */}
      <div className="card elev-2">
        <div className="card-head">
          <div className="titlewrap">
            <span className="eyebrow">Daily Watch Trend</span>
            <span className="title">
              Minutes + sessions, last <span className="accent">{range} days</span>
            </span>
          </div>
          <div className="right">
            <div className="row" style={{ gap: 14, fontSize: 11, color: 'var(--t-2)' }}>
              <span className="row" style={{ gap: 6 }}>
                <span style={{ width: 12, height: 3, borderRadius: 2, background: '#5fd1ff', boxShadow: '0 0 6px var(--teal-glow)' }}/>
                Minutes watched
              </span>
              <span className="row" style={{ gap: 6 }}>
                <span style={{ width: 8, height: 12, borderRadius: 2, background: 'linear-gradient(180deg,#ffba6f,#c97712)' }}/>
                Sessions
              </span>
            </div>
          </div>
        </div>
        <TrendChart data={trend} height={210}/>
      </div>

      {/* Sessions list + detail */}
      <div className="card">
        <div className="card-head">
          <div className="titlewrap">
            <span className="eyebrow">Realtime</span>
            <span className="title">Recent Playback Sessions</span>
          </div>
          <div className="right">
            <span className="chip">{recent.length} loaded</span>
          </div>
        </div>
        <div
          className="sessions-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 340px) minmax(0, 1fr)',
            gap: 14,
            alignItems: 'start',
          }}
        >
          <div className="col" style={{ gap: 6, maxHeight: 520, overflow: 'auto' }}>
            {recent.length === 0 && <div className="empty">No sessions yet.</div>}
            {recent.map((s) => (
              <SessionRow
                key={s.playbackSessionId}
                s={s}
                active={selectedId === s.playbackSessionId}
                onClick={() => setSelectedId(s.playbackSessionId)}
              />
            ))}
          </div>
          <SessionDetail s={detail} fallback={recent.find((r) => r.playbackSessionId === selectedId)}/>
        </div>
      </div>

      {/* Rankings */}
      <div className="grid cols-3">
        <RankingsCard
          title="Top Users"
          items={topUsers.slice(0, 5).map((u, i) => ({
            name: u.username || u.userId || 'unknown',
            meta: u.serverName || u.serverId || '—',
            value: fmtMinutes(Math.round((u.totalPlayDurationMs || 0) / 60000)),
            ratio: topUsers[0]?.totalPlayDurationMs ? (u.totalPlayDurationMs || 0) / topUsers[0].totalPlayDurationMs : 0,
            color: 'violet',
          }))}
        />
        <RankingsCard
          title="Top Libraries"
          items={topLibraries.slice(0, 5).map((l) => ({
            name: l.libraryName || l.name || '—',
            meta: l.serverName || l.serverId || '—',
            value: fmtMinutes(Math.round((l.totalPlayDurationMs || 0) / 60000)),
            ratio: topLibraries[0]?.totalPlayDurationMs ? (l.totalPlayDurationMs || 0) / topLibraries[0].totalPlayDurationMs : 0,
            color: 'green',
          }))}
        />
        <RankingsCard
          title="Top Items"
          items={topItems.slice(0, 5).map((it) => ({
            name: it.itemName || it.name || '—',
            meta: `${it.itemType || ''}${it.libraryName ? ' · ' + it.libraryName : ''}`,
            value: fmtMinutes(Math.round((it.totalPlayDurationMs || 0) / 60000)),
            ratio: topItems[0]?.totalPlayDurationMs ? (it.totalPlayDurationMs || 0) / topItems[0].totalPlayDurationMs : 0,
            color: 'orange',
            posterColor: hashColor(it.itemName || it.itemId),
          }))}
        />
      </div>

      {/* Sockets + Top Servers */}
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)' }}>
        <div className="card">
          <div className="card-head">
            <div className="titlewrap">
              <span className="eyebrow">Realtime Sockets</span>
              <span className="title">Jellyfin WebSocket Health</span>
            </div>
            <div className="right">
              <span className="chip">
                {sockets.filter((s) => (s.state || s.status) === 'connected' || s.connected === true).length} / {sockets.length} live
              </span>
            </div>
          </div>
          <div className="col" style={{ gap: 8 }}>
            {sockets.length === 0 && <div className="empty">No sockets configured. Verify a user under Servers to bring one up.</div>}
            {sockets.map((s, i) => (
              <SocketRow key={i} s={s}/>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div className="titlewrap">
              <span className="eyebrow">Top Servers</span>
              <span className="title">By Watch Time</span>
            </div>
          </div>
          <div className="col" style={{ gap: 10 }}>
            {topServers.length === 0 && <div className="empty">No server data yet.</div>}
            {topServers.slice(0, 5).map((s, i) => {
              const mins = Math.round((s.totalPlayDurationMs || 0) / 60000);
              const ratio = topServers[0]?.totalPlayDurationMs
                ? (s.totalPlayDurationMs || 0) / topServers[0].totalPlayDurationMs
                : 0;
              return (
                <div key={s.serverId || i} className="col" style={{ gap: 6 }}>
                  <div className="row between">
                    <div className="row" style={{ gap: 8, minWidth: 0 }}>
                      <span className="tnum muted" style={{ width: 14, textAlign: 'right' }}>{i + 1}</span>
                      <span style={{ fontWeight: 600, color: 'var(--t-0)' }}>{s.serverName || s.serverId || '—'}</span>
                    </div>
                    <span className="tnum" style={{ fontWeight: 700, color: 'var(--teal-bright)' }}>
                      {fmtMinutes(mins)}
                    </span>
                  </div>
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width: ratio * 100 + '%' }}/>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Watch history */}
      <div className="card">
        <div className="card-head">
          <div className="titlewrap">
            <span className="eyebrow">Archive</span>
            <span className="title">Watch History</span>
          </div>
          <div className="right">
            <input
              className="input"
              placeholder="Filter title…"
              value={historyQ}
              onChange={(e) => setHistoryQ(e.target.value)}
              style={{ width: 200 }}
            />
            <input
              className="input"
              placeholder="User"
              value={historyUser}
              onChange={(e) => setHistoryUser(e.target.value)}
              style={{ width: 130 }}
            />
            <button className="btn sm" onClick={loadHistory}>Apply</button>
            <button
              className="btn sm ghost"
              onClick={async () => {
                if (!confirm('Clear all watch history? This is irreversible.')) return;
                try {
                  await api.deleteAnalyticsHistory();
                  onToast?.('History cleared', 'success');
                  loadHistory();
                  load();
                } catch (e) { onToast?.('Clear failed: ' + e.message, 'error'); }
              }}
              title="Clear all history"
            >
              <Icon name="trash" size={13}/>
            </button>
          </div>
        </div>
        {history.length === 0 ? (
          <div className="empty">No watch history matches the current filters.</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 150 }}>Last Seen</th>
                <th>Title</th>
                <th style={{ width: 110 }}>User</th>
                <th style={{ width: 110 }}>Library</th>
                <th style={{ width: 110 }}>Watch Time</th>
                <th style={{ width: 110 }}>Status</th>
                <th style={{ width: 80 }}/>
              </tr>
            </thead>
            <tbody>
              {history.map((s) => {
                const stateChip =
                  s.completed
                    ? <span className="chip ok"><span className="dot"/> Complete</span>
                    : <span className="chip teal"><span className="dot"/> Watching</span>;
                return (
                  <tr key={s.playbackSessionId}>
                    <td className="muted tnum" style={{ fontSize: 11.5 }}>
                      {ago(s.lastSeenAt)}
                    </td>
                    <td>
                      <div className="row" style={{ gap: 10, minWidth: 0 }}>
                        <div
                          className="poster"
                          style={{
                            width: 22,
                            height: 32,
                            background: `linear-gradient(135deg, ${hashColor(s.itemName || s.itemId)}, #0d121a)`,
                            fontSize: 8,
                          }}
                        >
                          {initials(s.itemName)}
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <div
                            style={{
                              fontWeight: 600,
                              color: 'var(--t-0)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {s.itemName || s.itemId || '—'}
                          </div>
                          <div className="muted" style={{ fontSize: 10.5 }}>{s.itemType || '—'}</div>
                        </div>
                      </div>
                    </td>
                    <td>{s.username || s.userId || '—'}</td>
                    <td className="muted">{s.libraryName || '—'}</td>
                    <td className="tnum">{fmtMinutes(Math.round((s.playDurationMs || 0) / 60000))}</td>
                    <td>{stateChip}</td>
                    <td>
                      <div className="row" style={{ gap: 4 }}>
                        <button className="btn ghost sm" onClick={() => setSelectedId(s.playbackSessionId)}>↗</button>
                        <button className="btn ghost sm" onClick={() => deleteHistoryEntry(s.playbackSessionId)} title="Delete entry">
                          <Icon name="trash" size={12}/>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Housekeeping */}
      <div className="card">
        <div className="card-head">
          <div className="titlewrap">
            <span className="eyebrow">Housekeeping</span>
            <span className="title">Database Storage</span>
          </div>
          <div className="right">
            <button className="btn sm" onClick={() => api.databaseStats().then(setDbStats).catch(() => {})}>
              <Icon name="refresh" size={13}/> Refresh
            </button>
          </div>
        </div>
        <div className="grid cols-4" style={{ marginBottom: 14 }}>
          <div>
            <div className="eyebrow">File size</div>
            <div className="tnum" style={{ fontSize: 22, fontWeight: 700, color: 'var(--t-0)', marginTop: 4 }}>
              {dbStats?.fileSizeBytes != null ? formatFileSize(dbStats.fileSizeBytes) : '—'}
            </div>
          </div>
          <div>
            <div className="eyebrow">Sessions</div>
            <div className="tnum" style={{ fontSize: 22, fontWeight: 700, color: 'var(--t-0)', marginTop: 4 }}>
              {(dbStats?.counts?.playbackSessions ?? 0).toLocaleString()}
            </div>
            {dbStats?.oldestPlaybackAt && (
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                Oldest: {new Date(dbStats.oldestPlaybackAt).toISOString().slice(0, 10)}
              </div>
            )}
          </div>
          <div>
            <div className="eyebrow">Events</div>
            <div className="tnum" style={{ fontSize: 22, fontWeight: 700, color: 'var(--t-0)', marginTop: 4 }}>
              {(dbStats?.counts?.playbackSessionEvents ?? 0).toLocaleString()}
            </div>
          </div>
          <div>
            <div className="eyebrow">Log lines</div>
            <div className="tnum" style={{ fontSize: 22, fontWeight: 700, color: 'var(--t-0)', marginTop: 4 }}>
              {(dbStats?.counts?.deviceLogs ?? 0).toLocaleString()}
            </div>
            {dbStats?.counts?.devices != null && (
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                {dbStats.counts.devices} devices
              </div>
            )}
          </div>
        </div>
        <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 12, color: 'var(--t-2)' }}>
            Keep last{' '}
            <input
              className="input"
              type="number"
              value={pruneDays}
              onChange={(e) => setPruneDays(e.target.value)}
              style={{ width: 70, display: 'inline-block', margin: '0 6px' }}
            />{' '}
            days
          </label>
          <button className="btn sm danger" onClick={prunePlayback}>
            <Icon name="trash" size={13}/> Prune Playback
          </button>
          <button className="btn sm danger" onClick={pruneLogs}>
            <Icon name="trash" size={13}/> Prune Device Logs
          </button>
          <button className="btn sm" onClick={vacuum}>Reclaim Space (VACUUM)</button>
        </div>
      </div>
    </div>
  );
}

function formatFileSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(bytes) || 0;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return (v >= 10 || u === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + units[u];
}

function SessionRow({ s, active, onClick }) {
  const stateColor =
    s.completed === 0 || s.completed === false ? 'var(--teal-bright)' : 'var(--ok)';
  const ratio = s.runtimeTicks
    ? Math.max(0, Math.min(1, Number(s.positionTicks || 0) / Number(s.runtimeTicks)))
    : 0;
  return (
    <div
      onClick={onClick}
      style={{
        display: 'grid',
        gridTemplateColumns: '32px minmax(0, 1fr) auto',
        gap: 10,
        alignItems: 'center',
        padding: '9px 10px',
        borderRadius: 10,
        cursor: 'pointer',
        background: active
          ? 'linear-gradient(180deg, rgba(0,164,220,0.14), rgba(0,164,220,0.04))'
          : 'rgba(255,255,255,0.015)',
        border: '1px solid ' + (active ? 'var(--stroke-active)' : 'transparent'),
      }}
    >
      <div
        className="poster"
        style={{
          width: 32,
          height: 46,
          background: `linear-gradient(135deg, ${hashColor(s.itemName || s.itemId)}, #0a121e)`,
          fontSize: 10,
        }}
      >
        {initials(s.itemName)}
      </div>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--t-0)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {s.itemName || s.itemId || '—'}
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
          {(s.username || s.userId || '?')} · {s.clientName || s.deviceId || '?'} ·{' '}
          <span style={{ color: stateColor }}>{s.completed ? 'completed' : 'in progress'}</span>
        </div>
        <div className="bar-track" style={{ marginTop: 5, height: 3 }}>
          <div className="bar-fill" style={{ width: ratio * 100 + '%' }}/>
        </div>
      </div>
      <div
        className="tnum muted"
        style={{ fontSize: 10.5, textAlign: 'right', whiteSpace: 'nowrap' }}
      >
        {ago(s.lastSeenAt)}
      </div>
    </div>
  );
}

function SessionDetail({ s, fallback }) {
  const session = s?.session || fallback;
  const events = Array.isArray(s?.events) ? s.events : [];
  if (!session) return <div className="empty">Select a session.</div>;
  const ratio = session.runtimeTicks
    ? Math.max(0, Math.min(1, Number(session.positionTicks || 0) / Number(session.runtimeTicks)))
    : 0;
  return (
    <div
      className="col"
      style={{
        gap: 14,
        padding: 14,
        background: 'linear-gradient(180deg, rgba(8,14,22,0.65), rgba(4,8,14,0.45))',
        border: '1px solid var(--stroke-1)',
        borderRadius: 14,
        minHeight: 520,
      }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '98px minmax(0, 1fr)', gap: 16 }}>
        <div
          className="poster"
          style={{
            width: 98,
            height: 147,
            background: `linear-gradient(135deg, ${hashColor(session.itemName || session.itemId)}, #0a121e)`,
            fontSize: 12,
            borderRadius: 10,
          }}
        >
          {initials(session.itemName)}
        </div>
        <div className="col" style={{ gap: 8, minWidth: 0 }}>
          <div>
            <div className="eyebrow">
              {session.itemType || 'unknown'}{session.libraryName ? ' · ' + session.libraryName : ''}
            </div>
            <div
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: 'var(--t-0)',
                letterSpacing: '-0.012em',
                marginTop: 2,
              }}
            >
              {session.itemName || '—'}
            </div>
          </div>
          {session.itemMetadata?.overview && (
            <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
              {session.itemMetadata.overview}
            </div>
          )}
          <div className="row wrap" style={{ gap: 6, marginTop: 4 }}>
            {session.playbackMethod && <span className="chip teal">{session.playbackMethod}</span>}
            {session.completed != null && (
              <span className={'chip ' + (session.completed ? 'ok' : 'warn')}>
                {session.completed ? 'Completed' : 'In progress'}
              </span>
            )}
          </div>
          <div className="row wrap" style={{ gap: 16, marginTop: 8, fontSize: 11.5 }}>
            <div>
              <div className="eyebrow">User</div>
              <div style={{ color: 'var(--t-0)', fontWeight: 600, marginTop: 2 }}>
                {session.username || session.userId || '—'}
              </div>
            </div>
            <div>
              <div className="eyebrow">Device</div>
              <div style={{ color: 'var(--t-0)', fontWeight: 600, marginTop: 2 }}>
                {session.clientName || session.deviceId || '—'}
              </div>
            </div>
            <div>
              <div className="eyebrow">Watched</div>
              <div className="tnum" style={{ color: 'var(--t-0)', fontWeight: 600, marginTop: 2 }}>
                {fmtMinutes(Math.round((session.playDurationMs || 0) / 60000))}
              </div>
            </div>
            <div>
              <div className="eyebrow">Position</div>
              <div className="tnum" style={{ color: 'var(--t-0)', fontWeight: 600, marginTop: 2 }}>
                {Math.round(ratio * 100)}%
              </div>
            </div>
          </div>
        </div>
      </div>

      <div>
        <div className="row between" style={{ marginBottom: 6, fontSize: 10.5, color: 'var(--t-3)' }}>
          <span className="tnum">{Math.round(ratio * 100)}%</span>
          <span className="tnum">{fmtMinutes(Math.round((session.runtimeTicks || 0) / 600000000))}</span>
        </div>
        <div className="bar-track" style={{ height: 6 }}>
          <div className="bar-fill" style={{ width: ratio * 100 + '%' }}/>
        </div>
      </div>

      <div>
        <div className="eyebrow" style={{ marginBottom: 8 }}>
          Event Timeline · {events.length} events
        </div>
        {events.length === 0 ? (
          <div className="empty">No events recorded for this session yet.</div>
        ) : (
          <div className="col" style={{ gap: 6, maxHeight: 240, overflow: 'auto' }}>
            {events.map((e, i) => (
              <div
                key={i}
                className="row"
                style={{
                  gap: 12,
                  padding: '8px 10px',
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid var(--stroke-0)',
                  borderRadius: 8,
                }}
              >
                <span
                  className="mono tnum"
                  style={{ color: 'var(--t-3)', fontSize: 10.5, width: 64, flexShrink: 0 }}
                >
                  {e.createdAt ? new Date(e.createdAt).toLocaleTimeString() : '—'}
                </span>
                <span className="chip teal uc" style={{ width: 90, justifyContent: 'center' }}>
                  {e.eventType || 'event'}
                </span>
                <span style={{ fontSize: 12, color: 'var(--t-1)' }}>
                  Position: {Math.round(Number(e.positionTicks || 0) / 600000000)}m
                  {e.details && Object.keys(e.details).length
                    ? ' · ' + Object.entries(e.details).slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(' · ')
                    : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RankingsCard({ title, items }) {
  return (
    <div className="card">
      <div className="card-head">
        <div className="titlewrap">
          <span className="eyebrow">Top 5</span>
          <span className="title">{title}</span>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="empty">No data yet.</div>
      ) : (
        <div className="col" style={{ gap: 10 }}>
          {items.map((it, i) => (
            <div key={i} className="col" style={{ gap: 5 }}>
              <div className="row between">
                <div className="row" style={{ gap: 10, minWidth: 0 }}>
                  <span
                    className="tnum"
                    style={{
                      width: 18,
                      color: i === 0 ? 'var(--teal-bright)' : 'var(--t-3)',
                      fontWeight: 700,
                      fontSize: 12,
                      textAlign: 'right',
                    }}
                  >
                    {i + 1}
                  </span>
                  {it.posterColor && (
                    <div
                      className="poster"
                      style={{
                        width: 20,
                        height: 28,
                        fontSize: 8,
                        background: `linear-gradient(135deg, ${it.posterColor}, #0a121e)`,
                      }}
                    >
                      {initials(it.name)}
                    </div>
                  )}
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12.5,
                        fontWeight: 600,
                        color: 'var(--t-0)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {it.name}
                    </div>
                    <div
                      className="muted"
                      style={{
                        fontSize: 10.5,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {it.meta}
                    </div>
                  </div>
                </div>
                <span className="tnum" style={{ fontWeight: 700, color: 'var(--t-0)', flexShrink: 0 }}>
                  {it.value}
                </span>
              </div>
              <div className="bar-track">
                <div className={'bar-fill ' + (it.color || '')} style={{ width: it.ratio * 100 + '%' }}/>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SocketRow({ s }) {
  const state = s.state || s.status || (s.connected ? 'connected' : 'disconnected');
  const chip =
    state === 'connected'
      ? <span className="chip ok"><span className="dot"/> Connected</span>
      : state === 'reconnecting'
      ? <span className="chip warn"><span className="dot"/> Reconnecting</span>
      : <span className="chip err"><span className="dot"/> Disconnected</span>;
  return (
    <div
      className="row between"
      style={{
        padding: 10,
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid var(--stroke-0)',
        borderRadius: 10,
        gap: 12,
      }}
    >
      <div className="row" style={{ gap: 12, minWidth: 0 }}>
        <Icon
          name="signal"
          size={14}
          style={{
            color:
              state === 'connected' ? 'var(--ok)'
              : state === 'reconnecting' ? 'var(--warn)'
              : 'var(--err)',
          }}
        />
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              color: 'var(--t-0)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {s.serverName || s.serverId || '—'}{' '}
            <span style={{ color: 'var(--t-3)' }}>·</span>{' '}
            <span style={{ color: 'var(--t-2)' }}>{s.username || s.userId || '—'}</span>
          </div>
          <div className="muted" style={{ fontSize: 10.5 }}>
            {s.lastEventAt ? 'Last event ' + ago(s.lastEventAt) : 'No events yet'}
          </div>
        </div>
      </div>
      {chip}
    </div>
  );
}
