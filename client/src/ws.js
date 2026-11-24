// SpatialFin Companion admin WebSocket client.
// Connects to /ws only after auth-check confirms wsAllowed === true.
import { useEffect, useRef } from 'react';
import { api } from './api.js';

let socket = null;
let wsAllowed = false;
let listeners = new Set();
let reconnectTimer = null;

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function connect() {
  if (typeof window === 'undefined' || !wsAllowed || socket) return;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
  socket = ws;

  ws.onmessage = (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch (_) { return; }
    listeners.forEach((fn) => {
      try { fn(data); } catch (_) {}
    });
  };

  ws.onclose = (event) => {
    if (socket === ws) socket = null;
    if (!wsAllowed) return;
    if (reconnectTimer) return;

    const code = event?.code;
    const scheduleReconnect = async () => {
      reconnectTimer = null;
      if (!wsAllowed) return;
      if (code === 1006 || code === 4401) {
        try {
          const check = await api.authCheck();
          if (!check?.wsAllowed) {
            wsAllowed = false;
            return;
          }
        } catch (_) {
          wsAllowed = false;
          return;
        }
      }
      connect();
    };
    reconnectTimer = setTimeout(scheduleReconnect, 5000);
  };

  ws.onerror = () => {
    try { ws.close(); } catch (_) {}
  };
}

export function setWebSocketAuthAllowed(allowed) {
  wsAllowed = Boolean(allowed);
  if (!wsAllowed) {
    clearReconnect();
    if (socket) {
      try { socket.close(); } catch (_) {}
      socket = null;
    }
  } else {
    connect();
  }
}

export function startWebSocket() {
  if (wsAllowed && !socket) connect();
}

export function useWebSocketEvent(type, handler) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (wsAllowed) startWebSocket();
    const fn = (data) => {
      if (!type || data.type === type) handlerRef.current && handlerRef.current(data);
    };
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, [type]);
}
