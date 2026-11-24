import { useEffect, useRef, useState } from 'react';
import Icon from '../components/Icon.jsx';
import StatusDot from '../components/StatusDot.jsx';
import Toggle from '../components/Toggle.jsx';
import Modal from '../components/Modal.jsx';
import { api } from '../api.js';
import { hashColor } from '../format.js';

const primaryAddress = (srv) => (Array.isArray(srv?.addresses) ? srv.addresses[0] : null) || '';
const isVerifiedUser = (u) =>
  Boolean(u && (u.has_verified_token || (u.access_token && u.access_token !== '***REDACTED***')));

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
  const [addBaseVersion, setAddBaseVersion] = useState(null);
  const [draft, setDraft] = useState({ name: '', address: '' });
  const [testedServerId, setTestedServerId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [conflict, setConflict] = useState(false);
  const [dropConfirm, setDropConfirm] = useState(null); // { retry: () => Promise<boolean>, onCancel?: () => void, unmatched: string[] }
  const [qcModal, setQcModal] = useState(null); // { serverId, serverName, mode: 'link' | 'add_address', initialUrl?: string }

  async function testNew() {
    setBusy(true);
    setTestResult(null);
    setTestedServerId(null);
    try {
      const res = await api.testJellyfin({ url: draft.address });
      if (res.success && res.id) setTestedServerId(res.id);
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
    setConflict(false);
    try {
      let resolvedId = testedServerId;
      if (!resolvedId) {
        try {
          const probe = await api.testJellyfin({ url: draft.address });
          if (probe?.success && probe.id) resolvedId = probe.id;
        } catch (_) { /* offline fallback to srv-* */ }
      }
      const nextServers = [
        ...servers,
        {
          id: resolvedId || ('srv-' + Date.now().toString(36)),
          name: draft.name,
          addresses: [draft.address.trim()],
          users: [],
        },
      ];
      await api.setConfig({ servers: nextServers }, addBaseVersion ?? config?.configVersion);
      await reloadConfig?.();
      onToast?.('Server added — now verify a user under it.', 'success');
      setAdding(false);
      setDraft({ name: '', address: '' });
      setTestedServerId(null);
      setTestResult(null);
    } catch (e) {
      if (e?.status === 409) {
        setConflict(true);
        onToast?.('Configuration changed in another session — reload latest', 'warning');
      } else {
        onToast?.('Failed to add: ' + e.message, 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  async function deleteServer(id) {
    if (!confirm('Remove this server? Verified users on it will lose their tokens.')) return;
    setConflict(false);
    try {
      const nextServers = servers.filter((s) => s.id !== id);
      await api.setConfig({ servers: nextServers }, config?.configVersion);
      await reloadConfig?.();
      onToast?.('Server removed', 'success');
    } catch (e) {
      if (e?.status === 409) setConflict(true);
      onToast?.('Failed: ' + e.message, 'error');
    }
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

  async function updateServer(id, patch, expectedVersion, confirmDropUnmatchedSecrets = false) {
    setBusy(true);
    setConflict(false);
    try {
      const nextServers = servers.map((s) => (s.id === id ? { ...s, ...patch } : s));
      const payload = { servers: nextServers };
      if (confirmDropUnmatchedSecrets) payload.confirmDropUnmatchedSecrets = true;
      await api.setConfig(payload, expectedVersion ?? config?.configVersion);
      await reloadConfig?.();
      setDropConfirm(null);
      return true;
    } catch (e) {
      if (e?.status === 409) {
        setConflict(true);
        onToast?.('Configuration changed in another session — reload latest', 'warning');
      } else if (e?.status === 400 && e?.errorCode === 'redacted_secret_mismatch') {
        setDropConfirm({
          unmatched: e?.payload?.unmatchedSecrets || [],
          retry: () => updateServer(id, patch, expectedVersion, true),
        });
      } else {
        onToast?.('Save failed: ' + e.message, 'error');
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addAndVerifyUser(srv, username, password, confirmDropUnmatchedSecrets = false, expectedVersion = undefined) {
    if (!username || !password) {
      onToast?.('Username and password are required', 'error');
      return false;
    }
    if (!primaryAddress(srv)) {
      onToast?.('Server has no address configured', 'error');
      return false;
    }
    setBusy(true);
    setConflict(false);
    try {
      const payload = { serverId: srv.id, username, password };
      if (confirmDropUnmatchedSecrets) payload.confirmDropUnmatchedSecrets = true;
      const res = await api.verifyUser(payload, expectedVersion);
      await reloadConfig?.();
      setDropConfirm(null);
      if (res && res.success) {
        onToast?.(`Verified ${username}`, 'success');
        return true;
      }
      onToast?.('Verify failed: ' + (res?.error || 'unknown'), 'error');
      return false;
    } catch (e) {
      if (e?.status === 400 && e?.errorCode === 'redacted_secret_mismatch') {
        const challengedVersion = e?.payload?.configVersion ?? config?.configVersion;
        setDropConfirm({
          unmatched: e?.payload?.unmatchedSecrets || [],
          retry: () => addAndVerifyUser(srv, username, password, true, challengedVersion),
        });
      } else if (e?.status === 409) {
        setConflict(true);
        onToast?.('Configuration changed in another session — reload latest', 'warning');
      } else {
        onToast?.('Verify failed: ' + e.message, 'error');
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function unlinkUser(srv, user) {
    const name = user.username || user.name || user.id;
    if (!confirm(`Unlink "${name}" from Companion? Their stored token will be revoked.`)) return;
    setBusy(true);
    setConflict(false);
    try {
      await api.unlinkUser({ serverId: srv.id, userId: user.id, username: user.username || user.name }, config?.configVersion);
      await reloadConfig?.();
      onToast?.(`Unlinked ${name}`, 'success');
    } catch (e) {
      if (e?.status === 409) setConflict(true);
      onToast?.('Unlink failed: ' + e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function updateUser(srvId, userKey, patch, expectedVersion, confirmDropUnmatchedSecrets = false) {
    setBusy(true);
    setConflict(false);
    try {
      const nextServers = servers.map((s) => {
        if (s.id !== srvId) return s;
        const users = (s.users || []).map((u) => {
          const matches = (u.id && u.id === userKey) || (u.username || u.name) === userKey;
          if (!matches) return u;
          return {
            ...u,
            ...patch,
            preferences: patch.preferences !== undefined ? patch.preferences : (u.preferences || {}),
          };
        });
        return { ...s, users };
      });
      const payload = { servers: nextServers };
      if (confirmDropUnmatchedSecrets) payload.confirmDropUnmatchedSecrets = true;
      await api.setConfig(payload, expectedVersion ?? config?.configVersion);
      await reloadConfig?.();
      setDropConfirm(null);
      return true;
    } catch (e) {
      if (e?.status === 409) {
        setConflict(true);
        onToast?.('Configuration changed in another session — reload latest', 'warning');
      } else if (e?.status === 400 && e?.errorCode === 'redacted_secret_mismatch') {
        setDropConfirm({
          unmatched: e?.payload?.unmatchedSecrets || [],
          retry: () => updateUser(srvId, userKey, patch, expectedVersion, true),
        });
      } else {
        onToast?.('Save failed: ' + e.message, 'error');
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function removeUser(srv, username) {
    if (!confirm(`Remove user "${username}"?`)) return;
    setConflict(false);
    try {
      const nextUsers = (srv.users || []).filter((u) => u && (u.username || u.name) !== username);
      const nextServers = servers.map((s) => (s.id === srv.id ? { ...s, users: nextUsers } : s));
      await api.setConfig({ servers: nextServers }, config?.configVersion);
      await reloadConfig?.();
      onToast?.(`Removed ${username}`, 'success');
    } catch (e) {
      if (e?.status === 409) setConflict(true);
      onToast?.('Remove failed: ' + e.message, 'error');
    }
  }

  async function reloadLatest() {
    setConflict(false);
    const latest = await reloadConfig?.();
    if (latest?.configVersion != null) setAddBaseVersion(latest.configVersion);
  }

  const verifiedUserCount = servers.reduce(
    (acc, s) => acc + (Array.isArray(s.users) ? s.users.filter(isVerifiedUser).length : 0),
    0
  );

  return (
    <div className="col" style={{ gap: 14 }} data-screen-label="06 Servers and Users">
      {conflict && (
        <div className="card" style={{ borderColor: 'rgba(255,181,71,0.5)' }}>
          <div className="row between wrap" style={{ gap: 8 }}>
            <span style={{ fontSize: 12.5 }}>Configuration changed in another session. Your unsaved edits remain open below.</span>
            <button type="button" className="btn sm primary" onClick={reloadLatest}>Reload latest</button>
          </div>
        </div>
      )}

      <div className="row between">
        <div className="row" style={{ gap: 12 }}>
          <span className="chip">{servers.length} servers</span>
          <span className="chip">{verifiedUserCount} verified users</span>
        </div>
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            setAdding((a) => {
              const next = !a;
              if (next) setAddBaseVersion(config?.configVersion ?? null);
              return next;
            });
          }}
        >
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
            <div><label className="lbl" htmlFor="new-srv-name">Name</label></div>
            <div className="ctl">
              <input id="new-srv-name" className="input" placeholder="Living Room Jellyfin" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}/>
            </div>
          </div>
          <div className="setting-row">
            <div><label className="lbl" htmlFor="new-srv-url">Server URL</label><div className="desc">e.g. http://jelly.lan:8096. Add more after creation.</div></div>
            <div className="ctl">
              <input id="new-srv-url" className="input" placeholder="http://jelly.lan:8096" value={draft.address} onChange={(e) => { setTestedServerId(null); setDraft((d) => ({ ...d, address: e.target.value })); }}/>
            </div>
          </div>
          {testResult && (
            <div className={'chip ' + (testResult.ok ? 'ok' : 'err')} style={{ marginTop: 8 }}>
              <span className="dot"/> {testResult.label}
            </div>
          )}
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <button type="button" className="btn sm" disabled={busy} onClick={testNew}>Test</button>
            <button type="button" className="btn primary" disabled={busy} onClick={saveNew}>
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
          configVersion={config?.configVersion}
          onTest={() => testExisting(srv)}
          onDelete={() => deleteServer(srv.id)}
          onUpdateServer={(patch, ver) => updateServer(srv.id, patch, ver)}
          onUpdateUser={(userKey, patch, ver) => updateUser(srv.id, userKey, patch, ver)}
          onVerifyUser={(username, password) => addAndVerifyUser(srv, username, password)}
          onQuickConnectLink={() => setQcModal({ serverId: srv.id, serverName: srv.name || srv.id, mode: 'link' })}
          onQuickConnectAddAddress={() => setQcModal({ serverId: srv.id, serverName: srv.name || srv.id, mode: 'add_address' })}
          onUnlinkUser={(user) => unlinkUser(srv, user)}
          onRemoveUser={(username) => removeUser(srv, username)}
          busy={busy}
        />
      ))}

      {qcModal && (
        <QuickConnectLinkModal
          serverId={qcModal.serverId}
          serverName={qcModal.serverName}
          mode={qcModal.mode}
          onClose={() => setQcModal(null)}
          onLinked={async (username) => {
            setQcModal(null);
            await reloadConfig?.();
            onToast?.(`Linked ${username || 'user'} via Quick Connect`, 'success');
          }}
          onRequestDropConfirm={({ unmatched, onConfirm, onCancel }) => {
            setDropConfirm({
              unmatched,
              retry: async () => {
                setDropConfirm(null);
                return await onConfirm();
              },
              onCancel,
            });
          }}
          onToast={onToast}
        />
      )}

      {dropConfirm && (
        <Modal
          title="Drop unmatched stored credentials?"
          eyebrow="Target changed"
          width={500}
          onClose={() => {
            const cancel = dropConfirm.onCancel;
            setDropConfirm(null);
            cancel?.();
          }}
          footer={
            <>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  const cancel = dropConfirm.onCancel;
                  setDropConfirm(null);
                  cancel?.();
                }}
              >
                Cancel
              </button>
              <button type="button" className="btn danger" disabled={busy} onClick={() => dropConfirm.retry()}>
                Confirm &amp; drop secrets
              </button>
            </>
          }
        >
          <div style={{ fontSize: 13, color: 'var(--t-1)', lineHeight: 1.55 }}>
            Updating or expanding server addresses invalidates stored credentials bound to the previous target.
            <strong> Affected verified users will be marked for Quick Connect re-linking</strong> after saving.
            {dropConfirm.unmatched.length > 0 && (
              <div className="mono muted" style={{ fontSize: 11, marginTop: 8 }}>
                Affected: {dropConfirm.unmatched.join(', ')}
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

function formatSpacedCode(code) {
  const digits = String(code || '').replace(/\s+/g, '');
  if (digits.length === 6) return `${digits.slice(0, 3)} ${digits.slice(3)}`;
  return digits;
}

function QuickConnectLinkModal({ serverId, serverName, mode, onClose, onLinked, onRequestDropConfirm, onToast }) {
  const [serverUrl, setServerUrl] = useState('');
  const [pending, setPending] = useState(null); // { pendingId, code, expiresAt }
  const [statusText, setStatusText] = useState(
    mode === 'add_address'
      ? 'Enter the new Jellyfin server URL to verify and add via Quick Connect.'
      : 'Requesting a Quick Connect code…'
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pausedForConfirmRef = useRef(false);
  const pendingRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (pendingRef.current?.pendingId) {
        api.quickConnectCancel(pendingRef.current.pendingId).catch(() => {});
      }
    };
  }, []);

  async function startInitiate(explicitUrl) {
    setBusy(true);
    setError('');
    setStatusText('Requesting Quick Connect code from Jellyfin…');
    try {
      const body = { serverId };
      if (explicitUrl && explicitUrl.trim()) body.serverUrl = explicitUrl.trim();
      const res = await api.quickConnectInitiate(body);
      if (!mountedRef.current) {
        api.quickConnectCancel(res.pendingId).catch(() => {});
        return;
      }
      pendingRef.current = res;
      setPending(res);
      setStatusText('Approve this code in Jellyfin → Quick Connect. Waiting for approval…');
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e.message || 'Could not start Quick Connect.');
      setStatusText('');
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  useEffect(() => {
    if (mode === 'link') {
      startInitiate(null);
    }
  }, [mode, serverId]);

  useEffect(() => {
    if (!pending?.pendingId) return;
    let active = true;
    const poll = async () => {
      if (!active || pausedForConfirmRef.current || !pendingRef.current?.pendingId) return;
      const activeId = pendingRef.current.pendingId;
      try {
        const res = await api.quickConnectPoll({ pendingId: activeId });
        if (!active || !mountedRef.current) return;
        if (res.status === 'authenticated') {
          pendingRef.current = null;
          onLinked?.(res.username);
          return;
        }
        if (res.status === 'expired') {
          pendingRef.current = null;
          setPending(null);
          setError('Quick Connect code expired. Request a new code to try again.');
          setStatusText('');
          return;
        }
        if (res.status === 'failed') {
          pendingRef.current = null;
          setPending(null);
          setError(res.error || 'Quick Connect failed.');
          setStatusText('');
        }
      } catch (e) {
        if (!active || !mountedRef.current) return;
        if (e?.status === 400 && e?.errorCode === 'redacted_secret_mismatch') {
          pausedForConfirmRef.current = true;
          setStatusText('Confirm address expansion to complete linking.');
          onRequestDropConfirm?.({
            unmatched: e?.payload?.unmatchedSecrets || [],
            onConfirm: async () => {
              try {
                const confirmed = await api.quickConnectPoll({
                  pendingId: activeId,
                  confirmDropUnmatchedSecrets: true,
                });
                if (confirmed.status === 'authenticated') {
                  pendingRef.current = null;
                  onLinked?.(confirmed.username);
                  return true;
                }
                pausedForConfirmRef.current = false;
                setError(confirmed.error || 'Quick Connect confirmation expired.');
                return false;
              } catch (err) {
                pausedForConfirmRef.current = false;
                setError(err.message || 'Confirmation failed.');
                onToast?.(err.message || 'Confirmation failed.', 'error');
                return false;
              }
            },
            onCancel: () => {
              pausedForConfirmRef.current = false;
              pendingRef.current = null;
              api.quickConnectCancel(activeId).catch(() => {});
              setPending(null);
              setStatusText('Quick Connect linking cancelled.');
            },
          });
        } else {
          pendingRef.current = null;
          setPending(null);
          setError(e.message || 'Quick Connect polling failed.');
          setStatusText('');
        }
      }
    };
    const timer = setInterval(poll, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [pending?.pendingId]);

  const handleClose = () => {
    if (pendingRef.current?.pendingId) {
      const id = pendingRef.current.pendingId;
      pendingRef.current = null;
      api.quickConnectCancel(id).catch(() => {});
    }
    onClose?.();
  };

  const digitsLabel = pending?.code ? String(pending.code).replace(/\s+/g, '').split('').join(' ') : '';

  return (
    <Modal
      title={mode === 'add_address' ? 'Add address via Quick Connect' : 'Link user via Quick Connect'}
      eyebrow={serverName}
      width={480}
      onClose={handleClose}
      footer={
        <>
          <button type="button" className="btn" onClick={handleClose}>Close</button>
          {mode === 'add_address' && !pending && (
            <button
              type="button"
              className="btn primary"
              disabled={busy || !serverUrl.trim()}
              onClick={() => startInitiate(serverUrl)}
            >
              {busy ? 'Starting…' : 'Start Quick Connect'}
            </button>
          )}
          {mode === 'link' && !pending && !busy && (
            <button type="button" className="btn primary" onClick={() => startInitiate(null)}>
              Try again
            </button>
          )}
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        {mode === 'add_address' && !pending && (
          <div className="col" style={{ gap: 6 }}>
            <label className="eyebrow" htmlFor="qc-new-server-url">New Server URL</label>
            <input
              id="qc-new-server-url"
              className="input"
              placeholder="https://jellyfin.example.com"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              autoFocus
            />
          </div>
        )}
        {pending?.code && (
          <div
            style={{
              textAlign: 'center',
              padding: '18px 14px',
              borderRadius: 12,
              background: 'rgba(0,164,220,0.08)',
              border: '1px solid var(--stroke-active)',
            }}
          >
            <div className="eyebrow" style={{ marginBottom: 8 }}>Quick Connect Code</div>
            <div
              className="mono"
              aria-label={digitsLabel}
              style={{ fontSize: 32, fontWeight: 700, letterSpacing: '0.18em', color: 'var(--t-0)' }}
            >
              {formatSpacedCode(pending.code)}
            </div>
          </div>
        )}
        <div aria-live="polite" style={{ minHeight: 20 }}>
          {statusText && <div className="muted" style={{ fontSize: 12.5 }}>{statusText}</div>}
          {error && (
            <div className="chip err" style={{ marginTop: 6 }}>
              <span className="dot"/> {error}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function ServerCard({
  srv,
  configVersion,
  onTest,
  onDelete,
  onUpdateServer,
  onUpdateUser,
  onVerifyUser,
  onQuickConnectLink,
  onQuickConnectAddAddress,
  onUnlinkUser,
  onRemoveUser,
  busy,
}) {
  const [open, setOpen] = useState(true);
  const [editAddresses, setEditAddresses] = useState(false);
  const [addrDraft, setAddrDraft] = useState((srv.addresses || []).join('\n'));
  const [addrBaseVersion, setAddrBaseVersion] = useState(configVersion ?? null);
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

  async function saveAddresses() {
    const list = addrDraft
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const ok = await onUpdateServer({ addresses: list }, addrBaseVersion);
    if (ok) {
      setEditAddresses(false);
    }
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
          <button type="button" className="btn sm" onClick={onTest}>Test</button>
          <button type="button" className="btn sm ghost" onClick={onDelete} title="Remove server">
            <Icon name="trash" size={13}/>
          </button>
          <button type="button" className="btn icon-only sm ghost" onClick={() => setOpen(!open)}>
            <Icon name={open ? 'chevron-down' : 'chevron'} size={13}/>
          </button>
        </div>
      </div>

      {open && (
        <>
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
                <button type="button" className="btn ghost sm" onClick={() => { setAddrDraft((srv.addresses || []).join('\n')); setEditAddresses(false); }}>
                  Cancel
                </button>
                <button type="button" className="btn primary sm" onClick={saveAddresses} disabled={busy}>
                  <Icon name="check" size={12}/> Save addresses
                </button>
              </div>
            </div>
          ) : (
            <div className="row wrap" style={{ gap: 8, marginBottom: 14 }}>
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => {
                  setAddrDraft((srv.addresses || []).join('\n'));
                  setAddrBaseVersion(configVersion ?? null);
                  setEditAddresses(true);
                }}
                title="Edit primary + fallback addresses"
              >
                <Icon name="settings" size={12}/> Edit addresses
              </button>
              <button
                type="button"
                className="btn sm ghost"
                onClick={onQuickConnectAddAddress}
                disabled={busy}
                title="Add and verify a new server address using Quick Connect"
              >
                <Icon name="plus" size={12}/> Add address via Quick Connect
              </button>
            </div>
          )}

          {users.length === 0 ? (
            <div className="empty" style={{ marginBottom: 12 }}>
              No users yet — add and verify a Jellyfin user so the companion can sync and analyze playback.
            </div>
          ) : (
            <div className="col" style={{ gap: 8 }}>
              {users.map((user) => {
                const name = user.username || user.name || user.userId || user.id;
                const userKey = user.id || name;
                const isOpen = expandedUser === userKey;
                const verified = isVerifiedUser(user);
                return (
                  <div
                    key={userKey}
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
                        {user.needs_relink ? (
                          <button
                            type="button"
                            className="chip err"
                            style={{ cursor: 'pointer' }}
                            onClick={onQuickConnectLink}
                            disabled={busy}
                          >
                            <span className="dot"/> Re-link via Quick Connect
                          </button>
                        ) : verified ? (
                          <>
                            <span className="chip ok"><span className="dot"/> Verified</span>
                            {user.quick_connect_broker_enabled === false && (
                              <span className="chip warn"><span className="dot"/> Manual login only</span>
                            )}
                          </>
                        ) : (
                          <span className="chip warn"><span className="dot"/> Pending</span>
                        )}
                      </div>
                      <div className="row" style={{ gap: 4 }}>
                        {verified && (
                          <button type="button" className="btn ghost sm" onClick={() => onUnlinkUser(user)} disabled={busy}>
                            Unlink
                          </button>
                        )}
                        <button type="button" className="btn ghost sm" onClick={() => setExpandedUser(isOpen ? null : userKey)}>
                          {isOpen ? 'Hide overrides' : 'Overrides'}
                        </button>
                        <button type="button" className="btn ghost sm" onClick={() => onRemoveUser(name)} title="Remove user">
                          <Icon name="trash" size={13}/>
                        </button>
                      </div>
                    </div>
                    {isOpen && (
                      <UserOverrides
                        key={userKey}
                        user={user}
                        configVersion={configVersion}
                        onChange={(patch, ver) => onUpdateUser(userKey, patch, ver)}
                        busy={busy}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {!adding ? (
            <div className="row wrap" style={{ gap: 8, marginTop: 12 }}>
              <button type="button" className="btn sm primary" onClick={onQuickConnectLink} disabled={!url || busy}>
                <Icon name="signal" size={12}/> Link user via Quick Connect
              </button>
              <button type="button" className="btn sm" onClick={() => setAdding(true)} disabled={!url || busy}>
                <Icon name="plus" size={12}/> Verify with Password
              </button>
              {!url && (
                <span className="muted" style={{ fontSize: 11, marginLeft: 4 }}>
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
                Authenticates against {url} and stores only the resulting Jellyfin access token (passwords are never stored).
              </div>
            </form>
          )}
        </>
      )}
    </div>
  );
}

function UserOverrides({ user, configVersion, onChange, busy }) {
  const [draftBaseVersion] = useState(configVersion ?? null);
  const prefs = user.preferences || {};
  const userKey = user.id || user.username;

  const setPref = (key, value) => {
    const next = { ...prefs };
    if (value === '' || value == null) {
      delete next[key];
    } else {
      next[key] = value;
    }
    onChange({ preferences: next }, draftBaseVersion);
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
          <div className="lbl">Allow Quick Connect auto-approval</div>
          <div className="desc">When disabled, paired devices must sign in to this account manually instead of using Companion's setup token.</div>
        </div>
        <div className="ctl">
          <Toggle
            on={user.quick_connect_broker_enabled !== false}
            onChange={(v) => onChange({ quick_connect_broker_enabled: v }, draftBaseVersion)}
            disabled={busy}
          />
        </div>
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

      <MusicAssistantOverride key={`ma-${userKey}`} user={user} configVersion={configVersion} onChange={onChange} busy={busy} />
      <PluginsOverride key={`pl-${userKey}`} user={user} configVersion={configVersion} onChange={onChange} busy={busy} />
    </div>
  );
}

function MusicAssistantOverride({ user, configVersion, onChange, busy }) {
  const ma = user.musicAssistant || {};
  const [draftBaseVersion] = useState(configVersion ?? null);
  const [url, setUrl] = useState(ma.url || '');
  const [token, setToken] = useState(ma.token || '');
  const [username, setUsername] = useState(ma.username || '');
  const [password, setPassword] = useState(ma.password || '');

  const handleUrlChange = (nextUrl) => {
    setUrl(nextUrl);
    if (token === '***REDACTED***') setToken('');
    if (password === '***REDACTED***') setPassword('');
  };

  const save = () => {
    const next = {};
    if (url.trim()) next.url = url.trim();
    if (token.trim()) next.token = token.trim();
    if (username.trim()) next.username = username.trim();
    if (password.trim()) next.password = password.trim();
    onChange({ musicAssistant: next.url ? next : null }, draftBaseVersion);
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
          onChange={(e) => handleUrlChange(e.target.value)}
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
          <button type="button" className="btn sm" onClick={save} disabled={busy}>Save Music Assistant</button>
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          Applied to this user's headsets. Leave the URL empty and save to clear.
        </div>
      </div>
    </div>
  );
}

function PluginsOverride({ user, configVersion, onChange, busy }) {
  const [draftBaseVersion] = useState(configVersion ?? null);
  const [text, setText] = useState((user.plugins || []).join('\n'));

  const save = () => {
    const list = text.split('\n').map((s) => s.trim()).filter(Boolean);
    onChange({ plugins: list }, draftBaseVersion);
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
          <button type="button" className="btn sm" onClick={save} disabled={busy}>Save Plugins</button>
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          Each headset signed in as this user installs these manifests on next sync.
        </div>
      </div>
    </div>
  );
}
