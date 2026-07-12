import { createRoomSocket } from "./socket.js?v=20260711-stable-client-1";
import { PeerMesh } from "./webrtc.js?v=20260711-rtc-session-1";
import { VoiceManager } from "./voice.js?v=20260710-voice-status-1";
import { VideoUploader } from "./uploader.js?v=20260710-startup-buffer-2";
import { P2PDownloader } from "./downloader.js?v=20260711-room-range-1";
import { CinemaPlayer } from "./player.js?v=20260711-replay-1";
import { SyncController } from "./sync.js?v=20260711-lab-timeline-1";
import { UI } from "./ui.js?v=20260711-danmaku-default-on-1";
import { SourceManager } from "./source-manager.js?v=20260711-bilibili-1";
import { createId } from "./id.js";
import {
  pickVideoFileWithHandle,
  hasStoredLocalVideo,
  restoreLocalVideoFile,
  saveLocalVideoHandle,
  supportsFileHandles
} from "./local-file-store.js?v=20260711-auto-restore-1";

const ui = new UI();
const room = createRoomSocket();
ui.setNameValidator(async (name) => {
  const result = await room.checkSensitive(name, "name");
  return {
    allowed: Boolean(result.allowed),
    message: result.allowed ? "" : "昵称包含违禁词，请修改。"
  };
});
const mesh = new PeerMesh(room);
const voice = new VoiceManager(room, ui);
const player = new CinemaPlayer(ui);
const uploader = new VideoUploader(room, mesh, ui);
const downloader = new P2PDownloader(room, mesh, ui, ui.video);
const sourceManager = new SourceManager(ui, room);
const sync = new SyncController(room, player, () => shouldSendPlaybackHeartbeat(), () => ({
    bufferedAhead: measuredBufferedAhead(),
  hasSource: uploader.owns(player.meta?.id) || activeVideoMeta?.sourceType === "online"
}), (state) => applyIncomingPlayback(state), () => room.clientId());

const openSourceModal = async () => {
  await player.exitFullscreenForDialog();
  ui.openSourceModal();
};

const HOST_WAIT_BUFFER_SECONDS = 2;
const HOST_WAIT_MAX_MS = 8000;
const HOST_WAIT_COOLDOWN_MS = 5000;
const WATCH_STATE_FRESH_MS = 8000;
const REMOTE_CONTROL_REASONS = new Set([
  "remote-play-click",
  "remote-pause-click",
  "seek-release",
  "skip",
  "ratechange",
  "fitchange"
]);
const REMOTE_CONTROL_FRESH_MS = 8000;

let selfId = null;
let selfClientId = null;
let activeVideoMeta = null;
let currentName = "";
let currentRoomId = room.roomId();
let disconnectNoticeTimer = null;
let rejoinTimer = null;
let presenceTimer = null;
let latestUsers = [];
let autoPausedForPeers = false;
let autoResumeAfterPeerWait = false;
let hostPeerWaitVisible = false;
let hostPeerWaitStartedAt = 0;
let hostPeerWaitCooldownUntil = 0;
let pendingPlaybackState = null;
let sourceOfflineTimer = null;
let remoteBuffering = false;
let remoteCatchupTimer = null;
let voiceSignalLostAt = 0;
let chatSending = false;
let nativeFileInputOpening = false;
let restoringLocalSourceId = null;
let pendingPermissionRestore = null;
let permissionRestoreListenerInstalled = false;
let hostRemoteControlHoldUntil = 0;
let lastAppliedRemoteControlVersion = 0;
let onlineHeartbeatLeaderClientId = null;
let announcedRoomId = null;
const remoteAudioStates = new Map();

async function boot() {
  wireSocket();
  wireWebRTC();
  wireUI();
  sync.start();
  window.setInterval(() => announceLocalSource({ broadcast: false }), 2000);
  window.setInterval(() => pollAuthoritativeVideo(), 800);
  window.setInterval(() => updateVoiceConnectionStatus(), 1000);
  currentName = await ui.askName();
  currentRoomId = room.roomId();
  ui.setRoom(currentRoomId);
  selfClientId = await room.clientId().catch(() => null);
  startPresenceHeartbeat();
  if (room.raw.connected) {
    ui.setConnectionState("已连接", "ok");
    room.join(currentName, currentRoomId);
    announceLocalSource();
  }
}

function startPresenceHeartbeat() {
  if (presenceTimer) return;
  const sendPresence = async () => {
    if (!currentName) return;
    try {
      const clientId = await room.clientId();
      const response = await fetch("/api/presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, name: currentName })
      });
      if (!response.ok) return;
      const { users } = await response.json();
      if (Array.isArray(users)) ui.renderUsers(users, selfId);
    } catch {
      // Socket membership updates still run if HTTP presence misses a beat.
    }
  };
  presenceTimer = window.setInterval(sendPresence, 3000);
  sendPresence();
}

