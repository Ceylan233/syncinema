import { createId } from "./id.js";
import { ServerClock } from "./clock-sync.js";

export class SyncController {
  constructor(
    roomSocket,
    player,
    canSendHeartbeat = () => false,
    getWatchState = () => ({}),
    applyRemote = null,
    getClientId = null
  ) {
    this.socket = roomSocket;
    this.player = player;
    this.canSendHeartbeat = canSendHeartbeat;
    this.getWatchState = getWatchState;
    this.applyRemote = applyRemote || ((state) => this.player.applyRemote(state));
    this.getClientId = getClientId;
    this.lastSentAt = 0;
    this.lastHttpSentAt = 0;
    this.lastSeenVersion = 0;
    this.clientId = null;
    this.pending = null;
    this.flushTimer = null;
    this.lastRoomActionAt = 0;
    this.lastReconcileAt = 0;
    this.httpInFlight = new Map();
    this.clock = new ServerClock(roomSocket);
    this.scheduledTimer = null;
    this.scheduledState = null;
    this.lastOwnActionId = "";
    this.lastAppliedVersion = 0;
  }

  start() {
    this.player.addEventListener("local-sync", (event) => this.send(event.detail));
    ["play", "pause", "seeked", "waiting", "canplay"].forEach((eventName) => {
      this.player.video.addEventListener(eventName, () => this.sendWatchState());
    });
    window.setInterval(() => this.sendWatchState(), 700);
    window.setInterval(() => this.sendPlaybackHeartbeat(), 1000);
    this.resolveClientId();
    window.setInterval(() => this.pollPlayback(), 1200);
    this.clock.start();
  }

  send(state) {
    const roomState = {
      ...state,
      actionId: state.actionId || createId("action"),
      sentAt: Date.now()
    };
    const isHeartbeat = roomState.reason === "heartbeat";
    if (!isHeartbeat) {
      this.lastOwnActionId = roomState.actionId;
      if (roomState.userIntent && !Number.isFinite(roomState.requestedExecuteAt)) {
        roomState.requestedExecuteAt = this.clock.serverNow() + this.clock.suggestedLeadMs();
      }
      this.lastRoomActionAt = Date.now();
      this.sendHttpPlayback(roomState, { urgent: true });
    }
    this.pending = roomState;
    const now = Date.now();
    const wait = isHeartbeat ? Math.max(0, 350 - (now - this.lastSentAt)) : Math.max(0, 60 - (now - this.lastSentAt));
    if (wait > 0) {
      if (!this.flushTimer) {
        this.flushTimer = window.setTimeout(() => {
          this.flushTimer = null;
          this.flush();
        }, wait);
      }
      return;
    }
    this.flush();
  }

  flush() {
    if (!this.pending) return;
    if (this.flushTimer) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.lastSentAt = Date.now();
    this.socket.sendPlayback(this.pending);
    this.pending = null;
  }

  async resolveClientId() {
    if (!this.getClientId || this.clientId) return this.clientId;
    try {
      this.clientId = await this.getClientId();
    } catch {
      this.clientId = null;
    }
    return this.clientId;
  }

