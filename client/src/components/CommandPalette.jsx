import { useState } from 'react';
import Icon from './Icon.jsx';

export default function CommandPalette({ nav, actions, onClose, onNavigate }) {
  const [q, setQ] = useState('');
  const items = [
    ...nav.flatMap((g) => g.items.map((it) => ({ ...it, group: g.group }))),
    ...(actions || []),
  ];
  const filtered = q ? items.filter((i) => i.label.toLowerCase().includes(q.toLowerCase())) : items;
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        background: 'rgba(2, 6, 12, 0.72)',
        backdropFilter: 'blur(10px)',
        display: 'grid',
        placeItems: 'start center',
        paddingTop: '12vh',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card elev-3"
        style={{ width: 560, maxWidth: 'calc(100vw - 32px)', padding: 0, overflow: 'hidden' }}
      >
        <div className="row" style={{ gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--stroke-1)' }}>
          <Icon name="search" size={16} style={{ color: 'var(--t-2)' }}/>
          <input
            className="input"
            placeholder="Search screens, actions…"
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ border: 'none', background: 'transparent', height: 24, padding: 0, fontSize: 14 }}
          />
          <span className="kbd">ESC</span>
        </div>
        <div className="col" style={{ gap: 2, padding: 8, maxHeight: 360, overflow: 'auto' }}>
          {filtered.length === 0 && <div className="empty">No matches</div>}
          {filtered.map((it) => (
            <div
              key={it.id}
              onClick={() => {
                if (it.run) {
                  it.run();
                  onClose();
                } else {
                  onNavigate(it.id);
                }
              }}
              style={{
                display: 'grid',
                gridTemplateColumns: '20px 1fr auto',
                alignItems: 'center',
                gap: 10,
                padding: '8px 10px',
                borderRadius: 8,
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(95,209,255,0.06)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <Icon name={it.icon} size={14} style={{ color: 'var(--t-2)' }}/>
              <span style={{ fontSize: 13, color: 'var(--t-0)' }}>{it.label}</span>
              <span className="eyebrow" style={{ fontSize: 9 }}>{it.group}</span>
            </div>
          ))}
        </div>
        <div
          className="row between"
          style={{ padding: '10px 16px', borderTop: '1px solid var(--stroke-1)', fontSize: 11, color: 'var(--t-3)' }}
        >
          <span>
            <span className="kbd">↑</span> <span className="kbd">↓</span> navigate
          </span>
          <span>
            <span className="kbd">↵</span> select
          </span>
        </div>
      </div>
    </div>
  );
}
