export default function StatusDot({ state }) {
  const cls =
    state === 'connected' || state === 'online' || state === 'mounted' || state === 'synced' || state === 'ok' ? 'ok'
    : state === 'reconnecting' || state === 'syncing' || state === 'paired' || state === 'degraded' || state === 'warn' ? 'warn'
    : state === 'disconnected' || state === 'offline' || state === 'stale' || state === 'err' ? 'err'
    : '';
  return <span className={'dot ' + cls}/>;
}
