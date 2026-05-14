import { useCallback, useEffect, useMemo, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import TopBar from './components/TopBar.jsx';
import MobileBar from './components/MobileBar.jsx';
import CommandPalette from './components/CommandPalette.jsx';
import Login from './components/Login.jsx';
import Dashboard from './screens/Dashboard.jsx';
import Analytics from './screens/Analytics.jsx';
import Settings from './screens/Settings.jsx';
import Services from './screens/Services.jsx';
import Logs from './screens/Logs.jsx';
import Servers from './screens/Servers.jsx';
import Shares from './screens/Shares.jsx';
import Security from './screens/Security.jsx';
import { api } from './api.js';
import { useWebSocketEvent } from './ws.js';

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
    sub: 'Enforce app-lock policy at the headset level. Changes propagate over WebSocket in seconds.',
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

export default function App() {
  const [authState, setAuthState] = useState('checking'); // checking | open | needs-login | authed
  const [meta, setMeta] = useState(null);
  const [config, setConfig] = useState(null);
  const [screen, setScreen] = useState(() => {
    const hash = window.location.hash.slice(1);
    return VALID_SCREENS.includes(hash) ? hash : 'dashboard';
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [toast, setToast] = useState(null);

  const reloadConfig = useCallback(async () => {
    try {
      const c = await api.getConfig();
      setConfig(c);
    } catch (_) { /* keep prior */ }
  }, []);

  const checkAuth = useCallback(async () => {
    try {
      const check = await api.authCheck();
      if (check && check.authRequired === false) {
        setAuthState('open');
      } else if (check && check.authenticated) {
        setAuthState('authed');
      } else {
        setAuthState('needs-login');
      }
    } catch (_) {
      setAuthState('needs-login');
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
    window.location.hash = screen;
  }, [screen]);

  useEffect(() => {
    const onHash = () => {
      const hash = window.location.hash.slice(1);
      if (VALID_SCREENS.includes(hash)) setScreen(hash);
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

  const navigate = useCallback((id) => {
    setScreen(id);
    setSidebarOpen(false);
    setCmdOpen(false);
  }, []);

  const onToast = useCallback((message, level = 'info') => {
    setToast({ message, level, id: Date.now() });
    setTimeout(() => setToast((t) => (t && t.message === message ? null : t)), 3500);
  }, []);

  async function login(password, remember) {
    await api.login(password);
    if (remember) {
      try { localStorage.setItem('sf-companion-remember', '1'); } catch (_) {}
    }
    await checkAuth();
    await reloadConfig();
  }

  async function signOut() {
    try { await api.logout(); } catch (_) {}
    setAuthState('needs-login');
    setConfig(null);
  }

  const screenMeta = SCREEN_META[screen] || SCREEN_META.dashboard;
  const screenProps = { config, reloadConfig, version: meta?.version, onNavigate: navigate, onToast };

  const cmdActions = useMemo(() => [
    { id: 'sync-now', label: 'Sync analytics now', icon: 'refresh', group: 'Actions', run: async () => {
      try { await api.analyticsSyncNow(); onToast('Analytics sync started', 'success'); } catch (e) { onToast('Sync failed: ' + e.message, 'error'); }
    }},
    { id: 'rotate', label: 'Rotate setup token', icon: 'rotate', group: 'Actions', run: async () => {
      try { await api.rotateToken(); await reloadConfig(); onToast('Setup token rotated', 'success'); } catch (e) { onToast('Rotate failed: ' + e.message, 'error'); }
    }},
    { id: 'vacuum', label: 'Reclaim database space (VACUUM)', icon: 'trash', group: 'Actions', run: async () => {
      if (!confirm('Run VACUUM on the database?')) return;
      try { await api.databaseVacuum(); onToast('VACUUM finished', 'success'); } catch (e) { onToast('VACUUM failed: ' + e.message, 'error'); }
    }},
    { id: 'export', label: 'Export companion config', icon: 'download', group: 'Actions', run: () => { window.location.href = api.exportConfigUrl(); }},
  ], [onToast, reloadConfig]);

  if (authState === 'checking') {
    return (
      <div className="stage">
        <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: 'var(--t-2)', fontSize: 13 }}>
          Connecting…
        </div>
      </div>
    );
  }

  if (authState === 'needs-login') {
    return (
      <Login
        onSubmit={login}
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

      {toast && (
        <div
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
