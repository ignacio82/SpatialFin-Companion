import { useState } from 'react';
import Icon from '../components/Icon.jsx';
import Segmented from '../components/Segmented.jsx';
import { api } from '../api.js';

export default function Shares({ config, reloadConfig, onToast }) {
  const shares = Array.isArray(config?.networkShares) ? config.networkShares : [];
  const [proto, setProto] = useState('smb');
  const [host, setHost] = useState('');
  const [user, setUser] = useState('');
  const [pw, setPw] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [browsed, setBrowsed] = useState([]);

  async function browse() {
    setBrowsing(true);
    setBrowsed([]);
    try {
      const body = { host, username: user, password: pw };
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

  async function addShare(share) {
    try {
      const next = {
        ...config,
        networkShares: [
          ...shares,
          {
            id: 'sh-' + Date.now().toString(36),
            name: share.name || share.path || share.share || 'share',
            protocol: proto.toUpperCase(),
            host,
            path: share.path || share.share || share.name,
            username: user,
            password: pw,
            status: 'unmounted',
          },
        ],
      };
      await api.setConfig(next);
      await reloadConfig?.();
      onToast?.('Share added', 'success');
    } catch (e) { onToast?.('Add failed: ' + e.message, 'error'); }
  }

  async function removeShare(id) {
    if (!confirm('Remove this share?')) return;
    try {
      const next = { ...config, networkShares: shares.filter((s) => s.id !== id) };
      await api.setConfig(next);
      await reloadConfig?.();
    } catch (e) { onToast?.('Remove failed: ' + e.message, 'error'); }
  }

  async function testShare(s) {
    try {
      const res = await api.testShare({
        protocol: s.protocol,
        host: s.host,
        path: s.path,
        username: s.username,
        password: s.password,
      });
      onToast?.(res?.success ? 'Share reachable' : 'Share unreachable: ' + (res?.error || 'unknown'), res?.success ? 'success' : 'error');
    } catch (e) { onToast?.('Test failed: ' + e.message, 'error'); }
  }

  return (
    <div className="col" style={{ gap: 14 }} data-screen-label="07 Network Shares">
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
              onChange={setProto}
              options={[
                { value: 'smb', label: 'SMB' },
                { value: 'nfs', label: 'NFS' },
              ]}
            />
          </div>
        </div>
        <div className="row" style={{ gap: 8, marginBottom: 10 }}>
          <input className="input" placeholder="Host or IP (e.g. nas.lan)" style={{ flex: 1 }} value={host} onChange={(e) => setHost(e.target.value)}/>
          {proto === 'smb' && (
            <>
              <input className="input" placeholder="Username" style={{ width: 160 }} value={user} onChange={(e) => setUser(e.target.value)}/>
              <input className="input" type="password" placeholder="Password" style={{ width: 160 }} value={pw} onChange={(e) => setPw(e.target.value)}/>
            </>
          )}
          <button className="btn" disabled={browsing || !host} onClick={browse}>
            {browsing ? 'Browsing…' : 'Browse'}
          </button>
        </div>
        {browsed.length > 0 && (
          <div className="row wrap" style={{ gap: 6 }}>
            {browsed.map((s, i) => {
              const label = '//' + host + (s.path || s.share || s.name || '');
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
                  <button className="btn ghost sm" style={{ height: 22 }} onClick={() => addShare(s)}>
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
                <th style={{ width: 140 }}/>
              </tr>
            </thead>
            <tbody>
              {shares.map((sh) => (
                <tr key={sh.id}>
                  <td>
                    <span
                      className="chip"
                      style={{
                        background:
                          (sh.protocol || '').toUpperCase() === 'SMB' ? 'rgba(120,100,220,0.14)' : 'rgba(52,215,150,0.14)',
                        borderColor:
                          (sh.protocol || '').toUpperCase() === 'SMB' ? 'rgba(120,100,220,0.3)' : 'rgba(52,215,150,0.3)',
                        color:
                          (sh.protocol || '').toUpperCase() === 'SMB' ? '#a89bff' : 'var(--ok)',
                      }}
                    >
                      {(sh.protocol || '').toUpperCase() || 'SMB'}
                    </span>
                  </td>
                  <td style={{ fontWeight: 600, color: 'var(--t-0)' }}>{sh.name}</td>
                  <td className="mono muted" style={{ fontSize: 11 }}>
                    //{sh.host}{sh.path}
                  </td>
                  <td>
                    {sh.status === 'mounted'
                      ? <span className="chip ok"><span className="dot"/> Mounted</span>
                      : <span className="chip"><span className="dot"/> {sh.status || 'configured'}</span>}
                  </td>
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      <button className="btn ghost sm" onClick={() => testShare(sh)}>Test</button>
                      <button className="btn ghost sm" onClick={() => removeShare(sh.id)}>
                        <Icon name="trash" size={13}/>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
