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
        display: 'grid',
        placeItems: 'center',
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card elev-3"
        style={{
          width,
          maxWidth: '100%',
          maxHeight: '92vh',
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          overflow: 'auto',
        }}
      >
        <div className="card-head" style={{ marginBottom: 0 }}>
          <div className="titlewrap">
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            <span className="title">{title}</span>
          </div>
          <button className="btn ghost icon-only sm" onClick={onClose} title="Close">
            <Icon name="close" size={12}/>
          </button>
        </div>
        <div style={{ minWidth: 0 }}>{children}</div>
        {footer && <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>{footer}</div>}
      </div>
    </div>
  );
}