function wireSocket() {
  room.on("sensitive-rejected", ({ field } = {}) => {
    ui.addSystemMessage(field === "name" ? "昵称包含违禁词，服务器已使用临时昵称。" : "内容包含违禁词，未提交。");
  });
  room.on("connect", () => {
    window.clearTimeout(disconnectNoticeTimer);
    ui.setConnectionState("已连接", "ok");
    updateVoiceConnectionStatus();
    if (currentName) {
      room.join(currentName, currentRoomId);
      announceLocalSource();
    }
  });

  room.on("connect_error", () => {
    ui.setConnectionState("连接失败", "danger");
    updateVoiceConnectionStatus();
  });
  room.on("disconnect", () => {
    updateVoiceConnectionStatus();
    window.clearTimeout(disconnectNoticeTimer);
    disconnectNoticeTimer = window.setTimeout(() => {
      ui.setConnectionState("重连中", "warn");
      updateVoiceConnectionStatus();
    }, 1200);
  });
  room.on("reconnect", () => {
    window.clearTimeout(disconnectNoticeTimer);
    ui.setConnectionState("已重连", "ok");
    updateVoiceConnectionStatus();
    if (currentName) {
      room.join(currentName, currentRoomId);
      announceLocalSource();
    }
  });

  room.on("joined", async ({ id, peers, users, playback, videoMeta, chatHistory, playbackActivities, roomId }) => {
    const initialPlayback = playback?.hasVideo ? { ...playback, initialSync: true } : playback;
    selfId = id;
    currentRoomId = roomId || room.roomId();
    ui.setRoom(currentRoomId);
    if (isLockedDemoRoom() && voice.enabled) {
      voice.disable();
      await mesh.setLocalStream(null);
    }
    window.syncinemaSelfId = id;
    mesh.setSelfId(id);
    latestUsers = users || [];
    ui.renderUsers(users, selfId);
    updateVoicePeerTargets();
    mesh.ensureReceiveOnlyPeers(peers);
    await mesh.setLocalStream(voice.stream || null);
    ui.setMicControl({ enabled: voice.enabled });
    updateVoiceConnectionStatus();

    if (Array.isArray(chatHistory)) ui.renderMessages(chatHistory);
    if (Array.isArray(playbackActivities)) ui.renderPlaybackActivities(playbackActivities);
    if (announcedRoomId !== currentRoomId) {
      announcedRoomId = currentRoomId;
      ui.addSystemMessage(`已进入房间 ${currentRoomId}`);
    }

    if (videoMeta) {
      const alreadyLoadedVideo = player.meta?.id === videoMeta.id;
      activeVideoMeta = videoMeta;
      ui.setNowPlaying(videoMeta.name || "");
      if (uploader.owns(videoMeta.id)) {
        announceLocalSource();
      } else if (alreadyLoadedVideo) {
        if (videoMeta.sourceType !== "online" && videoMeta.sourceOnline !== false) downloader.markSourceOnline(videoMeta);
        if (initialPlayback?.hasVideo && initialPlayback.videoId === videoMeta.id) applyIncomingPlayback(initialPlayback);
      } else if (await shouldTryRestoreLocalSource(videoMeta)) {
        const restored = await tryRestoreLocalSource(videoMeta, initialPlayback);
        if (!restored) startRemoteVideo(videoMeta, { playback: initialPlayback });
      } else {
        startRemoteVideo(videoMeta, { playback: initialPlayback });
        if (videoMeta.sourceType === "online") {
          ui.addSystemMessage(`当前为网络点播：${videoMeta.name}`);
        } else if (videoMeta.sourceOnline === false) {
          scheduleSourceOffline(videoMeta);
        } else if (!isLockedDemoRoom()) {
          ui.addSystemMessage("如果你是原上传者，刷新后请选择同一个视频文件来恢复片源。");
        }
      }
    }

    if (initialPlayback?.hasVideo && !uploader.owns(initialPlayback.videoId)) {
      applyIncomingPlayback(initialPlayback);
    }
  });

  room.on("users", (users) => {
    latestUsers = users || [];
    ui.renderUsers(users, selfId);
    updateVoicePeerTargets();
    mesh.ensureReceiveOnlyPeers(latestUsers.map((item) => item.id));
    mesh.setLocalStream(voice.stream || null);
    ensureJoined(users);
  });
  room.on("user-joined", (user) => {
    if (!user?.id || user.id === selfId) return;
    latestUsers = latestUsers.some((item) => item.id === user.id) ? latestUsers : latestUsers.concat(user);
    updateVoicePeerTargets();
    mesh.ensureReceiveOnlyPeers(latestUsers.map((item) => item.id).concat(user.id));
    mesh.setLocalStream(voice.stream || null);
    updateVoiceConnectionStatus();
  });
  room.on("user-left", ({ id, name }) => {
    mesh.removePeer(id);
    voice.removeRemotePeer(id);
    latestUsers = latestUsers.filter((user) => user.id !== id);
    updateVoicePeerTargets();
    remoteAudioStates.delete(id);
    updateVoiceConnectionStatus();
  });
  room.on("signal", (payload) => mesh.handleSignal(payload));
  room.on("voice-packet", (meta, buffer) => {
    if (!meta?.from || meta.from === selfId) return;
    voice.handleVoicePacket(meta.from, meta, buffer).catch((error) => {
      console.warn("Voice packet playback failed", error);
    });
  });
  room.on("chat", (message) => {
    if (ui.addMessage(message)) ui.showDanmaku(message);
  });
  room.on("chat-cleared", (event) => {
    ui.renderMessages([]);
    ui.addSystemMessage(`${event?.name || "有人"} 清理了聊天记录`);
  });
  room.on("speaking", ({ id, speaking }) => ui.setSpeaking(id, speaking));
  room.on("playback", (state) => {
    rememberOnlinePlaybackLeader(state);
    sync.receive(state);
  });
  room.on("playback-activity", (activity) => ui.addPlaybackActivity(activity));
  room.on("playback-activity-cleared", () => ui.clearPlaybackActivities());
  room.on("playback-pulse", (state) => {
    rememberOnlinePlaybackLeader(state);
    if (!state?.hasVideo || player.hasLocalSource()) return;
    sync.receive(state);
  });
  room.on("sync-correction", (state) => sync.receiveCorrection(state));
  room.on("video-meta", async (meta) => {
    if (isStaleVideoMeta(meta)) return;
    if (activeVideoMeta?.switchId && meta.switchId === activeVideoMeta.switchId && player.meta?.id === meta.id) return;
    activeVideoMeta = meta;
    ui.setNowPlaying(meta.name || "");
    if (uploader.owns(meta.id)) return;
    if (await shouldTryRestoreLocalSource(meta)) {
      const playback = await fetchPlaybackSnapshot();
      if (await tryRestoreLocalSource(meta, playback)) return;
    }
    uploader.stopSharing(meta.id);
    pendingPlaybackState = null;
    startRemoteVideo(meta, { force: true });
    ui.addSystemMessage(`${meta.ownerName || "有人"} 正在共享 ${meta.name}`);
    await applyLatestPlaybackFor(meta.id);
  });
  room.on("source-ready", (meta) => {
    if (activeVideoMeta?.id && meta.id !== activeVideoMeta.id) return;
    if (isStaleVideoMeta(meta)) return;
    window.clearTimeout(sourceOfflineTimer);
    activeVideoMeta = meta;
    if (uploader.owns(meta.id)) return;
    downloader.markSourceOnline(meta);
  });
  room.on("source-offline", (meta) => {
    if (activeVideoMeta?.id && meta.id !== activeVideoMeta.id) return;
    if (isStaleVideoMeta(meta)) return;
    window.clearTimeout(sourceOfflineTimer);
    activeVideoMeta = meta;
    if (uploader.owns(meta.id)) return;
    scheduleSourceOffline(meta);
  });
  room.on("server-chunk-request", async (message) => {
    await uploader.handleServerRequest(message);
  });
  room.on("server-chunk", (payload, buffer) => {
    downloader.handleServerChunk(payload, buffer);
  });
  room.on("server-relay-status", (message) => {
    if (message.videoId !== activeVideoMeta?.id) return;
    ui.addSystemMessage(message.text || "服务器中转暂时不可用。");
  });

  if (room.raw.connected) ui.setConnectionState("已连接", "ok");
}

function announceLocalSource({ broadcast = true } = {}) {
  if (!uploader.meta?.id || !uploader.owns(uploader.meta.id)) return;
  if (Number.isFinite(ui.video.duration) && ui.video.duration > 0) {
    uploader.meta.duration = ui.video.duration;
  }
  uploader.kickHttpRelay();
  room.sendVideoMeta(uploader.meta);
  room.sendSourceReady(uploader.meta.id);
  if (broadcast) mesh.broadcastJSON({ kind: "source-ready", meta: uploader.meta });
}

function scheduleSourceOffline(meta) {
  window.clearTimeout(sourceOfflineTimer);
  sourceOfflineTimer = window.setTimeout(() => {
    if (activeVideoMeta?.id !== meta.id || activeVideoMeta.sourceOnline !== false) return;
    downloader.markSourceOffline(meta);
  }, 6000);
}

