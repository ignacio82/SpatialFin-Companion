import { useEffect, useMemo, useState } from 'react';
import Icon from '../components/Icon.jsx';
import Toggle from '../components/Toggle.jsx';
import Segmented from '../components/Segmented.jsx';
import { api } from '../api.js';

// Helpers: server stores preferences as string values. Convert to/from booleans.
const toBool = (v) => v === 'true' || v === true;
const fromBool = (v) => (v ? 'true' : 'false');

function getPref(prefs, key, fallback) {
  if (!prefs) return fallback;
  const v = prefs[key];
  return v == null ? fallback : v;
}

const LANG_OPTIONS = [
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

export default function Settings({ config, reloadConfig, onToast }) {
  const [draft, setDraft] = useState(() => ({ ...(config?.globalPreferences || {}) }));
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setDraft({ ...(config?.globalPreferences || {}) });
    setDirty(false);
  }, [config]);

  function setKey(key, value) {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty(true);
  }

  const spokenLangs = useMemo(() => {
    const raw = getPref(draft, 'pref_smart_spoken_languages', 'en,es,ja');
    return (raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  }, [draft]);

  function setSpokenLangs(arr) {
    setKey('pref_smart_spoken_languages', arr.filter(Boolean).join(','));
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      const next = {
        ...config,
        globalPreferences: draft,
      };
      await api.setConfig(next);
      await reloadConfig?.();
      onToast?.('Global settings saved', 'success');
      setDirty(false);
    } catch (e) {
      onToast?.('Save failed: ' + e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function importFile(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      await api.importConfig(parsed);
      await reloadConfig?.();
      onToast?.('Config imported', 'success');
    } catch (e) {
      onToast?.('Import failed: ' + e.message, 'error');
    }
  }

  return (
    <div className="col" style={{ gap: 14 }} data-screen-label="03 Global Settings">

      <div className="card">
        <div className="card-head">
          <div className="titlewrap">
            <span className="eyebrow">Audio · Subs · Routing</span>
            <span className="title">Language Behavior</span>
          </div>
          <div className="right">
            <span className="chip">applies to all devices</span>
          </div>
        </div>

        <div className="setting-row">
          <div>
            <div className="lbl">Prefer original language</div>
            <div className="desc">Always try the original audio track first when available.</div>
          </div>
          <div className="ctl">
            <Toggle
              on={toBool(getPref(draft, 'pref_smart_prefer_original_audio', 'true'))}
              onChange={(v) => setKey('pref_smart_prefer_original_audio', fromBool(v))}
            />
          </div>
        </div>

        <div className="setting-row" style={{ gridTemplateColumns: '1fr' }}>
          <div>
            <div className="lbl">Spoken languages (priority list)</div>
            <div className="desc">First language wins. Comma-separated ISO codes.</div>
            <div className="row wrap" style={{ gap: 6, marginTop: 10 }}>
              {spokenLangs.map((l, i) => (
                <div key={l + i} className="chip" style={{ paddingRight: 4 }}>
                  <span className="tnum muted" style={{ marginRight: 2 }}>{i + 1}</span> {l}
                  <button
                    className="btn icon-only sm ghost"
                    style={{ height: 18, width: 18 }}
                    onClick={() => setSpokenLangs(spokenLangs.filter((_, idx) => idx !== i))}
                  >
                    <Icon name="close" size={10}/>
                  </button>
                </div>
              ))}
              <AddLangButton onAdd={(code) => setSpokenLangs([...spokenLangs, code])}/>
            </div>
          </div>
        </div>

        <SelectRow
          label="Default audio language"
          value={getPref(draft, 'pref_audio_language', 'jpn')}
          options={LANG_OPTIONS}
          onChange={(v) => setKey('pref_audio_language', v)}
        />
        <SelectRow
          label="Default subtitle language"
          value={getPref(draft, 'pref_subtitle_language', 'eng')}
          options={LANG_OPTIONS}
          onChange={(v) => setKey('pref_subtitle_language', v)}
        />
      </div>

      <div className="card">
        <div className="card-head">
          <div className="titlewrap">
            <span className="eyebrow">Genre Routing</span>
            <span className="title">Anime Overrides</span>
          </div>
        </div>
        <SelectRow
          label="Anime audio"
          value={getPref(draft, 'pref_anime_audio_language', 'jpn')}
          options={LANG_OPTIONS}
          onChange={(v) => setKey('pref_anime_audio_language', v)}
        />
        <SelectRow
          label="Anime subtitles"
          value={getPref(draft, 'pref_anime_subtitle_language', 'eng')}
          options={LANG_OPTIONS}
          onChange={(v) => setKey('pref_anime_subtitle_language', v)}
        />
        <SelectRow
          label="Non-anime audio"
          value={getPref(draft, 'pref_non_anime_audio_language', 'eng')}
          options={LANG_OPTIONS}
          onChange={(v) => setKey('pref_non_anime_audio_language', v)}
        />
        <div className="setting-row">
          <div>
            <div className="lbl">Disable non-anime subtitles</div>
            <div className="desc">Hides subs entirely for non-anime content.</div>
          </div>
          <div className="ctl">
            <Toggle
              on={toBool(getPref(draft, 'pref_non_anime_subtitle_disabled', 'true'))}
              onChange={(v) => setKey('pref_non_anime_subtitle_disabled', fromBool(v))}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="titlewrap">
            <span className="eyebrow">Player</span>
            <span className="title">Playback Preferences</span>
          </div>
        </div>
        <NumberRow label="Seek back (ms)" hint="Milliseconds to skip on back." prefKey="pref_player_seek_back_inc" draft={draft} onChange={setKey}/>
        <NumberRow label="Seek forward (ms)" prefKey="pref_player_seek_forward_inc" draft={draft} onChange={setKey}/>
        <div className="setting-row">
          <div><div className="lbl">Chapter markers</div></div>
          <div className="ctl">
            <Toggle
              on={toBool(getPref(draft, 'pref_player_chapter_markers', 'true'))}
              onChange={(v) => setKey('pref_player_chapter_markers', fromBool(v))}
            />
          </div>
        </div>
        <div className="setting-row">
          <div><div className="lbl">Trickplay thumbnails</div></div>
          <div className="ctl">
            <Toggle
              on={toBool(getPref(draft, 'pref_player_trickplay', 'true'))}
              onChange={(v) => setKey('pref_player_trickplay', fromBool(v))}
            />
          </div>
        </div>
        <NumberRow label="Max bitrate" hint="0 = auto." prefKey="pref_player_max_bitrate" draft={draft} onChange={setKey}/>
        <div className="setting-row">
          <div><div className="lbl">Libass subtitle rendering</div></div>
          <div className="ctl">
            <Segmented
              value={getPref(draft, 'pref_libass_subtitle_usage', 'auto')}
              onChange={(v) => setKey('pref_libass_subtitle_usage', v)}
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'always', label: 'Always' },
                { value: 'never', label: 'Never' },
              ]}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="titlewrap">
            <span className="eyebrow">Iggy</span>
            <span className="title">Voice Assistant</span>
          </div>
        </div>
        <div className="setting-row">
          <div>
            <div className="lbl">Voice control enabled</div>
            <div className="desc">Hands-free wake & control on headsets.</div>
          </div>
          <div className="ctl">
            <Toggle
              on={toBool(getPref(draft, 'pref_voice_control_enabled', 'true'))}
              onChange={(v) => setKey('pref_voice_control_enabled', fromBool(v))}
            />
          </div>
        </div>
        <div className="setting-row">
          <div><div className="lbl">Gesture hand</div></div>
          <div className="ctl">
            <Segmented
              value={getPref(draft, 'pref_voice_gesture_hand', 'left')}
              onChange={(v) => setKey('pref_voice_gesture_hand', v)}
              options={[
                { value: 'left', label: 'Left' },
                { value: 'right', label: 'Right' },
              ]}
            />
          </div>
        </div>
        <div className="setting-row">
          <div><div className="lbl">Verbosity</div></div>
          <div className="ctl">
            <Segmented
              value={getPref(draft, 'pref_voice_assistant_verbosity', 'balanced')}
              onChange={(v) => setKey('pref_voice_assistant_verbosity', v)}
              options={[
                { value: 'minimal', label: 'Minimal' },
                { value: 'balanced', label: 'Balanced' },
                { value: 'verbose', label: 'Verbose' },
              ]}
            />
          </div>
        </div>
        <div className="setting-row">
          <div><div className="lbl">Spoiler policy</div></div>
          <div className="ctl">
            <Segmented
              value={getPref(draft, 'pref_voice_assistant_spoiler_policy', 'cautious')}
              onChange={(v) => setKey('pref_voice_assistant_spoiler_policy', v)}
              options={[
                { value: 'cautious', label: 'Cautious' },
                { value: 'permissive', label: 'Permissive' },
              ]}
            />
          </div>
        </div>
        <div className="setting-row">
          <div><div className="lbl">Spoken replies (TTS)</div></div>
          <div className="ctl">
            <Toggle
              on={toBool(getPref(draft, 'pref_voice_assistant_spoken_replies', 'true'))}
              onChange={(v) => setKey('pref_voice_assistant_spoken_replies', fromBool(v))}
            />
          </div>
        </div>
        <div className="setting-row">
          <div>
            <div className="lbl">
              On-device Gemma <span className="chip teal uc" style={{ marginLeft: 6 }}>LiteRT</span>
            </div>
            <div className="desc">SpatialFin downloads & uses LiteRT Gemma on supported headsets.</div>
          </div>
          <div className="ctl">
            <Toggle
              on={toBool(getPref(draft, 'pref_voice_assistant_gemma_enabled', 'false'))}
              onChange={(v) => setKey('pref_voice_assistant_gemma_enabled', fromBool(v))}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="titlewrap">
            <span className="eyebrow">Telemetry</span>
            <span className="title">Diagnostics</span>
          </div>
        </div>
        <div className="setting-row">
          <div>
            <div className="lbl">Enable companion logging</div>
            <div className="desc">SpatialFin streams new log lines back here for inspection & download.</div>
          </div>
          <div className="ctl">
            <Toggle
              on={toBool(getPref(draft, 'pref_logging_enabled', 'false'))}
              onChange={(v) => setKey('pref_logging_enabled', fromBool(v))}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="titlewrap">
            <span className="eyebrow">Backup</span>
            <span className="title">Config Snapshot</span>
          </div>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          <a className="btn sm" href={api.exportConfigUrl()} style={{ textDecoration: 'none' }}>
            <Icon name="download" size={13}/> Export config.json
          </a>
          <label className="btn sm" style={{ cursor: 'pointer' }}>
            <Icon name="upload" size={13}/> Import config.json
            <input
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={(e) => importFile(e.target.files?.[0])}
            />
          </label>
        </div>
      </div>

      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn" disabled={!dirty} onClick={() => { setDraft({ ...(config?.globalPreferences || {}) }); setDirty(false); }}>
          Discard
        </button>
        <button className="btn primary" disabled={!dirty || busy} onClick={save}>
          <Icon name="check" size={13}/> {busy ? 'Saving…' : 'Save Global Settings'}
        </button>
      </div>
    </div>
  );
}

