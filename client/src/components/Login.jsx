import { useState } from 'react';
import Icon from './Icon.jsx';

export default function Login({
  mode = 'login',
  canBootstrapWithPin = true,
  bootstrapPinExpiresAt = null,
  onSubmit,
  onBootstrap,
  onRetryBootstrapCheck,
  version,
  hostLabel,
}) {
  const [pw, setPw] = useState('');
  const [bootstrapPin, setBootstrapPin] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [err, setErr] = useState('');
  const [csrfHint, setCsrfHint] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submitLogin(e) {
    e.preventDefault();
    if (busy) return;
    setErr('');
    setCsrfHint(false);
    setBusy(true);
    try {
      await onSubmit(pw, remember);
    } catch (error) {
      setErr(error?.message || 'Login failed.');
      if (error?.errorCode === 'csrf_rejected') setCsrfHint(true);
    } finally {
      setBusy(false);
    }
  }

  async function submitBootstrap(e) {
    e.preventDefault();
    if (busy || !canBootstrapWithPin) return;
    setErr('');
    setCsrfHint(false);
    setBusy(true);
    try {
      await onBootstrap({ bootstrapPin, newPassword, remember });
    } catch (error) {
      setErr(error?.message || 'Bootstrap failed.');
      if (error?.errorCode === 'csrf_rejected') setCsrfHint(true);
      await onRetryBootstrapCheck?.();
    } finally {
      setBusy(false);
    }
  }

  const isBootstrap = mode === 'needs-bootstrap';

  return (
    <div className="login-stage" data-screen-label="00 Login">
      <form className="login-card" onSubmit={isBootstrap ? submitBootstrap : submitLogin}>
        <div className="row" style={{ justifyContent: 'center', marginBottom: 18 }}>
          <div className="brand-mark" style={{ width: 56, height: 56, borderRadius: 14 }}/>
        </div>
        <div style={{ textAlign: 'center', marginBottom: 22 }}>
          <div className="eyebrow" style={{ color: 'var(--teal-bright)', letterSpacing: '0.22em' }}>
            SpatialFin Companion
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--t-0)', letterSpacing: '-0.012em', marginTop: 6 }}>
            {isBootstrap ? 'Set Admin Password' : 'Welcome back, admin'}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            {isBootstrap
              ? 'No admin password is set yet. Check container stdout (docker logs) for the one-time 12-character bootstrap PIN.'
              : 'Authenticate to open the control plane.'}
          </div>
        </div>

        {isBootstrap ? (
          <div className="col" style={{ gap: 10 }}>
            {!canBootstrapWithPin && (
              <div className="chip warn" role="status" aria-live="polite" style={{ alignSelf: 'stretch' }}>
                <span className="dot"/> Bootstrap PIN is temporarily unavailable or in cooldown. Wait a few minutes and refresh, or set COMPANION_ADMIN_PASSWORD.
              </div>
            )}
            <label className="eyebrow" htmlFor="bootstrap-pin">
              Bootstrap PIN (from server logs)
            </label>
            <input
              id="bootstrap-pin"
              className="input mono"
              type="text"
              placeholder="12-character PIN"
              value={bootstrapPin}
              onChange={(e) => setBootstrapPin(e.target.value)}
              disabled={!canBootstrapWithPin || busy}
              autoFocus
            />
            <label className="eyebrow" htmlFor="bootstrap-new-pw">
              New Admin Password (min 8 characters)
            </label>
            <input
              id="bootstrap-new-pw"
              className="input"
              type="password"
              placeholder="••••••••••••"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={!canBootstrapWithPin || busy}
            />
            <label className="row" style={{ gap: 8, fontSize: 11.5, color: 'var(--t-2)' }}>
              <input type="checkbox" checked={remember} onChange={() => setRemember((r) => !r)}/>
              Keep me signed in for 30 days
            </label>
            {bootstrapPinExpiresAt && canBootstrapWithPin && (
              <div className="muted" style={{ fontSize: 11 }}>
                PIN expires at {new Date(bootstrapPinExpiresAt).toLocaleTimeString()}.
              </div>
            )}
            <div aria-live="polite">
              {err && (
                <div className="chip err" style={{ alignSelf: 'flex-start' }}>
                  <span className="dot"/> {err}
                </div>
              )}
              {csrfHint && (
                <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                  Behind a reverse proxy? Set <span className="mono">COMPANION_TRUST_PROXY=1</span> and forward <span className="mono">X-Forwarded-Proto</span> and <span className="mono">X-Forwarded-Host</span>.
                </div>
              )}
            </div>
            <button
              type="submit"
              className="btn primary lg"
              disabled={busy || !canBootstrapWithPin || !bootstrapPin.trim() || newPassword.length < 8}
              style={{ width: '100%', marginTop: 8 }}
            >
              <Icon name="lock" size={14}/> {busy ? 'Configuring…' : 'Set Admin Password'}
            </button>
            {!canBootstrapWithPin && (
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => onRetryBootstrapCheck?.()}
              >
                Check again
              </button>
            )}
          </div>
        ) : (
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
            <div aria-live="polite">
              {err && (
                <div className="chip err" style={{ alignSelf: 'flex-start' }}>
                  <span className="dot"/> {err}
                </div>
              )}
              {csrfHint && (
                <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                  Behind a reverse proxy? Set <span className="mono">COMPANION_TRUST_PROXY=1</span> and forward <span className="mono">X-Forwarded-Proto</span> and <span className="mono">X-Forwarded-Host</span>.
                </div>
              )}
            </div>
            <button type="submit" className="btn primary lg" disabled={busy} style={{ width: '100%', marginTop: 8 }}>
              <Icon name="lock" size={14}/> {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </div>
        )}

        <div className="row between" style={{ marginTop: 18, fontSize: 11, color: 'var(--t-3)' }}>
          <span>{version ? `v${version}` : 'companion'}</span>
          <span>{hostLabel || (typeof window !== 'undefined' ? window.location.host : '')}</span>
        </div>
      </form>
    </div>
  );
}
