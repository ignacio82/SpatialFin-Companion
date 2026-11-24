import { useState } from 'react';
import Icon from '../components/Icon.jsx';
import Segmented from '../components/Segmented.jsx';
import Modal from '../components/Modal.jsx';
import { api } from '../api.js';

export default function Shares({ config, reloadConfig, onToast }) {
  const shares = Array.isArray(config?.networkShares) ? config.networkShares : [];
  const [proto, setProto] = useState('smb');
  const [host, setHost] = useState('');
  const [domain, setDomain] = useState('');
  const [user, setUser] = useState('');
  const [pw, setPw] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [browsed, setBrowsed] = useState([]);
  const [draftBaseVersion, setDraftBaseVersion] = useState(() => config?.configVersion ?? null);
  const [editing, setEditing] = useState(null); // { id, name, protocol, host, port, shareName, path, username, domain, password, baseVersion }
  const [conflict, setConflict] = useState(false);
  const [secretDropPrompt, setSecretDropPrompt] = useState(null);
  const [busy, setBusy] = useState(false);

  async function browse() {
    setBrowsing(true);
    setBrowsed([]);
    setDraftBaseVersion(config?.configVersion ?? null);
    try {
      const body = { host, username: user, domain, password: pw };
      const res = proto === 'smb' ? await api.discoverSmb(body) : await api.discoverNfs(body);
      const list = Array.isArray(res?.shares) ? res.shares : (Array.isArray(res?.exports) ? res.exports : (Array.isArray(res) ? res : []));
      setBrowsed(list);
      if (!list.length) onToast?.('No shares discovered', 'warning');
    } catch (e) {
      onToast?.('Browse failed: ' + e.message, 'error');
    } finally {
      setBrowsing(false);
    }
  }

  async function saveShareList(nextShares, expectedVersion, confirmDropUnmatchedSecrets = false) {
    setBusy(true);
    setConflict(false);
    try {
      const payload = { networkShares: nextShares };
      if (confirmDropUnmatchedSecrets) payload.confirmDropUnmatchedSecrets = true;
      await api.setConfig(payload, expectedVersion ?? config?.configVersion);
      await reloadConfig?.();
      setSecretDropPrompt(null);
      return true;
    } catch (e) {
      if (e?.status === 409) {
        setConflict(true);
        onToast?.('Configuration changed in another session — reload latest', 'warning');
      } else if (e?.status === 400 && (e?.errorCode === 'share_password_required' || e?.errorCode === 'redacted_secret_mismatch')) {
        setSecretDropPrompt({
          message: e.message,
          retryDrop: () => saveShareList(nextShares, expectedVersion, true),
        });
      } else {
        onToast?.('Save failed: ' + e.message, 'error');
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addShare(share) {
    const shareName = typeof share === 'string'
      ? share
      : (share.name || share.share || share.path || '');
    const entry = {
      id: 'sh-' + Date.now().toString(36),
      name: shareName || 'share',
      protocol: proto.toLowerCase(),
      host: host.trim(),
      shareName,
      path: '',
      username: proto === 'smb' ? user.trim() : '',
      domain: proto === 'smb' ? domain.trim() : '',
      password: proto === 'smb' ? pw : '',
      status: 'unmounted',
    };
    const ok = await saveShareList([...shares, entry], draftBaseVersion ?? config?.configVersion);
    if (ok) onToast?.('Share added', 'success');
  }

  async function saveEdit() {
    if (!editing) return;
    const updated = shares.map((s) =>
      s.id === editing.id
        ? {
            ...s,
            name: editing.name.trim() || editing.shareName || 'share',
            protocol: editing.protocol,
            host: editing.host.trim(),
            port: editing.port ? Number(editing.port) : null,
            shareName: editing.shareName.trim(),
            path: editing.path.trim(),
            username: editing.protocol === 'smb' ? editing.username.trim() : '',
            domain: editing.protocol === 'smb' ? editing.domain.trim() : '',
            password: editing.protocol === 'smb' ? editing.password : '',
          }
        : s
    );
    const ok = await saveShareList(updated, editing.baseVersion);
    if (ok) {
      setEditing(null);
      onToast?.('Share updated', 'success');
    }
  }

  function updateEditField(field, value) {
    setEditing((prev) => {
      if (!prev) return prev;
      const next = { ...prev, [field]: value };
      const targetFields = ['protocol', 'host', 'port', 'shareName', 'username', 'domain'];
      if (targetFields.includes(field) && prev.password === '***REDACTED***') {
        next.password = '';
      }
      return next;
    });
  }

  async function removeShare(id) {
    if (!confirm('Remove this share?')) return;
    const ok = await saveShareList(shares.filter((s) => s.id !== id), config?.configVersion);
    if (ok) onToast?.('Share removed', 'success');
  }

  async function testShare(s) {
    try {
      const res = await api.testShare({
        id: s.id,
        protocol: s.protocol,
        host: s.host,
        shareName: s.shareName,
        path: s.path,
        port: s.port,
        username: s.username,
        domain: s.domain,
        password: s.password,
      });
      onToast?.(
        res?.success ? 'Share reachable' : 'Share unreachable: ' + (res?.error || 'unknown'),
        res?.success ? 'success' : 'error'
      );
    } catch (e) { onToast?.('Test failed: ' + e.message, 'error'); }
  }

  async function reloadLatest() {
    setConflict(false);
    const latest = await reloadConfig?.();
    if (latest?.configVersion != null) {
      setDraftBaseVersion(latest.configVersion);
      if (editing) setEditing((prev) => (prev ? { ...prev, baseVersion: latest.configVersion } : prev));
    }
  }

  return (
    <div className="col" style={{ gap: 14 }} data-screen-label="07 Network Shares">
      {conflict && (
        <div className="card" style={{ borderColor: 'rgba(255,181,71,0.5)' }}>
          <div className="row between wrap" style={{ gap: 8 }}>
            <span style={{ fontSize: 12.5 }}>Configuration changed in another session. Your unsaved edits are preserved.</span>
            <button type="button" className="btn sm primary" onClick={reloadLatest}>Reload latest</button>
          </div>
        </div>
      )}

      <div className="row between">
        <div className="row" style={{ gap: 12 }}>
          <span className="chip">{shares.length} configured</span>
          <span className="chip ok"><span className="dot"/> {shares.filter((s) => s.status === 'mounted').length} mounted</span>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="titlewrap">
            <span className="eyebrow">Discovery</span>
            <span className="title">Local Network Browser</span>
          </div>
          <div className="right">
            <Segmented
              value={proto}
              onChange={(v) => {
                setProto(v);
                if (pw === '***REDACTED***') setPw('');
              }}
              options={[
                { value: 'smb', label: 'SMB' },
                { value: 'nfs', label: 'NFS' },
              ]}
            />
          </div>
        </div>
        <div className="row wrap" style={{ gap: 8, marginBottom: 10 }}>
          <input className="input" placeholder="Host or IP (e.g. nas.lan)" style={{ flex: 1, minWidth: 160 }} value={host} onChange={(e) => setHost(e.target.value)}/>
          {proto === 'smb' && (
            <>
              <input className="input" placeholder="Domain (optional)" style={{ width: 130 }} value={domain} onChange={(e) => setDomain(e.target.value)}/>
              <input className="input" placeholder="Username" style={{ width: 140 }} value={user} onChange={(e) => setUser(e.target.value)}/>
              <input className="input" type="password" placeholder="Password" style={{ width: 140 }} value={pw} onChange={(e) => setPw(e.target.value)}/>
            </>
          )}
          <button type="button" className="btn" disabled={browsing || !host} onClick={browse}>
            {browsing ? 'Browsing…' : 'Browse'}
          </button>
        </div>
        {browsed.length > 0 && (
          <div className="row wrap" style={{ gap: 6 }}>
            {browsed.map((s, i) => {
              const name = typeof s === 'string' ? s : (s.name || s.share || s.path || '');
              const label = proto === 'nfs' ? `${host}:${name}` : `//${host}/${name}`;
              return (
                <div
                  key={i}
                  className="row"
                  style={{
                    gap: 8,
                    padding: '6px 12px',
                    background: 'rgba(255,255,255,0.02)',
                    border: '1px solid var(--stroke-1)',
                    borderRadius: 999,
                    fontSize: 11.5,
                  }}
                >
                  <Icon name="share" size={12} style={{ color: 'var(--teal-bright)' }}/>
                  <span className="mono">{label}</span>
                  <button type="button" className="btn ghost sm" style={{ height: 22 }} onClick={() => addShare(s)} disabled={busy}>
                    <Icon name="plus" size={11}/>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="card">
        {shares.length === 0 ? (
          <div className="empty">No shares configured.</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 60 }}>Type</th>
                <th>Name</th>
                <th>Host / Path</th>
                <th style={{ width: 110 }}>Status</th>
                <th style={{ width: 170 }}/>
              </tr>
            </thead>
            <tbody>
              {shares.map((sh) => {
                const isNfs = sh.protocol?.toLowerCase() === 'nfs';
                const formattedTarget = isNfs
                  ? `${sh.host}:${sh.shareName || '/'}${sh.path ? '/' + sh.path : ''}`
                  : `//${sh.host}/${sh.shareName || ''}${sh.path ? '/' + sh.path : ''}`;
                return (
                  <tr key={sh.id}>
                    <td>
                      <span
                        className="chip"
                        style={{
                          background: !isNfs ? 'rgba(120,100,220,0.14)' : 'rgba(52,215,150,0.14)',
                          borderColor: !isNfs ? 'rgba(120,100,220,0.3)' : 'rgba(52,215,150,0.3)',
                          color: !isNfs ? '#a89bff' : 'var(--ok)',
                        }}
                      >
                        {(sh.protocol || 'smb').toUpperCase()}
                      </span>
                    </td>
                    <td style={{ fontWeight: 600, color: 'var(--t-0)' }}>{sh.name}</td>
                    <td className="mono muted" style={{ fontSize: 11 }}>
                      {formattedTarget}
                    </td>
                    <td>
                      {sh.status === 'mounted'
                        ? <span className="chip ok"><span className="dot"/> Mounted</span>
                        : <span className="chip"><span className="dot"/> {sh.status || 'configured'}</span>}
                    </td>
                    <td>
                      <div className="row" style={{ gap: 4 }}>
                        <button type="button" className="btn ghost sm" onClick={() => testShare(sh)}>Test</button>
                        <button
                          type="button"
                          className="btn ghost sm"
                          onClick={() => setEditing({
                            id: sh.id,
                            name: sh.name || '',
                            protocol: isNfs ? 'nfs' : 'smb',
                            host: sh.host || '',
                            port: sh.port || '',
                            shareName: sh.shareName || '',
                            path: sh.path || '',
                            username: sh.username || '',
                            domain: sh.domain || '',
                            password: sh.password || '',
                            baseVersion: config?.configVersion ?? null,
                          })}
                        >
                          Edit
                        </button>
                        <button type="button" className="btn ghost sm" onClick={() => removeShare(sh.id)}>
                          <Icon name="trash" size={13}/>
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

      {editing && (
        <Modal
          title={`Edit ${editing.name || 'Share'}`}
          eyebrow="Network Share"
          width={500}
          onClose={() => setEditing(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button>
              <button type="button" className="btn primary" disabled={busy} onClick={saveEdit}>Save</button>
            </>
          }
        >
          <div className="col" style={{ gap: 10 }}>
            <label className="eyebrow" htmlFor="edit-sh-name">Display Name</label>
            <input id="edit-sh-name" className="input" value={editing.name} onChange={(e) => updateEditField('name', e.target.value)}/>
            <label className="eyebrow" htmlFor="edit-sh-host">Host / IP</label>
            <input id="edit-sh-host" className="input" value={editing.host} onChange={(e) => updateEditField('host', e.target.value)}/>
            <label className="eyebrow" htmlFor="edit-sh-share">{editing.protocol === 'nfs' ? 'Export Path' : 'Share Name'}</label>
            <input id="edit-sh-share" className="input" value={editing.shareName} onChange={(e) => updateEditField('shareName', e.target.value)}/>
            <label className="eyebrow" htmlFor="edit-sh-path">Subpath (optional)</label>
            <input id="edit-sh-path" className="input" value={editing.path} onChange={(e) => updateEditField('path', e.target.value)}/>
            {editing.protocol === 'smb' && (
              <>
                <label className="eyebrow" htmlFor="edit-sh-domain">Domain (optional)</label>
                <input id="edit-sh-domain" className="input" value={editing.domain} onChange={(e) => updateEditField('domain', e.target.value)}/>
                <label className="eyebrow" htmlFor="edit-sh-user">Username</label>
                <input id="edit-sh-user" className="input" value={editing.username} onChange={(e) => updateEditField('username', e.target.value)}/>
                <label className="eyebrow" htmlFor="edit-sh-pw">Password</label>
                <input id="edit-sh-pw" className="input" type="password" value={editing.password} onChange={(e) => updateEditField('password', e.target.value)}/>
              </>
            )}
          </div>
        </Modal>
      )}

      {secretDropPrompt && (
        <Modal
          title="Share password required"
          eyebrow="Target changed"
          width={480}
          onClose={() => setSecretDropPrompt(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setSecretDropPrompt(null)}>Re-enter password</button>
              <button type="button" className="btn danger" disabled={busy} onClick={() => secretDropPrompt.retryDrop()}>
                Save without password
              </button>
            </>
          }
        >
          <div style={{ fontSize: 13, color: 'var(--t-1)', lineHeight: 1.55 }}>
            {secretDropPrompt.message || 'Changing the share host, share name, or account cleared the stored password.'} Re-enter the password or confirm saving with an empty password.
          </div>
        </Modal>
      )}
    </div>
  );
}
