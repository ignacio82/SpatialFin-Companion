import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import Icon from './Icon.jsx';
import Modal from './Modal.jsx';
import Segmented from './Segmented.jsx';
import { api } from '../api.js';

const STEPS = { home: 'home', scan: 'scan', direct: 'direct', confirm: 'confirm', done: 'done' };

const canLiveScan =
  typeof window !== 'undefined' &&
  window.isSecureContext &&
  typeof navigator !== 'undefined' &&
  !!navigator.mediaDevices &&
  typeof navigator.mediaDevices.getUserMedia === 'function';

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

function decodeImageData(imageData) {
  const result = jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: 'attemptBoth',
  });
  return result && result.data ? result.data.trim() : null;
}

async function decodeQrFromFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('Could not read that image.'));
      im.src = url;
    });
    const maxDim = 1600;
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height) || 1);
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, width, height);
    return decodeImageData(ctx.getImageData(0, 0, width, height));
  } finally {
    URL.revokeObjectURL(url);
  }
}

function parseQrPayload(text) {
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object') return obj;
  } catch (_) { /* not JSON — server still validates */ }
  return null;
}

export default function TvPairingModal({ onClose, onToast }) {
  const [step, setStep] = useState(STEPS.home);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Direct entry
  const [hint, setHint] = useState(null);
  const [hostInput, setHostInput] = useState('');
  const [portInput, setPortInput] = useState('');
  const [code, setCode] = useState('');

  // QR scan
  const [liveScan, setLiveScan] = useState(false);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(0);
  const fileInputRef = useRef(null);

  const [confirm, setConfirm] = useState(null); // { candidate, sourceStep, qrPayload }

  useEffect(() => {
    api.tvSubnetHint().then((h) => {
      setHint(h);
      if (h?.prefix) setHostInput(h.prefix);
      if (h?.port) setPortInput(String(h.port));
    }).catch(() => {});
  }, []);

  function stopLiveScan() {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setLiveScan(false);
  }

  // Tear the camera down whenever we leave the scan step or unmount.
  useEffect(() => {
    if (step !== STEPS.scan) stopLiveScan();
    return stopLiveScan;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  function onDecoded(text) {
    stopLiveScan();
    const parsed = parseQrPayload(text);
    setConfirm({
      candidate: parsed
        ? {
            device_name: parsed.device_name,
            receiver_url: parsed.receiver_url,
            ip: parsed.ip,
            expires_at_epoch_ms: parsed.expires_at_epoch_ms,
          }
        : { device_name: 'TV' },
      sourceStep: STEPS.scan,
      qrPayload: text,
    });
    setStep(STEPS.confirm);
  }

  async function startLiveScan() {
    setError('');
    if (!canLiveScan) {
      setError('Live camera needs HTTPS. Tap “Take a photo of the QR” instead.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      streamRef.current = stream;
      setLiveScan(true);
      const video = videoRef.current;
      if (!video) {
        stopLiveScan();
        return;
      }
      video.srcObject = stream;
      video.setAttribute('playsinline', 'true');
      await video.play();
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const tick = () => {
        if (!streamRef.current || !videoRef.current) return;
        const v = videoRef.current;
        if (v.readyState >= 2 && v.videoWidth) {
          canvas.width = v.videoWidth;
          canvas.height = v.videoHeight;
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          const found = decodeImageData(ctx.getImageData(0, 0, canvas.width, canvas.height));
          if (found) {
            onDecoded(found);
            return;
          }
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch (_) {
      stopLiveScan();
      setError('Could not open the camera. Tap “Take a photo of the QR” instead.');
    }
  }

  async function onPickPhoto(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const text = await decodeQrFromFile(file);
      if (!text) {
        setError('No QR code found in that photo. Fill the frame with the TV’s QR and try again.');
        return;
      }
      onDecoded(text);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function doResolveDirect() {
    setBusy(true);
    setError('');
    try {
      const host = hostInput.trim();
      const portNum = Number(portInput) || 50500;
      const manualCode = normalizeCode(code);
      if (!host) throw new Error('Enter a TV host or IP.');
      if (manualCode.length !== 6) throw new Error('Enter the 6-character pairing code from your TV.');
      const receiverUrl = 'http://' + host + ':' + portNum + '/api/v1/tv-pairing/config';
      const res = await api.tvResolve({ receiverUrl, manualCode });
      setConfirm({ candidate: res.candidate, sourceStep: STEPS.direct });
      setStep(STEPS.confirm);
    } catch (e) {
      setError(describeError(e));
    } finally { setBusy(false); }
  }

  async function doPair() {
    if (!confirm) return;
    setBusy(true);
    setError('');
    try {
      let deviceName;
      if (confirm.qrPayload) {
        const res = await api.tvPairQr({ payload: confirm.qrPayload });
        deviceName = res?.deviceName || confirm.candidate?.device_name || 'TV';
      } else {
        if (!confirm.candidate) return;
        await api.tvPairManual({ candidate: confirm.candidate });
        deviceName = confirm.candidate.device_name || 'TV';
      }
      onToast?.(`Paired ${deviceName}`, 'success');
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
        <button className="btn lg primary" onClick={() => { setError(''); setStep(STEPS.scan); }}>
          <Icon name="qr" size={14}/> Scan the QR on the TV
        </button>
        <button className="btn lg" onClick={() => { setError(''); setStep(STEPS.direct); }}>
          <Icon name="signal" size={14}/> Direct IP address
        </button>
      </div>
    );
  } else if (step === STEPS.scan) {
    body = (
      <div className="col" style={{ gap: 12 }}>
        <div className="muted" style={{ fontSize: 12 }}>
          Point at the QR code on the TV pairing screen. Taking a photo works on any
          connection; live scanning needs an HTTPS dashboard.
        </div>
        {liveScan ? (
          <div
            style={{
              position: 'relative',
              borderRadius: 12,
              overflow: 'hidden',
              background: '#000',
              border: '1px solid var(--stroke-1)',
              aspectRatio: '1 / 1',
            }}
          >
            <video
              ref={videoRef}
              muted
              playsInline
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
            <div
              style={{
                position: 'absolute',
                inset: '14%',
                border: '2px solid rgba(255,255,255,0.85)',
                borderRadius: 12,
                boxShadow: '0 0 0 100vmax rgba(0,0,0,0.35)',
              }}
            />
          </div>
        ) : (
          <div
            className="muted"
            style={{
              display: 'grid',
              placeItems: 'center',
              aspectRatio: '1 / 1',
              borderRadius: 12,
              border: '1px dashed var(--stroke-1)',
              background: 'rgba(255,255,255,0.02)',
              fontSize: 12,
              textAlign: 'center',
              padding: 16,
            }}
          >
            <span>
              <Icon name="qr" size={26}/>
              <br/>
              {busy ? 'Reading photo…' : 'Capture the TV’s QR code'}
            </span>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={onPickPhoto}
          style={{ display: 'none' }}
        />
        <div className="pair-input-row">
          <button
            className="btn primary"
            onClick={() => fileInputRef.current && fileInputRef.current.click()}
            disabled={busy}
          >
            <Icon name="qr" size={13}/> Take a photo of the QR
          </button>
          {canLiveScan && !liveScan && (
            <button className="btn" onClick={startLiveScan} disabled={busy}>
              Use live camera
            </button>
          )}
          {liveScan && (
            <button className="btn" onClick={stopLiveScan}>
              Stop camera
            </button>
          )}
        </div>
      </div>
    );
  } else if (step === STEPS.direct) {
    body = (
      <div className="col" style={{ gap: 12 }}>
        <div className="muted" style={{ fontSize: 12 }}>
          Enter the TV's IP address (or hostname), the SpatialFin receiver port, and the
          6-character pairing code shown on the TV.
          {hint?.primary && (
            <> Companion sees the network as <span className="mono" style={{ color: 'var(--t-1)' }}>{hint.primary}</span>.</>
          )}
        </div>
        <div className="pair-input-row">
          <input
            className="input"
            placeholder="192.168.1.42"
            value={hostInput}
            onChange={(e) => setHostInput(e.target.value)}
            inputMode="decimal"
            autoFocus
          />
          <input
            className="input"
            placeholder="50500"
            value={portInput}
            onChange={(e) => setPortInput(e.target.value)}
            inputMode="numeric"
            pattern="[0-9]*"
          />
        </div>
        <div className="pair-input-row">
          <input
            className="input"
            placeholder="A1B2C3"
            value={code}
            onChange={(e) => setCode(normalizeCode(e.target.value))}
            style={{ letterSpacing: '0.3em', textAlign: 'center', fontSize: 18, fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace' }}
          />
          <button className="btn primary" onClick={doResolveDirect} disabled={busy || code.length !== 6}>
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
          {(c.receiver_url || c.ip) && (
            <div className="mono muted" style={{ fontSize: 11, marginTop: 4, wordBreak: 'break-all' }}>
              {c.receiver_url || c.ip}
            </div>
          )}
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
          <button className="btn ghost" onClick={() => { setError(''); stopLiveScan(); setStep(STEPS.home); }}>
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
              { value: STEPS.scan, label: 'Scan QR' },
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
