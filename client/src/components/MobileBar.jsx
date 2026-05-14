import Icon from './Icon.jsx';

export default function MobileBar({ onMenu, title }) {
  return (
    <div className="mobile-bar">
      <button className="btn icon-only sm" onClick={onMenu}>
        <Icon name="menu" size={14}/>
      </button>
      <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.12em', color: 'var(--t-0)' }}>
        {(title || '').toUpperCase()}
      </div>
      <div className="row" style={{ gap: 4 }}>
        <span className="dot ok"/>
      </div>
    </div>
  );
}
