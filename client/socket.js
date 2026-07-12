import { createId } from "./id.js";
import { io } from "socket.io-client";

const CLIENT_ID_KEY = "pc:client-id";
const DEVICE_CLIENT_ID_KEY = "pc:device-client-id";
const CLIENT_ID_CHANNEL = "pc-client-id";
const ROOM_ID_KEY = "pc:room-id";

function normalizeRoomId(roomId) {
  const clean = String(roomId || "1").trim().slice(0, 40);
  return clean || "1";
}

function readInitialRoomId() {
  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = normalizeRoomId(params.get("room") || "");
    if (fromUrl && params.has("room")) {
      localStorage.setItem(ROOM_ID_KEY, fromUrl);
      return fromUrl;
    }
    return normalizeRoomId(localStorage.getItem(ROOM_ID_KEY) || "1");
  } catch {
    return "1";
  }
}

function saveClientId(clientId) {
  try {
    sessionStorage.setItem(CLIENT_ID_KEY, clientId);
  } catch {
    // Session storage can be unavailable in hardened browsers.
  }
}

function storedClientId() {
  try {
    const existing = sessionStorage.getItem(CLIENT_ID_KEY);
    if (existing) {
      if (!localStorage.getItem(DEVICE_CLIENT_ID_KEY)) localStorage.setItem(DEVICE_CLIENT_ID_KEY, existing);
      return existing;
    }

    const clientId = localStorage.getItem(DEVICE_CLIENT_ID_KEY) || createId("client");
    localStorage.setItem(DEVICE_CLIENT_ID_KEY, clientId);
    saveClientId(clientId);
    return clientId;
  } catch {
    return createId("client");
  }
}

function uniqueClientIdentity(initialClientId) {
  if (!("BroadcastChannel" in window)) {
    return {
      get id() {
        return initialClientId;
      },
      ready: Promise.resolve(initialClientId)
    };
  }

  const pageId = createId("page");
  const channel = new BroadcastChannel(CLIENT_ID_CHANNEL);
  let clientId = initialClientId;
  let settled = false;

  channel.onmessage = (event) => {
    const message = event.data || {};
    if (message.pageId === pageId) return;

    if (message.type === "hello" && message.clientId === clientId) {
      channel.postMessage({ type: "collision", clientId, to: message.pageId, pageId });
      return;
    }

    if (!settled && message.type === "collision" && message.to === pageId && message.clientId === clientId) {
      clientId = createId("client");
      saveClientId(clientId);
    }
  };

  const ready = new Promise((resolve) => {
    channel.postMessage({ type: "hello", clientId, pageId });
    window.setTimeout(() => {
      settled = true;
      channel.postMessage({ type: "hello", clientId, pageId });
      resolve(clientId);
    }, 180);
  });

  return {
    get id() {
      return clientId;
    },
    ready
  };
}

