import { useEffect, useId, useRef } from 'react';
import Icon from './Icon.jsx';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export default function Modal({ title, eyebrow, onClose, children, width = 520, footer }) {
  const titleId = useId();
  const dialogRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const container = dialogRef.current;

    if (container) {
      const focusables = container.querySelectorAll(FOCUSABLE_SELECTOR);
      const target = focusables.length > 0 ? focusables[0] : container;
      if (target instanceof HTMLElement) {
        target.focus();
      }
    }

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current?.();
        return;
      }
      if (e.key === 'Tab' && container) {
        const focusables = Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
          (el) => el instanceof HTMLElement && el.offsetParent !== null
        );
        if (focusables.length === 0) {
          e.preventDefault();
          container.focus();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first || !container.contains(document.activeElement)) {
            e.preventDefault();
            last.focus();
          }
        } else if (document.activeElement === last || !container.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (previousFocus && typeof previousFocus.focus === 'function') {
        try { previousFocus.focus(); } catch (_) {}
      }
    };
  }, []);

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
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
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
            <span id={titleId} className="title">{title}</span>
          </div>
          <button
            type="button"
            className="btn ghost icon-only sm"
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >
            <Icon name="close" size={12}/>
          </button>
        </div>
        <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{children}</div>
        {footer && <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>{footer}</div>}
      </div>
    </div>
  );
}
