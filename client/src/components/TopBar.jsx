import Icon from './Icon.jsx';

export default function TopBar({ meta, statusLabel, statusOk, onCmd }) {
  return (
    <div className="topbar">
      <div style={{ minWidth: 0 }}>
        <div className="crumbs">
          {meta.crumbs.map((c, i) => (
            <span key={i}>
              {i > 0 && <span className="sep" style={{ margin: '0 6px' }}>›</span>}
              <span style={{ color: i === meta.crumbs.length - 1 ? 'var(--t-0)' : 'var(--t-2)' }}>{c}</span>
            </span>
          ))}
        </div>
        <h1 style={{ marginTop: 4 }}>{meta.title}</h1>
        <div className="sub">{meta.sub}</div>
      </div>
      <div className="actions">
        <div className="live" style={{ color: statusOk ? undefined : 'var(--warn)', background: statusOk ? undefined : 'rgba(255,181,71,0.08)' }}>
          <span className="dot" style={{ background: statusOk ? 'var(--ok)' : 'var(--warn)', boxShadow: statusOk ? '0 0 8px var(--ok)' : '0 0 8px var(--warn)' }}/>
          {statusLabel || (statusOk ? 'ALL SYSTEMS NOMINAL' : 'DEGRADED')}
        </div>
        <button className="btn" onClick={onCmd}>
          <Icon name="search" size={13}/> Search
          <span className="kbd" style={{ marginLeft: 4 }}>⌘K</span>
        </button>
      </div>
    </div>
  );
}
