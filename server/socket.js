const fs = require("fs");
const path = require("path");

const MAX_RELAY_CACHE_BYTES = 96 * 1024 * 1024;
const RECONNECT_GRACE_MS = 30000;
const SOURCE_HEARTBEAT_GRACE_MS = 20000;
const RELAY_REQUEST_TIMEOUT_MS = 8000;
const PLAYBACK_PULSE_INTERVAL_MS = 700;
const CHAT_HISTORY_LIMIT = 200;
const CHAT_HISTORY_FILE = path.resolve(process.env.CHAT_HISTORY_FILE || path.resolve(__dirname, "chat-history.json"));
const PLAYBACK_ACTIVITY_LIMIT = 100;
const PLAYBACK_ACTIVITY_FILE = path.resolve(process.env.PLAYBACK_ACTIVITY_FILE || path.resolve(__dirname, "playback-activity.json"));
const DEMO_ROOM_ID = "1";
const DEMO_VIDEO_ID = "server-demo-room-1";
const DEMO_VIDEO_NAME = "演示.mp4";
const PRELOAD_HEAD_CHUNKS = 4;
const PRELOAD_TAIL_CHUNKS = 4;
const PRELOAD_BEHIND_CHUNKS = 2;
const PRELOAD_AHEAD_CHUNKS = 12;
const STARTUP_BARRIER_TIMEOUT_MS = 8000;
const STARTUP_BUFFER_SECONDS = 2;
const MIN_COMMAND_LEAD_MS = 380;
const MAX_COMMAND_LEAD_MS = 1200;
const MAX_PLAYBACK_COMMAND_AGE_MS = 12000;
const EMPTY_ROOM_RESET_MS = 30 * 60 * 1000;
const SYNC_CORRECTION_INTERVAL_MS = 1800;
const SYNC_IGNORE_DRIFT_SECONDS = 0.35;
const SYNC_HARD_DRIFT_SECONDS = 1.5;
const SCHEDULED_PLAYBACK_REASONS = new Set([
  "play-click",
  "pause-click",
  "remote-play-click",
  "remote-replay-click",
  "remote-pause-click",
  "seek-release",
  "skip",
  "ratechange",
  "fitchange"
]);

function normalizeRoomId(roomId) {
  const clean = String(roomId || DEMO_ROOM_ID).trim().slice(0, 40);
  return clean || DEMO_ROOM_ID;
}

function roomKey(roomId) {
  return `room:${normalizeRoomId(roomId)}`;
}

function normalizeName(name) {
  const clean = String(name || "").trim().slice(0, 24);
  return clean || `用户${Math.floor(Math.random() * 9000 + 1000)}`;
}

function initialFromName(name) {
  return Array.from(String(name || "").trim())[0]?.toUpperCase() || "P";
}

function publicUser(socketId, user, activeVideoMeta = null) {
  const isSourceOwner = Boolean(
    activeVideoMeta &&
      ((activeVideoMeta.ownerClientId && activeVideoMeta.ownerClientId === user.clientId) ||
        (activeVideoMeta.ownerId && activeVideoMeta.ownerId === socketId))
  );
  return {
    id: socketId,
    name: user.name,
    initial: user.initial,
    speaking: user.speaking,
    sourceOwner: isSourceOwner,
    watchState: user.watchState || null,
    online: Date.now() - (user.lastSeenAt || user.connectedAt || 0) < RECONNECT_GRACE_MS,
    connectedAt: user.connectedAt
  };
}

function loadChatStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, "utf8"));
    if (parsed && parsed.rooms && typeof parsed.rooms === "object") return parsed.rooms;
    const legacy = Array.isArray(parsed) ? parsed : parsed.messages;
    return { [DEMO_ROOM_ID]: Array.isArray(legacy) ? legacy : [] };
  } catch {
    return {};
  }
}

function saveChatStore(rooms) {
  saveStoreAtomically(CHAT_HISTORY_FILE, { rooms }, "Chat history");
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message) => message && typeof message.text === "string")
    .slice(-CHAT_HISTORY_LIMIT)
    .map((message) => ({
      id: String(message.id || `${message.from || "chat"}-${message.time || Date.now()}`).slice(0, 120),
      from: String(message.from || "chat").slice(0, 80),
      name: normalizeName(message.name),
      text: String(message.text || "").slice(0, 1000),
      time: Number.isFinite(message.time) ? message.time : Date.now()
    }));
}

function loadPlaybackActivityStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PLAYBACK_ACTIVITY_FILE, "utf8"));
    return parsed && parsed.rooms && typeof parsed.rooms === "object" ? parsed.rooms : {};
  } catch {
    return {};
  }
}

function savePlaybackActivityStore(rooms) {
  saveStoreAtomically(PLAYBACK_ACTIVITY_FILE, { rooms }, "Playback activity");
}

