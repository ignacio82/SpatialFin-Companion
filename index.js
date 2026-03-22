const originalEmit = process.emit;
process.emit = function (name, data, ...args) {
  if (name === 'warning' && typeof data === 'object' && data.name === 'ExperimentalWarning' && data.message.includes('SQLite')) return false;
  return originalEmit.apply(process, [name, data, ...args]);
};
const express = require('express');
const qrcode = require('qrcode');
const bodyParser = require('body-parser');
const cors = require('cors');
const os = require('os');
const { WebSocketServer, WebSocket } = require('ws');
const helmet = require('helmet');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { createStorage } = require('./storage');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT) || 1982;
const ANALYTICS_SYNC_INTERVAL_MS = Math.max(30_000, Number(process.env.ANALYTICS_SYNC_INTERVAL_MS) || 120_000);

app.use(helmet({ contentSecurityPolicy: false })); // Disabled CSP for inline scripts if any
app.use(cors());
app.use(bodyParser.json({ limit: '5mb' }));
app.use(express.static('public'));

const DEFAULT_PREFERENCES = {
  // Language
  pref_audio_language: "jpn",
  pref_subtitle_language: "eng",
  pref_anime_audio_language: "jpn",
  pref_anime_subtitle_language: "eng",
  pref_non_anime_audio_language: "eng",
  pref_non_anime_subtitle_disabled: "true",
  pref_non_anime_subtitle_language: null,
  pref_smart_prefer_original_audio: "true",
  pref_smart_spoken_languages: "en,es,ja",

  // Interface
  pref_theme: "system",
  pref_dynamic_colors: "true",
  home_suggestions: "true",
  home_continue_watching: "true",
  home_next_up: "true",
  home_latest: "true",
  pref_display_extra_info: "false",
  pref_display_ratings: "true",

  // Player
  pref_player_seek_back_inc: "5000",
  pref_player_seek_forward_inc: "15000",
  pref_player_chapter_markers: "true",
  pref_player_trickplay: "true",
  pref_player_max_bitrate: "0",
  pref_libass_subtitle_usage: "auto",
  pref_logging_enabled: "false",

  // Voice
  pref_voice_control_enabled: "true",
  pref_voice_gesture_hand: "left",
  pref_voice_assistant_verbosity: "balanced",
  pref_voice_assistant_spoiler_policy: "cautious",
  pref_voice_assistant_spoken_replies: "true",
  pref_voice_assistant_voice: "male",
  pref_voice_assistant_cloud_api_key: null,

  // Seerr
  pref_seerr_enabled: "false",
  pref_seerr_url: null,
  pref_seerr_api_key: null,

  // TMDB
  pref_tmdb_api_key: null,
  pref_tmdb_auto_match: "true"
};

const storage = createStorage({
  rootDir: __dirname,
  defaultPreferences: DEFAULT_PREFERENCES
});

let appConfig = storage.getConfig();
let wss = null;
const analyticsSyncState = {
  running: false,
  lastRunAt: null,
  lastSuccessAt: null,
  lastError: null,
  accepted: 0,
  closed: 0,
  totalSessions: 0,
  polledServers: 0,
  polledUsers: 0,
  websocketConfigured: 0,
  websocketConnected: 0,
  websocketMessages: 0,
  websocketLastMessageAt: null
};
const jellyfinRealtimeSockets = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function saveConfig() {
  appConfig = storage.saveConfig(appConfig, {
    reason: 'config-save'
  });
}

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

async function httpGet(urlStr, headers = {}, timeout = 5000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(urlStr, { headers, signal: controller.signal });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { data = text; }
    return { status: res.status, data };
  } finally {
    clearTimeout(id);
  }
}

function buildJellyfinAuthHeaders(accessToken) {
  const token = String(accessToken || '').trim();
  return {
    'X-Emby-Token': token,
    'X-Emby-Authorization': `MediaBrowser Client="SpatialFin Companion", Device="Server", DeviceId="spatialfin-companion", Version="1.0.0", Token="${token}"`
  };
}

function ticksToMs(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.round(num / 10000);
}

function buildPlaybackEventType(session) {
  if (session.PlayState && session.PlayState.IsPaused) return 'pause';
  return 'progress';
}

function buildAnalyticsRequestContext(source) {
  return {
    ip: source || 'companion-internal',
    socket: { remoteAddress: source || 'companion-internal' },
    headers: { 'user-agent': source || 'companion-analytics-sync' }
  };
}

