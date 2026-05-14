import { useEffect, useState } from 'react';
import Icon from '../components/Icon.jsx';
import StatusDot from '../components/StatusDot.jsx';
import { api } from '../api.js';
import { hashColor, ago } from '../format.js';

export default function Servers({ config, reloadConfig, onToast }) {
  const servers = Array.isArray(config?.servers) ? config.servers : [];
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: '', baseUrl: '', apiKey: '' });
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState(null);

  async function testNew() {
    setBusy(true);
    setTestResult(null);
    try {
      const res = await api.testJellyfin({ url: draft.baseUrl, apiKey: draft.apiKey });
      setTestResult(res.success
        ? { ok: true, label: `Connected to ${res.serverName || 'Jellyfin'} ${res.version || ''}` }
        : { ok: false, label: res.error || 'Connection failed' });
    } catch (e) {
      setTestResult({ ok: false, label: e.message });
    } finally {
      setBusy(false);
    }
  }

  async function saveNew() {
    if (!draft.name || !draft.baseUrl) {
      onToast?.('Name and URL are required', 'error');
      return;
    }
    setBusy(true);
    try {
      const next = {
        ...config,
        servers: [
          ...servers,
          {
            id: 'srv-' + Date.now().toString(36),
            name: draft.name,
            baseUrl: draft.baseUrl,
            apiKey: draft.apiKey,
            users: [],
          },
        ],
      };
      await api.setConfig(next);
      await reloadConfig?.();
      onToast?.('Server added', 'success');
      setAdding(false);
      setDraft({ name: '', baseUrl: '', apiKey: '' });
      setTestResult(null);
    } catch (e) {
      onToast?.('Failed to add: ' + e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function deleteServer(id) {
    if (!confirm('Remove this server?')) return;
    try {
      const next = { ...config, servers: servers.filter((s) => s.id !== id) };
      await api.setConfig(next);
      await reloadConfig?.();
      onToast?.('Server removed', 'success');
    } catch (e) { onToast?.('Failed: ' + e.message, 'error'); }
  }

  async function testExisting(srv) {
    try {
      const res = await api.testJellyfin({ url: srv.baseUrl, apiKey: srv.apiKey });
      onToast?.(res.success ? `Connected to ${res.serverName || srv.name}` : 'Test failed: ' + (res.error || 'unknown'), res.success ? 'success' : 'error');
    } catch (e) { onToast?.('Test failed: ' + e.message, 'error'); }
  }

  const verifiedUserCount = servers.reduce(
    (acc, s) => acc + (Array.isArray(s.users) ? s.users.filter((u) => u && u.access_token).length : 0),
    0
  );

  return (
    <div className="col" style={{ gap: 14 }} data-screen-label="06 Servers and Users">
      <div className="row between">
        <div className="row" style={{ gap: 12 }}>
          <span className="chip">{servers.length} servers</span>
          <span className="chip">{verifiedUserCount} verified users</span>
        </div>
        <button className="btn primary" onClick={() => setAdding((a) => !a)}>
          <Icon name="plus" size={13}/> {adding ? 'Cancel' : 'Add Server'}
        </button>
      </div>

      {adding && (
        <div className="card">
          <div className="card-head">
            <div className="titlewrap">
              <span className="eyebrow">New</span>
              <span className="title">Add Jellyfin Server</span>
            </div>
          </div>
          <div className="setting-row">
            <div><div className="lbl">Name</div></div>
            <div className="ctl">
              <input className="input" placeholder="Living Room Jellyfin" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}/>
            </div>
          </div>
          <div className="setting-row">
            <div><div className="lbl">Base URL</div><div className="desc">e.g. http://jelly.lan:8096</div></div>
            <div className="ctl">
              <input className="input" placeholder="http://jelly.lan:8096" value={draft.baseUrl} onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}/>
            </div>
          </div>
          <div className="setting-row">
            <div><div className="lbl">API Key</div></div>
            <div className="ctl">
              <input className="input" type="password" value={draft.apiKey} onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}/>
            </div>
          </div>
          {testResult && (
            <div className={'chip ' + (testResult.ok ? 'ok' : 'err')} style={{ marginTop: 8 }}>
              <span className="dot"/> {testResult.label}
            </div>
          )}
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <button className="btn sm" disabled={busy} onClick={testNew}>Test</button>
            <button className="btn primary" disabled={busy} onClick={saveNew}>
              <Icon name="check" size={13}/> {busy ? 'Saving…' : 'Save Server'}
            </button>
          </div>
        </div>
      )}

      {servers.length === 0 && !adding && (
        <div className="empty">No servers yet. Click <strong>Add Server</strong> to pair your first Jellyfin.</div>
      )}

      {servers.map((srv) => (
        <ServerCard
          key={srv.id}
          srv={srv}
          users={Array.isArray(srv.users) ? srv.users : []}
          onTest={() => testExisting(srv)}
          onDelete={() => deleteServer(srv.id)}
        />
      ))}
    </div>
  );
}

