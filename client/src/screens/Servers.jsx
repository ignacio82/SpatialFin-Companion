import { useState } from 'react';
import Icon from '../components/Icon.jsx';
import StatusDot from '../components/StatusDot.jsx';
import Toggle from '../components/Toggle.jsx';
import { api } from '../api.js';
import { hashColor, ago } from '../format.js';

// Server config in storage uses `addresses: [string]` (array) and not `baseUrl`.
const primaryAddress = (srv) => (Array.isArray(srv?.addresses) ? srv.addresses[0] : null) || '';

const LANG_OPTIONS = [
  { value: '',    label: '(Inherit Global)' },
  { value: 'eng', label: 'English' },
  { value: 'spa', label: 'Spanish' },
  { value: 'jpn', label: 'Japanese' },
  { value: 'fre', label: 'French' },
  { value: 'ger', label: 'German' },
  { value: 'por', label: 'Portuguese' },
  { value: 'ita', label: 'Italian' },
  { value: 'kor', label: 'Korean' },
  { value: 'chi', label: 'Chinese' },
];

export default function Servers({ config, reloadConfig, onToast }) {
  const servers = Array.isArray(config?.servers) ? config.servers : [];
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: '', address: '' });
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState(null);

  async function testNew() {
    setBusy(true);
    setTestResult(null);
    try {
      const res = await api.testJellyfin({ url: draft.address });
      setTestResult(res.success
        ? { ok: true, label: `Reachable: ${res.serverName || 'Jellyfin'} ${res.version || ''}` }
        : { ok: false, label: res.error || 'Connection failed' });
    } catch (e) {
      setTestResult({ ok: false, label: e.message });
    } finally {
      setBusy(false);
    }
  }

  async function saveNew() {
    if (!draft.name || !draft.address) {
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
            addresses: [draft.address],
            users: [],
          },
        ],
      };
      await api.setConfig(next);
      await reloadConfig?.();
      onToast?.('Server added — now add a user under it.', 'success');
      setAdding(false);
      setDraft({ name: '', address: '' });
      setTestResult(null);
    } catch (e) {
      onToast?.('Failed to add: ' + e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function deleteServer(id) {
    if (!confirm('Remove this server? Verified users on it will lose their tokens.')) return;
    try {
      const next = { ...config, servers: servers.filter((s) => s.id !== id) };
      await api.setConfig(next);
      await reloadConfig?.();
      onToast?.('Server removed', 'success');
    } catch (e) { onToast?.('Failed: ' + e.message, 'error'); }
  }

  async function testExisting(srv) {
    try {
      const res = await api.testJellyfin({ url: primaryAddress(srv) });
      onToast?.(
        res.success ? `Connected to ${res.serverName || srv.name}` : 'Test failed: ' + (res.error || 'unknown'),
        res.success ? 'success' : 'error'
      );
    } catch (e) { onToast?.('Test failed: ' + e.message, 'error'); }
  }

  async function updateServer(id, patch) {
    setBusy(true);
    try {
      const next = {
        ...config,
        servers: servers.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      };
      await api.setConfig(next);
      await reloadConfig?.();
    } catch (e) { onToast?.('Save failed: ' + e.message, 'error'); }
    finally { setBusy(false); }
  }

  async function addAndVerifyUser(srv, username, password) {
    if (!username || !password) {
      onToast?.('Username and password are required', 'error');
      return false;
    }
    const url = primaryAddress(srv);
    if (!url) {
      onToast?.('Server has no address configured', 'error');
      return false;
    }
    setBusy(true);
    try {
      const others = (srv.users || []).filter((u) => u && (u.username || u.name) !== username);
      const nextUsers = [...others, { username, password, preferences: {} }];
      const nextServers = servers.map((s) => (s.id === srv.id ? { ...s, users: nextUsers } : s));
      await api.setConfig({ ...config, servers: nextServers });

      const res = await api.verifyUser({ serverUrl: url, username, password });
      await reloadConfig?.();
      if (res && res.success !== false) {
        onToast?.(`Verified ${username}`, 'success');
        return true;
      }
      onToast?.('Saved, but verify failed: ' + (res?.error || 'unknown'), 'error');
      return false;
    } catch (e) {
      onToast?.('Verify failed: ' + e.message, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function updateUser(srvId, username, patch) {
    setBusy(true);
    try {
      const nextServers = servers.map((s) => {
        if (s.id !== srvId) return s;
        const users = (s.users || []).map((u) =>
          (u.username || u.name) === username ? { ...u, ...patch, preferences: { ...(u.preferences || {}), ...(patch.preferences || {}) } } : u
        );
        return { ...s, users };
      });
      await api.setConfig({ ...config, servers: nextServers });
      await reloadConfig?.();
    } catch (e) { onToast?.('Save failed: ' + e.message, 'error'); }
    finally { setBusy(false); }
  }

  async function removeUser(srv, username) {
    if (!confirm(`Remove user "${username}"?`)) return;
    try {
      const nextUsers = (srv.users || []).filter((u) => u && (u.username || u.name) !== username);
      const nextServers = servers.map((s) => (s.id === srv.id ? { ...s, users: nextUsers } : s));
      await api.setConfig({ ...config, servers: nextServers });
      await reloadConfig?.();
      onToast?.(`Removed ${username}`, 'success');
    } catch (e) { onToast?.('Remove failed: ' + e.message, 'error'); }
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
            <div><div className="lbl">Server URL</div><div className="desc">e.g. http://jelly.lan:8096. Add more after creation.</div></div>
            <div className="ctl">
              <input className="input" placeholder="http://jelly.lan:8096" value={draft.address} onChange={(e) => setDraft((d) => ({ ...d, address: e.target.value }))}/>
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
          onTest={() => testExisting(srv)}
          onDelete={() => deleteServer(srv.id)}
          onUpdateServer={(patch) => updateServer(srv.id, patch)}
          onUpdateUser={(username, patch) => updateUser(srv.id, username, patch)}
          onVerifyUser={(username, password) => addAndVerifyUser(srv, username, password)}
          onRemoveUser={(username) => removeUser(srv, username)}
          busy={busy}
        />
      ))}
    </div>
  );
}

function ServerCard({ srv, onTest, onDelete, onUpdateServer, onUpdateUser, onVerifyUser, onRemoveUser, busy }) {
  const [open, setOpen] = useState(true);
  const [editAddresses, setEditAddresses] = useState(false);
  const [addrDraft, setAddrDraft] = useState((srv.addresses || []).join('\n'));
  const [adding, setAdding] = useState(false);
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [expandedUser, setExpandedUser] = useState(null);
  const url = primaryAddress(srv);
  const users = Array.isArray(srv.users) ? srv.users : [];
  const status = srv.status || (srv.online === false ? 'offline' : 'online');

  async function submit(e) {
    e?.preventDefault?.();
    const ok = await onVerifyUser(u, p);
    if (ok) {
      setU('');
      setP('');
      setAdding(false);
    }
  }

  function saveAddresses() {
    const list = addrDraft
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    onUpdateServer({ addresses: list });
    setEditAddresses(false);
  }

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
            <div className="row" style={{ gap: 8, marginTop: 2, flexWrap: 'wrap' }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--t-2)' }}>{url || '(no URL configured)'}</span>
              {(srv.addresses || []).length > 1 && (
                <span className="chip" title={(srv.addresses || []).slice(1).join(', ')}>
                  +{srv.addresses.length - 1} fallback{srv.addresses.length - 1 === 1 ? '' : 's'}
                </span>
              )}
              <StatusDot state={status}/>
              <span className="muted" style={{ fontSize: 11 }}>{status}</span>
            </div>
          </div>
        </div>
        <div className="right">
          <span className="chip"><span className="tnum">{users.length}</span> users</span>
          <button className="btn sm" onClick={onTest}>Test</button>
          <button className="btn sm ghost" onClick={onDelete} title="Remove server">
            <Icon name="trash" size={13}/>
          </button>
          <button className="btn icon-only sm ghost" onClick={() => setOpen(!open)}>
            <Icon name={open ? 'chevron-down' : 'chevron'} size={13}/>
          </button>
        </div>
      </div>

      {open && (
        <>
          {/* Addresses editor */}
          {editAddresses ? (
            <div style={{ marginBottom: 14 }}>
              <div className="eyebrow" style={{ marginBottom: 4 }}>Addresses (one per line; first is primary)</div>
              <textarea
                className="textarea"
                value={addrDraft}
                onChange={(e) => setAddrDraft(e.target.value)}
                rows={4}
              />
              <div className="row" style={{ gap: 8, justifyContent: 'flex-end', marginTop: 6 }}>
                <button className="btn ghost sm" onClick={() => { setAddrDraft((srv.addresses || []).join('\n')); setEditAddresses(false); }}>
                  Cancel
                </button>
                <button className="btn primary sm" onClick={saveAddresses} disabled={busy}>
                  <Icon name="check" size={12}/> Save addresses
                </button>
              </div>
            </div>
          ) : (
            <button
              className="btn sm ghost"
              onClick={() => setEditAddresses(true)}
              style={{ marginBottom: 14 }}
              title="Edit primary + fallback addresses"
            >
              <Icon name="settings" size={12}/> Edit addresses
            </button>
          )}

          {users.length === 0 ? (
            <div className="empty" style={{ marginBottom: 12 }}>
              No users yet — add and verify a Jellyfin user so the companion can sync and analyze playback.
            </div>
          ) : (
            <div className="col" style={{ gap: 8 }}>
              {users.map((user) => {
                const name = user.username || user.name || user.userId;
                const isOpen = expandedUser === name;
                return (
                  <div
                    key={name}
                    style={{
                      border: '1px solid var(--stroke-1)',
                      borderRadius: 10,
                      padding: '10px 12px',
                      background: isOpen ? 'rgba(0,164,220,0.04)' : 'rgba(255,255,255,0.015)',
                    }}
                  >
                    <div className="row between" style={{ gap: 10, flexWrap: 'wrap' }}>
                      <div className="row" style={{ gap: 10, minWidth: 0 }}>
                        <div
                          style={{
                            width: 22,
                            height: 22,
                            borderRadius: 50,
                            background: `linear-gradient(135deg, ${hashColor(name)}, hsl(0, 0%, 18%))`,
                            display: 'grid',
                            placeItems: 'center',
                            fontSize: 9.5,
                            fontWeight: 700,
                            color: '#fff',
                            textTransform: 'uppercase',
                            flexShrink: 0,
                          }}
                        >
                          {String(name || '?').slice(0, 1)}
                        </div>
                        <span style={{ fontWeight: 600, color: 'var(--t-0)' }}>{name}</span>
                        {user.access_token
                          ? <span className="chip ok"><span className="dot"/> Verified</span>
                          : <span className="chip warn"><span className="dot"/> Pending</span>}
                      </div>
                      <div className="row" style={{ gap: 4 }}>
                        <button className="btn ghost sm" onClick={() => setExpandedUser(isOpen ? null : name)}>
                          {isOpen ? 'Hide overrides' : 'Overrides'}
                        </button>
                        <button className="btn ghost sm" onClick={() => onRemoveUser(name)} title="Remove user">
                          <Icon name="trash" size={13}/>
                        </button>
                      </div>
                    </div>
                    {isOpen && (
                      <UserOverrides
                        user={user}
                        onChange={(patch) => onUpdateUser(name, patch)}
                        busy={busy}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {!adding ? (
            <div style={{ marginTop: 12 }}>
              <button className="btn sm" onClick={() => setAdding(true)} disabled={!url}>
                <Icon name="plus" size={12}/> Add &amp; Verify User
              </button>
              {!url && (
                <span className="muted" style={{ fontSize: 11, marginLeft: 10 }}>
                  Set a server URL first.
                </span>
              )}
            </div>
          ) : (
            <form
              onSubmit={submit}
              style={{
                marginTop: 12,
                padding: 12,
                background: 'rgba(255,255,255,0.02)',
                border: '1px solid var(--stroke-1)',
                borderRadius: 10,
              }}
            >
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div style={{ flex: 1, minWidth: 160 }}>
                  <div className="eyebrow" style={{ marginBottom: 4 }}>Jellyfin Username</div>
                  <input className="input" placeholder="jellyfin username" value={u} onChange={(e) => setU(e.target.value)} autoFocus/>
                </div>
                <div style={{ flex: 1, minWidth: 160 }}>
                  <div className="eyebrow" style={{ marginBottom: 4 }}>Jellyfin Password</div>
                  <input className="input" type="password" placeholder="password" value={p} onChange={(e) => setP(e.target.value)}/>
                </div>
                <button type="submit" className="btn primary" disabled={busy}>
                  <Icon name="check" size={13}/> {busy ? 'Verifying…' : 'Verify'}
                </button>
                <button type="button" className="btn ghost" onClick={() => { setAdding(false); setU(''); setP(''); }}>
                  Cancel
                </button>
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
                Authenticates against {url} and stores the resulting Jellyfin access token in the companion.
              </div>
            </form>
          )}
        </>
      )}
    </div>
  );
}

function UserOverrides({ user, onChange, busy }) {
  const prefs = user.preferences || {};
  const setPref = (key, value) => {
    const next = { ...prefs };
    if (value === '' || value == null) {
      delete next[key];
    } else {
      next[key] = value;
    }
    onChange({ preferences: next });
  };

  return (
    <div
      style={{
        marginTop: 10,
        padding: 10,
        background: 'rgba(0,0,0,0.25)',
        border: '1px solid var(--stroke-1)',
        borderRadius: 8,
      }}
    >
      <div className="eyebrow" style={{ marginBottom: 8, color: 'var(--teal-bright)' }}>
        Per-user overrides
      </div>
      <div className="setting-row" style={{ padding: '6px 0' }}>
        <div>
          <div className="lbl">Prefer Original Language</div>
          <div className="desc">When on, this user's headsets try original audio first.</div>
        </div>
        <div className="ctl">
          <Toggle
            on={prefs.pref_smart_prefer_original_audio === 'true'}
            onChange={(v) => setPref('pref_smart_prefer_original_audio', v ? 'true' : 'false')}
            disabled={busy}
          />
        </div>
      </div>
      <div className="setting-row" style={{ padding: '6px 0' }}>
        <div><div className="lbl">Audio Language</div></div>
        <div className="ctl">
          <select
            className="select"
            value={prefs.pref_audio_language || ''}
            onChange={(e) => setPref('pref_audio_language', e.target.value)}
          >
            {LANG_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>
      <div className="setting-row" style={{ padding: '6px 0' }}>
        <div><div className="lbl">Subtitle Language</div></div>
        <div className="ctl">
          <select
            className="select"
            value={prefs.pref_subtitle_language || ''}
            onChange={(e) => setPref('pref_subtitle_language', e.target.value)}
          >
            {LANG_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>

      <MusicAssistantOverride user={user} onChange={onChange} busy={busy} />
      <PluginsOverride user={user} onChange={onChange} busy={busy} />
    </div>
  );
}

// Per-user Music Assistant connection. Free text → saved on button tap, not per
// keystroke. Maps to the device's per-Jellyfin-user MA store via CompanionSyncWorker.
function MusicAssistantOverride({ user, onChange, busy }) {
  const ma = user.musicAssistant || {};
  const [url, setUrl] = useState(ma.url || '');
  const [token, setToken] = useState(ma.token || '');
  const [username, setUsername] = useState(ma.username || '');
  const [password, setPassword] = useState(ma.password || '');

  const save = () => {
    const next = {};
    if (url.trim()) next.url = url.trim();
    if (token.trim()) next.token = token.trim();
    if (username.trim()) next.username = username.trim();
    if (password.trim()) next.password = password.trim();
    // No url ⇒ clear (the backend drops a urless musicAssistant on normalize).
    onChange({ musicAssistant: next.url ? next : null });
  };

  return (
    <div
      style={{
        marginTop: 10,
        padding: 10,
        background: 'rgba(0,0,0,0.25)',
        border: '1px solid var(--stroke-1)',
        borderRadius: 8,
      }}
    >
      <div className="eyebrow" style={{ marginBottom: 8, color: 'var(--teal-bright)' }}>
        Music Assistant
      </div>
      <div className="col" style={{ gap: 6 }}>
        <input
          className="input"
          placeholder="Server URL (http://192.168.1.89:8095)"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <input
          className="input"
          placeholder="Username (optional)"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          className="input"
          type="password"
          placeholder="Password (if using username)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <input
          className="input"
          type="password"
          placeholder="Access token (optional)"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <div className="row" style={{ gap: 6 }}>
          <button className="btn sm" onClick={save} disabled={busy}>Save Music Assistant</button>
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          Applied to this user's headsets. Leave the URL empty and save to clear.
        </div>
      </div>
    </div>
  );
}

// Per-user universal source plugins. One manifest URL per line; the device
// installs them into this user's plugin scope on sync (additive).
function PluginsOverride({ user, onChange, busy }) {
  const [text, setText] = useState((user.plugins || []).join('\n'));

  const save = () => {
    const list = text.split('\n').map((s) => s.trim()).filter(Boolean);
    onChange({ plugins: list });
  };

  return (
    <div
      style={{
        marginTop: 10,
        padding: 10,
        background: 'rgba(0,0,0,0.25)',
        border: '1px solid var(--stroke-1)',
        borderRadius: 8,
      }}
    >
      <div className="eyebrow" style={{ marginBottom: 8, color: 'var(--teal-bright)' }}>
        Universal Plugins
      </div>
      <div className="col" style={{ gap: 6 }}>
        <textarea
          className="input"
          rows={3}
          placeholder="One plugin manifest URL per line"
          value={text}
          onChange={(e) => setText(e.target.value)}
          style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }}
        />
        <div className="row" style={{ gap: 6 }}>
          <button className="btn sm" onClick={save} disabled={busy}>Save Plugins</button>
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          Each headset signed in as this user installs these manifests on next sync.
        </div>
      </div>
    </div>
  );
}