export function createRoomSocket() {
  const identity = uniqueClientIdentity(storedClientId());
  let currentRoomId = readInitialRoomId();

  const appendRoomId = (input) => {
    if (typeof input !== "string" || !input.startsWith("/api/")) return input;
    if (
      input.startsWith("/api/ice") ||
      input.startsWith("/api/speed/") ||
      input.startsWith("/api/source/")
    ) {
      return input;
    }
    const url = new URL(input, window.location.origin);
    if (!url.searchParams.has("roomId")) url.searchParams.set("roomId", currentRoomId);
    return `${url.pathname}${url.search}${url.hash}`;
  };

  if (!window.__syncinemaRoomFetchPatched) {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => nativeFetch(appendRoomId(input), init);
    window.__syncinemaRoomFetchPatched = true;
  }

  const socket = io({
    transports: ["websocket"],
    upgrade: false,
    rememberUpgrade: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 700,
    reconnectionDelayMax: 5000,
    timeout: 10000
  });

  return {
    raw: socket,
    roomId() {
      return currentRoomId;
    },
    setRoomId(roomId) {
      currentRoomId = normalizeRoomId(roomId);
      localStorage.setItem(ROOM_ID_KEY, currentRoomId);
      return currentRoomId;
    },
    switchRoom(roomId) {
      const next = this.setRoomId(roomId);
      const url = new URL(window.location.href);
      url.searchParams.set("room", next);
      window.location.href = url.toString();
    },
    async join(name, roomId = currentRoomId) {
      await identity.ready;
      currentRoomId = normalizeRoomId(roomId);
      localStorage.setItem(ROOM_ID_KEY, currentRoomId);
      socket.emit("join", { name, clientId: identity.id, roomId: currentRoomId });
    },
    async clientId() {
      await identity.ready;
      return identity.id;
    },
    measureClock(clientSentAt = Date.now()) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error("clock-sync-timeout"));
        }, 1500);
        socket.emit("clock-sync", { clientSentAt }, (response = {}) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          if (!Number.isFinite(response.serverReceivedAt) || !Number.isFinite(response.serverSentAt)) {
            reject(new Error("clock-sync-invalid"));
            return;
          }
          resolve(response);
        });
      });
    },
    sendSignal(to, payload) {
      socket.emit("signal", { to, ...payload });
    },
    createChatMessageId() {
      return createId("chat");
    },
    sendChat(text, messageId = createId("chat"), name = localStorage.getItem("pc:name") || "User") {
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error("chat-timeout"));
        }, 700);

      socket.emit("chat", { text, messageId, name, roomId: currentRoomId }, (response = {}) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          if (response.ok) resolve(response.message);
          else reject(new Error(response.error || "chat-rejected"));
        });
      });
    },
    async sendChatHttp(text, name, messageId = createId("chat")) {
      const clientId = await identity.ready;
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, clientId, name, messageId, roomId: currentRoomId })
      });
      if (!response.ok) throw new Error("chat-http-failed");
      const result = await response.json();
      if (!result.ok) throw new Error(result.error || "chat-http-rejected");
      return result.message;
    },
    async checkSensitive(value, field = "chat") {
      const response = await fetch("/api/sensitive/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value, field })
      });
      if (!response.ok) throw new Error("sensitive-check-failed");
      return response.json();
    },
    async loadSensitiveWords(password) {
      const response = await fetch("/api/sensitive/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "load", password })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || "sensitive-admin-failed");
      return result;
    },
    async saveSensitiveWords(password, categories) {
      const response = await fetch("/api/sensitive/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", password, categories })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || "sensitive-admin-failed");
      return result;
    },
    async clearChat(name) {
      const clientId = await identity.ready;
      const response = await fetch("/api/chat/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, name, roomId: currentRoomId })
      });
      if (!response.ok) throw new Error("chat-clear-failed");
      const result = await response.json();
      if (!result.ok) throw new Error("chat-clear-rejected");
      return result.event;
    },
    async clearPlaybackActivities(name) {
      const clientId = await identity.ready;
      const response = await fetch("/api/playback-activity/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, name, roomId: currentRoomId })
      });
      if (!response.ok) throw new Error("playback-activity-clear-failed");
      const result = await response.json();
      if (!result.ok) throw new Error("playback-activity-clear-rejected");
      return result.event;
    },
    sendPlayback(state) {
      socket.emit("playback", { ...state, roomId: currentRoomId });
    },
    sendWatchState(state) {
      socket.emit("watch-state", { ...state, roomId: currentRoomId });
    },
    sendVideoMeta(meta) {
      identity.ready
        .then((clientId) => {
          const payload = {
            ...meta,
            clientId,
            roomId: currentRoomId,
            ownerName: localStorage.getItem("pc:name") || meta.ownerName || "Host"
          };
          socket.emit("video-meta", payload);
          return (
          fetch("/api/video", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          })
          );
        })
        .catch(() => {});
    },
    sendSourceReady(videoId) {
      identity.ready
        .then((clientId) => {
          const payload = {
            videoId,
            clientId,
            roomId: currentRoomId,
            name: localStorage.getItem("pc:name") || "Host"
          };
          socket.emit("source-ready", payload);
          return (
          fetch("/api/source-ready", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            keepalive: true
          })
          );
        })
        .catch(() => {});
    },
    requestServerChunk(videoId, index) {
      socket.emit("server-chunk-request", { videoId, index, roomId: currentRoomId });
    },
    sendServerChunk(requesterId, videoId, index, buffer) {
      socket.emit("server-chunk", { requesterId, videoId, index, roomId: currentRoomId }, buffer);
    },
    sendSpeaking(speaking) {
      socket.emit("speaking", { speaking });
    },
    sendVoicePacket(meta, buffer) {
      socket.emit("voice-packet", meta, buffer);
    },
    on(event, handler) {
      socket.on(event, handler);
    }
  };
}