function SelectRow({ label, value, options, onChange, hint }) {
  return (
    <div className="setting-row">
      <div>
        <div className="lbl">{label}</div>
        {hint && <div className="desc">{hint}</div>}
      </div>
      <div className="ctl">
        <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

function NumberRow({ label, hint, prefKey, draft, onChange }) {
  return (
    <div className="setting-row">
      <div>
        <div className="lbl">{label}</div>
        {hint && <div className="desc">{hint}</div>}
      </div>
      <div className="ctl">
        <input
          className="input"
          type="number"
          value={draft[prefKey] ?? ''}
          onChange={(e) => onChange(prefKey, e.target.value)}
        />
      </div>
    </div>
  );
}

function AddLangButton({ onAdd }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState('');
  if (!open) {
    return (
      <button className="btn sm ghost" onClick={() => setOpen(true)}>
        <Icon name="plus" size={12}/> Add language
      </button>
    );
  }
  return (
    <form
      style={{ display: 'flex', gap: 6 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) onAdd(v.trim().toLowerCase());
        setV('');
        setOpen(false);
      }}
    >
      <input className="input" autoFocus placeholder="iso (eg. fre)" value={v} onChange={(e) => setV(e.target.value)} style={{ width: 110, height: 22 }}/>
      <button className="btn sm primary" type="submit">Add</button>
      <button className="btn sm ghost" type="button" onClick={() => setOpen(false)}>Cancel</button>
    </form>
  );
}
