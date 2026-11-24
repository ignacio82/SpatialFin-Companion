import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import Icon from './Icon.jsx';
import Modal from './Modal.jsx';
import Segmented from './Segmented.jsx';
import { api } from '../api.js';

const STEPS = { home: 'home', discover: 'discover', scan: 'scan', direct: 'direct', confirm: 'confirm', done: 'done' };
const DEFAULT_PAIRING_PORT = 41230;

const canLiveScan =
  typeof window !== 'undefined' &&
  window.isSecureContext &&
  typeof navigator !== 'undefined' &&
  !!navigator.mediaDevices &&
  typeof navigator.mediaDevices.getUserMedia === 'function';

function normalizeCode(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^0-9A-HJKMNP-TV-Z]/g, '')
    .slice(0, 6);
}

function describeError(err) {
  if (!err) return 'Device pairing failed.';
  if (err.errorCode === 'pairing_token_invalid') {
    return err.message || 'The 6-character pairing code was rejected. Check the code on your device and try again.';
  }
  if (err.message) return err.message;
  const payload = err.payload;
  if (payload && (payload.error || payload.message)) return payload.error || payload.message;
  return 'Device pairing failed.';
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

function parseSetupUrlQrClient(text) {
  try {
    const parsed = new URL(String(text || '').trim());
    if (!/^http:$/i.test(parsed.protocol)) return null;
    if ((parsed.pathname.replace(/\/+$/, '') || '/') !== '/setup') return null;
    const hash = String(parsed.hash || '').replace(/^#/, '');
    const token = String(new URLSearchParams(hash).get('t') || '').trim();
    if (!/^[0-9a-f]{32}$/i.test(token)) return null;
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    const port = Number(parsed.port) || DEFAULT_PAIRING_PORT;
    return {
      isSetupUrl: true,
      device_name: 'SpatialFin Device',
      ip: host,
      port,
      receiver_url: `http://${parsed.hostname}:${port}/setup`,
      pairing_token: token.toLowerCase(),
    };
  } catch (_) {
    return null;
  }
}

function parseQrPayload(text) {
  const setupUrl = parseSetupUrlQrClient(text);
  if (setupUrl) return setupUrl;
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object') return obj;
  } catch (_) {}
  return null;
}

function collectVerifiedCandidates(config) {
  const servers = Array.isArray(config?.servers) ? config.servers : [];
  const list = [];
  for (const srv of servers) {
    if (!srv || !srv.id) continue;
    const users = Array.isArray(srv.users) ? srv.users : [];
    for (const u of users) {
      if (!u || !u.id) continue;
      if (u.has_verified_token || (u.access_token && u.access_token !== '***REDACTED***')) {
        list.push({
          key: `${srv.id}:${u.id}`,
          serverId: srv.id,
          serverName: srv.name || srv.id,
          userId: u.id,
          username: u.username || u.name || u.id,
        });
      }
    }
  }
  return list;
}

export default function TvPairingModal({ config, onClose, onToast }) {
  const [step, setStep] = useState(STEPS.home);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Network hint + optional companion URL override
  const [hint, setHint] = useState(null);
  const [companionUrlOverride, setCompanionUrlOverride] = useState('');

  // Verified user / share-only target selection
  const candidates = collectVerifiedCandidates(config);
  const [selectedTarget, setSelectedTarget] = useState(() => {
    if (candidates.length === 1) return candidates[0].key;
    if (candidates.length === 0) return '__share_only__';
    return candidates[0].key;
  });

  // Paste QR / setup URL input
  const [pastedQr, setPastedQr] = useState('');

  // Discover step
  const [discovered, setDiscovered] = useState([]);
  const [discoverSource, setDiscoverSource] = useState('');

  // Direct entry (host + port only; code entered on confirm)
  const [hostInput, setHostInput] = useState('');
  const [portInput, setPortInput] = useState(String(DEFAULT_PAIRING_PORT));

  // Manual pairing code entered on confirm when not QR
  const [code, setCode] = useState('');

  // Done summary
  const [doneResult, setDoneResult] = useState(null);

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
      if (h?.defaultCompanionUrl) setCompanionUrlOverride(h.defaultCompanionUrl);
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

  useEffect(() => {
    if (step !== STEPS.scan) stopLiveScan();
    return stopLiveScan;
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
            port: parsed.port || hint?.port || DEFAULT_PAIRING_PORT,
            expires_at_epoch_ms: parsed.expires_at_epoch_ms,
          }
        : { device_name: 'Device' },
      sourceStep: STEPS.scan,
      qrPayload: text,
    });
    setStep(STEPS.confirm);
  }

  async function runDiscover() {
    setBusy(true);
    setError('');
    setDiscovered([]);
    setDiscoverSource('');
    try {
      const res = await api.tvDiscover({});
      const list = Array.isArray(res?.candidates) ? res.candidates : [];
      setDiscovered(list);
      setDiscoverSource(res?.source || '');
      if (list.length === 0) {
        setError('No waiting SpatialFin devices found on the local network. Check that the pairing screen is open or use Direct IP.');
      }
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
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
        setError('No QR code found in that photo. Fill the frame with the device QR and try again.');
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
      const portNum = Number(portInput) || hint?.port || DEFAULT_PAIRING_PORT;
      if (!host) throw new Error('Enter a device IP address.');
      const res = await api.tvResolve({ host, port: portNum });
      setCode('');
      setConfirm({ candidate: res.candidate, sourceStep: STEPS.direct, qrPayload: null });
      setStep(STEPS.confirm);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function doPair() {
    if (!confirm) return;
    setBusy(true);
    setError('');
    try {
      const payload = {};
      if (companionUrlOverride.trim()) {
        payload.companionUrl = companionUrlOverride.trim();
      }
      if (confirm.qrPayload) {
        payload.qrPayload = confirm.qrPayload;
      } else {
        const c = confirm.candidate || {};
        const manualCode = normalizeCode(code);
        if (manualCode.length !== 6) {
          throw new Error('Enter the 6-character Companion pairing code shown on the device.');
        }
        payload.host = c.ip;
        payload.port = c.port || hint?.port || DEFAULT_PAIRING_PORT;
        payload.manualCode = manualCode;
      }

      if (selectedTarget === '__share_only__') {
        payload.shareOnly = true;
      } else if (selectedTarget) {
        const chosen = candidates.find((cand) => cand.key === selectedTarget);
        if (chosen) {
          payload.serverId = chosen.serverId;
          payload.userId = chosen.userId;
        }
      }

      const res = await api.deviceSetupHandoff(payload);
      const deviceName = res?.deviceName || confirm.candidate?.device_name || 'Device';
      setDoneResult({
        deviceName,
        status: res?.status || 'done',
      });
      onToast?.(`Paired ${deviceName}`, 'success');
      setStep(STEPS.done);
    } catch (e) {
      // Distinguish receiver 401 pairing_token_invalid from admin-session 401 invalid_credentials by errorCode
      if (e?.status === 401 && e?.errorCode === 'pairing_token_invalid') {
        setError(describeError(e));
      } else {
        setError(describeError(e));
      }
    } finally {
      setBusy(false);
    }
  }

  let body;
  if (step === STEPS.home) {
    body = (
      <div className="col" style={{ gap: 12 }}>
        <div className="muted" style={{ fontSize: 12 }}>
          Choose how to set up a waiting SpatialFin TV or XR headset on your local network.
        </div>
        <button
          type="button"
          className="btn lg primary"
          onClick={() => { setError(''); setStep(STEPS.discover); runDiscover(); }}
        >
          <Icon name="signal" size={14}/> Discover on local network
        </button>
        <button
          type="button"
          className="btn lg"
          onClick={() => { setError(''); setStep(STEPS.scan); }}
        >
          <Icon name="qr" size={14}/> Scan QR code on device
        </button>
        <button
          type="button"
          className="btn lg"
          onClick={() => { setError(''); setStep(STEPS.direct); }}
        >
          <Icon name="server" size={14}/> Direct IP address
        </button>
      </div>
    );
  } else if (step === STEPS.discover) {
    body = (
      <div className="col" style={{ gap: 12 }}>
        <div className="row between">
          <div className="muted" style={{ fontSize: 12 }}>
            {busy
              ? 'Scanning local network for waiting devices…'
              : discovered.length > 0
                ? `Found ${discovered.length} device${discovered.length === 1 ? '' : 's'} (${discoverSource || 'lan'}). Select one to continue:`
                : 'No waiting devices detected yet.'}
          </div>
          <button type="button" className="btn sm" onClick={runDiscover} disabled={busy}>
            <Icon name="refresh" size={12}/> Rescan
          </button>
        </div>
        <div className="col" style={{ gap: 8 }} aria-live="polite">
          {discovered.map((cand) => (
            <button
              key={`${cand.ip}:${cand.port}`}
              type="button"
              className="btn"
              style={{ justifyContent: 'space-between', textAlign: 'left', padding: '10px 14px', height: 'auto' }}
              onClick={() => {
                setError('');
                setCode('');
                setConfirm({ candidate: cand, sourceStep: STEPS.discover, qrPayload: null });
                setStep(STEPS.confirm);
              }}
            >
              <div>
                <div style={{ fontWeight: 700, color: 'var(--t-0)' }}>{cand.device_name || 'SpatialFin Device'}</div>
                <div className="mono muted" style={{ fontSize: 11 }}>{cand.ip}:{cand.port || DEFAULT_PAIRING_PORT}</div>
              </div>
              <span className="chip">{cand.device_class || 'tv'}</span>
            </button>
          ))}
        </div>
      </div>
    );
  } else if (step === STEPS.scan) {
    body = (
      <div className="col" style={{ gap: 12 }}>
        <div className="muted" style={{ fontSize: 12 }}>
          Point at the QR code on the device pairing screen. Taking a photo works on any
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
              {busy ? 'Reading photo…' : 'Capture the device QR code'}
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
            type="button"
            className="btn primary"
            onClick={() => fileInputRef.current && fileInputRef.current.click()}
            disabled={busy}
          >
            <Icon name="qr" size={13}/> Take a photo of the QR
          </button>
          {canLiveScan && !liveScan && (
            <button type="button" className="btn" onClick={startLiveScan} disabled={busy}>
              Use live camera
            </button>
          )}
          {liveScan && (
            <button type="button" className="btn" onClick={stopLiveScan}>
              Stop camera
            </button>
          )}
        </div>
        <div className="col" style={{ gap: 6, marginTop: 6 }}>
          <label className="eyebrow" htmlFor="tv-paste-qr">Or paste QR JSON / setup URL (http://…/setup#t=…)</label>
          <div className="row" style={{ gap: 8 }}>
            <input
              id="tv-paste-qr"
              className="input mono"
              placeholder="http://192.168.1.42:41230/setup#t=..."
              value={pastedQr}
              onChange={(e) => setPastedQr(e.target.value)}
            />
            <button
              type="button"
              className="btn sm"
              disabled={!pastedQr.trim()}
              onClick={() => {
                const parsed = parseQrPayload(pastedQr.trim());
                if (!parsed) {
                  setError('Paste a valid pairing QR JSON or http://<ip>:41230/setup#t=<token> URL.');
                  return;
                }
                setError('');
                onDecoded(pastedQr.trim());
              }}
            >
              Preview
            </button>
          </div>
        </div>
      </div>
    );
  } else if (step === STEPS.direct) {
    body = (
      <div className="col" style={{ gap: 12 }}>
        <div className="muted" style={{ fontSize: 12 }}>
          Enter the device's LAN IPv4 or IPv6 ULA address and port (default {DEFAULT_PAIRING_PORT}).
          {hint?.primary && (
            <> Companion sees the network as <span className="mono" style={{ color: 'var(--t-1)' }}>{hint.primary}</span>.</>
          )}
        </div>
        <div className="col" style={{ gap: 6 }}>
          <label className="eyebrow" htmlFor="tv-direct-host">Device IP Address</label>
          <input
            id="tv-direct-host"
            className="input"
            placeholder="192.168.1.42 or fd00::42"
            value={hostInput}
            onChange={(e) => setHostInput(e.target.value)}
            inputMode="text"
            autoFocus
          />
        </div>
        <div className="col" style={{ gap: 6 }}>
          <label className="eyebrow" htmlFor="tv-direct-port">Port</label>
          <input
            id="tv-direct-port"
            className="input"
            placeholder={String(DEFAULT_PAIRING_PORT)}
            value={portInput}
            onChange={(e) => setPortInput(e.target.value)}
            inputMode="numeric"
            pattern="[0-9]*"
          />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn primary" onClick={doResolveDirect} disabled={busy || !hostInput.trim()}>
            {busy ? 'Checking…' : 'Look up'}
          </button>
        </div>
      </div>
    );
  } else if (step === STEPS.confirm) {
    const c = confirm?.candidate || {};
    body = (
      <div className="col" style={{ gap: 12 }}>
        <div className="muted" style={{ fontSize: 12 }}>Confirm target device and send configuration:</div>
        <div
          style={{
            padding: 14,
            borderRadius: 12,
            background: 'rgba(0,164,220,0.05)',
            border: '1px solid var(--stroke-active)',
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--t-0)' }}>
            {c.device_name || 'SpatialFin Device'}
          </div>
          {(c.receiver_url || c.ip) && (
            <div className="mono muted" style={{ fontSize: 11, marginTop: 4, wordBreak: 'break-all' }}>
              {c.receiver_url || `${c.ip}:${c.port || hint?.port || DEFAULT_PAIRING_PORT}`}
            </div>
          )}
          {c.expires_at_epoch_ms && (
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              Code expires: {new Date(c.expires_at_epoch_ms).toLocaleString()}
            </div>
          )}
        </div>

        {!confirm?.qrPayload && (
          <div className="col" style={{ gap: 6 }}>
            <label className="eyebrow" htmlFor="tv-confirm-code">Companion pairing code (6 characters)</label>
            <input
              id="tv-confirm-code"
              className="input"
              placeholder="K7P-9M2"
              value={code}
              onChange={(e) => setCode(normalizeCode(e.target.value))}
              style={{ letterSpacing: '0.28em', textAlign: 'center', fontSize: 18, fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace' }}
              autoFocus
            />
          </div>
        )}

        <div className="col" style={{ gap: 6 }}>
          <label className="eyebrow" htmlFor="tv-target-profile">Account / Setup Mode</label>
          <select
            id="tv-target-profile"
            className="select"
            value={selectedTarget}
            onChange={(e) => setSelectedTarget(e.target.value)}
          >
            {candidates.map((cand) => (
              <option key={cand.key} value={cand.key}>
                {cand.serverName} — {cand.username}
              </option>
            ))}
            <option value="__share_only__">Network shares &amp; settings only (no Jellyfin server)</option>
          </select>
        </div>

        {hint?.isLikelyDockerBridge && (
          <div className="chip warn" role="status" aria-live="polite" style={{ alignSelf: 'stretch' }}>
            <span className="dot"/> Companion appears to be on a Docker bridge ({hint.primary}). Override the LAN Companion URL below so the device can reach this server.
          </div>
        )}

        <div className="col" style={{ gap: 6 }}>
          <label className="eyebrow" htmlFor="tv-companion-url">LAN Companion URL (optional override)</label>
          <input
            id="tv-companion-url"
            className="input mono"
            placeholder={hint?.defaultCompanionUrl || 'http://192.168.1.10:1982'}
            value={companionUrlOverride}
            onChange={(e) => setCompanionUrlOverride(e.target.value)}
          />
        </div>

        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" onClick={() => setStep(confirm?.sourceStep || STEPS.home)}>
            Back
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={doPair}
            disabled={busy || (!confirm?.qrPayload && normalizeCode(code).length !== 6)}
          >
            <Icon name="check" size={13}/> {busy ? 'Pairing…' : 'Send setup'}
          </button>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="col" style={{ gap: 12, alignItems: 'center', padding: '12px 0' }} aria-live="polite">
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
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--t-0)' }}>
          {doneResult?.deviceName || 'Device'} paired
        </div>
        <div className="muted" style={{ fontSize: 12, textAlign: 'center' }}>
          {doneResult?.status && doneResult.status !== 'done'
            ? `Status: ${doneResult.status}. Follow the remaining prompt on the device.`
            : 'Configuration was delivered and applied on the device.'}
        </div>
        <button type="button" className="btn primary" onClick={onClose}>Done</button>
      </div>
    );
  }

  return (
    <Modal
      title={step === STEPS.done ? 'Pairing complete' : 'Set up a device'}
      eyebrow="Device setup"
      width={560}
      onClose={onClose}
      footer={
        step !== STEPS.home && step !== STEPS.done ? (
          <button type="button" className="btn ghost" onClick={() => { setError(''); stopLiveScan(); setStep(STEPS.home); }}>
            ← Back
          </button>
        ) : null
      }
    >
      <div className="col" style={{ gap: 14 }}>
        {step === STEPS.home && (
          <Segmented
            value=""
            onChange={(v) => {
              setError('');
              setStep(v);
              if (v === STEPS.discover) runDiscover();
            }}
            options={[
              { value: STEPS.discover, label: 'Discover' },
              { value: STEPS.scan, label: 'Scan QR' },
              { value: STEPS.direct, label: 'Direct IP' },
            ]}
          />
        )}
        {body}
        <div aria-live="polite">
          {error && (
            <div className="chip err" style={{ alignSelf: 'flex-start', maxWidth: '100%' }}>
              <span className="dot"/> {error}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
