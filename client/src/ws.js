// SpatialFin Companion websocket client.
// The server broadcasts:
//   { type: 'new_logs', deviceId, logs }
//   { type: 'analytics_sessions_ingested' }
//   { type: 'analytics_sync_completed' }
//   { type: 'config_changed', deviceId }
import { useEffect, useRef } from 'react';

let socket = null;
let listeners = new Set();
let reconnectTimer = null;

function connect() {
  if (typeof window === 'undefined') return;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(protocol + '//' + window.location.host);
  socket.onmessage = (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch (_) { return; }
    listeners.forEach((fn) => {
      try { fn(data); } catch (_) {}
    });
  };
  socket.onclose = () => {
    socket = null;
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 5000);
  };
  socket.onerror = () => {
    try { socket && socket.close(); } catch (_) {}
  };
}

export function startWebSocket() {
  if (!socket) connect();
}

export function useWebSocketEvent(type, handler) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    startWebSocket();
    const fn = (data) => {
      if (!type || data.type === type) handlerRef.current && handlerRef.current(data);
    };
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, [type]);
}
