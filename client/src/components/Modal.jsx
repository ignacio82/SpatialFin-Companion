import Icon from './Icon.jsx';

export default function Modal({ title, eyebrow, onClose, children, width = 520, footer }) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        background: 'rgba(2, 6, 12, 0.72)',
        backdropFilter: 'blur(10px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        overflowY: 'auto',
        boxSizing: 'border-box',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card elev-3"
        style={{
          width,
          maxWidth: '100%',
          flex: '0 1 auto',
          maxHeight: '92vh',
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          overflowY: 'auto',
          overflowX: 'hidden',
          minWidth: 0,
          boxSizing: 'border-box',
        }}
      >
        <div className="card-head" style={{ marginBottom: 0 }}>
          <div className="titlewrap" style={{ minWidth: 0 }}>
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            <span className="title">{title}</span>
          </div>
          <button className="btn ghost icon-only sm" onClick={onClose} title="Close">
            <Icon name="close" size={12}/>
          </button>
        </div>
        <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{children}</div>
        {footer && <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>{footer}</div>}
      </div>
    </div>
  );
}
