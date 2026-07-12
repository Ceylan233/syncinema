import { MP4Remuxer } from "./mp4remuxer.js";

const REQUEST_RETRY_MS = 1200;
const PLAYING_BUFFER_AHEAD = 35;
const PAUSED_BUFFER_AHEAD = 8;
const STARTUP_HEAD_CHUNKS = 4;
const STARTUP_TAIL_CHUNKS = 4;
const STREAM_IN_FLIGHT = 8;
const FALLBACK_IN_FLIGHT = 6;
const HTTP_CHUNK_WAIT_MS = 9500;
const SERVER_RELAY_ENABLED = true;

export class P2PDownloader extends EventTarget {
  constructor(roomSocket, mesh, ui, video) {
    super();
    this.socket = roomSocket;
    this.mesh = mesh;
    this.ui = ui;
    this.video = video;
    this.meta = null;
    this.chunks = new Map();
    this.requested = new Map();
    this.nextAppend = 0;
    this.sourceBuffer = null;
    this.mediaSource = null;
    this.mseFailed = false;
    this.completeUrl = null;
    this.requestTimer = null;
    this.streamable = false;
    this.fallbackNoticeShown = false;
    this.remuxer = null;
    this.fedChunkIndexes = new Set();
    this.lastSeekAt = 0;
    this.lastSourceOfflineNoticeAt = 0;
    this.lastSourceOnlineNoticeAt = 0;
    this.sourceOnline = true;
    this.waitingForBuffer = false;
    this.seekTargetIndex = null;
    this.pendingSeekTime = null;
    this.rangeStreaming = false;
    this.lastRangeReloadAt = 0;
    this.lastRangePrimeAt = 0;

    this.video.addEventListener("seeking", () => this.handleSeeking());
    this.video.addEventListener("waiting", () => {
      this.waitingForBuffer = true;
      this.requestMore(true);
    });
    this.video.addEventListener("play", () => this.requestMore(true));
    this.video.addEventListener("timeupdate", () => {
      this.requestMore();
      this.updateTransferStatus();
    });
    this.video.addEventListener("canplay", () => {
      this.waitingForBuffer = false;
      this.seekTargetIndex = null;
      this.updateTransferStatus();
    });
    this.video.addEventListener("durationchange", () => this.applyPendingSeekTarget());
    this.video.addEventListener("error", () => this.recoverRangeStream());
    this.video.addEventListener("stalled", () => this.recoverRangeStream());
  }

  start(meta, options = {}) {
    if (!meta?.id || (this.meta?.id === meta.id && !options.force)) return;

    this.reset();
    this.meta = meta;
    this.sourceOnline = meta.sourceOnline !== false;
    this.ui.showEmpty(false);
    this.ui.setTransfer(`按需缓冲：${meta.name}`, 0);
    if (Number.isFinite(options.currentTime)) this.primeServerRelay(options.currentTime);
    this.preparePlayback(meta);
    this.requestTimer = window.setInterval(() => this.requestMore(), 400);
    this.requestMore(true);
  }

  stop() {
    this.reset();
  }

  reset() {
    if (this.requestTimer) window.clearInterval(this.requestTimer);
    this.requestTimer = null;
    this.meta = null;
    this.chunks.clear();
    this.requested.clear();
    this.nextAppend = 0;
    this.sourceBuffer = null;
    this.mediaSource = null;
    this.mseFailed = false;
    this.streamable = false;
    this.fallbackNoticeShown = false;
    this.fedChunkIndexes.clear();
    this.sourceOnline = true;
    this.waitingForBuffer = false;
    this.seekTargetIndex = null;
    this.pendingSeekTime = null;
    this.rangeStreaming = false;
    this.lastSourceOnlineNoticeAt = 0;
    this.lastRangePrimeAt = 0;
    this.remuxer?.destroy();
    this.remuxer = null;
    if (this.completeUrl) URL.revokeObjectURL(this.completeUrl);
    this.completeUrl = null;
  }

  preparePlayback(meta) {
    if (this.prepareServerRangePlayback(meta)) return;

    this.remuxer = new MP4Remuxer(this.video, this.ui);
    if (this.remuxer.start(meta)) {
      this.streamable = true;
      return;
    }

    this.prepareMediaSource(meta);
  }

  prepareServerRangePlayback(meta) {
    if (!meta?.id || !meta?.size || !meta?.chunkSize) return false;
    this.rangeStreaming = true;
    this.streamable = true;
    this.video.src = this.serverStreamUrl(meta.id);
    this.video.load();
    this.ui.addSystemMessage("已切换为大带宽按需播放：浏览器会按播放位置请求分段。");
    this.updateTransferStatus("range");
    return true;
  }

