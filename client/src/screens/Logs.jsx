import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../components/Icon.jsx';
import Segmented from '../components/Segmented.jsx';
import StatusDot from '../components/StatusDot.jsx';
import { api } from '../api.js';
import { useWebSocketEvent } from '../ws.js';
import { ago } from '../format.js';

function lvlColor(lvl) {
  const u = String(lvl || '').toUpperCase();
  if (u === 'ERROR' || u === 'E') return 'var(--err)';
  if (u === 'WARN' || u === 'WARNING' || u === 'W') return 'var(--warn)';
  return 'var(--ok)';
}

export default function Logs({ onToast }) {
  const [devices, setDevices] = useState([]);
  const [active, setActive] = useState(null);
  const [lines, setLines] = useState([]);
  const [filter, setFilter] = useState('ALL');
  const [q, setQ] = useState('');
  const [tail, setTail] = useState(true);
  const viewRef = useRef(null);

  const loadDevices = useCallback(async () => {
    try {
      const data = await api.deviceLogs();
      const list = Array.isArray(data?.devices) ? data.devices : (Array.isArray(data) ? data : []);
      setDevices(list);
      if (!active && list.length) setActive(list[0]);
    } catch (_) { /* keep prior */ }
  }, [active]);

  useEffect(() => { loadDevices(); }, [loadDevices]);

  useEffect(() => {
    if (!active) return;
    api.deviceLogLines(active.deviceId || active.id, 800)
      .then((d) => setLines(Array.isArray(d?.logs) ? d.logs : (Array.isArray(d) ? d : [])))
      .catch(() => setLines([]));
  }, [active]);

  useWebSocketEvent('new_logs', (data) => {
    if (!active) return;
    const id = active.deviceId || active.id;
    if (data.deviceId !== id) return;
    setLines((cur) => [...(Array.isArray(data.logs) ? data.logs : []), ...cur]);
    if (tail && viewRef.current) viewRef.current.scrollTop = 0;
  });

  async function clearLogs() {
    if (!active) return;
    if (!confirm('Clear logs for this device? This deletes them from the database.')) return;
    try {
      await api.clearDeviceLogs(active.deviceId || active.id);
      onToast?.('Logs cleared', 'success');
      setLines([]);
    } catch (e) { onToast?.('Clear failed: ' + e.message, 'error'); }
  }

  async function renameDevice() {
    if (!active) return;
    const id = active.deviceId || active.id;
    const next = window.prompt('Rename device', active.name || active.deviceName || id);
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === (active.name || active.deviceName)) return;
    try {
      await api.patchDevice(id, { name: trimmed });
      onToast?.('Device renamed', 'success');
      const refreshed = { ...active, name: trimmed };
      setActive(refreshed);
      loadDevices();
    } catch (e) { onToast?.('Rename failed: ' + e.message, 'error'); }
  }

  async function deleteDevice() {
    if (!active) return;
    const id = active.deviceId || active.id;
    if (!confirm(`Delete device "${active.name || id}"? This removes its logs and identity from the companion.`)) return;
    try {
      await api.deleteDevice(id);
      onToast?.('Device deleted', 'success');
      setActive(null);
      setLines([]);
      loadDevices();
    } catch (e) { onToast?.('Delete failed: ' + e.message, 'error'); }
  }

  function copyVisible() {
    const text = filtered.map((l) => `${l.t || l.timestamp || ''}  ${l.lvl || l.level || ''}  ${l.src || l.source || ''}  ${l.msg || l.message || ''}`).join('\n');
    navigator.clipboard.writeText(text).then(() => onToast?.('Copied visible lines', 'success')).catch(() => onToast?.('Copy failed', 'error'));
  }

  const filtered = lines.filter((l) => {
    const lvl = String(l.lvl || l.level || '').toUpperCase();
    if (filter !== 'ALL' && lvl !== filter) return false;
    if (q) {
      const text = `${l.msg || l.message || ''} ${l.src || l.source || ''}`.toLowerCase();
      if (!text.includes(q.toLowerCase())) return false;
    }
    return true;
  });

  const totalLines = devices.reduce((a, d) => a + Number(d.lineCount || d.lines || 0), 0);
  const receivingFrom = devices.filter((d) => (d.lineCount || d.lines || 0) > 0).length;

  return (
    <div className="col" style={{ gap: 14 }} data-screen-label="05 Device Logs">

      <div className="card">
        <div className="row between">
          <div>
            <div className="eyebrow">Stream Status</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--t-0)' }}>
              Companion logging is{' '}
              <span style={{ color: 'var(--ok)' }}>active</span> — receiving from{' '}
              <span className="tnum">{receivingFrom}</span> of <span className="tnum">{devices.length}</span> devices
            </div>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <span className="chip">{totalLines.toLocaleString()} lines stored</span>
            <button className="btn sm" onClick={loadDevices}>
              <Icon name="refresh" size={13}/> Refresh
            </button>
          </div>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 320px) minmax(0, 1fr)' }}>
        <div className="card">
          <div className="card-head">
            <div className="titlewrap">
              <span className="eyebrow">Devices</span>
              <span className="title">{devices.length} paired</span>
            </div>
          </div>
          {devices.length === 0 && (
            <div className="empty">No devices have synced yet. They appear once they upload logs.</div>
          )}
          <div className="col" style={{ gap: 6 }}>
            {devices.map((d) => {
              const id = d.deviceId || d.id;
              const isActive = active && (active.deviceId || active.id) === id;
              return (
                <div
                  key={id}
                  onClick={() => setActive(d)}
                  style={{
                    padding: '10px 12px',
                    borderRadius: 10,
                    cursor: 'pointer',
                    background: isActive
                      ? 'linear-gradient(180deg, rgba(0,164,220,0.14), rgba(0,164,220,0.03))'
                      : 'rgba(255,255,255,0.015)',
                    border: '1px solid ' + (isActive ? 'var(--stroke-active)' : 'transparent'),
                  }}
                >
                  <div className="row between">
                    <div className="row" style={{ gap: 8, minWidth: 0 }}>
                      <Icon name="headset" size={14} style={{ color: isActive ? 'var(--teal-bright)' : 'var(--t-2)' }}/>
                      <span
                        style={{
                          fontSize: 12.5,
                          fontWeight: 600,
                          color: 'var(--t-0)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {d.name || d.deviceName || id}
                      </span>
                    </div>
                    <StatusDot state={d.status || (d.lastSeenAt ? 'synced' : 'stale')}/>
                  </div>
                  <div className="row between muted" style={{ fontSize: 10.5, marginTop: 4 }}>
                    <span>last sync <span className="tnum">{d.lastSeenAt ? ago(d.lastSeenAt) : '—'}</span></span>
                    <span className="tnum">{Number(d.lineCount || d.lines || 0).toLocaleString()} lines</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--stroke-1)' }}>
            <div className="row between">
              <div>
                <div className="eyebrow">{active ? (active.name || active.deviceName || active.deviceId) : 'no device selected'}</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-0)' }}>
                  <span className="tnum">{lines.length.toLocaleString()}</span> lines loaded · streaming live
                </div>
              </div>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <button className="btn sm" onClick={renameDevice} disabled={!active} title="Rename device">
                  <Icon name="settings" size={13}/> Rename
                </button>
                <button className="btn sm" onClick={copyVisible} disabled={!filtered.length}>
                  <Icon name="copy" size={13}/> Copy
                </button>
                <a className="btn sm" href={active ? api.deviceLogDownloadUrl(active.deviceId || active.id) : '#'} style={{ pointerEvents: active ? 'auto' : 'none', textDecoration: 'none' }}>
                  <Icon name="download" size={13}/> Download
                </a>
                <button className="btn sm danger" onClick={clearLogs} disabled={!active} title="Delete this device's logs">
                  <Icon name="trash" size={13}/> Clear logs
                </button>
                <button className="btn sm danger" onClick={deleteDevice} disabled={!active} title="Forget the entire device">
                  <Icon name="trash" size={13}/> Delete device
                </button>
              </div>
            </div>
            <div className="row" style={{ gap: 8, marginTop: 10 }}>
              <input
                className="input"
                placeholder="Search logs…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                style={{ flex: 1 }}
              />
              <Segmented
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'ALL', label: 'All' },
                  { value: 'INFO', label: 'Info' },
                  { value: 'WARN', label: 'Warn' },
                  { value: 'ERROR', label: 'Error' },
                ]}
              />
              <label className="row" style={{ gap: 6, fontSize: 11, color: 'var(--t-2)' }}>
                <input type="checkbox" checked={tail} onChange={(e) => setTail(e.target.checked)}/> Tail
              </label>
            </div>
          </div>
          <div
            ref={viewRef}
            style={{
              padding: '10px 14px',
              background: 'linear-gradient(180deg, #04070d, #02050a)',
              minHeight: 460,
              fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
              fontSize: 11.5,
              lineHeight: 1.65,
              color: 'var(--t-1)',
              maxHeight: 520,
              overflow: 'auto',
            }}
          >
            {filtered.length === 0 && <div className="empty">No log lines match.</div>}
            {filtered.map((l, i) => {
              const t = l.t || l.timestamp || '';
              const lvl = String(l.lvl || l.level || 'INFO').toUpperCase();
              const src = l.src || l.source || '';
              const msg = l.msg || l.message || '';
              return (
                <div
                  key={i}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '170px 56px 100px minmax(0, 1fr)',
                    gap: 12,
                    padding: '3px 0',
                    borderBottom: '1px solid rgba(255,255,255,0.025)',
                  }}
                >
                  <span style={{ color: 'var(--t-3)' }}>
                    {typeof t === 'string' && t.length === 24 ? new Date(t).toLocaleTimeString() : t}
                  </span>
                  <span style={{ color: lvlColor(lvl), fontWeight: 700 }}>{lvl}</span>
                  <span style={{ color: 'var(--teal-bright)' }}>{src}</span>
                  <span>{msg}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