function ServerCard({ srv, users, onTest, onDelete }) {
  const [open, setOpen] = useState(true);
  const status = srv.status || (srv.online === false ? 'offline' : 'online');
  return (
    <div className="card">
      <div className="card-head">
        <div className="row" style={{ gap: 12, minWidth: 0 }}>
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              background:
                status === 'online'
                  ? 'linear-gradient(135deg, rgba(0,164,220,0.22), rgba(20,30,42,0.6))'
                  : 'linear-gradient(135deg, rgba(255,181,71,0.18), rgba(20,30,42,0.6))',
              border: '1px solid var(--stroke-1)',
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <Icon name="server" size={18} style={{ color: status === 'online' ? 'var(--teal-bright)' : 'var(--warn)' }}/>
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t-0)' }}>{srv.name || srv.id}</div>
            <div className="row" style={{ gap: 8, marginTop: 2 }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--t-2)' }}>{srv.baseUrl || '—'}</span>
              <StatusDot state={status}/>
              <span className="muted" style={{ fontSize: 11 }}>{status}</span>
            </div>
          </div>
        </div>
        <div className="right">
          <span className="chip"><span className="tnum">{users.length}</span> users</span>
          <button className="btn sm" onClick={onTest}>Test</button>
          <button className="btn sm ghost" onClick={onDelete} title="Remove">
            <Icon name="trash" size={13}/>
          </button>
          <button className="btn icon-only sm ghost" onClick={() => setOpen(!open)}>
            <Icon name={open ? 'chevron-down' : 'chevron'} size={13}/>
          </button>
        </div>
      </div>

      {open && (
        <table className="tbl">
          <thead>
            <tr>
              <th>User</th>
              <th style={{ width: 110 }}>Status</th>
              <th style={{ width: 130 }}>Last Seen</th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <tr><td colSpan={3} className="muted" style={{ textAlign: 'center' }}>No users verified yet.</td></tr>
            ) : (
              users.map((u) => (
                <tr key={u.id || u.userId || u.name}>
                  <td>
                    <div className="row" style={{ gap: 10 }}>
                      <div
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: 50,
                          background: `linear-gradient(135deg, ${hashColor(u.name || u.username || u.userId)}, hsl(0, 0%, 18%))`,
                          display: 'grid',
                          placeItems: 'center',
                          fontSize: 9.5,
                          fontWeight: 700,
                          color: '#fff',
                          textTransform: 'uppercase',
                        }}
                      >
                        {(u.name || u.username || u.userId || '?').slice(0, 1)}
                      </div>
                      <span style={{ fontWeight: 600, color: 'var(--t-0)' }}>{u.name || u.username || u.userId}</span>
                    </div>
                  </td>
                  <td>
                    {u.access_token
                      ? <span className="chip ok"><span className="dot"/> Verified</span>
                      : <span className="chip warn"><span className="dot"/> Pending</span>}
                  </td>
                  <td className="muted">{u.lastSeenAt ? ago(u.lastSeenAt) : '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