function normalizeJellyfinSession(serverConfig, userConfig, session) {
  if (!session || typeof session !== 'object') return null;
  const item = session.NowPlayingItem || session.NowPlayingItemDto || null;
  if (!item || !item.Id) return null;

  const sessionId = session.Id || session.PlayState?.MediaSourceId || null;
  const userId = session.UserId || userConfig.id || null;
  const username = session.UserName || userConfig.username || userConfig.name || null;
  const deviceId = session.DeviceId || session.DeviceName || session.Client || 'jellyfin-session';
  const positionTicks = session.PlayState?.PositionTicks ?? null;
  const runtimeTicks = item.RunTimeTicks ?? null;
  const lastSeenAt = session.LastPlaybackCheckIn || session.LastActivityDate || new Date().toISOString();

  return {
    playbackSessionId: `${serverConfig.id}:${sessionId || item.Id}:${userId || username || 'unknown'}:${deviceId}`,
    sessionId,
    deviceId,
    serverId: serverConfig.id || null,
    serverName: serverConfig.name || null,
    userId,
    username,
    itemId: item.Id || null,
    itemName: item.Name || item.SeriesName || 'Unknown Item',
    itemType: item.Type || null,
    libraryId: item.ParentId || item.CollectionType || null,
    libraryName: item.ParentTitle || item.CollectionType || null,
    clientName: session.Client || null,
    playbackMethod: session.PlayState?.PlayMethod || session.PlayState?.PlaybackMethod || null,
    startedAt: session.NowPlayingItem?.UserData?.LastPlayedDate || session.LastPlaybackCheckIn || lastSeenAt,
    lastSeenAt,
    endedAt: null,
    playDurationMs: ticksToMs(positionTicks),
    positionTicks,
    runtimeTicks,
    completed: false,
    eventType: buildPlaybackEventType(session),
    eventAt: lastSeenAt,
    eventDetails: {
      isPaused: !!session.PlayState?.IsPaused,
      isMuted: !!session.PlayState?.IsMuted,
      repeatMode: session.PlayState?.RepeatMode || null,
      shuffle: !!session.PlayState?.Shuffle,
      deviceName: session.DeviceName || null
    }
  };
}

function normalizeJellyfinItemMetadata(serverConfig, item) {
  if (!serverConfig || !item || !item.Id) return null;
  const imageTags = item.ImageTags && typeof item.ImageTags === 'object' ? item.ImageTags : {};
  const backdropImageTags = Array.isArray(item.BackdropImageTags) ? item.BackdropImageTags : [];
  return {
    serverId: serverConfig.id || null,
    itemId: item.Id || null,
    itemName: item.Name || item.SeriesName || null,
    itemType: item.Type || null,
    seriesName: item.SeriesName || null,
    seasonName: item.SeasonName || null,
    productionYear: item.ProductionYear ?? null,
    premiereDate: item.PremiereDate || null,
    officialRating: item.OfficialRating || null,
    communityRating: item.CommunityRating ?? null,
    runtimeTicks: item.RunTimeTicks ?? null,
    primaryImageTag: imageTags.Primary || imageTags.Thumb || null,
    backdropImageTag: backdropImageTags[0] || imageTags.Backdrop || null,
    overview: item.Overview || null,
    genres: Array.isArray(item.Genres) ? item.Genres : [],
    imageBlurHash: item.ImageBlurHashes?.Primary?.[imageTags.Primary || imageTags.Thumb] || null,
    lastRefreshedAt: new Date().toISOString()
  };
}

function findConfigServerById(serverId) {
  appConfig = storage.getConfig();
  return (Array.isArray(appConfig.servers) ? appConfig.servers : []).find((server) => server && server.id === serverId) || null;
}

function findVerifiedUserForServer(serverId, preferredUserId, preferredUsername) {
  const server = findConfigServerById(serverId);
  if (!server || !Array.isArray(server.users)) return { server: null, user: null };
  const candidates = server.users.filter((user) => user && user.access_token);
  const exact = candidates.find((user) => (preferredUserId && user.id === preferredUserId) || (preferredUsername && (user.username === preferredUsername || user.name === preferredUsername)));
  return { server, user: exact || candidates[0] || null };
}

async function fetchJellyfinItemMetadata(serverConfig, userConfig, itemId) {
  const baseUrl = String((serverConfig.addresses && serverConfig.addresses[0]) || '').replace(/\/+$/, '');
  const token = userConfig && userConfig.access_token;
  if (!baseUrl || !token || !itemId) return null;
  const encodedItemId = encodeURIComponent(itemId);
  const userId = userConfig.id ? encodeURIComponent(userConfig.id) : null;
  const itemPath = userId ? `/Users/${userId}/Items/${encodedItemId}` : `/Items/${encodedItemId}`;
  const query = 'Fields=Overview,PrimaryImageAspectRatio,PremiereDate,ProductionYear,CommunityRating,OfficialRating,Genres,RunTimeTicks,SeriesName,SeasonName,ImageTags,BackdropImageTags,ImageBlurHashes';
  const result = await httpGet(`${baseUrl}${itemPath}?${query}`, buildJellyfinAuthHeaders(token), 10000);
  if (result.status !== 200 || !result.data || typeof result.data !== 'object') {
    throw new Error(`Item fetch failed for ${serverConfig.name || baseUrl}: HTTP ${result.status}`);
  }
  return normalizeJellyfinItemMetadata(serverConfig, result.data);
}

async function enrichSessionsWithItemMetadata(serverConfig, userConfig, sessions) {
  const list = Array.isArray(sessions) ? sessions.filter((session) => session && session.itemId) : [];
  if (!list.length) return { accepted: 0 };
  const unique = new Map();
  list.forEach((session) => {
    const key = `${serverConfig.id || 'server'}:${session.itemId}`;
    if (!unique.has(key)) unique.set(key, session.itemId);
  });
  const entries = [];
  for (const itemId of unique.values()) {
    try {
      const metadata = await fetchJellyfinItemMetadata(serverConfig, userConfig, itemId);
      if (metadata) entries.push(metadata);
    } catch (error) {
      console.warn('Metadata enrichment failed:', serverConfig.name || serverConfig.id, itemId, error.message);
    }
  }
  return entries.length ? storage.upsertMediaItemMetadata(entries) : { accepted: 0 };
}

