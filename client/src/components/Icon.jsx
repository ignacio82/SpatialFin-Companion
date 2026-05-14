export default function Icon({ name, size = 16, className = '', style }) {
  const s = size;
  const p = (d) => (
    <svg
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={'ico ' + className}
      style={style}
      aria-hidden
    >
      {d}
    </svg>
  );
  switch (name) {
    case 'dashboard': return p(<><rect x="3.5" y="3.5" width="7" height="9" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="5" rx="1.5"/><rect x="13.5" y="11.5" width="7" height="9" rx="1.5"/><rect x="3.5" y="15.5" width="7" height="5" rx="1.5"/></>);
    case 'analytics': return p(<><path d="M3.5 20.5 L 9 13 L 13 17 L 20.5 6.5"/><path d="M14.5 6.5 H 20.5 V 12.5"/></>);
    case 'settings': return p(<><circle cx="12" cy="12" r="2.6"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.7l.05.05a2 2 0 0 1-2.8 2.8l-.05-.05a1.6 1.6 0 0 0-1.7-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.7.3l-.05.05a2 2 0 1 1-2.8-2.8l.05-.05a1.6 1.6 0 0 0 .3-1.7 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.7L4.25 7.2a2 2 0 1 1 2.8-2.8l.05.05a1.6 1.6 0 0 0 1.7.3h0a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5h0a1.6 1.6 0 0 0 1.7-.3l.05-.05a2 2 0 1 1 2.8 2.8l-.05.05a1.6 1.6 0 0 0-.3 1.7v0a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></>);
    case 'globe': return p(<><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12 H 20.5"/><path d="M12 3.5 C 15 6 15 18 12 20.5 C 9 18 9 6 12 3.5"/></>);
    case 'logs': return p(<><rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></>);
    case 'server': return p(<><rect x="3.5" y="4.5" width="17" height="6" rx="1.5"/><rect x="3.5" y="13.5" width="17" height="6" rx="1.5"/><circle cx="7" cy="7.5" r="0.6" fill="currentColor"/><circle cx="7" cy="16.5" r="0.6" fill="currentColor"/></>);
    case 'share': return p(<><path d="M4 7.5h10l4 3.5v9H4z"/><path d="M14 7.5V4.5H4V20"/></>);
    case 'lock': return p(<><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 1 1 8 0v3.5"/></>);
    case 'headset': return p(<><path d="M4 13.5V12a8 8 0 0 1 16 0v1.5"/><rect x="3" y="13" width="5" height="7" rx="1.5"/><rect x="16" y="13" width="5" height="7" rx="1.5"/></>);
    case 'users': return p(<><circle cx="9" cy="9" r="3.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 11.2c2 .8 3.5 2.8 3.5 5.3"/><path d="M15 4.5a3.5 3.5 0 0 1 0 6.5"/></>);
    case 'qr': return p(<><rect x="3.5" y="3.5" width="7" height="7" rx="1"/><rect x="13.5" y="3.5" width="7" height="7" rx="1"/><rect x="3.5" y="13.5" width="7" height="7" rx="1"/><path d="M13.5 13.5h3v3M20.5 13.5v3M13.5 17.5v3M16.5 20.5h4"/></>);
    case 'search': return p(<><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></>);
    case 'menu': return p(<><path d="M3.5 6h17M3.5 12h17M3.5 18h17"/></>);
    case 'close': return p(<><path d="M5 5l14 14M19 5L5 19"/></>);
    case 'play': return p(<path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke="none"/>);
    case 'pause': return p(<><rect x="6.5" y="4.5" width="3.5" height="15" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4.5" width="3.5" height="15" rx="1" fill="currentColor" stroke="none"/></>);
    case 'stop': return p(<rect x="5.5" y="5.5" width="13" height="13" rx="1.5" fill="currentColor" stroke="none"/>);
    case 'refresh': return p(<><path d="M3.5 12a8.5 8.5 0 0 1 14.5-6L20 8"/><path d="M20 3.5V8h-4.5"/><path d="M20.5 12a8.5 8.5 0 0 1-14.5 6L4 16"/><path d="M4 20.5V16h4.5"/></>);
    case 'expand': return p(<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>);
    case 'chevron': return p(<path d="M9 6l6 6-6 6"/>);
    case 'chevron-down': return p(<path d="M6 9l6 6 6-6"/>);
    case 'plus': return p(<path d="M12 5v14M5 12h14"/>);
    case 'copy': return p(<><rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M4.5 15.5V6a1.5 1.5 0 0 1 1.5-1.5h9.5"/></>);
    case 'download': return p(<><path d="M12 4v12"/><path d="M7 11l5 5 5-5"/><path d="M4.5 20h15"/></>);
    case 'upload': return p(<><path d="M12 20V8"/><path d="M7 13l5-5 5 5"/><path d="M4.5 4h15"/></>);
    case 'warn': return p(<><path d="M12 3 L 22 20 H 2 Z"/><path d="M12 10v5"/><circle cx="12" cy="18" r="0.7" fill="currentColor"/></>);
    case 'check': return p(<path d="M5 12.5l4.5 4.5L19 7"/>);
    case 'signal': return p(<><path d="M4 18 L 8 14"/><path d="M4 18 L 12 10"/><path d="M4 18 L 16 6"/><path d="M4 18 L 20 2"/></>);
    case 'cmd': return p(<><path d="M9 9h6v6H9z"/><path d="M6 9V6.5A2.5 2.5 0 1 1 9 9 M15 9V6.5A2.5 2.5 0 1 0 18 9 M9 15v2.5A2.5 2.5 0 1 0 6 15 M15 15v2.5A2.5 2.5 0 1 1 18 15"/></>);
    case 'eye': return p(<><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="2.5"/></>);
    case 'rotate': return p(<><path d="M21 12a9 9 0 1 1-3.2-6.9L21 8"/><path d="M21 3v5h-5"/></>);
    case 'trash': return p(<><path d="M4.5 6.5h15"/><path d="M9 6.5V4.5h6V6.5"/><path d="M6 6.5l1 13.5h10l1-13.5"/></>);
    case 'filter': return p(<path d="M4 5h16l-6 8v5l-4 2v-7z"/>);
    case 'tv': return p(<><rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/></>);
    default: return p(<rect x="4" y="4" width="16" height="16"/>);
  }
}
