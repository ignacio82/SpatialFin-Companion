import { useEffect, useState } from 'react';
import Icon from '../components/Icon.jsx';
import Toggle from '../components/Toggle.jsx';
import Segmented from '../components/Segmented.jsx';
import { api } from '../api.js';
import { useWebSocketEvent } from '../ws.js';
import { ago } from '../format.js';

const KEYS = {
  mode: 'pref_app_lock_mode',
  wipe: 'pref_app_lock_wipe_on_fail',
  attempts: 'pref_app_lock_max_attempts',
};

export default function Security({ config, reloadConfig, onToast }) {
  const gp = config?.globalPreferences || {};
  const [mode, setMode] = useState(gp[KEYS.mode] || '');
  const [wipe, setWipe] = useState(gp[KEYS.wipe] === 'true');
  const [attempts, setAttempts] = useState(Number(gp[KEYS.attempts] || 1));
  const [devices, setDevices] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setMode(gp[KEYS.mode] || '');
    setWipe(gp[KEYS.wipe] === 'true');
    setAttempts(Number(gp[KEYS.attempts] || 1));
  }, [config]);

  useEffect(() => { reloadDevices(); }, []);
  useWebSocketEvent('config_changed', () => reloadDevices());

  async function reloadDevices() {
    try {
      const data = await api.deviceLogs();
      const list = Array.isArray(data?.devices) ? data.devices : (Array.isArray(data) ? data : []);
      setDevices(list);
    } catch (_) {}
  }

  async function save() {
    setBusy(true);
    try {
      const nextPrefs = { ...gp };
      if (mode) {
        nextPrefs[KEYS.mode] = mode;
        nextPrefs[KEYS.wipe] = wipe ? 'true' : 'false';
        nextPrefs[KEYS.attempts] = String(Math.min(3, Math.max(1, Number(attempts) || 1)));
      } else {
        delete nextPrefs[KEYS.mode];
        delete nextPrefs[KEYS.wipe];
        delete nextPrefs[KEYS.attempts];
      }
      await api.setConfig({ ...config, globalPreferences: nextPrefs });
      await reloadConfig?.();
      onToast?.('Security saved · pushing to devices', 'success');
    } catch (e) { onToast?.('Save failed: ' + e.message, 'error'); }
    finally { setBusy(false); }
  }

  const devicePrefs = config?.devicePreferences || {};

  function effectiveMode(deviceId) {
    const override = devicePrefs[deviceId] || {};
    return override[KEYS.mode] || mode || 'off';
  }

  return (
    <div className="col" style={{ gap: 14 }} data-screen-label="08 Security">

      <div className="card">
        <div className="card-head">
          <div className="titlewrap">
            <span className="eyebrow">Global Default</span>
            <span className="title">App-Lock Enforcement</span>
          </div>
          <div className="right">
            {mode
              ? <span className="chip teal uc"><span className="dot"/> Enforced</span>
              : <span className="chip"><span className="dot"/> Per-device</span>}
          </div>
        </div>

        <div className="setting-row">
          <div>
            <div className="lbl">Enforcement</div>
            <div className="desc">When set, this overrides each device's local choice on every sync.</div>
          </div>
          <div className="ctl">
            <Segmented
              value={mode}
              onChange={setMode}
              options={[
                { value: '', label: 'Not enforced' },
                { value: 'off', label: 'Off' },
                { value: 'biometric', label: 'Biometric' },
                { value: 'pin', label: 'PIN' },
              ]}
            />
          </div>
        </div>

        <div className="setting-row">
          <div>
            <div className="lbl">Wipe app data on failed PIN attempts</div>
            <div className="desc">Only applies when mode is set to SpatialFin PIN.</div>
          </div>
          <div className="ctl"><Toggle on={wipe} onChange={setWipe} disabled={mode !== 'pin'}/></div>
        </div>

        <div className="setting-row">
          <div>
            <div className="lbl">Allowed PIN attempts before wipe</div>
            <div className="desc">1 – 3.</div>
          </div>
          <div className="ctl">
            <input
              className="input"
              type="number"
              min="1"
              max="3"
              value={attempts}
              onChange={(e) => setAttempts(e.target.value)}
              style={{ width: 80 }}
              disabled={mode !== 'pin'}
            />
          </div>
        </div>

        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button className="btn primary" disabled={busy} onClick={save}>
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
                <th style={{ width: 130 }}>Effective Mode</th>
                <th style={{ width: 130 }}>Override</th>
                <th style={{ width: 150 }}>Last Sync</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => {
                const id = d.deviceId || d.id;
                const override = devicePrefs[id]?.[KEYS.mode];
                const eff = effectiveMode(id);
                return (
                  <tr key={id}>
                    <td>
                      <div className="row" style={{ gap: 10 }}>
                        <Icon name="headset" size={14} style={{ color: 'var(--t-2)' }}/>
                        <span style={{ fontWeight: 600, color: 'var(--t-0)' }}>{d.name || d.deviceName || id}</span>
                      </div>
                    </td>
                    <td>
                      <span className={'chip ' + (eff === 'pin' ? 'warn' : eff === 'off' ? '' : 'teal')}>
                        {eff === 'off' ? 'Off' : eff === 'pin' ? 'SpatialFin PIN' : eff === 'biometric' ? 'Biometric' : 'Inherit'}
                      </span>
                    </td>
                    <td>
                      {override
                        ? <span className="chip warn"><span className="dot"/> Custom</span>
                        : <span className="muted">inherits global</span>}
                    </td>
                    <td className="muted tnum" style={{ fontSize: 11 }}>
                      {d.lastSeenAt ? ago(d.lastSeenAt) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