async function fetchJellyfinSessions(serverConfig, userConfig) {
  const baseUrl = String((serverConfig.addresses && serverConfig.addresses[0]) || '').replace(/\/+$/, '');
  const token = userConfig && userConfig.access_token;
  if (!baseUrl || !token) return [];

  const result = await httpGet(`${baseUrl}/Sessions`, buildJellyfinAuthHeaders(token), 10000);
  if (result.status !== 200 || !Array.isArray(result.data)) {
    throw new Error(`Session fetch failed for ${serverConfig.name || baseUrl}: HTTP ${result.status}`);
  }

  return result.data
    .map((session) => normalizeJellyfinSession(serverConfig, userConfig, session))
    .filter(Boolean);
}

function buildJellyfinSocketKey(serverConfig, userConfig) {
  return `${serverConfig.id || serverConfig.name || 'server'}:${userConfig.id || userConfig.username || userConfig.name || 'user'}`;
}

function buildJellyfinSocketUrl(serverConfig, userConfig) {
  const baseUrl = String((serverConfig.addresses && serverConfig.addresses[0]) || '').replace(/\/+$/, '');
  const token = String(userConfig && userConfig.access_token || '').trim();
  if (!baseUrl || !token) return null;
  const wsBase = baseUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  return `${wsBase}/socket?api_key=${encodeURIComponent(token)}&deviceId=spatialfin-companion`;
}

function broadcastAdminEvent(message) {
  if (!wss) return;
  const encoded = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(encoded);
  });
}

function refreshRealtimeSocketSummary() {
  const entries = Array.from(jellyfinRealtimeSockets.values());
  analyticsSyncState.websocketConfigured = entries.length;
  analyticsSyncState.websocketConnected = entries.filter((entry) => entry.connected).length;
  analyticsSyncState.websocketMessages = entries.reduce((total, entry) => total + (entry.messageCount || 0), 0);
  analyticsSyncState.websocketLastMessageAt = entries.reduce((latest, entry) => {
    if (!entry.lastMessageAt) return latest;
    if (!latest) return entry.lastMessageAt;
    return Date.parse(entry.lastMessageAt) > Date.parse(latest) ? entry.lastMessageAt : latest;
  }, null);
}

function getRealtimeSocketStatus() {
  return Array.from(jellyfinRealtimeSockets.values())
    .map((entry) => ({
      key: entry.key,
      serverId: entry.serverConfig.id || null,
      serverName: entry.serverConfig.name || null,
      username: entry.userConfig.username || entry.userConfig.name || null,
      connected: !!entry.connected,
      state: entry.connected ? 'connected' : (entry.reconnectTimer ? 'reconnecting' : 'disconnected'),
      reconnectAttempt: entry.reconnectAttempt || 0,
      nextReconnectAt: entry.nextReconnectAt || null,
      messageCount: entry.messageCount || 0,
      lastMessageAt: entry.lastMessageAt || null,
      lastError: entry.lastError || null,
      url: entry.url || null
    }))
    .sort((left, right) => {
      const connectedDelta = Number(right.connected) - Number(left.connected);
      if (connectedDelta !== 0) return connectedDelta;
      return String(left.serverName || left.serverId || left.key).localeCompare(String(right.serverName || right.serverId || right.key));
    });
}

function scheduleSocketScopeRefresh(entry, reason) {
  if (!entry) return;
  if (entry.refreshTimer) clearTimeout(entry.refreshTimer);
  entry.refreshTimer = setTimeout(async () => {
    entry.refreshTimer = null;
    try {
      const sessions = await fetchJellyfinSessions(entry.serverConfig, entry.userConfig);
      const activePlaybackSessionIds = sessions.map((session) => session.playbackSessionId);
      let result = { accepted: 0, totalSessions: storage.getAnalyticsOverview().totalSessions };
      await enrichSessionsWithItemMetadata(entry.serverConfig, entry.userConfig, sessions);
      if (sessions.length > 0) {
        result = storage.upsertPlaybackSessions({ sessions }, buildAnalyticsRequestContext('companion-analytics-websocket'));
      }
      const closedResult = storage.closeMissingPlaybackSessions({
        serverId: entry.serverConfig.id || null,
        userId: entry.userConfig.id || null,
        username: entry.userConfig.username || entry.userConfig.name || null,
        activePlaybackSessionIds,
        endedAt: new Date().toISOString()
      });
      analyticsSyncState.accepted = result.accepted || 0;
      analyticsSyncState.closed = closedResult.closed || 0;
      analyticsSyncState.totalSessions = result.totalSessions || analyticsSyncState.totalSessions || 0;
      analyticsSyncState.lastSuccessAt = new Date().toISOString();
      broadcastAdminEvent({
        type: 'analytics_sync_completed',
        accepted: analyticsSyncState.accepted,
        closed: analyticsSyncState.closed,
        totalSessions: analyticsSyncState.totalSessions,
        polledServers: analyticsSyncState.polledServers,
        polledUsers: analyticsSyncState.polledUsers
      });
      storage.recordEvent('analytics_websocket_refresh', null, {
        reason,
        serverId: entry.serverConfig.id || null,
        username: entry.userConfig.username || entry.userConfig.name || null,
        accepted: analyticsSyncState.accepted,
        closed: analyticsSyncState.closed
      });
    } catch (error) {
      console.warn('Analytics websocket refresh failed:', entry.serverConfig.name || entry.serverConfig.id, entry.userConfig.username || entry.userConfig.name, error.message);
    }
  }, 800);
}

