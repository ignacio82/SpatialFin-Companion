import { useEffect, useState } from 'react';
import Icon from '../components/Icon.jsx';
import Toggle from '../components/Toggle.jsx';
import Modal from '../components/Modal.jsx';
import { api } from '../api.js';
import { useWebSocketEvent } from '../ws.js';
import { ago } from '../format.js';

const KEYS = {
  wipe: 'pref_app_lock_wipe_on_fail',
  attempts: 'pref_app_lock_max_attempts',
};

function hasPolicy(map) {
  return Boolean(map && (map[KEYS.wipe] !== undefined || map[KEYS.attempts] !== undefined));
}

export default function Security({ config, reloadConfig, onToast }) {
  const gp = config?.globalPreferences || {};
  const [baseGlobalPrefs, setBaseGlobalPrefs] = useState(() => ({ ...gp }));
  const [draftBaseVersion, setDraftBaseVersion] = useState(() => config?.configVersion ?? null);
  const [enforced, setEnforced] = useState(() => hasPolicy(gp));
  const [wipe, setWipe] = useState(() => gp[KEYS.wipe] === 'true');
  const [attempts, setAttempts] = useState(() => Number(gp[KEYS.attempts] || 3));
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [devices, setDevices] = useState([]);
  const [busy, setBusy] = useState(false);
  const [editingDevice, setEditingDevice] = useState(null);

  useEffect(() => {
    if (!dirty) {
      const nextGp = config?.globalPreferences || {};
      setBaseGlobalPrefs({ ...nextGp });
      setDraftBaseVersion(config?.configVersion ?? null);
      setEnforced(hasPolicy(nextGp));
      setWipe(nextGp[KEYS.wipe] === 'true');
      setAttempts(Number(nextGp[KEYS.attempts] || 3));
    }
  }, [config, dirty]);

  useEffect(() => { reloadDevices(); }, []);
  useWebSocketEvent('config_changed', () => reloadDevices());

  async function reloadDevices() {
    try {
      const data = await api.deviceLogs();
      const list = Array.isArray(data?.devices) ? data.devices : (Array.isArray(data) ? data : []);
      setDevices(list);
    } catch (_) {}
  }

  async function reloadLatest() {
    setConflict(false);
    const latest = await reloadConfig?.();
    const nextGp = (latest || config)?.globalPreferences || {};
    setBaseGlobalPrefs({ ...nextGp });
    setDraftBaseVersion((latest || config)?.configVersion ?? null);
    setEnforced(hasPolicy(nextGp));
    setWipe(nextGp[KEYS.wipe] === 'true');
    setAttempts(Number(nextGp[KEYS.attempts] || 3));
    setDirty(false);
  }

  async function save() {
    setBusy(true);
    setConflict(false);
    try {
      const nextPrefs = { ...baseGlobalPrefs };
      if (enforced) {
        nextPrefs[KEYS.wipe] = wipe ? 'true' : 'false';
        nextPrefs[KEYS.attempts] = String(Math.min(3, Math.max(1, Number(attempts) || 3)));
      } else {
        nextPrefs[KEYS.wipe] = null;
        nextPrefs[KEYS.attempts] = null;
      }
      await api.setConfig({ globalPreferences: nextPrefs }, draftBaseVersion);
      setDirty(false);
      await reloadConfig?.();
      onToast?.('Security policy saved · pushing to enrolled devices', 'success');
    } catch (e) {
      if (e?.status === 409) {
        setConflict(true);
        onToast?.('Configuration changed in another session — reload latest', 'warning');
      } else {
        onToast?.('Save failed: ' + e.message, 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveDeviceOverride(deviceId, override) {
    setBusy(true);
    setConflict(false);
    try {
      if (!override.enforced) {
        await api.setDevicePrefs(
          deviceId,
          { [KEYS.wipe]: null, [KEYS.attempts]: null },
          override.baseVersion ?? config?.configVersion
        );
        onToast?.('Override cleared · device inherits global policy', 'success');
      } else {
        const body = {
          [KEYS.wipe]: override.wipe ? 'true' : 'false',
          [KEYS.attempts]: String(Math.min(3, Math.max(1, Number(override.attempts) || 3))),
        };
        await api.setDevicePrefs(deviceId, body, override.baseVersion ?? config?.configVersion);
        onToast?.('Override pushed to device', 'success');
      }
      await reloadConfig?.();
      setEditingDevice(null);
    } catch (e) {
      if (e?.status === 409) {
        setConflict(true);
        onToast?.('Configuration changed in another session — reload latest', 'warning');
      } else {
        onToast?.('Save failed: ' + e.message, 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  const devicePrefs = config?.devicePreferences || {};

  return (
    <div className="col" style={{ gap: 14 }} data-screen-label="08 Security">
      {conflict && (
        <div className="card" style={{ borderColor: 'rgba(255,181,71,0.5)' }}>
          <div className="row between wrap" style={{ gap: 8 }}>
            <span style={{ fontSize: 12.5 }}>Configuration changed in another session. Your unsaved edits are preserved below.</span>
            <button type="button" className="btn sm primary" onClick={reloadLatest}>Reload latest</button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <div className="titlewrap">
            <span className="eyebrow">Global Default</span>
            <span className="title">App-Lock Wipe Policy</span>
          </div>
          <div className="right">
            {enforced
              ? <span className="chip teal uc"><span className="dot"/> Enforced</span>
              : <span className="chip"><span className="dot"/> Per-device</span>}
          </div>
        </div>

        <div className="setting-row">
          <div>
            <div className="lbl">Push global failed-PIN policy</div>
            <div className="desc">App Lock enrollment (Biometric / PIN) is configured locally on each device. When enabled here, enrolled devices adopt this wipe-on-failure policy.</div>
          </div>
          <div className="ctl">
            <Toggle on={enforced} onChange={(v) => { setDirty(true); setEnforced(v); }}/>
          </div>
        </div>

        <div className="setting-row">
          <div>
            <div className="lbl">Wipe app data on failed PIN attempts</div>
            <div className="desc">Applies to devices with App Lock enabled locally.</div>
          </div>
          <div className="ctl">
            <Toggle on={wipe} onChange={(v) => { setDirty(true); setWipe(v); }} disabled={!enforced}/>
          </div>
        </div>

        <div className="setting-row">
          <div>
            <label className="lbl" htmlFor="sec-max-attempts">Allowed PIN attempts before wipe</label>
            <div className="desc">1 – 3 (default 3).</div>
          </div>
          <div className="ctl">
            <input
              id="sec-max-attempts"
              className="input"
              type="number"
              min="1"
              max="3"
              value={attempts}
              onChange={(e) => { setDirty(true); setAttempts(e.target.value); }}
              style={{ width: 80 }}
              disabled={!enforced}
            />
          </div>
        </div>

        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button type="button" className="btn primary" disabled={busy} onClick={save}>
            <Icon name="check" size={13}/> {busy ? 'Saving…' : 'Save Global Security'}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="titlewrap">
            <span className="eyebrow">Per-Device</span>
            <span className="title">{devices.length} devices</span>
          </div>
          <div className="right">
            <span className="chip">Pushes over WebSocket · &lt;5s</span>
          </div>
        </div>
        {devices.length === 0 ? (
          <div className="empty">No devices have synced yet.</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Device</th>
                <th style={{ width: 170 }}>Policy</th>
                <th style={{ width: 150 }}>Last Seen</th>
                <th style={{ width: 90 }}/>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => {
                const id = d.deviceId || d.id;
                const overrides = devicePrefs[id] || {};
                const hasCustom = hasPolicy(overrides);
                return (
                  <tr key={id}>
                    <td>
                      <div className="row" style={{ gap: 10 }}>
                        <Icon name="headset" size={14} style={{ color: 'var(--t-2)' }}/>
                        <span style={{ fontWeight: 600, color: 'var(--t-0)' }}>{d.name || d.deviceName || id}</span>
                      </div>
                    </td>
                    <td>
                      {hasCustom ? (
                        <span className="chip warn">
                          <span className="dot"/> Custom ({overrides[KEYS.wipe] === 'true' ? `wipe after ${overrides[KEYS.attempts] || 3}` : 'no wipe'})
                        </span>
                      ) : (
                        <span className="muted">inherits global</span>
                      )}
                    </td>
                    <td className="muted tnum" style={{ fontSize: 11 }}>
                      {d.lastSeenAt ? ago(d.lastSeenAt) : '—'}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn ghost sm"
                        onClick={() => setEditingDevice({
                          deviceId: id,
                          name: d.name || d.deviceName || id,
                          enforced: hasCustom,
                          wipe: overrides[KEYS.wipe] === 'true',
                          attempts: Number(overrides[KEYS.attempts] || 3),
                          baseVersion: config?.configVersion ?? null,
                        })}
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {editingDevice && (
        <DeviceOverrideModal
          state={editingDevice}
          onChange={setEditingDevice}
          onSave={() => saveDeviceOverride(editingDevice.deviceId, editingDevice)}
          onClear={() => saveDeviceOverride(editingDevice.deviceId, { ...editingDevice, enforced: false })}
          onClose={() => setEditingDevice(null)}
          busy={busy}
        />
      )}
    </div>
  );
}

function DeviceOverrideModal({ state, onChange, onSave, onClear, onClose, busy }) {
  return (
    <Modal
      title={state.name}
      eyebrow="Per-device policy override"
      width={480}
      onClose={onClose}
      footer={
        <>
          {state.enforced && (
            <button type="button" className="btn danger" onClick={onClear} disabled={busy}>
              Clear override
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" onClick={onSave} disabled={busy}>
            <Icon name="check" size={13}/> {busy ? 'Pushing…' : 'Push to device'}
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 10 }}>
        <div className="setting-row">
          <div>
            <label className="lbl" htmlFor="dev-override-enforced">Custom wipe policy</label>
            <div className="desc">Override global failed-PIN wipe behavior for this device.</div>
          </div>
          <div className="ctl">
            <Toggle
              on={state.enforced}
              onChange={(v) => onChange({ ...state, enforced: v })}
            />
          </div>
        </div>
        {state.enforced && (
          <>
            <div className="setting-row">
              <div><label className="lbl" htmlFor="dev-override-wipe">Wipe on failed PIN</label></div>
              <div className="ctl">
                <Toggle on={state.wipe} onChange={(v) => onChange({ ...state, wipe: v })}/>
              </div>
            </div>
            <div className="setting-row">
              <div><label className="lbl" htmlFor="dev-override-attempts">Max attempts (1–3)</label></div>
              <div className="ctl">
                <input
                  id="dev-override-attempts"
                  className="input"
                  type="number"
                  min="1"
                  max="3"
                  value={state.attempts}
                  onChange={(e) => onChange({ ...state, attempts: e.target.value })}
                  style={{ width: 80 }}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