  recoverRangeStream() {
    if (!this.rangeStreaming || !this.meta?.id) return;
    const now = Date.now();
    if (now - this.lastRangeReloadAt < 2500) return;
    this.lastRangeReloadAt = now;
    const resumeAt = this.video.currentTime || 0;
    this.primeServerRelay(resumeAt);
    this.video.src = this.serverStreamUrl(this.meta.id);
    this.video.load();
    this.video.addEventListener(
      "loadedmetadata",
      () => {
        if (Number.isFinite(resumeAt) && resumeAt > 0) {
          try {
            this.video.currentTime = resumeAt;
          } catch {
            // Some browsers reject a seek before the range source is ready.
          }
        }
      },
      { once: true }
    );
  }

  serverStreamUrl(videoId) {
    const params = new URLSearchParams({
      roomId: this.socket.roomId(),
      t: String(Date.now())
    });
    return `/api/videos/${encodeURIComponent(videoId)}/stream?${params.toString()}`;
  }

  primeServerRelay(time = this.video.currentTime || 0) {
    if (!SERVER_RELAY_ENABLED || !this.meta?.id) return;
    fetch("/api/chunks/preload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId: this.meta.id,
        currentTime: Number.isFinite(time) ? time : 0,
        duration: Number.isFinite(this.video.duration) ? this.video.duration : Number(this.meta.duration || 0)
      })
    }).catch(() => {});
  }

  primeRangePlaybackWindow(force = false) {
    const now = Date.now();
    if (!force && now - this.lastRangePrimeAt < 500) return;
    this.lastRangePrimeAt = now;
    this.primeServerRelay(this.video.currentTime || 0);
  }

  prepareMediaSource(meta) {
    if (!("MediaSource" in window)) {
      this.mseFailed = true;
      this.ui.addSystemMessage("当前浏览器不支持 MSE，会低并发接收，避免一次性吃满流量。");
      return;
    }

    const mime = meta.type || "video/mp4";
    if (!MediaSource.isTypeSupported(mime)) {
      this.mseFailed = true;
      this.ui.addSystemMessage(`${mime} 不能直接边收边播，会低并发接收，避免一次性吃满流量。`);
      return;
    }

    try {
      this.mediaSource = new MediaSource();
      this.video.src = URL.createObjectURL(this.mediaSource);
      this.mediaSource.addEventListener("sourceopen", () => {
        try {
          this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);
          this.sourceBuffer.mode = "sequence";
          this.streamable = true;
          this.sourceBuffer.addEventListener("updateend", () => this.appendReadyChunks());
          this.appendReadyChunks();
        } catch (error) {
          console.warn("MSE source buffer failed", error);
          this.mseFailed = true;
          this.streamable = false;
          this.ui.addSystemMessage("这个格式不能直接边收边播，会切换到省流慢速接收。");
        }
      });
    } catch (error) {
      console.warn("MSE failed", error);
      this.mseFailed = true;
      this.ui.addSystemMessage("MSE 初始化失败，会切换到省流慢速接收。");
    }
  }

  handleDataMessage(peerId, message) {
    if (message.kind === "video-meta") {
      return true;
    }

    if (message.kind === "source-ready" && message.meta?.id === this.meta?.id) {
      this.markSourceOnline(message.meta);
      return true;
    }

    if (message.kind === "chunk-request") {
      return this.answerChunkRequest(peerId, message);
    }

    return false;
  }

  markSourceOnline(meta) {
    if (!this.meta || meta?.id !== this.meta.id) return;
    if (!this.sourceOnline) {
      this.lastSourceOnlineNoticeAt = Date.now();
      this.ui.addSystemMessage(`${meta.ownerName || "片源"} 已恢复，可以继续接收分段。`);
    }
    this.sourceOnline = true;
    this.requestMore(true);
  }

  markSourceOffline(meta) {
    if (!this.meta || meta?.id !== this.meta.id) return;
    this.sourceOnline = false;
    const percent = Math.round((this.chunks.size / this.meta.totalChunks) * 100);
    this.ui.setTransfer(`等待片源恢复：${this.meta.name}（已缓存 ${this.chunks.size}/${this.meta.totalChunks} 分段）`, percent);
    const now = Date.now();
    if (now - this.lastSourceOfflineNoticeAt > 5000) {
      this.lastSourceOfflineNoticeAt = now;
      this.ui.addSystemMessage("当前视频源离线了，原上传者需要重新选择同一个文件来恢复。");
    }
  }

  async answerChunkRequest(peerId, message) {
    if (message.videoId !== this.meta?.id || !this.chunks.has(message.index)) return false;
    const buffer = this.chunks.get(message.index);
    return this.mesh.sendChunk(peerId, { videoId: this.meta.id, index: message.index }, buffer);
  }

  handleBinary({ peerId, header, buffer }) {
    this.acceptChunk({ peerId, header, buffer });
  }

  handleServerChunk(header, buffer) {
    this.acceptChunk({ peerId: "server", header, buffer });
  }

  acceptChunk({ peerId, header, buffer }) {
    if (this.rangeStreaming) return;
    if (!header || header.videoId !== this.meta?.id || !Number.isInteger(header.index)) return;
    if (this.chunks.has(header.index)) return;

    this.chunks.set(header.index, buffer);
    this.requested.delete(header.index);
    this.mesh.broadcastJSON({
      kind: "chunk-have",
      videoId: this.meta.id,
      index: header.index
    });

    const percent = Math.round((this.chunks.size / this.meta.totalChunks) * 100);
    this.updateTransferStatus();
    this.dispatchEvent(new CustomEvent("progress", { detail: { percent, peerId } }));

    this.feedChunkToRemuxer(header.index, buffer);
    this.appendReadyChunks();
    this.requestMore();

    if (this.chunks.size === this.meta.totalChunks) {
      this.finish();
    }
  }

  requestMore(force = false) {
    if (!this.meta || this.chunks.size === this.meta.totalChunks) return;
    if (this.rangeStreaming) {
      this.primeRangePlaybackWindow(force);
      this.updateTransferStatus("range");
      return;
    }

    this.expireRequests();
    if (!force && this.streamable && this.hasEnoughBufferedAhead() && !this.isNearlyComplete()) {
      this.updateTransferStatus("buffered");
      return;
    }

    const maxInFlight = this.streamable ? STREAM_IN_FLIGHT : FALLBACK_IN_FLIGHT;
    if (this.requested.size >= maxInFlight) {
      this.updateTransferStatus("waiting");
      return;
    }
    const hasP2P = this.mesh.openPeerCount() > 0;

    const candidates = this.requestCandidates(maxInFlight - this.requested.size);
    for (const index of candidates) {
      this.requestChunk(index);
      if (this.requested.size >= maxInFlight) break;
    }
    this.updateTransferStatus(this.requested.size > 0 ? (hasP2P ? "requesting" : "server") : "waiting");
  }

  requestCandidates(limit) {
    const total = this.meta.totalChunks;
    const candidates = [];
    const add = (index) => {
      if (!Number.isInteger(index) || index < 0 || index >= total) return;
      if (this.chunks.has(index) || this.requested.has(index) || candidates.includes(index)) return;
      candidates.push(index);
    };
    const addAround = (center, ahead = 12, behind = 4) => {
      add(center);
      for (let offset = 1; offset <= ahead && candidates.length < limit; offset += 1) add(center + offset);
      for (let offset = 1; offset <= behind && candidates.length < limit; offset += 1) add(center - offset);
    };

    if (Number.isInteger(this.seekTargetIndex)) {
      addAround(this.seekTargetIndex, this.remuxer?.ready ? 20 : 10, 5);
    }

    if (!this.streamable) {
      if (!this.fallbackNoticeShown) {
        this.fallbackNoticeShown = true;
        this.ui.addSystemMessage("省流慢速模式：只少量请求分段，不会像普通下载一样一次性请求全部视频。");
      }
      for (let index = 0; index < total && candidates.length < limit; index += 1) add(index);
      return candidates;
    }

    if (this.remuxer && !this.remuxer.failed) {
      if (!this.remuxer.ready) this.addStartupMetadataCandidates(add, candidates, limit, total);

      const timeIndex = Number.isInteger(this.seekTargetIndex) ? this.seekTargetIndex : this.estimatedChunkForCurrentTime();
      if (Number.isInteger(timeIndex)) addAround(timeIndex, 4, 3);

      const hint = Math.min(total - 1, Math.max(0, this.remuxer.nextChunkHint || 0));
      const ahead = this.remuxer.ready ? 24 : 10;
      for (let offset = 0; offset <= ahead && candidates.length < limit; offset += 1) add(hint + offset);
      for (let offset = 1; offset <= 5 && candidates.length < limit; offset += 1) add(hint - offset);
    } else {
      const baseIndex = Math.min(this.nextAppend, total - 1);
      const ahead = this.video.paused ? 8 : 22;
      for (let offset = 0; offset <= ahead && candidates.length < limit; offset += 1) add(baseIndex + offset);
    }

    for (let index = 0; index < total && candidates.length < limit; index += 1) add(index);
    return candidates;
  }

  addStartupMetadataCandidates(add, candidates, limit, total) {
    for (let offset = 0; candidates.length < limit; offset += 1) {
      const addedBefore = candidates.length;
      if (offset < STARTUP_HEAD_CHUNKS) add(offset);
      if (offset < STARTUP_TAIL_CHUNKS) add(total - 1 - offset);
      if (offset >= STARTUP_HEAD_CHUNKS && offset >= STARTUP_TAIL_CHUNKS) break;
      if (candidates.length === addedBefore && offset >= total) break;
    }
  }

  requestChunk(index) {
    this.requested.set(index, Date.now());
    this.mesh.broadcastJSON({
      kind: "chunk-request",
      videoId: this.meta.id,
      index
    });
    if (SERVER_RELAY_ENABLED) {
      this.requestHttpChunk(index);
    }
  }

  async requestHttpChunk(index) {
    try {
      await fetch("/api/chunks/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: this.meta.id, index })
      });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (this.chunks.has(index) || this.meta?.id == null) return;
        const response = await fetch(`/api/chunks/${encodeURIComponent(this.meta.id)}/${index}?wait=${HTTP_CHUNK_WAIT_MS}&t=${Date.now()}`, {
          cache: "no-store"
        });
        if (response.ok && response.status !== 204) {
          const buffer = await response.arrayBuffer();
          this.acceptChunk({
            peerId: "http-relay",
            header: { videoId: this.meta.id, index },
            buffer
          });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    } catch {
      // P2P requests will continue retrying; HTTP relay is a fallback path.
    } finally {
      if (!this.chunks.has(index)) {
        this.requested.delete(index);
        this.requestMore(true);
      }
    }
  }

  expireRequests() {
    const now = Date.now();
    for (const [index, requestedAt] of this.requested) {
      if (now - requestedAt > REQUEST_RETRY_MS) this.requested.delete(index);
    }
  }

  hasEnoughBufferedAhead() {
    if (this.waitingForBuffer) return false;
    if (this.remuxer && !this.remuxer.ready) return false;
    if (this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return false;
    const bufferedAhead = this.bufferedAhead();
    if (bufferedAhead < 0) return false;
    return bufferedAhead > (this.video.paused ? PAUSED_BUFFER_AHEAD : PLAYING_BUFFER_AHEAD);
  }

  isNearlyComplete() {
    if (!this.meta?.totalChunks) return false;
    return this.chunks.size / this.meta.totalChunks > 0.92;
  }

  estimatedChunkForCurrentTime() {
    return this.chunkIndexForTime(this.video.currentTime || 0);
  }

  chunkIndexForTime(time) {
    if (!this.meta?.totalChunks || !Number.isFinite(this.video.duration) || this.video.duration <= 0) return null;
    const ratio = Math.min(1, Math.max(0, (time || 0) / this.video.duration));
    return Math.min(this.meta.totalChunks - 1, Math.max(0, Math.floor(ratio * this.meta.totalChunks)));
  }

  bufferedAhead() {
    const time = this.video.currentTime || 0;
    const ranges = this.video.buffered;
    for (let index = 0; index < ranges.length; index += 1) {
      if (ranges.start(index) <= time + 0.25 && ranges.end(index) >= time) {
        return ranges.end(index) - time;
      }
    }
    return -1;
  }

  appendReadyChunks() {
    if (this.remuxer) return;
    if (this.mseFailed || !this.sourceBuffer || this.sourceBuffer.updating) return;
    if (!this.chunks.has(this.nextAppend)) return;

    const buffer = this.chunks.get(this.nextAppend);
    this.nextAppend += 1;

    try {
      this.sourceBuffer.appendBuffer(buffer);
    } catch (error) {
      console.warn("MSE append failed, falling back to Blob playback", error);
      this.mseFailed = true;
      this.streamable = false;
      this.ui.addSystemMessage("这个视频不是流式 MP4/WebM，已切换为省流慢速接收。");
      if (this.chunks.size === this.meta.totalChunks) this.finish();
    }
  }

  transferLabel() {
    if (this.remuxer && !this.remuxer.failed) return `流式转封装：${this.meta.name}`;
    return this.streamable ? `按需缓冲：${this.meta.name}` : `省流慢速：${this.meta.name}`;
  }

  updateTransferStatus(mode = "normal") {
    if (!this.meta) return;
    if (this.rangeStreaming || mode === "range") {
      const ahead = this.bufferedAhead();
      const aheadText = ahead >= 0 ? `，已缓冲 ${Math.floor(ahead)} 秒` : "";
      const percent = ahead >= 0 ? Math.min(100, Math.round((ahead / 30) * 100)) : 0;
      this.ui.setTransfer(`大带宽按需播放：${this.meta.name}${aheadText}`, percent);
      return;
    }

    const percent = Math.round((this.chunks.size / this.meta.totalChunks) * 100);
    const ahead = this.bufferedAhead();
    const aheadText = ahead >= 0 ? `，已缓冲 ${Math.floor(ahead)} 秒` : "";
    const countText = `${this.chunks.size}/${this.meta.totalChunks} 分段`;
    const inFlightText = this.requested.size > 0 ? `，请求中 ${this.requested.size}` : "";

    if (mode === "buffered") {
      this.ui.setTransfer(`${this.transferLabel()}（${countText}${aheadText}，暂停预取）`, percent);
      return;
    }

    if (mode === "offline") {
      this.ui.setTransfer(`${this.transferLabel()}（等待 P2P 片源连接，${countText}）`, percent);
      return;
    }

    if (mode === "server") {
      this.ui.setTransfer(`${this.transferLabel()}（服务器中转中，${countText}${inFlightText}）`, percent);
      return;
    }

    if (mode === "waiting") {
      this.ui.setTransfer(`${this.transferLabel()}（等待分段返回，${countText}${inFlightText}）`, percent);
      return;
    }

    if (mode === "requesting") {
      this.ui.setTransfer(`${this.transferLabel()}（P2P/服务器请求中，${countText}${aheadText}${inFlightText}）`, percent);
      return;
    }

    this.ui.setTransfer(`${this.transferLabel()}（${countText}${aheadText}）`, percent);
  }

  feedChunkToRemuxer(index, buffer) {
    if (!this.remuxer || this.remuxer.failed || this.fedChunkIndexes.has(index)) return;
    this.fedChunkIndexes.add(index);
    this.remuxer.appendChunk(index, buffer);
  }

  handleSeeking() {
    if (!this.meta) return;
    if (this.rangeStreaming) {
      this.waitingForBuffer = true;
      this.updateTransferStatus("range");
      return;
    }
    const now = Date.now();
    if (now - this.lastSeekAt < 120) return;
    this.lastSeekAt = now;
    this.waitingForBuffer = true;
    this.prioritizeTime(this.video.currentTime || 0);
  }

  prioritizeTime(time) {
    if (!this.meta || !Number.isFinite(time)) return;
    if (this.rangeStreaming) {
      this.primeServerRelay(time);
      this.updateTransferStatus("range");
      return;
    }
    this.waitingForBuffer = true;
    const targetIndex = this.chunkIndexForTime(time);
    if (Number.isInteger(targetIndex)) {
      this.seekTargetIndex = targetIndex;
      this.pendingSeekTime = null;
    } else {
      this.pendingSeekTime = time;
    }

    if (this.remuxer && !this.remuxer.failed) {
      this.remuxer.seek(time);
    }

    this.requested.clear();
    this.requestMore(true);
  }

  applyPendingSeekTarget() {
    if (!Number.isFinite(this.pendingSeekTime)) return;
    this.prioritizeTime(this.pendingSeekTime);
  }

  finish() {
    if (this.requestTimer) window.clearInterval(this.requestTimer);
    this.requestTimer = null;
    this.ui.setTransfer(`接收完成：${this.meta.name}`, 100);

    if (this.remuxer && !this.remuxer.failed) {
      try {
        this.remuxer.mp4box?.flush();
      } catch {
        // Segmentation may already be flushed.
      }
      return;
    }

    if (this.mediaSource && !this.mseFailed && this.mediaSource.readyState === "open") {
      try {
        this.mediaSource.endOfStream();
        return;
      } catch {
        this.mseFailed = true;
      }
    }

    const ordered = [];
    for (let index = 0; index < this.meta.totalChunks; index += 1) {
      ordered.push(this.chunks.get(index));
    }
    this.completeUrl = URL.createObjectURL(new Blob(ordered, { type: this.meta.type }));
    this.video.src = this.completeUrl;
    this.video.load();
  }
}