function looksLikePlaybackMessage(messageType) {
  const normalized = String(messageType || '').toLowerCase();
  return normalized.includes('session')
    || normalized.includes('play')
    || normalized.includes('progress')
    || normalized.includes('pause')
    || normalized.includes('stop');
}

function extractRealtimeSessionsFromMessage(serverConfig, userConfig, payload) {
  const sources = [];
  if (Array.isArray(payload)) sources.push(payload);
  if (Array.isArray(payload?.Data)) sources.push(payload.Data);
  if (Array.isArray(payload?.data)) sources.push(payload.data);
  if (Array.isArray(payload?.MessageData)) sources.push(payload.MessageData);
  if (payload?.Data && typeof payload.Data === 'object' && Array.isArray(payload.Data.Items)) sources.push(payload.Data.Items);
  if (payload?.data && typeof payload.data === 'object' && Array.isArray(payload.data.Items)) sources.push(payload.data.Items);

  if (payload?.Data && typeof payload.Data === 'object' && (payload.Data.NowPlayingItem || payload.Data.NowPlayingItemDto)) {
    sources.push([payload.Data]);
  }
  if (payload?.data && typeof payload.data === 'object' && (payload.data.NowPlayingItem || payload.data.NowPlayingItemDto)) {
    sources.push([payload.data]);
  }

  const normalized = [];
  sources.forEach((items) => {
    items.forEach((item) => {
      const session = normalizeJellyfinSession(serverConfig, userConfig, item);
      if (session) normalized.push(session);
    });
  });
  return normalized;
}

function subscribeToJellyfinSocket(entry) {
  if (!entry || !entry.socket || entry.socket.readyState !== WebSocket.OPEN) return;
  try {
    entry.socket.send(JSON.stringify({ MessageType: 'SessionsStart', Data: '0,1500' }));
  } catch (_) {}
}

function connectJellyfinRealtimeSocket(serverConfig, userConfig) {
  const url = buildJellyfinSocketUrl(serverConfig, userConfig);
  const key = buildJellyfinSocketKey(serverConfig, userConfig);
  if (!url) return;

  const existing = jellyfinRealtimeSockets.get(key);
  if (existing && existing.url === url) return;
  if (existing) {
    existing.closedManually = true;
    if (existing.refreshTimer) clearTimeout(existing.refreshTimer);
    if (existing.reconnectTimer) clearTimeout(existing.reconnectTimer);
    try { existing.socket && existing.socket.close(); } catch (_) {}
  }

  const entry = {
    key,
    url,
    serverConfig,
    userConfig,
    socket: null,
    connected: false,
    reconnectAttempt: 0,
    reconnectTimer: null,
    refreshTimer: null,
    closedManually: false,
    messageCount: 0,
    lastMessageAt: null
  };
  jellyfinRealtimeSockets.set(key, entry);
  refreshRealtimeSocketSummary();

  const open = () => {
    const socket = new WebSocket(url, {
      headers: buildJellyfinAuthHeaders(userConfig.access_token)
    });
    entry.socket = socket;

    socket.on('open', () => {
      entry.connected = true;
      entry.reconnectAttempt = 0;
      entry.nextReconnectAt = null;
      entry.lastError = null;
      refreshRealtimeSocketSummary();
      subscribeToJellyfinSocket(entry);
      scheduleSocketScopeRefresh(entry, 'websocket-open');
    });

    socket.on('message', (raw) => {
      entry.connected = true;
      entry.messageCount += 1;
      entry.lastMessageAt = new Date().toISOString();
      refreshRealtimeSocketSummary();

      let payload;
      try {
        payload = JSON.parse(raw.toString());
      } catch (_) {
        return;
      }

      const messageType = payload.MessageType || payload.messageType || payload.Type || payload.type || '';
      const sessions = extractRealtimeSessionsFromMessage(serverConfig, userConfig, payload);
      if (sessions.length > 0) {
        enrichSessionsWithItemMetadata(serverConfig, userConfig, sessions).catch((error) => {
          console.warn('Realtime metadata enrichment failed:', serverConfig.name || serverConfig.id, error.message);
        });
        const result = storage.upsertPlaybackSessions({ sessions }, buildAnalyticsRequestContext('companion-analytics-websocket'));
        analyticsSyncState.accepted = result.accepted || 0;
        analyticsSyncState.totalSessions = result.totalSessions || analyticsSyncState.totalSessions || 0;
        analyticsSyncState.lastSuccessAt = new Date().toISOString();
        broadcastAdminEvent({
          type: 'analytics_sessions_ingested',
          accepted: result.accepted || 0,
          totalSessions: analyticsSyncState.totalSessions
        });
      }

      if (looksLikePlaybackMessage(messageType)) {
        scheduleSocketScopeRefresh(entry, `websocket:${messageType || 'message'}`);
      }
    });

    socket.on('close', () => {
      entry.connected = false;
      refreshRealtimeSocketSummary();
      if (entry.closedManually) return;
      const retryDelay = Math.min(60_000, 2000 * Math.max(1, ++entry.reconnectAttempt));
      entry.nextReconnectAt = new Date(Date.now() + retryDelay).toISOString();
      entry.reconnectTimer = setTimeout(open, retryDelay);
    });

    socket.on('error', (error) => {
      entry.connected = false;
      entry.lastError = error.message;
      analyticsSyncState.lastError = error.message;
      refreshRealtimeSocketSummary();
    });
  };

  open();
}