function isStaleVideoMeta(meta) {
  if (!meta?.id || !activeVideoMeta?.id) return false;
  const currentSelectedAt = Number(activeVideoMeta.selectedAt || 0);
  const incomingSelectedAt = Number(meta.selectedAt || 0);
  if (currentSelectedAt > 0 && incomingSelectedAt > 0 && incomingSelectedAt !== currentSelectedAt) {
    return incomingSelectedAt < currentSelectedAt;
  }
  if (meta.id !== activeVideoMeta.id) return false;
  const currentVersion = Number(activeVideoMeta.version || 0);
  const incomingVersion = Number(meta.version || 0);
  if (currentVersion > 0 && incomingVersion > 0 && incomingVersion < currentVersion) return true;
  return false;
}

function ensureJoined(users = []) {
  if (!currentName || !room.raw.connected || !selfId) return;
  if (users.some((user) => user.id === selfId)) return;
  if (rejoinTimer) return;

  rejoinTimer = window.setTimeout(() => {
    rejoinTimer = null;
    if (!currentName || !room.raw.connected) return;
    room.join(currentName, currentRoomId);
    announceLocalSource();
  }, 250);
}

function applyIncomingPlayback(state) {
  if (!state?.hasVideo) return;
  if (state.barrier?.pending) {
    ui.setSyncing(true, `等待成员缓冲 ${state.barrier.ready}/${state.barrier.total}`);
  }
  if (activeVideoMeta?.id && state.videoId && state.videoId !== activeVideoMeta.id) return;
  if (state.videoId && player.meta?.id !== state.videoId) {
    if (activeVideoMeta?.id === state.videoId && !uploader.owns(state.videoId)) {
      startRemoteVideo(activeVideoMeta, { playback: state });
    } else {
      pendingPlaybackState = state;
      return;
    }
  }

  if (player.hasLocalSource()) {
    const scheduledState =
      Boolean(state.scheduledExecution) ||
      Boolean(state.targetedCorrection) ||
      Number(state.executeAt || 0) > 0;
    if (!scheduledState && !isFreshRemoteControl(state)) return;
    if (Number.isFinite(state.version)) lastAppliedRemoteControlVersion = state.version;
    hostRemoteControlHoldUntil = Date.now() + 4000;
  }

  const targetTime = player.remoteTargetTime(state);
  if (Number.isFinite(targetTime) && activeVideoMeta?.sourceType !== "online") downloader.prioritizeTime(targetTime);
  player.applyRemote(state);
}

function isFreshRemoteControl(state) {
  if (!state || isSelfPlaybackState(state)) return false;
  const reason = String(state.reason || "");
  if (!REMOTE_CONTROL_REASONS.has(reason)) return false;
  const version = Number(state.version);
  if (Number.isFinite(version) && version > 0) return version > lastAppliedRemoteControlVersion;
  const updatedAt = Number(state.updatedAt || 0);
  return Number.isFinite(updatedAt) && updatedAt > 0;
}

function isSelfPlaybackState(state) {
  const by = state?.by || {};
  return Boolean(
    (selfClientId && by.clientId && by.clientId === selfClientId) ||
      (selfId && by.id && by.id === selfId)
  );
}

function startRemoteVideo(meta, options = {}) {
  if (!meta?.id) return;
  if (options.force || meta.sourceType === "online" || meta.sourceType === "server-demo") downloader.stop();
  player.setRemoteMeta(meta);
  if (meta.sourceType === "online" || meta.sourceType === "server-demo") {
    player.setOnlineSource(meta, { resetPlayback: true });
    if (pendingPlaybackState?.videoId === meta.id) {
      const state = pendingPlaybackState;
      pendingPlaybackState = null;
      window.setTimeout(() => applyIncomingPlayback(state), 0);
    }
    scheduleRemotePlaybackCatchup(meta.id);
    return;
  }
  const currentTime = options.currentTime ?? (options.playback ? player.remoteTargetTime(options.playback) : null);
  downloader.start(meta, {
    ...options,
    currentTime: Number.isFinite(currentTime) ? currentTime : 0
  });
  if (pendingPlaybackState?.videoId === meta.id) {
    const state = pendingPlaybackState;
    pendingPlaybackState = null;
    window.setTimeout(() => applyIncomingPlayback(state), 0);
  }
  scheduleRemotePlaybackCatchup(meta.id);
}

function scheduleRemotePlaybackCatchup(videoId) {
  [250, 900, 1800, 3200].forEach((delay) => {
    window.setTimeout(() => {
      if (player.meta?.id !== videoId || player.hasLocalSource()) return;
      applyLatestPlaybackFor(videoId);
    }, delay);
  });
}

async function applyLatestPlaybackFor(videoId) {
  const playback = await fetchPlaybackSnapshot();
  if (playback?.hasVideo && playback.videoId === videoId) {
    applyIncomingPlayback({
      ...playback,
      reason: "catchup",
      executeAt: 0,
      initialSync: false,
      scheduledExecution: false,
      targetedCorrection: false,
      correctionMode: "soft"
    });
  }
}

async function handleRemotePlaybackToggle(wantsPlaying) {
  if (!player.meta?.id || player.hasLocalSource()) return;
  if (wantsPlaying) {
    player.enableVideoSound();
    if (player.meta.live) player.followLiveEdge(true);
  }
  const playback = await fetchPlaybackSnapshot();
  if (!playback?.hasVideo || playback.videoId !== player.meta.id) return;

  const snapshotTime = player.remoteTargetTime(playback);
  const localTime = Number.isFinite(ui.video.currentTime) ? ui.video.currentTime : 0;
  const targetTime = Number.isFinite(snapshotTime) ? snapshotTime : Number(playback.currentTime || 0);
  const knownDuration = Number(ui.video.duration || player.meta?.duration || playback.duration || 0);
  const isLive = Boolean(player.meta?.live);
  if (!isLive && !(knownDuration > 0)) return;

  const replayFromEnd = Boolean(
    !isLive &&
    wantsPlaying &&
      (ui.video.ended || localTime >= knownDuration - 0.1 || Number(playback.currentTime || 0) >= knownDuration - 0.1)
  );
  const currentTime = isLive
    ? 0
    : replayFromEnd
    ? 0
    : Math.max(targetTime, localTime > 0.75 ? localTime : 0);
  const state = {
    ...playback,
    actionId: createId("action"),
    sentAt: Date.now(),
    reason: replayFromEnd ? "remote-replay-click" : wantsPlaying ? "remote-play-click" : "remote-pause-click",
    userIntent: true,
    paused: !wantsPlaying,
    currentTime,
    duration: isLive
      ? 0
      : Number.isFinite(ui.video.duration) && ui.video.duration > 0
      ? ui.video.duration
      : knownDuration,
    playbackRate: ui.video.playbackRate || playback.playbackRate || 1,
    fitMode: player.fitMode || playback.fitMode || "contain",
    readyState: ui.video.readyState,
    waiting: !ui.video.paused && ui.video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA,
    bufferedAhead: measuredBufferedAhead(),
    updatedAt: Date.now()
  };

  if (!isLive && Number.isFinite(currentTime)) downloader.prioritizeTime(currentTime);
  onlineHeartbeatLeaderClientId = selfClientId || (await room.clientId().catch(() => null));
  sync.send(state);
  mesh.broadcastJSON({
    kind: "playback-sync",
    state: {
      ...state,
      updatedAt: Date.now()
    }
  });
}

