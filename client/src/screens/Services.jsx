import { useEffect, useState } from 'react';
import Icon from '../components/Icon.jsx';
import Toggle from '../components/Toggle.jsx';
import Modal from '../components/Modal.jsx';
import { api } from '../api.js';

const toBool = (v) => v === 'true' || v === true;
const fromBool = (v) => (v ? 'true' : 'false');

export default function Services({ config, reloadConfig, onToast }) {
  const [draft, setDraft] = useState(() => ({ ...(config?.globalPreferences || {}) }));
  const [draftBaseVersion, setDraftBaseVersion] = useState(() => config?.configVersion ?? null);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [dropPrompt, setDropPrompt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tests, setTests] = useState({});

  useEffect(() => {
    if (!dirty) {
      setDraft({ ...(config?.globalPreferences || {}) });
      setDraftBaseVersion(config?.configVersion ?? null);
    }
  }, [config, dirty]);

  const set = (k, v) => {
    setDirty(true);
    setDraft((d) => {
      const next = { ...d, [k]: v };
      if (k === 'pref_seerr_url' && d.pref_seerr_api_key === '***REDACTED***') {
        next.pref_seerr_api_key = '';
      }
      return next;
    });
  };

  async function save(confirmDropUnmatchedSecrets = false) {
    setBusy(true);
    setConflict(false);
    try {
      const payload = { globalPreferences: draft };
      if (confirmDropUnmatchedSecrets) payload.confirmDropUnmatchedSecrets = true;
      await api.setConfig(payload, draftBaseVersion);
      setDirty(false);
      setDropPrompt(null);
      await reloadConfig?.();
      onToast?.('Services saved', 'success');
    } catch (e) {
      if (e?.status === 409) {
        setConflict(true);
        onToast?.('Configuration changed in another session — reload latest', 'warning');
      } else if (e?.status === 400 && e?.errorCode === 'redacted_secret_mismatch') {
        setDropPrompt(e?.payload?.unmatchedSecrets || ['pref_seerr_api_key']);
      } else {
        onToast?.('Save failed: ' + e.message, 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  async function testSeerr() {
    setTests((t) => ({ ...t, seerr: 'testing' }));
    try {
      const res = await api.testSeerr({
        url: draft.pref_seerr_url,
        apiKey: draft.pref_seerr_api_key,
      });
      setTests((t) => ({ ...t, seerr: res.success ? 'ok' : 'err' }));
      onToast?.(res.success ? 'Seerr reachable' : 'Seerr unreachable: ' + (res.error || ''), res.success ? 'success' : 'error');
    } catch (e) {
      setTests((t) => ({ ...t, seerr: 'err' }));
      onToast?.('Seerr test failed: ' + e.message, 'error');
    }
  }

  async function reloadLatest() {
    setConflict(false);
    const latest = await reloadConfig?.();
    setDraft({ ...((latest || config)?.globalPreferences || {}) });
    setDraftBaseVersion((latest || config)?.configVersion ?? null);
    setDirty(false);
  }

  return (
    <div className="col" style={{ gap: 14 }} data-screen-label="04 External Services">
      {conflict && (
        <div className="card" style={{ borderColor: 'rgba(255,181,71,0.5)' }}>
          <div className="row between wrap" style={{ gap: 8 }}>
            <span style={{ fontSize: 12.5 }}>Configuration changed in another session. Your unsaved edits are still preserved below.</span>
            <button type="button" className="btn sm primary" onClick={reloadLatest}>Reload latest</button>
          </div>
        </div>
      )}

      <ServiceCard
        title="Seerr"
        subtitle="Overseerr / Jellyseerr requests"
        icon="globe"
        status={tests.seerr === 'ok' ? 'connected' : tests.seerr === 'err' ? 'offline' : draft.pref_seerr_enabled === 'true' ? 'connected' : 'inactive'}
      >
        <Row label="Seerr URL" hint="Full URL to your instance.">
          <input className="input" placeholder="http://192.168.1.10:5055" value={draft.pref_seerr_url || ''} onChange={(e) => set('pref_seerr_url', e.target.value)}/>
        </Row>
        <Row label="API Key">
          <input className="input" type="password" value={draft.pref_seerr_api_key || ''} onChange={(e) => set('pref_seerr_api_key', e.target.value)}/>
        </Row>
        <Row label="Enable Seerr">
          <Toggle on={toBool(draft.pref_seerr_enabled)} onChange={(v) => set('pref_seerr_enabled', fromBool(v))}/>
        </Row>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button type="button" className="btn sm" onClick={testSeerr}>Test Connection</button>
        </div>
      </ServiceCard>

      <ServiceCard
        title="TMDB"
        subtitle="The Movie Database — metadata + trailers"
        icon="globe"
        status={draft.pref_tmdb_api_key ? 'connected' : 'inactive'}
      >
        <Row label="API Key">
          <input className="input" type="password" value={draft.pref_tmdb_api_key || ''} onChange={(e) => set('pref_tmdb_api_key', e.target.value)}/>
        </Row>
        <Row label="Auto-match" hint="Use TMDB to enrich Jellyfin items in analytics.">
          <Toggle on={toBool(draft.pref_tmdb_auto_match || 'true')} onChange={(v) => set('pref_tmdb_auto_match', fromBool(v))}/>
        </Row>
      </ServiceCard>

      <ServiceCard
        title="OMDb"
        subtitle="IMDb ratings & supplemental metadata"
        icon="globe"
        status={draft.pref_omdb_api_key ? 'connected' : 'inactive'}
      >
        <Row label="API Key">
          <input className="input" type="password" value={draft.pref_omdb_api_key || ''} onChange={(e) => set('pref_omdb_api_key', e.target.value)}/>
        </Row>
      </ServiceCard>

      <ServiceCard
        title="Gemini"
        subtitle="Cloud AI fallback for voice & search"
        icon="globe"
        status={draft.pref_voice_assistant_cloud_api_key ? 'connected' : 'inactive'}
      >
        <Row label="API Key">
          <input className="input" type="password" value={draft.pref_voice_assistant_cloud_api_key || ''} onChange={(e) => set('pref_voice_assistant_cloud_api_key', e.target.value)}/>
        </Row>
      </ServiceCard>

      <ServiceCard
        title="SearXNG"
        subtitle="Bundled web-search sidecar"
        icon="search"
        status="connected"
      >
        <Row label="Endpoint" hint="Loopback by default. Override with COMPANION_SEARXNG_URL.">
          <input className="input" placeholder="http://127.0.0.1:8888" defaultValue="http://127.0.0.1:8888" disabled/>
        </Row>
      </ServiceCard>

      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button type="button" className="btn primary" disabled={busy} onClick={() => save(false)}>
          <Icon name="check" size={13}/> {busy ? 'Saving…' : 'Save Services'}
        </button>
      </div>

      {dropPrompt && (
        <Modal
          title="Clear unmatched stored secrets?"
          eyebrow="Target changed"
          width={480}
          onClose={() => setDropPrompt(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setDropPrompt(null)}>Cancel</button>
              <button type="button" className="btn danger" disabled={busy} onClick={() => save(true)}>
                Drop unmatched secrets &amp; save
              </button>
            </>
          }
        >
          <div style={{ fontSize: 13, color: 'var(--t-1)', lineHeight: 1.55 }}>
            Changing the Seerr URL invalidates previously stored Seerr API keys ({dropPrompt.join(', ')}). Confirm to drop them and save.
          </div>
        </Modal>
      )}
    </div>
  );
}

function Row({ label, hint, children }) {
  return (
    <div className="setting-row">
      <div>
        <div className="lbl">{label}</div>
        {hint && <div className="desc">{hint}</div>}
      </div>
      <div className="ctl">{children}</div>
    </div>
  );
}

function ServiceCard({ title, subtitle, icon, status, children }) {
  const chip =
    status === 'connected'
      ? <span className="chip ok"><span className="dot"/> Connected</span>
      : status === 'warning'
      ? <span className="chip warn"><span className="dot"/> Warning</span>
      : status === 'offline'
      ? <span className="chip err"><span className="dot"/> Offline</span>
      : <span className="chip"><span className="dot"/> Inactive</span>;
  return (
    <div className="card">
      <div className="card-head">
        <div className="row" style={{ gap: 12 }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: 'linear-gradient(135deg, rgba(0,164,220,0.18), rgba(20,30,42,0.6))',
              border: '1px solid var(--stroke-1)',
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <Icon name={icon} size={18} style={{ color: 'var(--teal-bright)' }}/>
          </div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t-0)' }}>{title}</div>
            <div style={{ fontSize: 11.5, color: 'var(--t-2)' }}>{subtitle}</div>
          </div>
        </div>
        <div className="right">{chip}</div>
      </div>
      {children}
    </div>
  );
}