function reconcileJellyfinRealtimeSockets() {
  appConfig = storage.getConfig();
  const desiredKeys = new Set();
  const servers = Array.isArray(appConfig.servers) ? appConfig.servers : [];
  servers.forEach((server) => {
    const users = Array.isArray(server.users) ? server.users.filter((user) => user && user.access_token) : [];
    users.forEach((user) => {
      const key = buildJellyfinSocketKey(server, user);
      desiredKeys.add(key);
      connectJellyfinRealtimeSocket(server, user);
    });
  });

  Array.from(jellyfinRealtimeSockets.entries()).forEach(([key, entry]) => {
    if (desiredKeys.has(key)) return;
    entry.closedManually = true;
    if (entry.refreshTimer) clearTimeout(entry.refreshTimer);
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    try { entry.socket && entry.socket.close(); } catch (_) {}
    jellyfinRealtimeSockets.delete(key);
  });

  refreshRealtimeSocketSummary();
}

async function runAnalyticsSync(reason) {
  if (analyticsSyncState.running) {
    return { skipped: true, reason: 'already-running', state: analyticsSyncState };
  }

  analyticsSyncState.running = true;
  analyticsSyncState.lastRunAt = new Date().toISOString();
  analyticsSyncState.lastError = null;

  let polledServers = 0;
  let polledUsers = 0;
  let closedSessions = 0;
  const collectedSessions = [];

  try {
    appConfig = storage.getConfig();
    const servers = Array.isArray(appConfig.servers) ? appConfig.servers : [];
    for (const server of servers) {
      const users = Array.isArray(server.users) ? server.users.filter((user) => user && user.access_token) : [];
      if (!users.length) continue;
      polledServers += 1;
      for (const user of users) {
        polledUsers += 1;
        try {
          const sessions = await fetchJellyfinSessions(server, user);
          collectedSessions.push(...sessions);
          await enrichSessionsWithItemMetadata(server, user, sessions);
          const activePlaybackSessionIds = sessions.map((session) => session.playbackSessionId);
          const closedResult = storage.closeMissingPlaybackSessions({
            serverId: server.id || null,
            userId: user.id || null,
            username: user.username || user.name || null,
            activePlaybackSessionIds,
            endedAt: new Date().toISOString()
          });
          closedSessions += closedResult.closed || 0;
        } catch (error) {
          console.warn('Analytics sync user poll failed:', server.name || server.id, user.username || user.name, error.message);
        }
      }
    }

    let result = { accepted: 0, totalSessions: storage.getAnalyticsOverview().totalSessions };
    if (collectedSessions.length > 0) {
      result = storage.upsertPlaybackSessions({ sessions: collectedSessions }, buildAnalyticsRequestContext('companion-analytics-sync'));
    }

    analyticsSyncState.lastSuccessAt = new Date().toISOString();
    analyticsSyncState.accepted = result.accepted || 0;
    analyticsSyncState.closed = closedSessions;
    analyticsSyncState.totalSessions = result.totalSessions || analyticsSyncState.totalSessions || 0;
    analyticsSyncState.polledServers = polledServers;
    analyticsSyncState.polledUsers = polledUsers;

    storage.recordEvent('analytics_sync_completed', null, {
      reason,
      accepted: analyticsSyncState.accepted,
      closed: analyticsSyncState.closed,
      polledServers,
      polledUsers
    });

    broadcastAdminEvent({
      type: 'analytics_sync_completed',
      accepted: analyticsSyncState.accepted,
      closed: analyticsSyncState.closed,
      totalSessions: analyticsSyncState.totalSessions,
      polledServers,
      polledUsers
    });

    return { skipped: false, state: analyticsSyncState };
  } catch (error) {
    analyticsSyncState.lastError = error.message;
    storage.recordEvent('analytics_sync_failed', null, {
      reason,
      error: error.message
    });
    return { skipped: false, state: analyticsSyncState, error };
  } finally {
    analyticsSyncState.running = false;
  }
}

async function httpPost(urlStr, body, headers = {}, timeout = 5000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    if (!headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(urlStr, {
      method: 'POST',
      headers,
      body: payload,
      signal: controller.signal
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { data = text; }
    return { status: res.status, data };
  } finally {
    clearTimeout(id);
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    const key = pair.substring(0, idx).trim();
    const val = pair.substring(idx + 1).trim();
    cookies[key] = decodeURIComponent(val);
  });
  return cookies;
}

// ---------------------------------------------------------------------------
// Admin authentication (opt-in)
// ---------------------------------------------------------------------------
const ADMIN_PASSWORD = process.env.COMPANION_ADMIN_PASSWORD || null;


function adminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) return next();
  // Exempt login endpoint
  if (req.path === '/login') return next();
  const cookies = parseCookies(req);
  const token = cookies['session'];
  if (token && storage.validateAdminSession(token)) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

const adminRouter = express.Router();
adminRouter.use(adminAuth);

function formatLogEntry(entry) {
  const timestamp = entry.timestamp || entry.receivedAt || new Date().toISOString();
  const level = entry.level || '?';
  const tag = entry.tag || 'SpatialFin';
  const message = entry.message || '';
  const header = `${timestamp} ${level}/${tag}: ${message}`;
  return entry.stack ? `${header}\n${entry.stack}` : header;
}

// ---------------------------------------------------------------------------
// Admin login & auth-check (login is exempt from auth via middleware)
// ---------------------------------------------------------------------------
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts, please try again later' }
});