async function pollAuthoritativeVideo() {
  try {
    const response = await fetch(`/api/state?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return;
    const { videoMeta, playback } = await response.json();
    if (!videoMeta?.id) return;
    if (isStaleVideoMeta(videoMeta)) return;
    rememberOnlinePlaybackLeader(playback);
    if (activeVideoMeta?.id === videoMeta.id && player.meta?.id === videoMeta.id) {
      activeVideoMeta = { ...activeVideoMeta, ...videoMeta };
      ui.setNowPlaying(activeVideoMeta.name || "");
      if (uploader.owns(videoMeta.id)) {
        announceLocalSource({ broadcast: false });
        return;
      }
      if (
        playback?.hasVideo &&
        playback.videoId === videoMeta.id &&
        !isSelfPlaybackState(playback) &&
        sync.shouldReconcile(playback)
      ) {
        applyIncomingPlayback(playback);
      }
      return;
    }

    activeVideoMeta = videoMeta;
    ui.setNowPlaying(videoMeta.name || "");
    pendingPlaybackState = null;
    if (uploader.owns(videoMeta.id)) {
      announceLocalSource({ broadcast: false });
      return;
    }
    if (await shouldTryRestoreLocalSource(videoMeta)) {
      if (await tryRestoreLocalSource(videoMeta, playback)) return;
    }

    uploader.stopSharing(videoMeta.id);
    startRemoteVideo(videoMeta, { force: true, playback });
    if (playback?.hasVideo && playback.videoId === videoMeta.id) applyIncomingPlayback(playback);
  } catch {
    // Socket video-meta remains the primary path; polling is a recovery rail.
  }
}

function evaluateHostPeerWait() {
  // Buffering is always local. A slow member reports watch health so the
  // server can correct that member later, but never pauses another player.
  clearHostPeerWait();
}

function clearHostPeerWait() {
  if (hostPeerWaitVisible) {
    hostPeerWaitVisible = false;
    hostPeerWaitStartedAt = 0;
    ui.setSyncing(false);
  }
  if (!autoPausedForPeers) return;
  autoPausedForPeers = false;
  autoResumeAfterPeerWait = false;
}

function shouldSendPlaybackHeartbeat() {
  if (Date.now() < hostRemoteControlHoldUntil) return false;
  if (uploader.owns(player.meta?.id)) return true;
  if (!player.meta?.id || activeVideoMeta?.sourceType !== "online" || activeVideoMeta.id !== player.meta.id) return false;
  const leaderClientId = onlineHeartbeatLeaderClientId || activeVideoMeta.ownerClientId || "";
  if (!leaderClientId) return true;
  return Boolean(selfClientId && selfClientId === leaderClientId);
}

function rememberOnlinePlaybackLeader(state) {
  if (!state?.hasVideo || !state.videoId || !state.by?.clientId) return;
  if (state.reason === "heartbeat") return;
  if (activeVideoMeta?.sourceType !== "online" || activeVideoMeta.id !== state.videoId) return;
  onlineHeartbeatLeaderClientId = state.by.clientId;
}

function peersNeedingBuffer() {
  const now = Date.now();
  return latestUsers.filter((user) => {
    if (!user || user.id === selfId || user.online === false) return false;
    const watch = user.watchState;
    if (!watch || watch.videoId !== player.meta.id) return false;
    if (now - watch.updatedAt > WATCH_STATE_FRESH_MS) return false;
    if (watch.paused) return false;
    const ahead = Number(watch.bufferedAhead);
    return Boolean(watch.waiting) || (Number.isFinite(ahead) && ahead > 0 && ahead < HOST_WAIT_BUFFER_SECONDS);
  });
}

function updateVoiceConnectionStatus(summary = mesh.connectionSummary?.()) {
  if (!room.raw.connected) {
    if (!voiceSignalLostAt) voiceSignalLostAt = Date.now();
    const lostFor = Date.now() - voiceSignalLostAt;
    if (lostFor > 3500) {
      ui.setVoiceState("语音信令断开", "danger");
    } else if (!ui.state?.voiceText || ui.state.voiceTone === "danger") {
      ui.setVoiceState("语音信令恢复中", "warn");
    }
    return;
  }
  voiceSignalLostAt = 0;

  const peerTotal = Math.max(0, (latestUsers?.length || 1) - 1, Number(summary?.total || 0));
  const connected = Math.max(Number(summary?.connected || 0), voice.realtimePeerCount?.() || 0);
  const relayTargets = voice.relayTargetIds?.().length || 0;
  const now = Date.now();
  const playingAudio = Array.from(remoteAudioStates.values()).some((state) =>
    state.playing && (!state.relay || !state.receivedAt || now - state.receivedAt < 2500)
  );
  const relayAudio = Array.from(remoteAudioStates.values()).some((state) =>
    state.relay && state.playing && state.receivedAt && now - state.receivedAt < 2500
  );
  mesh.repairUnconnectedPeers?.((latestUsers || []).map((user) => user.id));

  if (!voice.enabled) {
    if (relayAudio) {
      ui.setVoiceState(`中继收听`, "ok");
    } else if (playingAudio && connected > 0) {
      ui.setVoiceState(`直连收听 ${connected}/${peerTotal}`, "ok");
    } else if (playingAudio) {
      ui.setVoiceState("正在收听", "ok");
    } else if (peerTotal > 0) {
      ui.setVoiceState(`等待语音`, "warn");
    } else {
      ui.setVoiceState("麦克风已关闭", "warn");
    }
    return;
  }

  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    ui.setVoiceState("语音需要 HTTPS", "danger");
    return;
  }

  if (peerTotal === 0) {
    ui.setVoiceState("语音已开启 · 等待他人", "ok");
    return;
  }

  if (relayAudio) {
    ui.setVoiceState(`中继语音 ${relayTargets || peerTotal}人`, "ok");
    return;
  }

  if (connected > 0) {
    ui.setVoiceState(playingAudio ? `直连语音 ${connected}/${peerTotal}` : `直连语音 ${connected}/${peerTotal} · 中继备用${relayTargets}`, "ok");
    return;
  }

  ui.setVoiceState(`中继语音${relayTargets ? ` ${relayTargets}人` : ""}`, "ok");
}
function wireWebRTC() {
  voice.addEventListener("local-speaking", (event) => {
    if (selfId) ui.setSpeaking(selfId, event.detail.speaking);
  });

  mesh.addEventListener("remote-stream", (event) => {
    voice.setRealtimePeer(event.detail.peerId, true);
    voice.attachRemoteStream(event.detail.peerId, event.detail.stream);
    updateVoiceConnectionStatus();
  });

  mesh.addEventListener("peer-state", (event) => {
    const peerId = event.detail?.peerId;
    const connected = event.detail?.state === "connected" || event.detail?.iceState === "connected" || event.detail?.iceState === "completed";
    if (peerId) voice.setRealtimePeer(peerId, connected);
    updateVoiceConnectionStatus(event.detail?.summary);
  });

  mesh.addEventListener("peer-open", (event) => {
    if (event.detail?.peerId) voice.setRealtimePeer(event.detail.peerId, true);
    if (uploader.meta) {
      mesh.broadcastJSON({ kind: "source-ready", meta: uploader.meta });
    }
    updateVoiceConnectionStatus();
  });

  mesh.addEventListener("peer-close", (event) => {
    const peerId = event.detail?.peerId;
    if (peerId) voice.removeRemotePeer(peerId);
    remoteAudioStates.delete(peerId);
    updateVoiceConnectionStatus();
  });

  voice.addEventListener("remote-audio-state", (event) => {
    if (event.detail?.peerId) remoteAudioStates.set(event.detail.peerId, event.detail);
    updateVoiceConnectionStatus();
  });

  player.addEventListener("local-sync", async (event) => {
    if (event.detail.reason === "heartbeat") return;
    if (activeVideoMeta?.sourceType === "online") {
      onlineHeartbeatLeaderClientId = selfClientId || (await room.clientId().catch(() => null));
      return;
    }
    const state = await protectPlaybackProgress(event.detail);
    mesh.broadcastJSON({
      kind: "playback-sync",
      state: {
        ...state,
        updatedAt: Date.now()
      }
    });
  });

  player.addEventListener("remote-play-toggle", (event) => {
    handleRemotePlaybackToggle(Boolean(event.detail?.wantsPlaying));
  });

  mesh.addEventListener("data-message", async (event) => {
    const { peerId, message } = event.detail;
    if (message.kind === "playback-sync") {
      // Socket.IO and the HTTP snapshot carry the authoritative, versioned
      // state. Direct peer messages can arrive late after buffering/reconnect.
      return;
    }
    if (message.kind === "video-meta") return;
    const servedByUploader = await uploader.handleRequest(peerId, message);
    if (!servedByUploader) downloader.handleDataMessage(peerId, message);
  });

  mesh.addEventListener("binary-message", (event) => {
    downloader.handleBinary(event.detail);
  });
}

function updateVoicePeerTargets() {
  voice.setExpectedRemotePeers((latestUsers || []).filter((user) => user.id !== selfId).map((user) => user.id));
}

function wireUI() {
  ui.nameForm?.addEventListener("submit", () => {
    player.primeVideoPlayback();
    voice.unlockPlayback();
  }, { capture: true });

  ["loadedmetadata", "durationchange"].forEach((eventName) => {
    ui.video.addEventListener(eventName, () => {
      publishLocalPlaybackFromVideo(`host-${eventName}`);
    });
  });

  if (ui.voiceVolume) {
    ui.voiceVolume.value = Math.round(voice.outputVolume * 100);
    ui.voiceVolume.addEventListener("input", () => {
      voice.setOutputVolume(Number(ui.voiceVolume.value) / 100);
      voice.unlockPlayback();
    });
  }

  if (ui.micVolume) {
    ui.micVolume.value = Math.round(voice.inputVolume * 100);
    ui.micVolume.addEventListener("input", () => {
      voice.setInputVolume(Number(ui.micVolume.value) / 100);
    });
  }

  ui.video.addEventListener("waiting", () => {
    if (!player.hasLocalSource()) remoteBuffering = true;
  });

  ["canplay", "playing"].forEach((eventName) => {
    ui.video.addEventListener(eventName, () => {
      if (!remoteBuffering || player.hasLocalSource() || !player.meta?.id) return;
      remoteBuffering = false;
      window.clearTimeout(remoteCatchupTimer);
        remoteCatchupTimer = window.setTimeout(() => applyLatestPlaybackFor(player.meta.id), 80);
    });
  });

  player.addEventListener("native-player-exit", () => {
    if (!player.meta?.id) return;
    window.clearTimeout(remoteCatchupTimer);
    remoteCatchupTimer = window.setTimeout(() => applyLatestPlaybackFor(player.meta.id), 120);
  });

  ui.video.addEventListener("playing", () => {
    if (!player.applyingRemote && player.hasLocalSource() && player.meta?.id) {
      sendCurrentPlayback(player.meta, "playing");
    }
  });

  ui.chooseVideoButton?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openLocalVideoPicker({ requestPermission: true });
  });

  document.addEventListener("click", (event) => {
    const pickerLabel = event.target.closest?.('label[for="fileInput"]');
    if (!pickerLabel) return;
    event.preventDefault();
    openLocalVideoPicker({ requestPermission: true });
  });

  ui.fileInput?.addEventListener("change", async (event) => {
    const [file] = event.target.files;
    if (!file) return;
    try {
      await handleSelectedVideo(file);
    } finally {
      event.target.value = "";
    }
  });

  ui.onlineSourceButton?.addEventListener("click", () => openSourceModal());
  ui.emptyOnlineSourceButton?.addEventListener("click", () => openSourceModal());
  ui.sourceClose?.addEventListener("click", () => ui.closeSourceModal());

  document.addEventListener("click", (event) => {
    if (event.target.closest?.("#danmakuToggleButton")) {
      ui.toggleDanmaku();
      return;
    }
    if (event.target.closest?.("#danmakuSettingsButton")) {
      ui.toggleDanmakuSettings();
      return;
    }
    const areaButton = event.target.closest?.("[data-danmaku-area]");
    if (areaButton) {
      ui.setDanmakuArea(areaButton.dataset.danmakuArea);
      return;
    }
    if (ui.state.danmakuSettingsVisible && !event.target.closest?.("#danmakuSettingsMenu")) {
      ui.state.danmakuSettingsVisible = false;
    }
  });

  ui.danmakuOpacity?.addEventListener("input", () => {
    ui.setDanmakuOpacity(Number(ui.danmakuOpacity.value) / 100);
  });

  ui.sourceImportForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      sourceManager.importKazumi(ui.sourceImportInput.value);
      ui.sourceImportInput.value = "";
    } catch (error) {
      ui.setSourceState({ status: error.message || "片源导入失败" });
    }
  });

  ui.sourceList?.addEventListener("click", (event) => {
    const deleteButton = event.target.closest("[data-source-delete]");
    if (deleteButton) {
      sourceManager.deleteSource(deleteButton.dataset.sourceDelete);
      return;
    }
    const button = event.target.closest("[data-source-id]");
    if (!button) return;
    sourceManager.selectSource(button.dataset.sourceId);
  });

  ui.sourceDirectForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const resolved = await sourceManager.resolveDirectUrl(ui.sourceDirectInput.value);
      ui.sourceDirectInput.value = "";
      if (resolved.provider === "bilibili" && !resolved.live && resolved.inspectOnly) return;
      await switchToOnlineSource(resolved);
      ui.closeSourceModal();
    } catch (error) {
      ui.addSystemMessage(error.message || "直链点播失败");
    }
  });

  ui.sourceSearchForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await sourceManager.search(ui.sourceSearchInput.value);
    } catch (error) {
      ui.addSystemMessage(error.message || "片源搜索失败");
    }
  });

  ui.sourceSearchResults?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-result-url]");
    if (!button) return;
    try {
      await sourceManager.loadChapters({
        name: button.dataset.resultName || button.textContent.trim(),
        url: button.dataset.resultUrl
      });
    } catch (error) {
      ui.addSystemMessage(error.message || "读取选集失败");
    }
  });

  ui.sourceRoads?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-source-road-id]");
    if (!button) return;
    sourceManager.selectChapterGroup(button.dataset.sourceRoadId);
  });

  ui.sourceChapters?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-chapter-url]");
    if (!button) return;
    try {
      const resolved = await sourceManager.resolveChapter({
        name: button.dataset.chapterName || button.textContent.trim(),
        url: button.dataset.chapterUrl
      });
      await switchToOnlineSource(resolved);
      ui.closeSourceModal();
    } catch (error) {
      ui.addSystemMessage(error.message || "点播失败");
    }
  });

  ui.sensitiveClose?.addEventListener("click", () => ui.closeSensitiveModal());
  ui.sensitiveAddCategory?.addEventListener("click", () => ui.addSensitiveCategory());
  ui.sensitiveCategoryList?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-delete-category]");
    if (!button) return;
    ui.removeSensitiveCategory(Number(button.dataset.deleteCategory));
  });
  ui.sensitiveModal?.addEventListener("click", (event) => {
    if (event.target === ui.sensitiveModal) ui.closeSensitiveModal();
  });
  ui.sensitiveForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (ui.state.sensitive.busy) return;
    ui.state.sensitive.busy = true;
    ui.state.sensitive.status = "";
    try {
      const categories = Array.from(ui.sensitiveCategoryList.querySelectorAll(".sensitive-category")).map((section) => ({
        id: section.dataset.categoryId,
        name: section.querySelector(".sensitive-category-name")?.value || "未命名分类",
        words: section.querySelector(".sensitive-category-words")?.value || ""
      }));
      const result = await room.saveSensitiveWords(
        ui.state.sensitive.password,
        categories
      );
      ui.state.sensitive.categories = result.categories;
      ui.state.sensitive.status = `已保存 ${result.categories.length} 个分类、${result.count} 个唯一违禁词，立即生效。`;
    } catch {
      ui.state.sensitive.status = "保存失败，管理员密码可能已变更。";
    } finally {
      ui.state.sensitive.busy = false;
    }
  });

  document.addEventListener("syncinema:rename-self", async () => {
    const nextName = await ui.requestRename(currentName);
    await renameSelf(nextName);
  });

  ui.chatInput.addEventListener("input", () => ui.updateCommandSuggestions(ui.chatInput.value));
  ui.chatInput.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" && ui.moveCommandSelection(1)) {
      event.preventDefault();
      return;
    }
    if (event.key === "ArrowUp" && ui.moveCommandSelection(-1)) {
      event.preventDefault();
      return;
    }
    if (["Tab", "Enter"].includes(event.key) && ui.state.commandMenuVisible && ui.selectActiveCommand()) {
      event.preventDefault();
      return;
    }
    if (event.key === "Escape") ui.closeCommandSuggestions();
  });
  ui.chatInput.addEventListener("blur", () => window.setTimeout(() => ui.closeCommandSuggestions(), 120));

  ui.chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    ui.closeCommandSuggestions();
    if (chatSending) return;
    const text = ui.chatInput.value.trim();
    if (!text) return;
    const messageId = room.createChatMessageId();
    const senderName = currentName || localStorage.getItem("pc:name") || "User";
    if (await handleChatCommand(text, senderName)) {
      ui.chatInput.value = "";
      return;
    }
    chatSending = true;
    window.syncinemaChatPriorityUntil = Date.now() + 2500;
    ui.chatInput.disabled = true;
    const submitButton = ui.chatForm.querySelector("button[type='submit']");
    if (submitButton) submitButton.disabled = true;
    try {
      const message = await room.sendChatHttp(text, senderName, messageId);
      ui.addMessage(message);
      ui.chatInput.value = "";
    } catch (error) {
      if (error?.message === "sensitive") {
        ui.addSystemMessage("消息包含违禁词，未发送。");
        return;
      }
      try {
        const message = await room.sendChat(text, messageId, senderName);
        ui.addMessage(message);
        ui.chatInput.value = "";
      } catch (fallbackError) {
        ui.addSystemMessage(
          fallbackError?.message === "sensitive"
            ? "消息包含违禁词，未发送。"
            : "消息发送失败，正在重连时请稍后再试。"
        );
      }
    } finally {
      chatSending = false;
      ui.chatInput.disabled = false;
      if (submitButton) submitButton.disabled = false;
      ui.chatInput.focus();
    }
  });

  ui.micToggleButton?.addEventListener("click", async () => {
    if (isLockedDemoRoom()) {
      if (voice.enabled) voice.disable();
      await mesh.setLocalStream(null);
      return;
    }
    ui.setMicControl({ enabled: voice.enabled, busy: true, text: "处理中" });
    try {
      const stream = await voice.toggle();
      await mesh.setLocalStream(voice.enabled ? stream : null);
      await voice.unlockPlayback();
    } catch {
      // VoiceManager has already shown the permission state.
    } finally {
      ui.setMicControl({ enabled: voice.enabled });
      updateVoiceConnectionStatus();
    }
  });

  ui.noiseToggleButton?.addEventListener("click", async () => {
    ui.setNoiseControl({ enabled: voice.noiseReductionEnabled, busy: true });
    try {
      const stream = await voice.toggleNoiseReduction();
      await mesh.setLocalStream(voice.enabled ? stream : null);
    } finally {
      ui.setNoiseControl({ enabled: voice.noiseReductionEnabled });
      updateVoiceConnectionStatus();
    }
  });

}

async function renameSelf(nextName) {
  const cleanName = String(nextName || "").trim().slice(0, 24);
  if (!cleanName || cleanName === currentName) return;
  try {
    const result = await room.checkSensitive(cleanName, "name");
    if (!result.allowed) {
      ui.addSystemMessage("昵称包含违禁词，未修改。");
      return;
    }
  } catch {
    ui.addSystemMessage("暂时无法验证昵称，请稍后重试。");
    return;
  }

  currentName = cleanName;
  localStorage.setItem("pc:name", cleanName);
  if (selfId) {
    latestUsers = latestUsers.map((user) =>
      user.id === selfId
        ? { ...user, name: cleanName, initial: Array.from(cleanName)[0]?.toUpperCase() || "P" }
        : user
    );
    ui.renderUsers(latestUsers, selfId);
  }

  if (room.raw.connected) {
    room.join(cleanName, currentRoomId);
    announceLocalSource();
  }
  ui.addSystemMessage(`已改名为 ${cleanName}`);
}

async function handleChatCommand(text, senderName) {
  if (!text.startsWith("/")) return false;
  const raw = text.trim();
  const command = raw.toLowerCase();
  if (["/clear", "/清理聊天记录", "/清屏", "/清理"].includes(command)) {
    try {
      await room.clearChat(senderName);
      ui.chatInput.value = "";
    } catch {
      ui.addSystemMessage("清理聊天记录失败，请稍后再试。");
    }
    return true;
  }

  if (command === "/clearactivity") {
    try {
      await room.clearPlaybackActivities(senderName);
      ui.chatInput.value = "";
      ui.closeCommandSuggestions();
    } catch {
      ui.addSystemMessage("清理操作记录失败，请稍后再试。");
    }
    return true;
  }

  if (command === "/sensitive" || command.startsWith("/sensitive ")) {
    const password = raw.slice("/sensitive".length).trim();
    if (!password) {
      ui.addSystemMessage("指令格式：/sensitive 管理员密码");
      return true;
    }
    try {
      const result = await room.loadSensitiveWords(password);
      ui.openSensitiveModal(result.categories, password);
    } catch (error) {
      ui.addSystemMessage(error?.message === "invalid-password" ? "管理员密码错误。" : "无法打开违禁词管理，请稍后重试。");
    }
    return true;
  }

  if (command === "/file") {
    if (isLockedDemoRoom()) return true;
    await openLocalVideoPicker({ requestPermission: true });
    return true;
  }

  if (["/vod", "/dianbo"].includes(command)) {
    if (isLockedDemoRoom()) return true;
    await openSourceModal();
    return true;
  }

  if (command.startsWith("/room")) {
    const nextRoom = raw.slice(5).trim();
    if (!nextRoom) {
      ui.addSystemMessage(`当前房间：${currentRoomId || room.roomId()}`);
      return true;
    }
    const cleanRoom = nextRoom.slice(0, 40) || "1";
    ui.addSystemMessage(`正在进入房间：${cleanRoom}`);
    room.switchRoom(cleanRoom);
    return true;
  }

  ui.addSystemMessage(`未知指令：${text}`);
  return true;
}

function isLockedDemoRoom() {
  return String(currentRoomId || room.roomId()) === "1";
}
async function openLocalVideoPicker() {
  if (supportsFileHandles()) {
    try {
      const picked = await pickVideoFileWithHandle();
      if (picked?.file) {
        await handleSelectedVideo(picked.file, { handle: picked.handle });
      }
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
      console.warn("File System Access picker failed, falling back", error);
    }
  }

  if (!ui.fileInput) return;
  nativeFileInputOpening = true;
  ui.fileInput.click();
  window.setTimeout(() => {
    nativeFileInputOpening = false;
  }, 0);
}

async function shouldTryRestoreLocalSource(meta) {
  if (isLockedDemoRoom() || meta?.sourceType === "server-demo") return false;
  if (!meta?.id || meta.sourceType === "online" || uploader.owns(meta.id)) return false;
  if (!selfClientId) {
    try {
      selfClientId = await room.clientId();
    } catch {
      selfClientId = null;
    }
  }
  const ownsServerSource = Boolean(
    (selfClientId && meta.ownerClientId && meta.ownerClientId === selfClientId) ||
      (selfId && meta.ownerId && meta.ownerId === selfId)
  );
  if (ownsServerSource) return true;
  return hasStoredLocalVideo(meta);
}

async function tryRestoreLocalSource(meta, playback = null) {
  if (!meta?.id || restoringLocalSourceId === meta.id) return false;
  restoringLocalSourceId = meta.id;
  try {
    const restored = await restoreLocalVideoFile(meta);
    if (restored?.file) {
      await handleSelectedVideo(restored.file, {
        handle: restored.handle,
        restoring: true
      });
      return true;
    }
    if (restored?.needsPermission) {
      schedulePermissionRestore(meta, playback);
      ui.addSystemMessage("浏览器需要确认本地文件权限，点击页面任意位置后会自动恢复片源。");
    } else {
      ui.addSystemMessage("没有可自动恢复的本地片源记录，请点“片源”选择同一个视频来恢复。");
    }
    if (playback?.hasVideo && playback.videoId === meta.id) pendingPlaybackState = playback;
    return false;
  } finally {
    restoringLocalSourceId = null;
  }
}

function schedulePermissionRestore(meta, playback) {
  pendingPermissionRestore = { meta, playback };
  if (permissionRestoreListenerInstalled) return;
  permissionRestoreListenerInstalled = true;

  const retry = async () => {
    document.removeEventListener("click", retry, true);
    document.removeEventListener("keydown", retry, true);
    permissionRestoreListenerInstalled = false;
    const pending = pendingPermissionRestore;
    pendingPermissionRestore = null;
    if (!pending?.meta?.id || player.meta?.id !== pending.meta.id) return;

    const restored = await restoreLocalVideoFile(pending.meta, { requestPermission: true });
    if (!restored?.file) return;
    await handleSelectedVideo(restored.file, {
      handle: restored.handle,
      restoring: true
    });
  };

  document.addEventListener("click", retry, { capture: true, once: true });
  document.addEventListener("keydown", retry, { capture: true, once: true });
}

async function handleSelectedVideo(file, options = {}) {
  if (isLockedDemoRoom()) return;
  player.clearSavedPositions();
  if (isSameActiveVideo(file, activeVideoMeta)) {
    const playback = await fetchPlaybackSnapshot();
    const meta = await uploader.resumeFile(file, activeVideoMeta);
    if (options.handle) await saveLocalVideoHandle(meta, options.handle);
    downloader.stop();
    player.setLocalFile(file, meta, { silent: true, skipSavedPosition: true });
    await waitForVideoMetadata();
    if (playback?.hasVideo && playback.videoId === meta.id) {
      await restoreLocalPlaybackFromRoom(playback);
    }
    ui.addSystemMessage(`已用本地文件恢复片源：${meta.name}`);
    return;
  }

  const isCurrentSourceOwner = await ownsActiveSource();
  if (activeVideoMeta?.id && activeVideoMeta.sourceOnline !== false && !isCurrentSourceOwner) {
    const replace = await ui.confirm({
      title: "切换全房间视频",
      message: `当前正在播放《${activeVideoMeta.name}》。确定要切换为《${file.name}》吗？`,
      okText: "确定切换",
      cancelText: "取消"
    });
    if (!replace) return;
  }

  const meta = await uploader.useFile(file);
  if (options.handle) await saveLocalVideoHandle(meta, options.handle);
  activeVideoMeta = meta;
  downloader.stop();
  player.setLocalFile(file, meta, { resetPlayback: true, silent: true });
  ui.video.pause();
  await resetVideoToStart();
  await waitForVideoMetadata();
  publishLocalPlaybackFromVideo("file-metadata-ready");
  ui.addSystemMessage(`开始共享 ${meta.name}`);
}

async function switchToOnlineSource(resolved) {
  if (isLockedDemoRoom()) {
    ui.addSystemMessage("1 号房是备案演示房，点播入口已关闭。输入 /room 其他房间名 后可使用点播。");
    return;
  }
  if (!resolved?.playUrl) throw new Error("没有可播放地址");
  if (activeVideoMeta?.id) {
    const replace = await ui.confirm({
      title: "切换全房间点播",
      message: `确定要切换为《${resolved.title || "网络点播"}》吗？`,
      okText: "确定切换",
      cancelText: "取消"
    });
    if (!replace) return;
  }

  const meta = {
    id: createId("online"),
    switchId: createId("switch"),
    selectedAt: Date.now(),
    sourceType: "online",
    provider: resolved.provider || "direct",
    live: Boolean(resolved.live),
    name: resolved.title || resolved.mediaUrl || "网络点播",
    type: resolved.kind === "hls"
      ? "application/vnd.apple.mpegurl"
      : resolved.kind === "flv" ? "video/x-flv" : "video/mp4",
    kind: resolved.kind,
    playUrl: resolved.playUrl,
    originalUrl: resolved.mediaUrl,
    pageUrl: resolved.pageUrl,
    referer: resolved.referer,
    quality: Number(resolved.quality || 0),
    lineCount: Math.min(6, Math.max(1, Number(resolved.lineCount || 1))),
    qualities: Array.isArray(resolved.qualities) ? resolved.qualities : [],
    duration: Number(resolved.duration || 0),
    size: 0,
    chunkSize: 0,
    totalChunks: 0,
    ownerName: localStorage.getItem("pc:name") || "点播"
  };

  activeVideoMeta = meta;
  onlineHeartbeatLeaderClientId = selfClientId || (await room.clientId().catch(() => null));
  uploader.stopSharing();
  downloader.stop();
  player.setOnlineSource(meta, { resetPlayback: true });
  room.sendVideoMeta(meta);
  ui.setTransfer(`网络点播：${meta.name}`, 100);
  ui.addSystemMessage(`开始点播 ${meta.name}`);

  ui.video.pause();
}

async function ownsActiveSource() {
  if (!activeVideoMeta?.id) return false;
  if (uploader.owns(activeVideoMeta.id)) return true;

  try {
    const clientId = await room.clientId();
    return Boolean(activeVideoMeta.ownerClientId && activeVideoMeta.ownerClientId === clientId);
  } catch {
    return false;
  }
}

async function fetchPlaybackSnapshot() {
  try {
    const response = await fetch(`/api/playback?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

async function protectPlaybackProgress(state) {
  if (!state?.hasVideo || !state.videoId) return state;
  if (["seek-drag", "seek-release", "skip", "file", "metadata"].includes(state.reason)) return state;
  if (Number(state.currentTime || 0) >= 0.75) return state;
  const playback = await fetchPlaybackSnapshot();
  if (!playback?.hasVideo || playback.videoId !== state.videoId) return state;
  if (Number(playback.currentTime || 0) <= 2) return state;
  return {
    ...state,
    currentTime: playback.currentTime,
    duration: state.duration || playback.duration || 0
  };
}

async function autoplayLocalVideo(meta, autoplayAttempt = null) {
  await resetVideoToStart();
  player.enableVideoSound();

  try {
    if (autoplayAttempt) {
      const result = await autoplayAttempt;
      if (result instanceof Error) throw result;
    }
    if (ui.video.paused) await playLocalVideoWhenReady();
  } catch {
    ui.addSystemMessage("浏览器阻止了自动播放，请手动点一次播放。");
  }

  sendCurrentPlayback(meta, "file-play");
  window.setTimeout(() => sendCurrentPlayback(meta, "file-play-confirm"), 350);
}

async function restoreLocalPlaybackFromRoom(playback) {
  if (!player.hasLocalSource() || !playback?.hasVideo) return;

  const targetTime = player.remoteTargetTime(playback);
  if (Number.isFinite(playback.playbackRate)) {
    ui.video.playbackRate = playback.playbackRate;
    if (ui.rateSelect) ui.rateSelect.value = String(playback.playbackRate);
  }
  if (playback.fitMode) {
    player.applyFitMode(playback.fitMode);
  }
  if (Number.isFinite(targetTime)) {
    try {
      ui.video.currentTime = Math.max(0, Math.min(targetTime, ui.video.duration || targetTime));
    } catch {
      // Local file seeking can fail briefly while metadata settles.
    }
  }
  if (playback.paused) {
    ui.video.pause();
    return;
  }
  player.enableVideoSound();
  await ui.video.play().catch(() => {
    ui.addSystemMessage("浏览器阻止了自动播放，请手动点一次播放。");
  });
}

function sendCurrentPlayback(meta, reason) {
  if (!meta?.id) return;
  sync.send({
    reason,
    hasVideo: true,
    videoId: meta.id,
    fileName: meta.name,
    paused: ui.video.paused,
    currentTime: ui.video.currentTime || 0,
    duration: Number.isFinite(ui.video.duration) && ui.video.duration > 0
      ? ui.video.duration
      : Number(player.meta?.duration || 0),
    playbackRate: ui.video.playbackRate || 1,
    fitMode: player.fitMode || "contain",
    readyState: ui.video.readyState,
    waiting: !ui.video.paused && ui.video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA,
    bufferedAhead: measuredBufferedAhead()
  });
}

function publishLocalPlaybackFromVideo(reason = "host-state") {
  if (player.applyingRemote) return;
  if (Date.now() < hostRemoteControlHoldUntil && String(reason).startsWith("host-")) return;
  if (!uploader.owns(player.meta?.id)) return;
  const meta = uploader.meta || player.meta;
  if (!meta?.id) return;

  if (Number.isFinite(ui.video.duration) && ui.video.duration > 0) {
    meta.duration = ui.video.duration;
    if (activeVideoMeta?.id === meta.id) activeVideoMeta.duration = ui.video.duration;
    room.sendVideoMeta(meta);
  }

  sendCurrentPlayback(meta, reason);
}

async function playLocalVideoWhenReady(timeout = 1800) {
  if (ui.video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
    await new Promise((resolve) => {
      const done = () => {
        window.clearTimeout(timer);
        ui.video.removeEventListener("canplay", done);
        ui.video.removeEventListener("loadeddata", done);
        resolve();
      };
      const timer = window.setTimeout(done, timeout);
      ui.video.addEventListener("canplay", done, { once: true });
      ui.video.addEventListener("loadeddata", done, { once: true });
    });
  }
  player.enableVideoSound();
  await ui.video.play();
}

async function resetVideoToStart() {
  await waitForVideoMetadata();

  try {
    ui.video.currentTime = 0;
  } catch {
    // Some mobile browsers reject early seeks until metadata is fully ready.
  }
}

async function waitForVideoMetadata(timeout = 1200) {
  if (ui.video.readyState < HTMLMediaElement.HAVE_METADATA) {
    await new Promise((resolve) => {
      const done = () => {
        window.clearTimeout(timer);
        ui.video.removeEventListener("loadedmetadata", done);
        resolve();
      };
      const timer = window.setTimeout(done, timeout);
      ui.video.addEventListener("loadedmetadata", done, { once: true });
    });
  }
}

function isSameActiveVideo(file, meta) {
  if (!file || !meta?.id) return false;
  return file.name === meta.name && file.size === meta.size;
}

function bufferedAhead(video) {
  const time = video.currentTime || 0;
  const ranges = video.buffered;
  for (let index = 0; index < ranges.length; index += 1) {
    if (ranges.start(index) <= time + 0.25 && ranges.end(index) >= time) {
      return ranges.end(index) - time;
    }
  }
  return 0;
}

function measuredBufferedAhead() {
  const downloaderAhead = downloader.bufferedAhead?.();
  if (Number.isFinite(downloaderAhead) && downloaderAhead >= 0) return downloaderAhead;
  return bufferedAhead(ui.video);
}

boot();