function saveStoreAtomically(file, value, label) {
  const temporary = `${file}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
    fs.renameSync(temporary, file);
  } catch (error) {
    console.warn(`${label} save failed`, error);
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

function sanitizePlaybackActivities(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(-PLAYBACK_ACTIVITY_LIMIT).map((item) => ({
    id: String(item?.id || `activity-${Date.now()}`).slice(0, 120),
    kind: String(item?.kind || "").slice(0, 24),
    name: normalizeName(item?.name),
    actorClientId: String(item?.actorClientId || "").slice(0, 80),
    time: Number.isFinite(item?.time) ? item.time : Date.now(),
    currentTime: Math.max(0, Number(item?.currentTime || 0)),
    playbackRate: Math.max(0.25, Math.min(4, Number(item?.playbackRate || 1))),
    fitMode: String(item?.fitMode || "contain").slice(0, 24),
    fileName: String(item?.fileName || "").slice(0, 200)
  })).filter((item) => item.kind);
}

function createDemoMeta() {
  return {
    id: DEMO_VIDEO_ID,
    switchId: "server-demo-switch",
    selectedAt: 1,
    version: 1,
    name: DEMO_VIDEO_NAME,
    sourceType: "server-demo",
    kind: "video",
    playUrl: "/api/demo/stream",
    type: "video/mp4",
    size: 0,
    duration: 0,
    chunkSize: 0,
    totalChunks: 0,
    ownerId: "server",
    ownerClientId: "server",
    ownerName: "同映",
    sourceOnline: true,
    sourceLastSeenAt: Date.now(),
    locked: true,
    loop: true,
    createdAt: Date.now()
  };
}

module.exports = function attachSocketHandlers(io, options = {}) {
  const rooms = new Map();
  const persistStores = options.persist !== false;
  const sensitiveFilter = options.sensitiveFilter || null;
  const chatStore = persistStores ? loadChatStore() : {};
  const playbackActivityStore = persistStores ? loadPlaybackActivityStore() : {};
  if (persistStores && Array.isArray(playbackActivityStore[DEMO_ROOM_ID])) {
    const previousLength = playbackActivityStore[DEMO_ROOM_ID].length;
    playbackActivityStore[DEMO_ROOM_ID] = playbackActivityStore[DEMO_ROOM_ID]
      .filter((item) => !["join", "leave"].includes(String(item?.kind || "")));
    if (playbackActivityStore[DEMO_ROOM_ID].length !== previousLength) {
      savePlaybackActivityStore(playbackActivityStore);
    }
  }
  let chatSaveTimer = null;
  let playbackActivitySaveTimer = null;
  const relayStoredHandlers = new Set();
  const emptyRoomResetMs = Number.isFinite(options.emptyRoomResetMs)
    ? Math.max(10, Number(options.emptyRoomResetMs))
    : EMPTY_ROOM_RESET_MS;

  const scheduleChatSave = () => {
    if (!persistStores) return;
    if (chatSaveTimer) clearTimeout(chatSaveTimer);
    chatSaveTimer = setTimeout(() => saveChatStore(chatStore), 120);
  };

  const schedulePlaybackActivitySave = () => {
    if (!persistStores) return;
    if (playbackActivitySaveTimer) clearTimeout(playbackActivitySaveTimer);
    playbackActivitySaveTimer = setTimeout(() => savePlaybackActivityStore(playbackActivityStore), 120);
  };

  const getRoom = (roomId = DEMO_ROOM_ID) => {
    const id = normalizeRoomId(roomId);
    if (!rooms.has(id)) rooms.set(id, createRoomState(id));
    return rooms.get(id);
  };

  const roomFromRequest = (req) => {
    const bodyRoom = req?.body && typeof req.body === "object" ? req.body.roomId : "";
    return getRoom(req?.query?.roomId || bodyRoom || DEMO_ROOM_ID);
  };

  function createRoomState(roomId) {
    const key = roomKey(roomId);
    const users = new Map();
    const socketsByClientId = new Map();
    const disconnectTimersByClientId = new Map();
    const relayChunks = new Map();
    const relayRequests = new Map();
    const relayWaiters = new Map();
    const relayWaiterTimers = new Map();
    const recentChatBySender = new Map();
    const chatHistory = sanitizeMessages(chatStore[roomId] || []);
    const playbackActivities = sanitizePlaybackActivities(playbackActivityStore[roomId] || []);
    const chatMessagesById = new Map(chatHistory.map((message) => [message.id, message]));
    chatStore[roomId] = chatHistory;
    playbackActivityStore[roomId] = playbackActivities;
    let relayCacheBytes = 0;
    let videoVersion = roomId === DEMO_ROOM_ID ? 1 : 0;
    let activeVideoMeta = roomId === DEMO_ROOM_ID ? createDemoMeta() : null;
    const playback = {
      hasVideo: roomId === DEMO_ROOM_ID,
      videoId: roomId === DEMO_ROOM_ID ? DEMO_VIDEO_ID : null,
      fileName: roomId === DEMO_ROOM_ID ? DEMO_VIDEO_NAME : "",
      duration: 0,
      paused: roomId === DEMO_ROOM_ID ? false : true,
      currentTime: 0,
      playbackRate: 1,
      fitMode: "contain",
      updatedAt: Date.now(),
      version: roomId === DEMO_ROOM_ID ? 1 : 0,
      reason: roomId === DEMO_ROOM_ID ? "server-demo" : "",
      actionId: "",
      sentAt: Date.now(),
      executeAt: 0,
      by: null
    };
    let lastPlaybackPulseAt = 0;
    let remoteControlLockUntil = 0;
    let watchBroadcastTimer = null;
    const recentPlaybackActions = new Map();
    const pendingSeekActions = new Map();
    let startupBarrier = null;
    let startupBarrierTimer = null;
    let emptyRoomCleanupTimer = null;

    const emit = (event, ...args) => io.to(key).emit(event, ...args);
    const containsSensitive = (value) => Boolean(sensitiveFilter?.contains(value));

    const isLockedRoom = () => roomId === DEMO_ROOM_ID;

    const isUserVisible = (user) =>
      Date.now() - (user.lastSeenAt || user.connectedAt || 0) < RECONNECT_GRACE_MS;

    const dedupeUserEntries = () => {
      const entries = Array.from(users, ([id, user]) => ({ id, user }))
        .filter(({ user }) => isUserVisible(user))
        .sort((left, right) => (right.user.lastSeenAt || 0) - (left.user.lastSeenAt || 0));
      const byClientId = new Map();
      for (const entry of entries) {
        const clientKey = entry.user.clientId || `socket:${entry.id}`;
        if (!byClientId.has(clientKey)) byClientId.set(clientKey, entry);
      }
      return Array.from(byClientId.values()).sort((left, right) => left.user.connectedAt - right.user.connectedAt);
    };

    const listUsers = () => dedupeUserEntries().map(({ id, user }) => publicUser(id, user, activeVideoMeta));
    const broadcastUsers = () => emit("users", listUsers());

    const findUserIdsByClientId = (clientId) => {
      const ids = [];
      for (const [id, user] of users) {
        if (user.clientId === clientId) ids.push(id);
      }
      return ids;
    };

    const clearDisconnectTimer = (clientId) => {
      const timer = disconnectTimersByClientId.get(clientId);
      if (!timer) return;
      clearTimeout(timer);
      disconnectTimersByClientId.delete(clientId);
    };

    const touchPresence = ({ clientId, name } = {}) => {
      const cleanClientId = String(clientId || "").slice(0, 80);
      if (!cleanClientId) return listUsers();
      const requestedName = normalizeName(name);
      const now = Date.now();
      const ids = findUserIdsByClientId(cleanClientId);
      const primaryId = ids[0] || `presence:${cleanClientId}`;
      const existing = users.get(primaryId);
      const displayName = containsSensitive(requestedName)
        ? existing?.name || normalizeName("")
        : requestedName;
      users.set(primaryId, {
        name: existing?.name || displayName,
        initial: existing?.initial || initialFromName(displayName),
        clientId: cleanClientId,
        speaking: existing?.speaking || false,
        watchState: existing?.watchState || null,
        connectedAt: existing?.connectedAt || now,
        lastSeenAt: now,
        presenceOnly: existing ? Boolean(existing.presenceOnly) : true
      });
      for (const id of ids.slice(1)) users.delete(id);
      scheduleEmptyRoomCleanup();
      broadcastUsers();
      return listUsers();
    };

    const publishChat = ({ from, name, text, messageId } = {}) => {
      const clean = String(text || "").trim().slice(0, 1000);
      if (!clean || containsSensitive(clean) || containsSensitive(name)) return null;
      const senderKey = String(from || "chat").slice(0, 80);
      const recent = recentChatBySender.get(senderKey);
      if (recent && recent.text === clean && Date.now() - recent.time < 1500) return recent.message;
      const cleanMessageId = String(messageId || "").trim().slice(0, 120);
      if (cleanMessageId && chatMessagesById.has(cleanMessageId)) return chatMessagesById.get(cleanMessageId);
      const message = {
        id: cleanMessageId || `${senderKey}-${Date.now()}`,
        from: senderKey,
        name: normalizeName(name),
        text: clean,
        time: Date.now()
      };
      recentChatBySender.set(senderKey, { text: clean, time: Date.now(), message });
      chatHistory.push(message);
      chatMessagesById.set(message.id, message);
      if (chatHistory.length > CHAT_HISTORY_LIMIT) {
        const removed = chatHistory.splice(0, chatHistory.length - CHAT_HISTORY_LIMIT);
        removed.forEach((item) => chatMessagesById.delete(item.id));
      }
      chatStore[roomId] = chatHistory;
      scheduleChatSave();
      emit("chat", message);
      return message;
    };

    const postChat = ({ clientId, name, text, messageId } = {}) => {
      const cleanClientId = String(clientId || "http-chat").slice(0, 80);
      if (containsSensitive(text) || containsSensitive(name)) return { ok: false, error: "sensitive" };
      if (cleanClientId && cleanClientId !== "http-chat") touchPresence({ clientId: cleanClientId, name });
      const message = publishChat({ from: cleanClientId, name, text, messageId });
      return { ok: Boolean(message), message };
    };

    const clearChatHistory = ({ clientId, name } = {}) => {
      const cleanClientId = String(clientId || "http-chat").slice(0, 80);
      if (cleanClientId && cleanClientId !== "http-chat") touchPresence({ clientId: cleanClientId, name });
      chatHistory.splice(0, chatHistory.length);
      chatMessagesById.clear();
      recentChatBySender.clear();
      chatStore[roomId] = chatHistory;
      if (chatSaveTimer) clearTimeout(chatSaveTimer);
      chatSaveTimer = null;
      if (persistStores) saveChatStore(chatStore);
      const event = { by: cleanClientId, name: normalizeName(name || "User"), time: Date.now() };
      emit("chat-cleared", event);
      return { ok: true, event };
    };

    const clearPlaybackActivities = ({ clientId, name } = {}) => {
      playbackActivities.splice(0, playbackActivities.length);
      playbackActivityStore[roomId] = playbackActivities;
      if (playbackActivitySaveTimer) clearTimeout(playbackActivitySaveTimer);
      playbackActivitySaveTimer = null;
      if (persistStores) savePlaybackActivityStore(playbackActivityStore);
      const event = {
        by: String(clientId || "").slice(0, 80),
        name: normalizeName(name || "User"),
        time: Date.now()
      };
      emit("playback-activity-cleared", event);
      return { ok: true, event };
    };

    const connectedRoomUsers = () => Array.from(users, ([socketId, user]) => ({ socketId, user }))
      .filter(({ socketId }) => io.sockets.sockets.has(socketId));

    const cancelEmptyRoomCleanup = () => {
      if (!emptyRoomCleanupTimer) return;
      clearTimeout(emptyRoomCleanupTimer);
      emptyRoomCleanupTimer = null;
    };

    const commandLeadMs = () => {
      const rtts = connectedRoomUsers()
        .map(({ user }) => Number(user.watchState?.clockRttMs || 0))
        .filter((value) => Number.isFinite(value) && value > 0 && value < 3000);
      const slowestRtt = rtts.length ? Math.max(...rtts) : 100;
      return Math.round(Math.min(MAX_COMMAND_LEAD_MS, Math.max(MIN_COMMAND_LEAD_MS, 280 + slowestRtt * 1.5)));
    };

    const barrierStatus = () => {
      if (!startupBarrier) return null;
      const members = connectedRoomUsers();
      const isReady = ({ user }) => {
        const watch = user.watchState;
        if (!watch || watch.videoId !== startupBarrier.videoId || watch.readyState < 3 || watch.waiting) return false;
        return watch.hasSource || watch.bufferedAhead >= STARTUP_BUFFER_SECONDS;
      };
      const ready = members.filter(isReady);
      const owner = members.find(({ socketId, user }) => (
        (activeVideoMeta?.ownerClientId && user.clientId === activeVideoMeta.ownerClientId) ||
        (activeVideoMeta?.ownerId && socketId === activeVideoMeta.ownerId)
      ));
      const ownerReady = owner ? isReady(owner) : false;
      return {
        pending: true,
        videoId: startupBarrier.videoId,
        ready: ready.length,
        total: members.length,
        ownerReady,
        deadlineAt: startupBarrier.deadlineAt
      };
    };

    const playbackSnapshot = () => {
      const now = Date.now();
      const snapshot = {
        ...playback,
        roomId,
        barrier: barrierStatus(),
        by: playback.by ? { ...playback.by } : null
      };
      if (activeVideoMeta?.live) {
        snapshot.currentTime = 0;
        snapshot.duration = 0;
      } else if (snapshot.hasVideo && !snapshot.paused && Number.isFinite(snapshot.currentTime)) {
        const timelineStart = Math.max(playback.updatedAt, Number(playback.executeAt || 0));
        const elapsed = Math.max(0, (now - timelineStart) / 1000);
        const rate = Number.isFinite(snapshot.playbackRate) ? snapshot.playbackRate : 1;
        snapshot.currentTime = Math.max(0, snapshot.currentTime + elapsed * rate);
        if (isLockedRoom() && Number(snapshot.duration) > 0) {
          snapshot.currentTime %= snapshot.duration;
        } else if (!activeVideoMeta?.live && Number(snapshot.duration) > 0 && snapshot.currentTime >= snapshot.duration) {
          snapshot.currentTime = snapshot.duration;
          snapshot.paused = true;
        }
      }
      snapshot.updatedAt = now;
      return snapshot;
    };

    const releaseStartupBarrier = (force = false) => {
      if (!startupBarrier || !activeVideoMeta || startupBarrier.videoId !== activeVideoMeta.id) return false;
      const status = barrierStatus();
      // A weak viewer must not hold the source owner and every ready viewer at
      // the startup line. Once the owner can play, other viewers catch up from
      // the authoritative timeline as their own buffers become ready.
      if (!force && status.total > 0 && !status.ownerReady) return false;
      const barrier = startupBarrier;
      startupBarrier = null;
      if (startupBarrierTimer) clearTimeout(startupBarrierTimer);
      startupBarrierTimer = null;
      playback.paused = Boolean(barrier.desiredPaused);
      playback.currentTime = 0;
      const now = Date.now();
      playback.executeAt = now + commandLeadMs();
      playback.updatedAt = now;
      playback.version += 1;
      playback.reason = "buffer-barrier-release";
      playback.actionId = `barrier-${activeVideoMeta.id}-${playback.version}`;
      playback.sentAt = Date.now();
      playback.by = { id: "server", clientId: "server", name: "Syncinema" };
      emit("playback", playbackSnapshot());
      return true;
    };

    const beginStartupBarrier = (videoId) => {
      if (startupBarrierTimer) clearTimeout(startupBarrierTimer);
      startupBarrier = {
        videoId,
        desiredPaused: false,
        deadlineAt: Date.now() + STARTUP_BARRIER_TIMEOUT_MS
      };
      startupBarrierTimer = setTimeout(() => releaseStartupBarrier(true), STARTUP_BARRIER_TIMEOUT_MS);
      startupBarrierTimer.unref?.();
    };

    const activeVideoSnapshot = () => {
      if (isLockedRoom()) {
        activeVideoMeta.sourceOnline = true;
        return { ...activeVideoMeta };
      }
      if (
        activeVideoMeta &&
        activeVideoMeta.sourceType !== "online" &&
        !hasCompleteRelaySource(activeVideoMeta.id, activeVideoMeta.totalChunks) &&
        !resolveOwnerSocketId() &&
        Date.now() - (activeVideoMeta.sourceLastSeenAt || 0) > SOURCE_HEARTBEAT_GRACE_MS
      ) {
        activeVideoMeta.sourceOnline = false;
      }
      return activeVideoMeta ? { ...activeVideoMeta } : null;
    };

    const rememberPlaybackAction = (actionId) => {
      if (!actionId) return false;
      const now = Date.now();
      for (const [id, time] of recentPlaybackActions) {
        if (now - time > 15000) recentPlaybackActions.delete(id);
      }
      if (recentPlaybackActions.has(actionId)) return true;
      recentPlaybackActions.set(actionId, now);
      return false;
    };

    const isOwnerActor = (actor = {}) =>
      Boolean(
        activeVideoMeta &&
          ((actor.clientId && activeVideoMeta.ownerClientId && actor.clientId === activeVideoMeta.ownerClientId) ||
            (actor.id && activeVideoMeta.ownerId && actor.id === activeVideoMeta.ownerId) ||
            (isLockedRoom() && actor.id))
      );

    const playbackActivityKind = (state, reason) => {
      if (!state.userIntent) return "";
      if (reason === "remote-replay-click") return "replay";
      if (["play", "play-click", "remote-play-click"].includes(reason)) return "play";
      if (["pause", "pause-click", "remote-pause-click"].includes(reason)) return "pause";
      if (["seek-release", "skip"].includes(reason)) return "seek";
      if (reason === "ratechange") return "rate";
      if (reason === "fitchange") return "fit";
      if (reason === "video-meta") return "source";
      if (reason === "user-join") return "join";
      if (reason === "user-leave") return "leave";
      return "";
    };

    const recordPlaybackActivity = (state, reason, actor) => {
      if (isLockedRoom() && ["user-join", "user-leave"].includes(reason)) return null;
      const kind = playbackActivityKind(state, reason);
      if (!kind) return null;
      const now = Date.now();
      const actorClientId = String(actor.clientId || actor.id || "");
      const previous = playbackActivities[playbackActivities.length - 1];
      if (previous && previous.kind === kind && previous.actorClientId === actorClientId && now - previous.time < 1200) {
        return null;
      }
      const activity = {
        id: String(state.actionId || `activity-${playback.version}-${now}`).slice(0, 120),
        kind,
        name: normalizeName(actor.name || playback.by?.name || "User"),
        actorClientId,
        time: now,
        currentTime: Math.max(0, Number(playback.currentTime || 0)),
        playbackRate: Number(playback.playbackRate || 1),
        fitMode: String(playback.fitMode || "contain"),
        fileName: String(playback.fileName || "").slice(0, 200)
      };
      playbackActivities.push(activity);
      if (playbackActivities.length > PLAYBACK_ACTIVITY_LIMIT) {
        playbackActivities.splice(0, playbackActivities.length - PLAYBACK_ACTIVITY_LIMIT);
      }
      playbackActivityStore[roomId] = playbackActivities;
      schedulePlaybackActivitySave();
      emit("playback-activity", activity);
      return activity;
    };

    const clearPendingSeekActions = () => {
      for (const pending of pendingSeekActions.values()) clearTimeout(pending.timer);
      pendingSeekActions.clear();
    };

    const applyPlayback = (state = {}, actor = {}, options = {}) => {
      if (!activeVideoMeta && (state.hasVideo || state.videoId)) return playbackSnapshot();
      if (activeVideoMeta && state.videoId && String(state.videoId) !== activeVideoMeta.id) return playbackSnapshot();
      const reason = String(state.reason || "");
      const isHeartbeat = reason === "heartbeat";
      const sentAt = Number(state.sentAt || 0);
      if (
        !isHeartbeat &&
        !state.userIntent &&
        sentAt > 0 &&
        Date.now() - sentAt > MAX_PLAYBACK_COMMAND_AGE_MS
      ) {
        return playbackSnapshot();
      }
      const actorOwnsSource = isOwnerActor(actor);
      if (options.coalesceSeek && reason === "seek-drag") return playbackSnapshot();
      if (
        options.coalesceSeek &&
        !options.coalescedSeek &&
        state.userIntent &&
        ["seek-release", "skip"].includes(reason)
      ) {
        const actorKey = String(actor.clientId || actor.id || "seek").slice(0, 120);
        const previousPending = pendingSeekActions.get(actorKey);
        if (previousPending) clearTimeout(previousPending.timer);
        if (!actorOwnsSource) remoteControlLockUntil = Date.now() + 4000;
        const timer = setTimeout(() => {
          pendingSeekActions.delete(actorKey);
          applyPlayback(state, actor, { ...options, coalescedSeek: true });
        }, reason === "skip" ? 160 : 70);
        timer.unref?.();
        pendingSeekActions.set(actorKey, { timer, reason });
        return playbackSnapshot();
      }
      if (
        startupBarrier &&
        state.userIntent &&
        ["play-click", "pause-click", "remote-play-click", "remote-pause-click"].includes(reason)
      ) {
        startupBarrier.desiredPaused = Boolean(state.paused);
        // Playing waits for the shared startup point, but pausing must freeze
        // the authoritative timeline immediately, even while members buffer.
        if (!state.paused) return playbackSnapshot();
      }
      if (isHeartbeat && !actorOwnsSource) return playbackSnapshot();
      if (isHeartbeat) {
        if (activeVideoMeta) {
          activeVideoMeta.sourceOnline = true;
          activeVideoMeta.sourceLastSeenAt = Date.now();
        }
        const snapshot = playbackSnapshot();
        if (options.broadcast !== false) {
          const now = Date.now();
          if (now - lastPlaybackPulseAt >= PLAYBACK_PULSE_INTERVAL_MS) {
            lastPlaybackPulseAt = now;
            emit("playback-pulse", snapshot);
          }
        }
        return snapshot;
      }
      const automaticOwnerReasons = new Set([
        "play",
        "pause",
        "seeking",
        "seeked",
        "ended",
        "metadata",
        "playing",
        "loadedmetadata",
        "durationchange"
      ]);
      if (
        actorOwnsSource &&
        !isHeartbeat &&
        Date.now() < remoteControlLockUntil &&
        (reason.startsWith("host-") || automaticOwnerReasons.has(reason))
      ) {
        return playbackSnapshot();
      }
      const explicitRemoteReasons = new Set([
        "remote-play-click",
        "remote-replay-click",
        "remote-pause-click",
        "seek-drag",
        "seek-release",
        "skip",
        "ratechange",
        "fitchange"
      ]);
      if (!actorOwnsSource && !isHeartbeat) {
        if (!state.userIntent || !explicitRemoteReasons.has(reason)) return playbackSnapshot();
        if (["remote-play-click", "remote-replay-click", "seek-drag", "seek-release", "skip"].includes(reason)) {
          // Seeking makes readyState drop and emits `waiting` even after metadata
          // is available. Only block controls before the guest knows the video.
          if (
            !activeVideoMeta?.live &&
            Number(state.duration || playback.duration || activeVideoMeta?.duration || 0) <= 0
          ) {
            return playbackSnapshot();
          }
        }
      }
      if (reason === "ratechange" && Number.isFinite(Number(state.playbackRate))) {
        const allowedRates = [0.5, 0.75, 1, 1.25, 1.5, 2];
        const incomingRate = allowedRates.reduce(
          (best, rate) => Math.abs(rate - Number(state.playbackRate)) < Math.abs(best - Number(state.playbackRate)) ? rate : best,
          1
        );
        if (incomingRate === playback.playbackRate) return playbackSnapshot();
      }
      if (
        reason === "fitchange" &&
        typeof state.fitMode === "string" &&
        state.fitMode === playback.fitMode
      ) {
        return playbackSnapshot();
      }
      if (!isHeartbeat && state.actionId && rememberPlaybackAction(String(state.actionId).slice(0, 120))) {
        return playbackSnapshot();
      }
      if (!actorOwnsSource && !isHeartbeat) remoteControlLockUntil = Date.now() + 4000;

      const previous = playbackSnapshot();
      playback.hasVideo = Boolean(state.hasVideo ?? playback.hasVideo);
      playback.videoId = state.videoId ?? playback.videoId;
      playback.fileName = state.fileName ?? playback.fileName;
      const incomingDuration = Number(state.duration);
      if (!activeVideoMeta?.live && Number.isFinite(incomingDuration) && incomingDuration > 0) {
        playback.duration = incomingDuration;
        if (activeVideoMeta) activeVideoMeta.duration = incomingDuration;
      }
      const scheduledIntent = !isHeartbeat && state.userIntent && SCHEDULED_PLAYBACK_REASONS.has(reason);
      const now = Date.now();
      let scheduledLead = 0;
      if (scheduledIntent) {
        const proposedLead = Number(state.requestedExecuteAt || 0) - now;
        scheduledLead = Number.isFinite(proposedLead) && proposedLead > 0
          ? Math.max(commandLeadMs(), Math.min(MAX_COMMAND_LEAD_MS, proposedLead))
          : commandLeadMs();
      }
      playback.paused = Boolean(state.paused);
      let incomingTime = activeVideoMeta?.live
        ? 0
        : Number.isFinite(state.currentTime)
          ? Math.max(0, state.currentTime)
          : playback.currentTime;
      if (["ratechange", "fitchange"].includes(reason)) {
        incomingTime = previous.currentTime;
      }
      if (
        scheduledIntent &&
        ["pause-click", "remote-pause-click"].includes(reason) &&
        !previous.paused
      ) {
        incomingTime = previous.currentTime + (scheduledLead / 1000) * previous.playbackRate;
      } else if (
        scheduledIntent &&
        ["play-click", "remote-play-click"].includes(reason)
      ) {
        incomingTime = previous.currentTime;
      }
      if (
        !isHeartbeat &&
        previous.currentTime > 2 &&
        incomingTime < 0.75 &&
        !["remote-replay-click", "seek-drag", "seek-release", "skip", "file", "metadata", "server-demo"].includes(reason)
      ) {
        incomingTime = previous.currentTime;
      }
      if (isLockedRoom() && Number(playback.duration) > 0) incomingTime %= playback.duration;
      if (!isLockedRoom() && !activeVideoMeta?.live && Number(playback.duration) > 0 && incomingTime >= playback.duration - 0.05) {
        incomingTime = playback.duration;
        playback.paused = true;
      }
      playback.currentTime = incomingTime;
      if (Number.isFinite(state.playbackRate)) {
        const allowedRates = [0.5, 0.75, 1, 1.25, 1.5, 2];
        playback.playbackRate = allowedRates.reduce(
          (best, rate) => Math.abs(rate - state.playbackRate) < Math.abs(best - state.playbackRate) ? rate : best,
          1
        );
      }
      if (typeof state.fitMode === "string") {
        playback.fitMode = ["contain", "ratio-16-9", "ratio-4-3", "fill"].includes(state.fitMode)
          ? state.fitMode
          : playback.fitMode;
      }
      playback.updatedAt = now;
      if (scheduledIntent) {
        playback.executeAt = now + scheduledLead;
      } else if (!isHeartbeat) {
        playback.executeAt = 0;
      }
      if (!isHeartbeat) {
        playback.version += 1;
        playback.reason = reason;
        playback.actionId = String(state.actionId || "").slice(0, 120);
        playback.sentAt = Number(state.sentAt || Date.now());
        playback.by = {
          id: actor.id || "http",
          clientId: actor.clientId || "",
          name: actor.name || "User"
        };
        recordPlaybackActivity(state, reason, playback.by);
      }
      if (actorOwnsSource && activeVideoMeta) {
        activeVideoMeta.sourceOnline = true;
        activeVideoMeta.sourceLastSeenAt = Date.now();
      }

      const snapshot = playbackSnapshot();
      if (options.broadcast !== false) emit("playback", snapshot);
      return snapshot;
    };

    const relayKey = (videoId, index) => `${videoId}:${index}`;

    const deleteRelayEntry = (key) => {
      const entry = relayChunks.get(key);
      if (!entry) return;
      relayCacheBytes -= entry.size || 0;
      relayChunks.delete(key);
    };

    const trimRelayCache = () => {
      if (relayCacheBytes <= MAX_RELAY_CACHE_BYTES) return;
      Array.from(relayChunks, ([key, entry]) => ({ key, entry }))
        .sort((a, b) => a.entry.lastAccessAt - b.entry.lastAccessAt)
        .forEach(({ key }) => {
          if (relayCacheBytes > MAX_RELAY_CACHE_BYTES) deleteRelayEntry(key);
        });
    };

    const cacheRelayChunk = (videoId, index, buffer) => {
      const key = relayKey(videoId, index);
      const old = relayChunks.get(key);
      if (old) relayCacheBytes -= old.size || 0;
      const payload = Buffer.from(buffer);
      relayChunks.set(key, {
        videoId,
        index,
        buffer: payload,
        size: payload.byteLength || payload.length || 0,
        cachedAt: old?.cachedAt || Date.now(),
        lastAccessAt: Date.now()
      });
      relayCacheBytes += payload.byteLength || payload.length || 0;
      relayRequests.delete(key);
      trimRelayCache();
      for (const handler of relayStoredHandlers) handler(roomId, videoId, index, payload);
    };

    const relayChunk = (videoId, index) => {
      const cleanIndex = Number(index);
      if (!Number.isInteger(cleanIndex)) return null;
      const entry = relayChunks.get(relayKey(String(videoId || ""), cleanIndex));
      if (!entry) return null;
      entry.lastAccessAt = Date.now();
      return entry.buffer;
    };

    const hasCompleteRelaySource = (videoId, totalChunks) => {
      const cleanVideoId = String(videoId || "");
      const total = Number(totalChunks || 0);
      if (!cleanVideoId || !Number.isInteger(total) || total <= 0) return false;
      for (let index = 0; index < total; index += 1) {
        if (!relayChunks.has(relayKey(cleanVideoId, index))) return false;
      }
      return true;
    };

    const resolveOwnerSocketId = () => {
      if (!activeVideoMeta || isLockedRoom()) return null;
      if (activeVideoMeta.ownerId && users.has(activeVideoMeta.ownerId) && io.sockets.sockets.has(activeVideoMeta.ownerId)) {
        return activeVideoMeta.ownerId;
      }
      const socketId = activeVideoMeta.ownerClientId ? socketsByClientId.get(activeVideoMeta.ownerClientId) : null;
      if (socketId && users.has(socketId) && io.sockets.sockets.has(socketId)) {
        activeVideoMeta.ownerId = socketId;
        return socketId;
      }
      return null;
    };

    const requestRelayChunk = ({ videoId, index, priority = 0 } = {}) => {
      const cleanVideoId = String(videoId || "");
      const cleanIndex = Number(index);
      if (!activeVideoMeta || activeVideoMeta.id !== cleanVideoId) return { ok: false };
      if (!Number.isInteger(cleanIndex) || cleanIndex < 0 || cleanIndex >= Number(activeVideoMeta.totalChunks || 0)) {
        return { ok: false };
      }
      const key = relayKey(cleanVideoId, cleanIndex);
      const cached = relayChunks.get(key);
      if (cached?.videoId === cleanVideoId) return { ok: true, cached: true };
      const existing = relayRequests.get(key);
      const cleanPriority = Number(priority || 0);
      relayRequests.set(key, {
        videoId: cleanVideoId,
        index: cleanIndex,
        requestedAt: cleanPriority > Number(existing?.priority || 0) ? Date.now() : existing?.requestedAt || Date.now(),
        priority: Math.max(cleanPriority, Number(existing?.priority || 0))
      });
      const ownerSocketId = resolveOwnerSocketId();
      if (ownerSocketId) {
        io.to(ownerSocketId).emit("server-chunk-request", {
          requesterId: "__http_stream__",
          videoId: cleanVideoId,
          index: cleanIndex,
          priority: cleanPriority
        });
      }
      return { ok: true, cached: false };
    };

    const requestRelayWindow = ({ videoId, currentTime, duration, index, ahead, behind } = {}) => {
      const cleanVideoId = String(videoId || "");
      if (!activeVideoMeta || activeVideoMeta.id !== cleanVideoId) return { ok: false, requested: 0 };
      const total = Number(activeVideoMeta.totalChunks || 0);
      const indexes = [];
      const seen = new Set();
      const add = (value) => {
        const cleanIndex = Number(value);
        if (!Number.isInteger(cleanIndex) || cleanIndex < 0 || cleanIndex >= total || seen.has(cleanIndex)) return;
        seen.add(cleanIndex);
        indexes.push(cleanIndex);
      };
      for (let offset = 0; offset < PRELOAD_HEAD_CHUNKS; offset += 1) add(offset);
      for (let offset = 0; offset < PRELOAD_TAIL_CHUNKS; offset += 1) add(total - 1 - offset);
      let center = Number(index);
      const cleanDuration = Number(duration || activeVideoMeta.duration || playback.duration || 0);
      const cleanTime = Number(currentTime || 0);
      if (!Number.isInteger(center) && Number.isFinite(cleanDuration) && cleanDuration > 0 && Number.isFinite(cleanTime)) {
        center = Math.floor((Math.max(0, cleanTime) / cleanDuration) * total);
      }
      if (Number.isInteger(center)) {
        const back = Math.max(0, Number.isFinite(behind) ? Number(behind) : PRELOAD_BEHIND_CHUNKS);
        const forward = Math.max(0, Number.isFinite(ahead) ? Number(ahead) : PRELOAD_AHEAD_CHUNKS);
        for (let offset = 0; offset <= forward; offset += 1) add(center + offset);
        for (let offset = 1; offset <= back; offset += 1) add(center - offset);
      }
      let requested = 0;
      for (const chunkIndex of indexes) {
        const result = requestRelayChunk({ videoId: cleanVideoId, index: chunkIndex });
        if (result.ok && !result.cached) requested += 1;
      }
      return { ok: true, requested, indexes };
    };

    const relayRequestList = (videoId, limit = 12) => {
      const cleanVideoId = String(videoId || "");
      if (!activeVideoMeta || activeVideoMeta.id !== cleanVideoId) return [];
      requestRelayWindow({
        videoId: cleanVideoId,
        currentTime: playbackSnapshot().currentTime,
        duration: activeVideoMeta.duration || playback.duration
      });
      const now = Date.now();
      const pending = [];
      for (const [key, request] of relayRequests) {
        const cached = relayChunks.get(key);
        if (cached?.videoId === cleanVideoId) {
          relayRequests.delete(key);
          continue;
        }
        if (now - request.requestedAt > 15000) {
          relayRequests.delete(key);
          continue;
        }
        pending.push(request);
      }
      pending.sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0) || a.requestedAt - b.requestedAt);
      return pending.slice(0, limit).map((request) => request.index);
    };

    const relayMissingList = (videoId, indexes = []) => {
      const cleanVideoId = String(videoId || "");
      if (!activeVideoMeta || activeVideoMeta.id !== cleanVideoId) return [];
      return (Array.isArray(indexes) ? indexes : [])
        .map(Number)
        .filter((index) => Number.isInteger(index) && index >= 0 && index < activeVideoMeta.totalChunks)
        .filter((index) => !relayChunks.has(relayKey(cleanVideoId, index)));
    };

    const relayDebugSnapshot = (videoId) => {
      const cleanVideoId = String(videoId || activeVideoMeta?.id || "");
      const cached = [];
      const requested = [];
      for (const entry of relayChunks.values()) if (entry.videoId === cleanVideoId) cached.push(entry.index);
      for (const request of relayRequests.values()) if (request.videoId === cleanVideoId) requested.push(request.index);
      cached.sort((a, b) => a - b);
      requested.sort((a, b) => a - b);
      return {
        roomId,
        videoId: cleanVideoId,
        cachedCount: cached.length,
        cachedSample: cached.slice(0, 80),
        requestedCount: requested.length,
        requestedSample: requested.slice(0, 80),
        cacheBytes: relayCacheBytes
      };
    };

    const storeRelayChunk = ({ videoId, index, buffer } = {}) => {
      const cleanVideoId = String(videoId || "");
      const cleanIndex = Number(index);
      if (!activeVideoMeta || activeVideoMeta.id !== cleanVideoId) return { ok: false };
      if (!Number.isInteger(cleanIndex) || cleanIndex < 0 || cleanIndex >= Number(activeVideoMeta.totalChunks || 0)) {
        return { ok: false };
      }
      if (!buffer || buffer.byteLength > Number(activeVideoMeta.chunkSize || 0) + 1024) return { ok: false };
      activeVideoMeta.sourceOnline = true;
      activeVideoMeta.sourceLastSeenAt = Date.now();
      cacheRelayChunk(cleanVideoId, cleanIndex, Buffer.from(buffer));
      if (hasCompleteRelaySource(cleanVideoId, activeVideoMeta.totalChunks)) {
        emit("source-ready", activeVideoMeta);
      }
      return { ok: true };
    };

    const clearRelay = () => {
      for (const timer of relayWaiterTimers.values()) clearTimeout(timer);
      relayWaiterTimers.clear();
      relayWaiters.clear();
      relayChunks.clear();
      relayRequests.clear();
      relayCacheBytes = 0;
    };

    const resetEmptyRoomPlayback = () => {
      if (isLockedRoom()) return false;
      if (connectedRoomUsers().length || dedupeUserEntries().length) return false;
      cancelEmptyRoomCleanup();
      if (startupBarrierTimer) clearTimeout(startupBarrierTimer);
      startupBarrierTimer = null;
      startupBarrier = null;
      clearRelay();
      clearPendingSeekActions();
      activeVideoMeta = null;
      videoVersion += 1;
      playback.hasVideo = false;
      playback.videoId = null;
      playback.fileName = "";
      playback.duration = 0;
      playback.paused = true;
      playback.currentTime = 0;
      playback.playbackRate = 1;
      playback.fitMode = "contain";
      playback.updatedAt = Date.now();
      playback.version += 1;
      playback.reason = "room-empty-reset";
      playback.actionId = "";
      playback.sentAt = playback.updatedAt;
      playback.executeAt = 0;
      playback.by = null;
      recentPlaybackActions.clear();
      remoteControlLockUntil = 0;
      return true;
    };

    const scheduleEmptyRoomCleanup = () => {
      if (isLockedRoom()) return;
      cancelEmptyRoomCleanup();
      emptyRoomCleanupTimer = setTimeout(() => {
        emptyRoomCleanupTimer = null;
        resetEmptyRoomPlayback();
      }, emptyRoomResetMs);
      emptyRoomCleanupTimer.unref?.();
    };

    const setActiveVideoMeta = (meta = {}, actor = {}) => {
      if (isLockedRoom()) return { ...activeVideoMeta };
      if (!meta.id) return null;
      const user = actor.socketId ? users.get(actor.socketId) : null;
      const ownerClientId = actor.clientId || user?.clientId || "";
      const ownerId = actor.socketId || (ownerClientId ? socketsByClientId.get(ownerClientId) : null) || actor.id || null;
      const ownerName = actor.name || user?.name || String(meta.ownerName || "Host").slice(0, 24);
      const incomingId = String(meta.id);
      const incomingSwitchId = String(meta.switchId || "");
      const isSameVideo = Boolean(
        activeVideoMeta &&
          activeVideoMeta.id === incomingId &&
          (!incomingSwitchId || activeVideoMeta.switchId === incomingSwitchId)
      );

      if (isSameVideo) {
        activeVideoMeta.ownerId = ownerId || activeVideoMeta.ownerId;
        activeVideoMeta.ownerClientId = ownerClientId || activeVideoMeta.ownerClientId;
        activeVideoMeta.ownerName = ownerName || activeVideoMeta.ownerName;
        activeVideoMeta.sourceOnline = true;
        activeVideoMeta.sourceLastSeenAt = Date.now();
        const duration = Number(meta.duration || 0);
        if (Number.isFinite(duration) && duration > 0) {
          activeVideoMeta.duration = Math.max(Number(activeVideoMeta.duration || 0), duration);
          playback.duration = Math.max(Number(playback.duration || 0), duration);
        }
        return { ...activeVideoMeta };
      }

      videoVersion += 1;
      activeVideoMeta = {
        id: incomingId,
        switchId: String(meta.switchId || `server-switch-${videoVersion}`),
        selectedAt: Number(meta.selectedAt || Date.now()),
        version: videoVersion,
        name: String(meta.name || "video").slice(0, 200),
        sourceType: String(meta.sourceType || "local").slice(0, 40),
        provider: String(meta.provider || "").slice(0, 40),
        live: Boolean(meta.live),
        kind: String(meta.kind || "").slice(0, 40),
        playUrl: String(meta.playUrl || "").slice(0, 4000),
        originalUrl: String(meta.originalUrl || "").slice(0, 4000),
        pageUrl: String(meta.pageUrl || "").slice(0, 4000),
        referer: String(meta.referer || "").slice(0, 1000),
        quality: Number(meta.quality || 0),
        lineCount: Math.min(6, Math.max(1, Number(meta.lineCount || 1))),
        qualities: Array.isArray(meta.qualities)
          ? meta.qualities.slice(0, 20).map((item) => ({
              value: String(item?.value ?? item?.quality ?? "").slice(0, 20),
              quality: Number(item?.quality || 0),
              label: String(item?.label || "").slice(0, 40),
              playUrl: String(item?.playUrl || "").slice(0, 4000)
            })).filter((item) => item.value && item.playUrl)
          : [],
        size: Number(meta.size || 0),
        type: String(meta.type || "video/mp4"),
        duration: Number(meta.duration || 0),
        chunkSize: Number(meta.chunkSize || 0),
        totalChunks: Number(meta.totalChunks || 0),
        ownerId,
        ownerClientId,
        ownerName,
        sourceOnline: true,
        sourceLastSeenAt: Date.now(),
        createdAt: Date.now()
      };
      clearRelay();
      clearPendingSeekActions();
      playback.hasVideo = true;
      playback.videoId = activeVideoMeta.id;
      playback.fileName = activeVideoMeta.name;
      playback.duration = activeVideoMeta.live ? 0 : activeVideoMeta.duration || 0;
      playback.currentTime = 0;
      playback.paused = true;
      playback.playbackRate = 1;
      playback.fitMode = "contain";
      playback.updatedAt = Date.now();
      playback.version += 1;
      playback.reason = "video-meta";
      playback.actionId = "";
      playback.sentAt = playback.updatedAt;
      playback.executeAt = 0;
      playback.by = { id: actor.id || ownerId || "video", clientId: ownerClientId, name: ownerName };
      recentPlaybackActions.clear();
      recordPlaybackActivity(
        { userIntent: true, actionId: `video-${activeVideoMeta.switchId}` },
        "video-meta",
        playback.by
      );
      beginStartupBarrier(activeVideoMeta.id);
      if (!connectedRoomUsers().length && !dedupeUserEntries().length) scheduleEmptyRoomCleanup();
      emit("video-meta", activeVideoMeta);
      emit("playback", playbackSnapshot());
      broadcastUsers();
      return { ...activeVideoMeta };
    };

    const markSourceReady = ({ videoId, clientId, name, socketId } = {}) => {
      const cleanVideoId = String(videoId || "");
      if (!activeVideoMeta || activeVideoMeta.id !== cleanVideoId) return null;
      if (isLockedRoom()) return { ...activeVideoMeta };
      const cleanClientId = String(clientId || "").slice(0, 80);
      const socketUser = socketId ? users.get(socketId) : null;
      if (socketId && users.has(socketId)) activeVideoMeta.ownerId = socketId;
      else if (cleanClientId) activeVideoMeta.ownerId = socketsByClientId.get(cleanClientId) || activeVideoMeta.ownerId;
      if (cleanClientId) activeVideoMeta.ownerClientId = cleanClientId;
      activeVideoMeta.ownerName = String(name || socketUser?.name || activeVideoMeta.ownerName || "Host").slice(0, 24);
      activeVideoMeta.sourceOnline = true;
      activeVideoMeta.sourceLastSeenAt = Date.now();
      emit("source-ready", activeVideoMeta);
      broadcastUsers();
      return { ...activeVideoMeta };
    };

    const handleJoin = (socket, { name, clientId } = {}) => {
      cancelEmptyRoomCleanup();
      const oldRoomId = socket.data.roomId;
      if (oldRoomId && oldRoomId !== roomId) getRoom(oldRoomId).removeSocket(socket, "switch-room");
      socket.join(key);
      socket.data.roomId = roomId;
      const requestedName = normalizeName(name);
      const rejectedName = containsSensitive(requestedName);
      const displayName = rejectedName ? normalizeName("") : requestedName;
      const cleanClientId = String(clientId || socket.id).slice(0, 80);
      clearDisconnectTimer(cleanClientId);
      const oldSocketIds = findUserIdsByClientId(cleanClientId).filter((id) => id !== socket.id);
      const oldUser = oldSocketIds.map((id) => users.get(id)).find(Boolean);
      for (const id of oldSocketIds) {
        const oldSocket = io.sockets.sockets.get(id);
        if (oldSocket && oldSocket.id !== socket.id) {
          oldSocket.data.replacedBy = socket.id;
          oldSocket.disconnect(true);
        }
        users.delete(id);
      }
      const user = {
        name: displayName,
        initial: initialFromName(displayName),
        clientId: cleanClientId,
        speaking: oldUser?.speaking || false,
        watchState: oldUser?.watchState || null,
        connectedAt: oldUser?.connectedAt || Date.now(),
        lastSeenAt: Date.now()
      };
      users.set(socket.id, user);
      socket.data.user = user;
      socketsByClientId.set(cleanClientId, socket.id);
      if (!oldUser || oldUser.presenceOnly) {
        recordPlaybackActivity(
          { userIntent: true, actionId: `presence-join-${cleanClientId}-${Date.now()}` },
          "user-join",
          { id: socket.id, clientId: cleanClientId, name: displayName }
        );
      }
      if (activeVideoMeta?.ownerClientId === cleanClientId && !isLockedRoom()) {
        activeVideoMeta.ownerId = socket.id;
        activeVideoMeta.sourceOnline = true;
        activeVideoMeta.sourceLastSeenAt = Date.now();
        emit("source-ready", activeVideoMeta);
      }
      const peers = dedupeUserEntries().map(({ id }) => id).filter((id) => id !== socket.id);
      socket.emit("joined", {
        id: socket.id,
        roomId,
        peers,
        users: listUsers(),
        playback: playbackSnapshot(),
        videoMeta: activeVideoMeta,
        chatHistory,
        playbackActivities: playbackActivities.slice()
      });
      if (rejectedName) socket.emit("sensitive-rejected", { field: "name" });
      socket.to(key).emit("user-joined", {
        ...publicUser(socket.id, user, activeVideoMeta),
        reconnected: Boolean(oldUser && !oldUser.presenceOnly)
      });
      broadcastUsers();
    };

    const removeSocket = (socket, reason = "disconnect") => {
      socket.leave(key);
      const user = users.get(socket.id);
      if (!user) return;
      const disconnectedAt = Date.now();
      const finalize = () => {
        if (socket.data.replacedBy) {
          users.delete(socket.id);
          return;
        }
        if (user.lastSeenAt && Date.now() - user.lastSeenAt < RECONNECT_GRACE_MS) {
          disconnectTimersByClientId.set(user.clientId, setTimeout(finalize, RECONNECT_GRACE_MS));
          return;
        }
        if (socketsByClientId.get(user.clientId) === socket.id) socketsByClientId.delete(user.clientId);
        users.delete(socket.id);
        const replacementSession = Array.from(users.entries()).some(([id, candidate]) =>
          id !== socket.id &&
          candidate.name === user.name &&
          Number(candidate.connectedAt || 0) >= disconnectedAt - 2000 &&
          Date.now() - Number(candidate.lastSeenAt || 0) < RECONNECT_GRACE_MS
        );
        if (
          !isLockedRoom() &&
          activeVideoMeta?.ownerId === socket.id &&
          activeVideoMeta.sourceType !== "online" &&
          !hasCompleteRelaySource(activeVideoMeta.id, activeVideoMeta.totalChunks)
        ) {
          activeVideoMeta.ownerId = null;
          activeVideoMeta.sourceOnline = false;
          emit("source-offline", activeVideoMeta);
        }
        if (!replacementSession) {
          recordPlaybackActivity(
            { userIntent: true, actionId: `presence-leave-${user.clientId}-${Date.now()}` },
            "user-leave",
            { id: socket.id, clientId: user.clientId, name: user.name }
          );
          emit("user-left", { id: socket.id, name: user.name, reason });
        }
        broadcastUsers();
        if (!connectedRoomUsers().length && !dedupeUserEntries().length) scheduleEmptyRoomCleanup();
      };
      clearDisconnectTimer(user.clientId);
      disconnectTimersByClientId.set(user.clientId, setTimeout(finalize, RECONNECT_GRACE_MS));
    };

    const handleSignal = (socket, { to, ...payload } = {}) => {
      if (!to || !users.has(socket.id) || !users.has(to)) return;
      io.to(to).emit("signal", { from: socket.id, ...payload });
    };

    const handleVoicePacket = (socket, { sampleRate, channels, seq, sentAt, targets } = {}, buffer) => {
      if (!users.has(socket.id)) return;
      if (!buffer || buffer.byteLength > 64 * 1024) return;
      const targetIds = Array.isArray(targets)
        ? targets.map((id) => String(id || "")).filter((id) => id && id !== socket.id && users.has(id)).slice(0, 32)
        : [];
      if (Array.isArray(targets) && targetIds.length === 0) return;
      const target = targetIds.length > 0 ? io.to(targetIds) : socket.to(key);
      target.emit(
        "voice-packet",
        {
          from: socket.id,
          sampleRate: Number(sampleRate) || 32000,
          channels: Number(channels) || 1,
          seq: Number(seq),
          sentAt: Number(sentAt) || Date.now(),
          relayedAt: Date.now()
        },
        buffer
      );
    };

    const handleWatchState = (socket, state = {}) => {
      const user = users.get(socket.id);
      if (!user) return;
      const previousWatchState = user.watchState;
      user.watchState = {
        videoId: state.videoId ? String(state.videoId) : null,
        currentTime: Number.isFinite(state.currentTime) ? Math.max(0, state.currentTime) : 0,
        bufferedAhead: Number.isFinite(state.bufferedAhead) ? Math.max(0, state.bufferedAhead) : 0,
        paused: Boolean(state.paused),
        waiting: Boolean(state.waiting),
        readyState: Number(state.readyState || 0),
        playbackRate: Number.isFinite(state.playbackRate) ? state.playbackRate : 1,
        fitMode: typeof state.fitMode === "string" ? state.fitMode : "contain",
        clockOffsetMs: Number(state.clockOffsetMs || 0),
        clockRttMs: Math.max(0, Number(state.clockRttMs || 0)),
        syncLeadMs: Math.max(0, Number(state.syncLeadMs || 0)),
        hasSource: Boolean(state.hasSource),
        lastCorrectionAt: Number(previousWatchState?.lastCorrectionAt || 0),
        updatedAt: Date.now()
      };
      if (startupBarrier?.videoId === user.watchState.videoId) releaseStartupBarrier(false);
      if (
        activeVideoMeta &&
        !activeVideoMeta.live &&
        user.watchState.videoId === activeVideoMeta.id &&
        Number.isFinite(state.duration) &&
        state.duration > 0
      ) {
        activeVideoMeta.duration = Math.max(activeVideoMeta.duration || 0, state.duration);
        playback.duration = activeVideoMeta.duration;
      }
      const authoritative = playbackSnapshot();
      if (authoritative.hasVideo && authoritative.videoId === user.watchState.videoId) {
        const drift = activeVideoMeta?.live
          ? 0
          : Math.abs(user.watchState.currentTime - authoritative.currentTime);
        const pausedMismatch = user.watchState.paused !== authoritative.paused;
        const rateMismatch = Math.abs(user.watchState.playbackRate - authoritative.playbackRate) > 0.01;
        const fitMismatch = user.watchState.fitMode !== authoritative.fitMode;
        const commandPending = Number(authoritative.executeAt || 0) > Date.now();
        const barrierPending = Boolean(authoritative.barrier?.pending);
        const canCorrectTime =
          !activeVideoMeta?.live &&
          !commandPending &&
          !barrierPending &&
          user.watchState.readyState >= 1 &&
          !user.watchState.waiting;
        const lastCorrectionAt = Number(user.watchState.lastCorrectionAt || 0);
        if (
          Date.now() - lastCorrectionAt >= SYNC_CORRECTION_INTERVAL_MS &&
          !commandPending &&
          !barrierPending &&
          (pausedMismatch || rateMismatch || fitMismatch || (canCorrectTime && drift > SYNC_IGNORE_DRIFT_SECONDS))
        ) {
          user.watchState.lastCorrectionAt = Date.now();
          const hardTimelineCorrection = Boolean(
            pausedMismatch ||
            (canCorrectTime && drift > SYNC_HARD_DRIFT_SECONDS) ||
            (authoritative.paused && canCorrectTime && drift > SYNC_IGNORE_DRIFT_SECONDS)
          );
          socket.emit("sync-correction", {
            ...authoritative,
            correctionMode: hardTimelineCorrection ? "hard" : "soft",
            correctionReason: pausedMismatch
              ? "play-state"
              : rateMismatch
                ? "playback-rate"
                : fitMismatch
                  ? "fit-mode"
                  : "timeline-drift"
          });
        }
      }
      if (!watchBroadcastTimer) {
        watchBroadcastTimer = setTimeout(() => {
          watchBroadcastTimer = null;
          broadcastUsers();
        }, 900);
      }
    };

    const handleServerChunkRequest = (socket, { videoId, index } = {}) => {
      const cleanVideoId = String(videoId || "");
      const cleanIndex = Number(index);
      if (!users.has(socket.id) || !activeVideoMeta || activeVideoMeta.id !== cleanVideoId) return;
      if (!Number.isInteger(cleanIndex) || cleanIndex < 0 || cleanIndex >= activeVideoMeta.totalChunks) return;
      if (relayChunk(cleanVideoId, cleanIndex)) return;
      const ownerSocketId = resolveOwnerSocketId();
      if (!ownerSocketId) return;
      const waitKey = relayKey(cleanVideoId, cleanIndex);
      const waiters = relayWaiters.get(waitKey);
      if (waiters) {
        waiters.add(socket.id);
        return;
      }
      relayWaiters.set(waitKey, new Set([socket.id]));
      relayWaiterTimers.set(
        waitKey,
        setTimeout(() => {
          relayWaiters.delete(waitKey);
          relayWaiterTimers.delete(waitKey);
        }, RELAY_REQUEST_TIMEOUT_MS)
      );
      io.to(ownerSocketId).emit("server-chunk-request", {
        requesterId: socket.id,
        videoId: cleanVideoId,
        index: cleanIndex
      });
    };

    const handleServerChunk = (socket, { videoId, index } = {}, buffer) => {
      const cleanVideoId = String(videoId || "");
      const cleanIndex = Number(index);
      const user = users.get(socket.id);
      if (!activeVideoMeta || activeVideoMeta.id !== cleanVideoId || !user) return;
      const isOwner = activeVideoMeta.ownerId === socket.id || activeVideoMeta.ownerClientId === user.clientId;
      if (!isOwner || !Number.isInteger(cleanIndex)) return;
      const result = storeRelayChunk({ videoId: cleanVideoId, index: cleanIndex, buffer });
      if (!result.ok) return;
      const waitKey = relayKey(cleanVideoId, cleanIndex);
      const timer = relayWaiterTimers.get(waitKey);
      if (timer) clearTimeout(timer);
      relayWaiterTimers.delete(waitKey);
      relayWaiters.delete(waitKey);
    };

    return {
      id: roomId,
      key,
      isLockedRoom,
      playbackSnapshot,
      activeVideoSnapshot,
      applyPlayback,
      setActiveVideoMeta,
      markSourceReady,
      touchPresence,
      postChat,
      clearChatHistory,
      clearPlaybackActivities,
      resetEmptyRoomPlayback,
      scheduleEmptyRoomCleanup,
      chatHistory: () => chatHistory.slice(),
      playbackActivities: () => playbackActivities.slice(),
      containsSensitive,
      requestRelayChunk,
      requestRelayWindow,
      relayRequestList,
      relayChunk,
      relayMissingList,
      relayDebugSnapshot,
      storeRelayChunk,
      handleJoin,
      removeSocket,
      handleSignal,
      handleVoicePacket,
      handleWatchState,
      handleServerChunkRequest,
      handleServerChunk,
      publishChat,
      broadcastUsers,
      users,
      socketsByClientId
    };
  }

  io.on("connection", (socket) => {
    socket.on("clock-sync", ({ clientSentAt } = {}, ack) => {
      const serverReceivedAt = Date.now();
      if (typeof ack !== "function") return;
      ack({
        clientSentAt: Number(clientSentAt || 0),
        serverReceivedAt,
        serverSentAt: Date.now()
      });
    });

    socket.on("join", ({ name, clientId, roomId } = {}) => {
      getRoom(roomId).handleJoin(socket, { name, clientId });
    });

    socket.on("signal", (payload = {}) => {
      getRoom(socket.data.roomId).handleSignal(socket, payload);
    });

    socket.on("voice-packet", (meta = {}, buffer) => {
      getRoom(socket.data.roomId).handleVoicePacket(socket, meta, buffer);
    });

    socket.on("chat", ({ text, messageId, name } = {}, ack) => {
      const state = getRoom(socket.data.roomId);
      const user = state.users.get(socket.id) || socket.data.user;
      if (state.containsSensitive(text) || state.containsSensitive(user?.name || name)) {
        if (typeof ack === "function") ack({ ok: false, error: "sensitive" });
        return;
      }
      const message = state.publishChat({
        from: socket.id,
        name: user?.name || name || "User",
        text,
        messageId
      });
      if (typeof ack === "function") ack({ ok: Boolean(message), message });
    });

    socket.on("chat-clear", ({ name } = {}, ack) => {
      const state = getRoom(socket.data.roomId);
      const user = state.users.get(socket.id) || socket.data.user;
      const result = state.clearChatHistory({
        clientId: user?.clientId || socket.id,
        name: user?.name || name || "User"
      });
      if (typeof ack === "function") ack(result);
    });

    socket.on("playback", (payload = {}) => {
      const state = getRoom(socket.data.roomId);
      const user = state.users.get(socket.id);
      if (!user) return;
      state.applyPlayback(
        payload,
        { id: socket.id, clientId: user.clientId, name: user.name, watchState: user.watchState },
        { coalesceSeek: true }
      );
    });

    socket.on("watch-state", (payload = {}) => {
      getRoom(socket.data.roomId).handleWatchState(socket, payload);
    });

    socket.on("video-meta", (meta = {}) => {
      const state = getRoom(socket.data.roomId);
      const user = state.users.get(socket.id) || socket.data.user || {
        name: String(meta.ownerName || "Host").slice(0, 24),
        clientId: String(meta.clientId || socket.id).slice(0, 80)
      };
      state.setActiveVideoMeta(meta, {
        id: socket.id,
        socketId: socket.id,
        clientId: String(meta.clientId || user.clientId || socket.id).slice(0, 80),
        name: user.name
      });
    });

    socket.on("source-ready", ({ videoId, clientId, name } = {}) => {
      const state = getRoom(socket.data.roomId);
      const user = state.users.get(socket.id) || socket.data.user || {
        name: String(name || "Host").slice(0, 24),
        clientId: String(clientId || socket.id).slice(0, 80)
      };
      state.markSourceReady({
        videoId,
        socketId: socket.id,
        clientId: String(clientId || user.clientId || socket.id).slice(0, 80),
        name: name || user.name
      });
    });

    socket.on("server-chunk-request", (payload = {}) => {
      getRoom(socket.data.roomId).handleServerChunkRequest(socket, payload);
    });

    socket.on("server-chunk", (meta = {}, buffer) => {
      getRoom(socket.data.roomId).handleServerChunk(socket, meta, buffer);
    });

    socket.on("speaking", ({ speaking } = {}) => {
      const state = getRoom(socket.data.roomId);
      const user = state.users.get(socket.id);
      if (!user) return;
      user.speaking = Boolean(speaking);
      socket.to(state.key).emit("speaking", { id: socket.id, speaking: user.speaking });
      state.broadcastUsers();
    });

    socket.on("disconnect", (reason) => {
      if (socket.data.roomId) getRoom(socket.data.roomId).removeSocket(socket, reason);
    });
  });

  return {
    normalizeRoomId,
    room: getRoom,
    roomFromRequest,
    playbackSnapshot(roomId) {
      return getRoom(roomId).playbackSnapshot();
    },
    activeVideoSnapshot(roomId) {
      return getRoom(roomId).activeVideoSnapshot();
    },
    onRelayChunkStored(handler) {
      relayStoredHandlers.add(handler);
      return () => relayStoredHandlers.delete(handler);
    }
  };
};