adminRouter.post('/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  if (!ADMIN_PASSWORD) {
    return res.json({ authenticated: true });
  }
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  storage.createAdminSession(token);
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/`);
  res.json({ authenticated: true });
});

adminRouter.get('/auth-check', (req, res) => {
  res.json({ authenticated: true, authRequired: !!ADMIN_PASSWORD });
});

// ---------------------------------------------------------------------------
// Existing admin routes
// ---------------------------------------------------------------------------
adminRouter.get('/config', (req, res) => res.json(appConfig));

adminRouter.post('/config', (req, res) => {
  const { globalPreferences, servers, networkShares } = req.body;
  if (globalPreferences) appConfig.globalPreferences = globalPreferences;
  if (servers) appConfig.servers = servers;
  if (networkShares) appConfig.networkShares = networkShares;
  appConfig = storage.saveConfig(appConfig, {
    reason: 'config-update',
    eventType: 'config_updated',
    req,
    details: {
      servers: Array.isArray(appConfig.servers) ? appConfig.servers.length : 0,
      networkShares: Array.isArray(appConfig.networkShares) ? appConfig.networkShares.length : 0
    }
  });
  reconcileJellyfinRealtimeSockets();
  res.json({ status: 'ok' });
});

adminRouter.get('/qr', async (req, res) => {
  const host = req.query.host || getLocalIp();
  const payload = JSON.stringify({
    version: 1,
    companion_url: `http://${host}:${PORT}`,
    setup_token: appConfig.setup_token
  });
  try {
    const qrImage = await qrcode.toDataURL(payload);
    res.json({ qr: qrImage, payload });
  } catch (err) {
    res.status(500).json({ error: 'QR fail' });
  }
});

