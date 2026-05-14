import { useState } from 'react';
import Icon from './Icon.jsx';

export default function Login({ onSubmit, version, hostLabel }) {
  const [pw, setPw] = useState('');
  const [remember, setRemember] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setErr('');
    setBusy(true);
    try {
      await onSubmit(pw, remember);
    } catch (e) {
      setErr(e && e.message ? e.message : 'Login failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-stage" data-screen-label="00 Login">
      <form className="login-card" onSubmit={submit}>
        <div className="row" style={{ justifyContent: 'center', marginBottom: 18 }}>
          <div className="brand-mark" style={{ width: 56, height: 56, borderRadius: 14 }}/>
        </div>
        <div style={{ textAlign: 'center', marginBottom: 22 }}>
          <div className="eyebrow" style={{ color: 'var(--teal-bright)', letterSpacing: '0.22em' }}>
            SpatialFin Companion
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--t-0)', letterSpacing: '-0.012em', marginTop: 6 }}>
            Welcome back, admin
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Authenticate to open the control plane.
          </div>
        </div>
        <div className="col" style={{ gap: 10 }}>
          <label className="eyebrow" htmlFor="login-pw">
            Admin Password
          </label>
          <input
            id="login-pw"
            className="input"
            type="password"
            placeholder="••••••••••••"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            autoFocus
          />
          <label className="row" style={{ gap: 8, fontSize: 11.5, color: 'var(--t-2)' }}>
            <input type="checkbox" checked={remember} onChange={() => setRemember((r) => !r)}/>
            Keep me signed in for 30 days
          </label>
          {err && (
            <div className="chip err" style={{ alignSelf: 'flex-start' }}>
              <span className="dot"/> {err}
            </div>
          )}
          <button type="submit" className="btn primary lg" disabled={busy} style={{ width: '100%', marginTop: 8 }}>
            <Icon name="lock" size={14}/> {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
        <div className="row between" style={{ marginTop: 18, fontSize: 11, color: 'var(--t-3)' }}>
          <span>{version ? `v${version}` : 'companion'}</span>
          <span>{hostLabel || (typeof window !== 'undefined' ? window.location.host : '')}</span>
        </div>
      </form>
    </div>
  );
}
