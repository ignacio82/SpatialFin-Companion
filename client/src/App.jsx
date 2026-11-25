import { useCallback, useEffect, useMemo, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import TopBar from './components/TopBar.jsx';
import MobileBar from './components/MobileBar.jsx';
import CommandPalette from './components/CommandPalette.jsx';
import Login from './components/Login.jsx';
import Modal from './components/Modal.jsx';
import Dashboard from './screens/Dashboard.jsx';
import Analytics from './screens/Analytics.jsx';
import Settings from './screens/Settings.jsx';
import Services from './screens/Services.jsx';
import Logs from './screens/Logs.jsx';
import Servers from './screens/Servers.jsx';
import Shares from './screens/Shares.jsx';
import Security from './screens/Security.jsx';
import { api } from './api.js';
import { setWebSocketAuthAllowed, useWebSocketEvent } from './ws.js';

const NAV = [
  { group: 'Overview', items: [
    { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
    { id: 'analytics', label: 'Analytics', icon: 'analytics', badge: 'live' },
  ]},
  { group: 'Configuration', items: [
    { id: 'settings', label: 'Global Settings', icon: 'settings' },
    { id: 'services', label: 'External Services', icon: 'globe' },
    { id: 'security', label: 'Security', icon: 'lock' },
  ]},
  { group: 'Infrastructure', items: [
    { id: 'servers', label: 'Servers & Users', icon: 'server' },
    { id: 'shares',  label: 'Network Shares', icon: 'share' },
    { id: 'logs',    label: 'Device Logs', icon: 'logs' },
  ]},
];

const SCREEN_META = {
  dashboard: {
    crumbs: ['Companion', 'Dashboard'],
    title: 'Dashboard',
    sub: 'Pair headsets, manage your setup token, and watch the system breathe in real time.',
  },
  analytics: {
    crumbs: ['Companion', 'Analytics'],
    title: 'Analytics',
    sub: 'Playback intelligence from every verified Jellyfin user — polled and streamed live.',
  },
  settings: {
    crumbs: ['Companion', 'Configuration', 'Global Settings'],
    title: 'Global Settings',
    sub: 'Defaults pushed to every paired headset on next sync.',
  },
  services: {
    crumbs: ['Companion', 'Configuration', 'External Services'],
    title: 'External Services',
    sub: 'Connect TMDB, Seerr, OMDb and AI providers — keys live in this companion only.',
  },
  security: {
    crumbs: ['Companion', 'Configuration', 'Security'],
    title: 'Security',
    sub: 'Configure app-lock wipe policy pushed to enrolled devices.',
  },
  servers: {
    crumbs: ['Companion', 'Infrastructure', 'Servers & Users'],
    title: 'Jellyfin Servers',
    sub: 'Pair Jellyfin servers and verify users so the companion can sync, enrich, and analyze playback.',
  },
  shares: {
    crumbs: ['Companion', 'Infrastructure', 'Network Shares'],
    title: 'Network Shares',
    sub: 'SMB & NFS mounts surfaced to SpatialFin clients.',
  },
  logs: {
    crumbs: ['Companion', 'Infrastructure', 'Device Logs'],
    title: 'Device Logs',
    sub: 'Tail live log streams from every paired headset. Filter, search, export.',
  },
};

const VALID_SCREENS = Object.keys(SCREEN_META);

function parseCompanionHash(rawHash) {
  const cleaned = String(rawHash || '').replace(/^#/, '');
  const qIndex = cleaned.indexOf('?');
  const routePart = (qIndex >= 0 ? cleaned.slice(0, qIndex) : cleaned).trim().toLowerCase();
  const queryPart = qIndex >= 0 ? cleaned.slice(qIndex + 1) : '';
  const screen = VALID_SCREENS.includes(routePart) ? routePart : 'dashboard';
  const params = {};
  if (queryPart) {
    const sp = new URLSearchParams(queryPart);
    for (const [k, v] of sp.entries()) {
      if (k && v) params[k] = v;
    }
  }
  return { screen, params };
}

export default function App() {
  // checking | open | needs-bootstrap | needs-login | authed | host-rejected
  const [authState, setAuthState] = useState('checking');
  const [bootstrapMeta, setBootstrapMeta] = useState({ canBootstrapWithPin: false, bootstrapPinExpiresAt: null });
  const [meta, setMeta] = useState(null);
  const [config, setConfig] = useState(null);
  const [initialRoute] = useState(() => parseCompanionHash(window.location.hash));
  const [screen, setScreen] = useState(initialRoute.screen);
  const [deepLink, setDeepLink] = useState(() =>
    Object.keys(initialRoute.params).length > 0
      ? { screen: initialRoute.screen, params: initialRoute.params, id: Date.now() }
      : null
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [rotateConfirmOpen, setRotateConfirmOpen] = useState(false);
  const [rotatingToken, setRotatingToken] = useState(false);
  const [toast, setToast] = useState(null);

  const reloadConfig = useCallback(async () => {
    try {
      const c = await api.getConfig();
      setConfig(c);
      return c;
    } catch (_) {
      return null;
    }
  }, []);

  const checkAuth = useCallback(async () => {
    try {
      const check = await api.authCheck();
      setWebSocketAuthAllowed(Boolean(check?.wsAllowed));
      if (check?.adminPasswordRequired && !check?.authenticated) {
        setBootstrapMeta({
          canBootstrapWithPin: Boolean(check.canBootstrapWithPin),
          bootstrapPinExpiresAt: check.bootstrapPinExpiresAt || null,
        });
        setAuthState('needs-bootstrap');
      } else if (check?.authRequired === false) {
        setAuthState('open');
      } else if (check?.authenticated) {
        setAuthState('authed');
      } else {
        setAuthState('needs-login');
      }
    } catch (err) {
      setWebSocketAuthAllowed(false);
      if (err?.status === 403 && err?.errorCode === 'host_rejected') {
        setAuthState('host-rejected');
      } else {
        setAuthState('needs-login');
      }
    }
  }, []);

  useEffect(() => {
    api.meta().then(setMeta).catch(() => {});
    checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    if (authState === 'open' || authState === 'authed') reloadConfig();
  }, [authState, reloadConfig]);

  useWebSocketEvent('config_changed', () => reloadConfig());

  useEffect(() => {
    if (deepLink && deepLink.screen === screen) return;
    if (window.location.hash !== `#${screen}`) {
      window.location.hash = screen;
    }
  }, [screen, deepLink]);

  useEffect(() => {
    const onHash = () => {
      const parsed = parseCompanionHash(window.location.hash);
      setScreen(parsed.screen);
      if (Object.keys(parsed.params).length > 0) {
        setDeepLink({ screen: parsed.screen, params: parsed.params, id: Date.now() });
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCmdOpen((o) => !o);
      } else if (e.key === 'Escape') {
        setCmdOpen(false);
        setSidebarOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const consumeDeepLink = useCallback(() => {
    setDeepLink(null);
    try {
      if (window.location.hash.includes('?')) {
        window.history.replaceState(null, '', `#${screen}`);
      }
    } catch (_) {}
  }, [screen]);

  const navigate = useCallback((id) => {
    setDeepLink(null);
    setScreen(id);
    setSidebarOpen(false);
    setCmdOpen(false);
  }, []);

  const onToast = useCallback((message, level = 'info') => {
    setToast({ message, level, id: Date.now() });
    setTimeout(() => setToast((t) => (t && t.message === message ? null : t)), 3500);
  }, []);

  async function login(password, remember) {
    await api.login(password, Boolean(remember));
    if (remember) {
      try { localStorage.setItem('sf-companion-remember', '1'); } catch (_) {}
    }
    await checkAuth();
    await reloadConfig();
  }

  async function bootstrap({ bootstrapPin, newPassword, remember }) {
    await api.bootstrapPassword({ bootstrapPin, newPassword, remember: Boolean(remember) });
    await checkAuth();
    await reloadConfig();
  }

  async function signOut() {
    setWebSocketAuthAllowed(false);
    try { await api.logout(); } catch (_) {}
    setAuthState('needs-login');
    setConfig(null);
  }

  const requestRotateToken = useCallback(() => {
    setRotateConfirmOpen(true);
  }, []);

  async function confirmRotateToken() {
    setRotatingToken(true);
    try {
      await api.rotateToken();
      await reloadConfig();
      setRotateConfirmOpen(false);
      onToast('Setup token rotated — re-pair existing devices with the new QR/token', 'success');
    } catch (e) {
      onToast('Rotate failed: ' + e.message, 'error');
    } finally {
      setRotatingToken(false);
    }
  }

  const screenMeta = SCREEN_META[screen] || SCREEN_META.dashboard;
  const screenProps = {
    config,
    reloadConfig,
    version: meta?.version,
    onNavigate: navigate,
    onToast,
    onRequestRotateToken: requestRotateToken,
    deepLink: deepLink && deepLink.screen === screen ? deepLink : null,
    onConsumeDeepLink: consumeDeepLink,
  };

  const cmdActions = useMemo(() => [
    { id: 'sync-now', label: 'Sync analytics now', icon: 'refresh', group: 'Actions', run: async () => {
      try { await api.analyticsSyncNow(); onToast('Analytics sync started', 'success'); } catch (e) { onToast('Sync failed: ' + e.message, 'error'); }
    }},
    { id: 'rotate', label: 'Rotate setup token', icon: 'rotate', group: 'Actions', run: () => {
      setCmdOpen(false);
      requestRotateToken();
    }},
    { id: 'vacuum', label: 'Reclaim database space (VACUUM)', icon: 'trash', group: 'Actions', run: async () => {
      if (!confirm('Run VACUUM on the database?')) return;
      try { await api.databaseVacuum(); onToast('VACUUM finished', 'success'); } catch (e) { onToast('VACUUM failed: ' + e.message, 'error'); }
    }},
    { id: 'export', label: 'Export companion config', icon: 'download', group: 'Actions', run: () => { window.location.href = api.exportConfigUrl(); }},
  ], [onToast, requestRotateToken]);

  if (authState === 'checking') {
    return (
      <div className="stage">
        <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: 'var(--t-2)', fontSize: 13 }}>
          Connecting…
        </div>
      </div>
    );
  }

  if (authState === 'host-rejected') {
    return (
      <div className="login-stage">
        <div className="login-card" style={{ maxWidth: 460 }}>
          <div className="eyebrow" style={{ color: 'var(--err)' }}>Access Blocked (403 host_rejected)</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--t-0)', marginTop: 6 }}>
            Invalid Host header for loopback access
          </div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 10, lineHeight: 1.55 }}>
            SpatialFin Companion rejected this request because the <span className="mono">Host</span> header does not match a direct loopback address (<span className="mono">localhost</span>, <span className="mono">127.0.0.1</span>, or <span className="mono">[::1]</span>).
            If you are accessing Companion through a reverse proxy, set <span className="mono">COMPANION_TRUST_PROXY=1</span> and configure an admin password via <span className="mono">COMPANION_ADMIN_PASSWORD</span>.
          </div>
        </div>
      </div>
    );
  }

  if (authState === 'needs-login' || authState === 'needs-bootstrap') {
    return (
      <Login
        mode={authState}
        canBootstrapWithPin={bootstrapMeta.canBootstrapWithPin}
        bootstrapPinExpiresAt={bootstrapMeta.bootstrapPinExpiresAt}
        onSubmit={login}
        onBootstrap={bootstrap}
        onRetryBootstrapCheck={checkAuth}
        version={meta?.version}
        hostLabel={typeof window !== 'undefined' ? window.location.host : ''}
      />
    );
  }

  return (
    <div className="stage">
      <div className="shell">
        <Sidebar
          nav={NAV}
          screen={screen}
          onNavigate={navigate}
          open={sidebarOpen}
          version={meta?.version}
          onSignOut={signOut}
          adminAuthRequired={authState === 'authed'}
        />

        <div>
          <MobileBar onMenu={() => setSidebarOpen(true)} title={screenMeta.title}/>
          {sidebarOpen && <div className="scrim" onClick={() => setSidebarOpen(false)}/>}
          <div className="content">
            <TopBar
              meta={screenMeta}
              onCmd={() => setCmdOpen(true)}
              statusLabel="ALL SYSTEMS NOMINAL"
              statusOk
            />
            <Screen id={screen} props={screenProps}/>
          </div>
        </div>
      </div>

      {cmdOpen && (
        <CommandPalette
          nav={NAV}
          actions={cmdActions}
          onClose={() => setCmdOpen(false)}
          onNavigate={navigate}
        />
      )}

      {rotateConfirmOpen && (
        <Modal
          title="Rotate setup token?"
          eyebrow="Security"
          width={460}
          onClose={() => !rotatingToken && setRotateConfirmOpen(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setRotateConfirmOpen(false)} disabled={rotatingToken}>
                Cancel
              </button>
              <button type="button" className="btn danger" onClick={confirmRotateToken} disabled={rotatingToken}>
                {rotatingToken ? 'Rotating…' : 'Rotate token'}
              </button>
            </>
          }
        >
          <div style={{ fontSize: 13, color: 'var(--t-1)', lineHeight: 1.55 }}>
            Rotating the setup token immediately revokes active Companion sync connections and FCast tickets.
            <strong> All currently paired headsets, phones, TVs, and WebXR browsers will need to re-pair</strong> using the new QR code or setup token.
          </div>
        </Modal>
      )}

      {toast && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed',
            bottom: 18,
            right: 18,
            zIndex: 100,
            padding: '10px 14px',
            borderRadius: 12,
            background: 'var(--glass-2)',
            border: '1px solid ' + (toast.level === 'error' ? 'rgba(255,91,110,0.4)' : toast.level === 'success' ? 'rgba(52,215,150,0.4)' : 'var(--stroke-2)'),
            color: 'var(--t-0)',
            fontSize: 12.5,
            fontWeight: 600,
            boxShadow: 'var(--elev-2)',
            backdropFilter: 'blur(20px)',
            maxWidth: 360,
          }}
        >
          <span
            className="dot"
            style={{
              background:
                toast.level === 'error' ? 'var(--err)'
                : toast.level === 'success' ? 'var(--ok)'
                : toast.level === 'warning' ? 'var(--warn)'
                : 'var(--teal-bright)',
              boxShadow: '0 0 6px currentColor',
              marginRight: 8,
            }}
          />
          {toast.message}
        </div>
      )}
    </div>
  );
}

function Screen({ id, props }) {
  switch (id) {
    case 'dashboard': return <Dashboard {...props}/>;
    case 'analytics': return <Analytics {...props}/>;
    case 'settings':  return <Settings {...props}/>;
    case 'services':  return <Services {...props}/>;
    case 'logs':      return <Logs {...props}/>;
    case 'servers':   return <Servers {...props}/>;
    case 'shares':    return <Shares {...props}/>;
    case 'security':  return <Security {...props}/>;
    default:          return <Dashboard {...props}/>;
  }
}