// ---------------------------------------------------------------------------
// New admin routes
// ---------------------------------------------------------------------------
adminRouter.post('/test-jellyfin', async (req, res) => {
  try {
    const url = (req.body.url || '').replace(/\/+$/, '');
    const result = await httpGet(`${url}/System/Info/Public`);
    if (result.status === 200 && result.data) {
      res.json({ success: true, serverName: result.data.ServerName, version: result.data.Version });
    } else {
      res.json({ success: false, error: `Unexpected status ${result.status}` });
    }
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

adminRouter.post('/test-seerr', async (req, res) => {
  try {
    const { url, apiKey } = req.body;
    const cleanUrl = (url || '').replace(/\/+$/, '');
    const result = await httpGet(`${cleanUrl}/api/v1/status`, { 'X-Api-Key': apiKey });
    if (result.status === 200) {
      res.json({ success: true, data: result.data });
    } else {
      res.json({ success: false, error: `Unexpected status ${result.status}` });
    }
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

adminRouter.post('/verify-user', async (req, res) => {
  try {
    const { serverUrl, username, password } = req.body;
    const cleanUrl = (serverUrl || '').replace(/\/+$/, '');
    const authHeader = 'MediaBrowser Client="SpatialFin Companion", Device="Server", DeviceId="spatialfin-companion", Version="1.0.0"';
    const result = await httpPost(
      `${cleanUrl}/Users/AuthenticateByName`,
      { Username: username, Pw: password },
      { 'X-Emby-Authorization': authHeader }
    );
    if (result.status === 200 && result.data) {
      const accessToken = result.data.AccessToken;
      const userId = result.data.User ? result.data.User.Id : result.data.UserId;
      // Save access_token to matching user in config
      if (appConfig.servers) {
        for (const server of appConfig.servers) {
          if (server.users) {
            for (const user of server.users) {
              if (user.username === username || user.name === username) {
                user.access_token = accessToken;
                user.id = userId;
              }
            }
          }
        }
        appConfig = storage.saveConfig(appConfig, {
          reason: 'verify-user',
          eventType: 'user_verified',
          req,
          details: {
            username,
            serverUrl: cleanUrl
          }
        });
        reconcileJellyfinRealtimeSockets();
      }
      res.json({ success: true, userId, accessToken });
    } else {
      res.json({ success: false, error: `Authentication failed with status ${result.status}` });
    }
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

adminRouter.post('/rotate-token', (req, res) => {
  appConfig.setup_token = 'sf-setup-' + crypto.randomBytes(6).toString('hex');
  appConfig = storage.saveConfig(appConfig, {
    reason: 'rotate-token',
    eventType: 'token_rotated',
    req
  });
  res.json({ setup_token: appConfig.setup_token });
});

adminRouter.get('/config/snapshots', (req, res) => {
  res.json(storage.getConfigSnapshots());
});

adminRouter.post('/config/snapshots/restore', (req, res) => {
  try {
    const success = storage.restoreConfigSnapshot(req.body.id);
    if (success) {
      appConfig = storage.getConfig();
      res.json({ success: true, config: appConfig });
    } else {
      res.status(404).json({ success: false, error: 'Snapshot not found' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

adminRouter.get('/config/export', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="spatialfin-config.json"');
  res.json(appConfig);
});

adminRouter.post('/config/import', (req, res) => {
  try {
    const imported = req.body;
    if (!imported || typeof imported !== 'object' || Array.isArray(imported)) {
      return res.status(400).json({ error: 'Invalid config: must be a JSON object' });
    }
    if (imported.globalPreferences) {
      appConfig.globalPreferences = { ...appConfig.globalPreferences, ...imported.globalPreferences };
    }
    if (imported.servers) {
      appConfig.servers = imported.servers;
    }
    if (imported.networkShares) {
      appConfig.networkShares = imported.networkShares;
    }
    if (imported.setup_token) {
      appConfig.setup_token = imported.setup_token;
    }
    appConfig = storage.saveConfig(appConfig, {
      reason: 'config-import',
      eventType: 'config_imported',
      req,
      details: {
        importedServers: Array.isArray(imported.servers) ? imported.servers.length : 0,
        importedShares: Array.isArray(imported.networkShares) ? imported.networkShares.length : 0
      }
    });
    res.json({ status: 'ok', config: appConfig });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

adminRouter.get('/sync-log', (req, res) => {
  res.json(storage.getSyncLog(100));
});

adminRouter.get('/device-logs', (req, res) => {
  res.json({
    loggingEnabled: appConfig.globalPreferences.pref_logging_enabled === 'true',
    devices: storage.getDeviceSummaries()
  });
});

adminRouter.get('/device-logs/:deviceId', (req, res) => {
  const requestedLimit = Number(req.query.limit) || 500;
  const limit = Math.max(1, Math.min(2000, requestedLimit));
  const result = storage.getDeviceWithLogs(req.params.deviceId, limit);
  if (!result) {
    return res.status(404).json({ error: 'Device logs not found' });
  }
  res.json({
    device: result.device,
    entries: result.entries
  });
});

adminRouter.get('/device-logs/:deviceId/download', (req, res) => {
  const result = storage.getDeviceWithLogs(req.params.deviceId, 1000000);
  if (!result) {
    return res.status(404).json({ error: 'Device logs not found' });
  }
  const { device, entries } = result;
  const safeName = (device.deviceName || device.deviceId || 'spatialfin-device')
    .replace(/[^a-z0-9-_]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'spatialfin-device';
  const lines = [
    `Device: ${device.deviceName || device.deviceId}`,
    `Device ID: ${device.deviceId}`,
    `Model: ${device.manufacturer ? device.manufacturer + ' ' : ''}${device.model || ''}`.trim(),
    `App Version: ${device.appVersion || '-'}`,
    `Android Version: ${device.androidVersion || '-'}`,
    `Last Seen: ${device.lastSeenAt || '-'}`,
    `Entries: ${entries.length}`,
    ''
  ];
  entries.forEach((entry) => {
    lines.push(formatLogEntry(entry));
    lines.push('');
  });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}-logs.txt"`);
  res.send(lines.join('\n'));
});

adminRouter.delete('/device-logs/:deviceId', (req, res) => {
  storage.clearDeviceLogs(req.params.deviceId);
  res.json({ status: 'ok' });
});

adminRouter.get('/analytics/overview', (req, res) => {
  const recentLimit = Math.max(1, Math.min(100, Number(req.query.recentLimit) || 10));
  const topLimit = Math.max(1, Math.min(100, Number(req.query.topLimit) || 10));
  const trendLimit = Math.max(1, Math.min(60, Number(req.query.trendLimit) || 14));
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  res.json({
    sync: analyticsSyncState,
    realtimeSockets: getRealtimeSocketStatus(),
    rangeDays: days,
    overview: storage.getAnalyticsOverview({ days }),
    recentSessions: storage.getRecentPlaybackSessions(recentLimit, { days }),
    topUsers: storage.getTopPlaybackUsers(topLimit, { days }),
    topServers: storage.getTopPlaybackServers(topLimit, { days }),
    topLibraries: storage.getTopPlaybackLibraries(topLimit, { days }),
    trends: storage.getDailyPlaybackTrends(trendLimit, { days }),
    topItems: storage.getTopPlaybackItems(topLimit, { days })
  });
});

adminRouter.get('/analytics/sync-status', (req, res) => {
  res.json({
    sync: analyticsSyncState,
    realtimeSockets: getRealtimeSocketStatus(),
    intervalMs: ANALYTICS_SYNC_INTERVAL_MS
  });
});

adminRouter.get('/analytics/realtime-status', (req, res) => {
  res.json({
    sync: analyticsSyncState,
    sockets: getRealtimeSocketStatus()
  });
});

adminRouter.get('/analytics/artwork/:serverId/:itemId', async (req, res) => {
  const lookup = findVerifiedUserForServer(req.params.serverId, null, null);
  if (!lookup.server || !lookup.user) {
    return res.status(404).json({ error: 'Artwork source not available' });
  }
  const baseUrl = String((lookup.server.addresses && lookup.server.addresses[0]) || '').replace(/\/+$/, '');
  const token = lookup.user.access_token;
  const url = `${baseUrl}/Items/${encodeURIComponent(req.params.itemId)}/Images/Primary?maxHeight=420&quality=90`;
  try {
    const upstream = await fetch(url, {
      headers: buildJellyfinAuthHeaders(token)
    });
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: 'Artwork fetch failed' });
    }
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const arrayBuffer = await upstream.arrayBuffer();
    res.end(Buffer.from(arrayBuffer));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.post('/analytics/sync-now', async (req, res) => {
  const result = await runAnalyticsSync('manual');
  if (result.error) {
    return res.status(500).json({
      success: false,
      error: result.error.message,
      sync: analyticsSyncState
    });
  }
  res.json({
    success: true,
    skipped: !!result.skipped,
    sync: analyticsSyncState
  });
});

adminRouter.get('/analytics/sessions', (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  res.json({
    sessions: storage.getRecentPlaybackSessions(limit, { days })
  });
});

adminRouter.get('/analytics/sessions/:playbackSessionId', (req, res) => {
  const limit = Math.max(1, Math.min(2000, Number(req.query.limit) || 500));
  const result = storage.getPlaybackSessionWithEvents(req.params.playbackSessionId, limit);
  if (!result) {
    return res.status(404).json({ error: 'Playback session not found' });
  }
  res.json(result);
});

adminRouter.get('/analytics/users', (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25));
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  res.json({
    users: storage.getTopPlaybackUsers(limit, { days })
  });
});

adminRouter.get('/analytics/users/:userRef', (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 30));
  const result = storage.getPlaybackUserDetail(req.params.userRef, { limit });
  if (!result) {
    return res.status(404).json({ error: 'User analytics not found' });
  }
  res.json(result);
});

adminRouter.get('/analytics/libraries', (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25));
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  res.json({
    libraries: storage.getTopPlaybackLibraries(limit, { days })
  });
});

adminRouter.get('/analytics/servers', (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25));
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  res.json({
    servers: storage.getTopPlaybackServers(limit, { days })
  });
});

adminRouter.get('/analytics/trends', (req, res) => {
  const limit = Math.max(1, Math.min(90, Number(req.query.limit) || 30));
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  res.json({
    trends: storage.getDailyPlaybackTrends(limit, { days })
  });
});

adminRouter.get('/analytics/items', (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25));
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  res.json({
    items: storage.getTopPlaybackItems(limit, { days })
  });
});

adminRouter.get('/analytics/items/:itemRef', (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 30));
  const result = storage.getPlaybackItemDetail(req.params.itemRef, { limit });
  if (!result) {
    return res.status(404).json({ error: 'Item analytics not found' });
  }
  res.json(result);
});

adminRouter.get('/analytics/history', (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  res.json({
    history: storage.getWatchHistory({
      limit,
      days,
      user: req.query.user || null,
      item: req.query.item || null
    })
  });
});

app.use('/api/admin', adminRouter);

// ---------------------------------------------------------------------------
// Public API (NOT under admin auth)
// ---------------------------------------------------------------------------
app.get('/api/v1/config', (req, res) => {
  const token = req.headers['x-setup-token'];
  if (token !== appConfig.setup_token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  storage.recordEvent('device_sync_pull', req, {
    setupTokenPrefix: appConfig.setup_token.slice(0, 12)
  });
  res.json(appConfig);
});

app.post('/api/v1/device-logs', (req, res) => {
  const token = req.headers['x-setup-token'];
  if (token !== appConfig.setup_token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const payload = req.body || {};
  if (!payload.deviceId || !Array.isArray(payload.logs) || payload.logs.length === 0) {
    return res.status(400).json({ error: 'Invalid log payload' });
  }
  const device = storage.upsertDeviceLogs(payload, req);
  res.json({
    status: 'ok',
    deviceId: device.deviceId,
    accepted: payload.logs.length,
    totalEntries: device.entryCount
  });
  
  if (wss) {
    const msg = JSON.stringify({ type: 'new_logs', deviceId: device.deviceId, logs: payload.logs });
    wss.clients.forEach(client => {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(msg);
      }
    });
  }
});

app.post('/api/v1/analytics/sessions', (req, res) => {
  const token = req.headers['x-setup-token'];
  if (token !== appConfig.setup_token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const payload = req.body || {};
  const sessionCount = Array.isArray(payload.sessions)
    ? payload.sessions.length
    : (payload && typeof payload === 'object' ? 1 : 0);
  if (sessionCount === 0) {
    return res.status(400).json({ error: 'Invalid analytics payload' });
  }

  const result = storage.upsertPlaybackSessions(payload, req);
  res.json({
    status: 'ok',
    accepted: result.accepted,
    totalSessions: result.totalSessions
  });

  if (wss && result.accepted > 0) {
    const msg = JSON.stringify({
      type: 'analytics_sessions_ingested',
      accepted: result.accepted,
      totalSessions: result.totalSessions
    });
    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        client.send(msg);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
});

// Automated Backups
function backupDatabase() {
  const dataDir = path.join(__dirname, 'data');
  const backupDir = path.join(dataDir, 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const dbFile = path.join(dataDir, 'companion.sqlite');
  if (!fs.existsSync(dbFile)) return;
  const backupFile = path.join(backupDir, `companion-${new Date().toISOString().split('T')[0]}.sqlite.bak`);
  fs.copyFileSync(dbFile, backupFile);
  
  const files = fs.readdirSync(backupDir).map(f => ({ name: f, time: fs.statSync(path.join(backupDir, f)).mtime.getTime() }));
  files.sort((a, b) => b.time - a.time);
  files.slice(7).forEach(f => fs.unlinkSync(path.join(backupDir, f.name)));
}
setInterval(backupDatabase, 24 * 60 * 60 * 1000);
backupDatabase();

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`SpatialFin Companion on port ${PORT}`);
});

wss = new WebSocketServer({ server });
wss.on('connection', () => {
  // Client connected for live log and analytics streaming.
});

reconcileJellyfinRealtimeSockets();

setInterval(() => {
  runAnalyticsSync('interval').catch((error) => {
    console.error('Analytics sync interval failed:', error);
  });
}, ANALYTICS_SYNC_INTERVAL_MS);

setTimeout(() => {
  runAnalyticsSync('startup').catch((error) => {
    console.error('Analytics sync startup failed:', error);
  });
}, 5000);