  async sendHttpPlayback(state, options = {}) {
    const now = Date.now();
    const isUrgent = Boolean(options.urgent);
    if (!isUrgent && now - this.lastHttpSentAt < 120) return;
    this.lastHttpSentAt = now;
    const actionKey = state.actionId || `${state.reason}:${state.videoId}:${state.sentAt}`;
    if (this.httpInFlight.has(actionKey)) return this.httpInFlight.get(actionKey);
    const clientId = await this.resolveClientId();
    const body = JSON.stringify({
      ...state,
      roomId: this.socket.roomId(),
      clientId,
      name: localStorage.getItem("pc:name") || "User"
    });

    const request = fetch("/api/playback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: body.length < 60000
    })
      .catch(() => {})
      .finally(() => {
        this.httpInFlight.delete(actionKey);
      });
    this.httpInFlight.set(actionKey, request);
    return request;
  }

  async pollPlayback() {
    try {
      const params = new URLSearchParams({
        roomId: this.socket.roomId(),
        t: String(Date.now())
      });
      const response = await fetch(`/api/playback?${params.toString()}`, {
        cache: "no-store"
      });
      if (!response.ok) return;
      const state = await response.json();
      if (!state?.hasVideo || !Number.isFinite(state.version)) return;
      this.receive(state);
    } catch {
      // Socket sync still runs when HTTP polling is temporarily unavailable.
    }
  }

  receive(state) {
    if (!state?.hasVideo || !Number.isFinite(state.version)) return false;
    const by = state.by || {};
    const isSelf = Boolean(
      this.clientId &&
        ((by.clientId && by.clientId === this.clientId) || (by.id && by.id === this.clientId))
    );
    const isScheduledOwnAction = Boolean(
      isSelf &&
      Number(state.executeAt || 0) > 0 &&
      state.reason !== "heartbeat"
    );
    if (isSelf && !isScheduledOwnAction) {
      this.lastSeenVersion = Math.max(this.lastSeenVersion, state.version);
      return false;
    }
    if (state.version < this.lastSeenVersion) return false;
    if (state.version === this.lastSeenVersion) {
      if (!this.shouldReconcile(state)) return false;
      this.applyOrSchedule(state);
      return true;
    }
    this.lastSeenVersion = state.version;
    this.applyOrSchedule(state);
    return true;
  }

  receiveCorrection(state) {
    if (!state?.hasVideo || !Number.isFinite(state.version)) return false;
    this.lastSeenVersion = Math.max(this.lastSeenVersion, state.version);
    const correctionState = { ...state, targetedCorrection: true };
    if (!this.shouldReconcile(correctionState, { allowLocalSource: true })) return false;
    this.applyOrSchedule(correctionState);
    return true;
  }

  applyOrSchedule(state) {
    const executeAt = Number(state.executeAt || 0);
    const delay = executeAt > 0 ? this.clock.delayUntil(executeAt) : 0;
    if (delay <= 24) {
      if (this.scheduledState && Number(this.scheduledState.version || 0) <= Number(state.version || 0)) {
        window.clearTimeout(this.scheduledTimer);
        this.scheduledTimer = null;
        this.scheduledState = null;
      }
      this.applyRemote(executeAt > 0
        ? { ...state, executeAt: 0, scheduledExecution: true, updatedAt: Date.now() }
        : state);
      this.lastAppliedVersion = Math.max(this.lastAppliedVersion, Number(state.version || 0));
      return;
    }

    if (this.scheduledState && Number(this.scheduledState.version || 0) > Number(state.version || 0)) return;
    window.clearTimeout(this.scheduledTimer);
    this.scheduledState = state;
    this.player.prepareScheduled?.(state);
    this.scheduledTimer = window.setTimeout(() => {
      const scheduled = this.scheduledState;
      this.scheduledTimer = null;
      this.scheduledState = null;
      if (!scheduled || this.player.meta?.id !== scheduled.videoId) return;
      this.applyRemote({
        ...scheduled,
        executeAt: 0,
        scheduledExecution: true,
        updatedAt: Date.now()
      });
      this.lastAppliedVersion = Math.max(this.lastAppliedVersion, Number(scheduled.version || 0));
    }, delay);
  }

  shouldReconcile(state, options = {}) {
    if (!this.player.meta || this.player.meta.id !== state.videoId) return false;
    if (
      this.player.hasLocalSource?.() &&
      !options.allowLocalSource &&
      Number(state.executeAt || 0) <= 0
    ) return false;
    if (Date.now() < this.player.userSyncUntil) return false;
    if (Date.now() - this.lastReconcileAt < 900) return false;

    const targetTime = this.player.remoteTargetTime(state);
    const localTime = this.player.video.currentTime || 0;
    const drift = Number.isFinite(targetTime) ? Math.abs(localTime - targetTime) : 0;
    const pausedMismatch = this.player.video.paused !== Boolean(state.paused);
    const rateMismatch = Number.isFinite(state.playbackRate) && Math.abs((this.player.video.playbackRate || 1) - state.playbackRate) > 0.01;
    const fitMismatch = state.fitMode && this.player.fitMode !== state.fitMode;

    if (drift < 0.35 && !pausedMismatch && !rateMismatch && !fitMismatch) return false;
      if (drift >= 0.35) {
      if (this.player.video.readyState < HTMLMediaElement.HAVE_METADATA) return false;
      if (!this.player.isBuffered(targetTime) && this.player.video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return false;
    }
    if (pausedMismatch && this.player.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return false;
    this.lastReconcileAt = Date.now();
    return true;
  }

  sendWatchState() {
    if (!this.player.meta) return;
    this.socket.sendWatchState({
      videoId: this.player.meta.id,
      currentTime: this.player.video.currentTime || 0,
      duration: Number.isFinite(this.player.video.duration) && this.player.video.duration > 0
        ? this.player.video.duration
        : Number(this.player.meta?.duration || 0),
      paused: this.player.video.paused,
      waiting: this.player.video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA,
      readyState: this.player.video.readyState,
      fitMode: this.player.fitMode || "contain",
      bufferedAhead: this.player.bufferedAhead?.() ?? 0,
      clockOffsetMs: this.clock.offsetMs,
      clockRttMs: this.clock.rttMs,
      syncLeadMs: this.clock.suggestedLeadMs(),
      playbackRate: Number(this.player.ui?.rateSelect?.value) || this.player.video.playbackRate || 1,
      ...this.getWatchState()
    });
  }

  sendPlaybackHeartbeat() {
    if (!this.canSendHeartbeat() || !this.player.meta) return;
    const video = this.player.video;
    this.send({
      reason: "heartbeat",
      hasVideo: true,
      videoId: this.player.meta.id,
      fileName: this.player.meta.name || "",
      paused: video.paused,
      currentTime: video.currentTime || 0,
      duration: Number.isFinite(video.duration) && video.duration > 0
        ? video.duration
        : Number(this.player.meta?.duration || 0),
      playbackRate: video.playbackRate || 1,
      fitMode: this.player.fitMode || "contain"
    });
  }
}
