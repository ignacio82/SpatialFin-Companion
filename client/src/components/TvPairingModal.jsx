import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import Modal from './Modal.jsx';
import Segmented from './Segmented.jsx';
import { api } from '../api.js';

const STEPS = { home: 'home', direct: 'direct', manual: 'manual', confirm: 'confirm', done: 'done' };

function normalizeCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

function describeError(err) {
  if (!err) return 'TV pairing failed.';
  if (err.message) return err.message;
  const payload = err.payload;
  if (payload && payload.message) return payload.message;
  return 'TV pairing failed.';
}

export default function TvPairingModal({ onClose, onToast }) {
  const [step, setStep] = useState(STEPS.home);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Direct entry
  const [hint, setHint] = useState(null);
  const [hostInput, setHostInput] = useState('');
  const [portInput, setPortInput] = useState('');

  // Manual code
  const [code, setCode] = useState('');
  const [candidates, setCandidates] = useState([]);
  const [scannedCount, setScannedCount] = useState(0);
  const [selectedIdx, setSelectedIdx] = useState(0);

  const [confirm, setConfirm] = useState(null); // { candidate, sourceStep }

  useEffect(() => {
    api.tvSubnetHint().then((h) => {
      setHint(h);
      if (h?.prefix) setHostInput(h.prefix);
      if (h?.port) setPortInput(String(h.port));
    }).catch(() => {});
  }, []);

  async function doResolveDirect() {
    setBusy(true);
    setError('');
    try {
      const host = hostInput.trim();
      const portNum = Number(portInput) || 50500;
      if (!host) throw new Error('Enter a TV host or IP.');
      const receiverUrl = 'http://' + host + ':' + portNum + '/api/v1/tv-pairing/config';
      const res = await api.tvResolve({ receiverUrl });
      setConfirm({ candidate: res.candidate, sourceStep: STEPS.direct });
      setStep(STEPS.confirm);
    } catch (e) {
      setError(describeError(e));
    } finally { setBusy(false); }
  }

  async function doDiscover() {
    const normalized = normalizeCode(code);
    if (normalized.length !== 6) {
      setError('Enter the 6-character code from your TV.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await api.tvDiscover({ manualCode: normalized });
      const list = Array.isArray(res.candidates) ? res.candidates : [];
      setCandidates(list);
      setScannedCount(res.scannedCount || 0);
      setSelectedIdx(0);
      if (list.length === 0) {
        setError('No TVs found on this network with that code. Make sure the TV is on and showing a code.');
      } else if (list.length === 1) {
        setConfirm({ candidate: list[0], sourceStep: STEPS.manual });
        setStep(STEPS.confirm);
      }
    } catch (e) {
      setError(describeError(e));
    } finally { setBusy(false); }
  }

  async function doPair() {
    if (!confirm?.candidate) return;
    setBusy(true);
    setError('');
    try {
      await api.tvPairManual({ candidate: confirm.candidate });
      onToast?.(`Paired ${confirm.candidate.device_name || 'TV'}`, 'success');
      setStep(STEPS.done);
    } catch (e) {
      setError(describeError(e));
    } finally { setBusy(false); }
  }

  let body;
  if (step === STEPS.home) {
    body = (
      <div className="col" style={{ gap: 12 }}>
        <div className="muted" style={{ fontSize: 12 }}>
          Choose how to connect this companion to your Google TV. Make sure the SpatialFin TV
          receiver is running on the TV and showing the pairing screen.
        </div>
        <button className="btn lg" onClick={() => { setError(''); setStep(STEPS.manual); }}>
          <Icon name="qr" size={14}/> Enter 6-character code
        </button>
        <button className="btn lg" onClick={() => { setError(''); setStep(STEPS.direct); }}>
          <Icon name="signal" size={14}/> Direct IP address
        </button>
      </div>
    );
  } else if (step === STEPS.manual) {
    body = (
      <div className="col" style={{ gap: 12 }}>
        <div className="muted" style={{ fontSize: 12 }}>
          Type the 6-character code currently showing on your TV. The companion will scan the
          local subnet for it.
        </div>
        <div className="row" style={{ gap: 8 }}>
          <input
            className="input"
            placeholder="A1B2C3"
            value={code}
            onChange={(e) => setCode(normalizeCode(e.target.value))}
            style={{ flex: 1, letterSpacing: '0.3em', textAlign: 'center', fontSize: 18, fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace' }}
            autoFocus
          />
          <button className="btn primary" onClick={doDiscover} disabled={busy || code.length !== 6}>
            {busy ? 'Searching…' : 'Discover'}
          </button>
        </div>
        {candidates.length > 1 && (
          <div className="col" style={{ gap: 6 }}>
            <div className="eyebrow">Found {candidates.length} TVs · scanned {scannedCount} hosts</div>
            {candidates.map((c, i) => (
              <label
                key={i}
                className="row"
                style={{
                  gap: 10,
                  padding: 10,
                  borderRadius: 8,
                  background: i === selectedIdx ? 'rgba(0,164,220,0.12)' : 'rgba(255,255,255,0.02)',
                  border: '1px solid ' + (i === selectedIdx ? 'var(--stroke-active)' : 'var(--stroke-1)'),
                  cursor: 'pointer',
                }}
              >
                <input type="radio" checked={i === selectedIdx} onChange={() => setSelectedIdx(i)}/>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: 'var(--t-0)' }}>{c.device_name || 'TV'}</div>
                  <div className="mono muted" style={{ fontSize: 11 }}>{c.receiver_url || c.ip}</div>
                </div>
              </label>
            ))}
            <button
              className="btn primary"
              onClick={() => { setConfirm({ candidate: candidates[selectedIdx], sourceStep: STEPS.manual }); setStep(STEPS.confirm); }}
            >
              Continue
            </button>
          </div>
        )}
      </div>
    );
  } else if (step === STEPS.direct) {
    body = (
      <div className="col" style={{ gap: 12 }}>
        <div className="muted" style={{ fontSize: 12 }}>
          Enter the TV's IP address (or hostname) and the SpatialFin receiver port.
          {hint?.primary && (
            <> Companion sees the network as <span className="mono" style={{ color: 'var(--t-1)' }}>{hint.primary}</span>.</>
          )}
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input
            className="input"
            placeholder="192.168.1.42"
            value={hostInput}
            onChange={(e) => setHostInput(e.target.value)}
            style={{ flex: 2, minWidth: 200 }}
            autoFocus
          />
          <input
            className="input"
            placeholder="50500"
            value={portInput}
            onChange={(e) => setPortInput(e.target.value)}
            style={{ flex: 1, minWidth: 120 }}
          />
          <button className="btn primary" onClick={doResolveDirect} disabled={busy}>
            {busy ? 'Checking…' : 'Look up'}
          </button>
        </div>
      </div>
    );
  } else if (step === STEPS.confirm) {
    const c = confirm?.candidate || {};
    body = (
      <div className="col" style={{ gap: 12 }}>
        <div className="muted" style={{ fontSize: 12 }}>Confirm and pair:</div>
        <div
          style={{
            padding: 14,
            borderRadius: 12,
            background: 'rgba(0,164,220,0.05)',
            border: '1px solid var(--stroke-active)',
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--t-0)' }}>
            {c.device_name || 'TV'}
          </div>
          <div className="mono muted" style={{ fontSize: 11, marginTop: 4 }}>
            {c.receiver_url || c.ip}
          </div>
          {c.expires_at_epoch_ms && (
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              Code expires: {new Date(c.expires_at_epoch_ms).toLocaleString()}
            </div>
          )}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn" onClick={() => setStep(confirm?.sourceStep || STEPS.home)}>
            Back
          </button>
          <button className="btn primary" onClick={doPair} disabled={busy}>
            <Icon name="check" size={13}/> {busy ? 'Pairing…' : 'Pair TV'}
          </button>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="col" style={{ gap: 12, alignItems: 'center', padding: '12px 0' }}>
        <div
          style={{
            width: 60,
            height: 60,
            borderRadius: 50,
            background: 'linear-gradient(135deg, rgba(52,215,150,0.18), rgba(52,215,150,0.05))',
            display: 'grid',
            placeItems: 'center',
            color: 'var(--ok)',
            border: '1px solid rgba(52,215,150,0.3)',
          }}
        >
          <Icon name="check" size={28}/>
        </div>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--t-0)' }}>TV paired</div>
        <div className="muted" style={{ fontSize: 12, textAlign: 'center' }}>
          The TV will now show as a cast target from your headsets.
        </div>
        <button className="btn primary" onClick={onClose}>Done</button>
      </div>
    );
  }

  return (
    <Modal
      title={step === STEPS.done ? 'Pairing complete' : 'Pair TV'}
      eyebrow="Cast targets"
      width={560}
      onClose={onClose}
      footer={
        step !== STEPS.home && step !== STEPS.done ? (
          <button className="btn ghost" onClick={() => { setError(''); setStep(STEPS.home); }}>
            ← Back
          </button>
        ) : null
      }
    >
      <div className="col" style={{ gap: 14 }}>
        {step === STEPS.home && (
          <Segmented
            value=""
            onChange={(v) => { setError(''); setStep(v); }}
            options={[
              { value: STEPS.manual, label: 'Code' },
              { value: STEPS.direct, label: 'Direct IP' },
            ]}
          />
        )}
        {body}
        {error && (
          <div className="chip err" style={{ alignSelf: 'flex-start', maxWidth: '100%' }}>
            <span className="dot"/> {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
