import Icon from './Icon.jsx';

export default function Sidebar({ nav, screen, onNavigate, open, version, onSignOut, adminAuthRequired }) {
  return (
    <aside className={'sidebar ' + (open ? 'open' : '')}>
      <div className="brand">
        <div className="brand-mark"/>
        <div className="brand-text">
          <div className="name">SPATIALFIN</div>
          <div className="role">Companion</div>
        </div>
      </div>

      {nav.map((group) => (
        <div key={group.group} className="nav-group">
          <div className="nav-group-label">{group.group}</div>
          {group.items.map((it) => (
            <div
              key={it.id}
              className={'nav-item ' + (screen === it.id ? 'active' : '')}
              onClick={() => onNavigate(it.id)}
            >
              <Icon name={it.icon} size={15}/>
              <span>{it.label}</span>
              {it.badge != null && (
                <span className="badge">
                  {it.badge === 'live' ? (
                    <>
                      <span className="dot ok" style={{ width: 5, height: 5, marginRight: 4, verticalAlign: 'middle' }}/>
                      LIVE
                    </>
                  ) : (
                    it.badge
                  )}
                </span>
              )}
            </div>
          ))}
        </div>
      ))}

      <div className="side-footer">
        <div className="avatar">{adminAuthRequired ? 'A' : '~'}</div>
        <div className="who">
          <div className="n">{adminAuthRequired ? 'admin' : 'open access'}</div>
          <div className="v">{version ? `v${version}` : 'companion'}</div>
        </div>
        {adminAuthRequired && (
          <button className="signout" onClick={onSignOut} title="Sign out">
            <Icon name="close" size={12}/>
          </button>
        )}
      </div>
    </aside>
  );
}
