import { createId } from "./id.js";

export const CHUNK_SIZE = 256 * 1024;
const SERVER_RELAY_ENABLED = true;
const HTTP_RELAY_POLL_MS = 90;
const HTTP_RELAY_BATCH_LIMIT = 32;
const HTTP_RELAY_UPLOAD_CONCURRENCY = 8;
const HTTP_STARTUP_UPLOAD_CONCURRENCY = 8;
const HTTP_PRELOAD_POLL_MS = 800;
const HTTP_PRELOAD_AHEAD_CHUNKS = 64;
const HTTP_PRELOAD_BEHIND_CHUNKS = 4;
const HTTP_PRELOAD_BATCH_LIMIT = 48;
const HTTP_PRELOAD_CHECK_LIMIT = 80;
const HTTP_CRITICAL_POLL_MS = 800;
const HTTP_CRITICAL_HEAD_CHUNKS = 4;
const HTTP_CRITICAL_AHEAD_CHUNKS = 32;
const HTTP_CRITICAL_BEHIND_CHUNKS = 3;
const HTTP_CRITICAL_BATCH_LIMIT = 32;
const HTTP_UPLOADED_TRACK_LIMIT = 1000;
const HTTP_STARTUP_HEAD_CHUNKS = 16;
const HTTP_STARTUP_TAIL_CHUNKS = 4;
const HTTP_CONTINUOUS_ENABLED = false;
const HTTP_CONTINUOUS_POLL_MS = 700;
const HTTP_CONTINUOUS_CHECK_LIMIT = 16;
const HTTP_CONTINUOUS_BATCH_LIMIT = 6;
const HTTP_UPLOAD_GAP_MS = 0;
const CHAT_PRIORITY_KEY = "syncinemaChatPriorityUntil";

function chatPriorityActive() {
  return Date.now() < Number(window[CHAT_PRIORITY_KEY] || 0);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    window.clearTimeout(timer);
  }
}

export class VideoUploader {
  constructor(roomSocket, mesh, ui) {
    this.socket = roomSocket;
    this.mesh = mesh;
    this.ui = ui;
    this.file = null;
    this.meta = null;
    this.serverSendQueue = Promise.resolve();
    this.peerSendQueues = new Map();
    this.httpRelayTimer = null;
    this.httpPreloadTimer = null;
    this.httpContinuousTimer = null;
    this.httpCriticalTimer = null;
    this.httpRelayUploading = false;
    this.httpPreloadUploading = false;
    this.httpContinuousUploading = false;
    this.httpCriticalUploading = false;
    this.httpRelayStartedAt = 0;
    this.httpPreloadStartedAt = 0;
    this.uploadedToServer = new Map();
    this.serverUploadInFlight = new Set();
    this.clientId = null;
    this.continuousUploadIndex = 0;
  }

  async useFile(file) {
    if (!file) return null;

    this.file = file;
    this.uploadedToServer.clear();
    this.serverUploadInFlight.clear();
    this.meta = {
      id: createId("video"),
      switchId: createId("switch"),
      selectedAt: Date.now(),
      name: file.name,
      size: file.size,
      type: file.type || "video/mp4",
      chunkSize: CHUNK_SIZE,
      totalChunks: Math.ceil(file.size / CHUNK_SIZE),
      ownerName: localStorage.getItem("pc:name") || "Host"
    };

    this.socket.sendVideoMeta(this.meta);
    this.socket.sendSourceReady(this.meta.id);
    this.startRelayAfterMeta();
    this.ui.setTransfer(`正在共享：${file.name}`, 100);
    return this.meta;
  }

  async resumeFile(file, meta) {
    if (!file || !meta?.id) return null;

    this.file = file;
    this.uploadedToServer.clear();
    this.serverUploadInFlight.clear();
    this.meta = {
      ...meta,
      ownerName: localStorage.getItem("pc:name") || meta.ownerName || "Host"
    };

    this.mesh.broadcastJSON({ kind: "source-ready", meta: this.meta });
    this.socket.sendSourceReady(this.meta.id);
    this.socket.sendVideoMeta(this.meta);
    this.startRelayAfterMeta();
    this.ui.setTransfer(`已恢复视频源：${file.name}`, 100);
    return this.meta;
  }

  owns(videoId) {
    return this.meta?.id === videoId && this.file;
  }

  stopSharing(videoId = null) {
    if (videoId && this.meta?.id === videoId) return;
    this.file = null;
    this.meta = null;
    this.uploadedToServer.clear();
    this.serverUploadInFlight.clear();
    this.peerSendQueues.clear();
    if (this.httpRelayTimer) window.clearInterval(this.httpRelayTimer);
    if (this.httpPreloadTimer) window.clearInterval(this.httpPreloadTimer);
    if (this.httpContinuousTimer) window.clearInterval(this.httpContinuousTimer);
    if (this.httpCriticalTimer) window.clearInterval(this.httpCriticalTimer);
    this.httpRelayTimer = null;
    this.httpPreloadTimer = null;
    this.httpContinuousTimer = null;
    this.httpCriticalTimer = null;
    this.httpRelayUploading = false;
    this.httpPreloadUploading = false;
    this.httpContinuousUploading = false;
    this.httpCriticalUploading = false;
    this.httpRelayStartedAt = 0;
    this.httpPreloadStartedAt = 0;
  }

  async handleRequest(peerId, message) {
    if (message.kind !== "chunk-request" || !this.owns(message.videoId)) return false;
    const key = String(peerId || "peer");
    const queue = this.peerSendQueues.get(key) || Promise.resolve();
    const next = queue
      .then(() => this.sendChunk(peerId, message.index))
      .catch((error) => {
        console.warn("P2P chunk send failed", error);
        return false;
      });
    const tracked = next.finally(() => {
      if (this.peerSendQueues.get(key) === tracked) this.peerSendQueues.delete(key);
    });
    this.peerSendQueues.set(key, tracked);
    await next;
    return true;
  }

  async handleServerRequest(message) {
    if (!SERVER_RELAY_ENABLED) return false;
    if (!this.owns(message?.videoId) || !Number.isInteger(message.index)) return false;
    // The HTTP relay queue is priority-sorted and concurrency-limited. Uploading
    // directly from every socket event lets preload traffic starve startup chunks.
    this.kickHttpRelay();
    return true;
  }

  async sendServerChunk(message) {
    if (!this.owns(message?.videoId) || !Number.isInteger(message.index)) return false;
    const buffer = await this.readChunk(message.index);
    if (!buffer) return false;
    this.socket.sendServerChunk(message.requesterId, this.meta.id, message.index, buffer);
    await wait(10);
    return true;
  }

  startHttpRelay() {
    if (!SERVER_RELAY_ENABLED || this.httpRelayTimer) return;
    this.httpRelayTimer = window.setInterval(() => this.flushHttpRelayRequests(), HTTP_RELAY_POLL_MS);
    if (!this.httpPreloadTimer) {
      this.httpPreloadTimer = window.setInterval(() => this.uploadPlaybackWindow(), HTTP_PRELOAD_POLL_MS);
    }
    if (HTTP_CONTINUOUS_ENABLED && !this.httpContinuousTimer) {
      this.httpContinuousTimer = window.setInterval(() => this.uploadContinuousWindow(), HTTP_CONTINUOUS_POLL_MS);
    }
    if (!this.httpCriticalTimer) {
      this.httpCriticalTimer = window.setInterval(() => this.uploadCriticalWindow(), HTTP_CRITICAL_POLL_MS);
    }
    this.flushHttpRelayRequests();
  }

  startRelayAfterMeta() {
    window.setTimeout(() => this.uploadStartupChunks(), 0);
    window.setTimeout(() => this.startHttpRelay(), 150);
    window.setTimeout(() => this.uploadStartupChunks(), 600);
  }

  kickHttpRelay() {
    if (!SERVER_RELAY_ENABLED || !this.meta?.id || !this.file) return;
    this.startHttpRelay();
    const now = Date.now();
    if (this.httpRelayUploading && now - this.httpRelayStartedAt > 8000) {
      this.httpRelayUploading = false;
    }
    if (this.httpPreloadUploading && now - this.httpPreloadStartedAt > 10000) {
      this.httpPreloadUploading = false;
    }
    this.flushHttpRelayRequests();
  }

  async flushHttpRelayRequests() {
    if (!this.meta?.id || !this.file || this.httpRelayUploading) return;
    if (chatPriorityActive()) return;
    this.httpRelayUploading = true;
    this.httpRelayStartedAt = Date.now();
    try {
      const clientId = await this.resolveClientId();
      const params = new URLSearchParams({
        videoId: this.meta.id,
        limit: String(HTTP_RELAY_BATCH_LIMIT),
        t: String(Date.now())
      });
      if (clientId) params.set("clientId", clientId);
      const name = localStorage.getItem("pc:name") || this.meta.ownerName || "Host";
      if (name) params.set("name", name);
      const response = await fetchWithTimeout(`/api/chunks/requests?${params.toString()}`, {
        cache: "no-store"
      }, 5000);
      if (!response.ok) return;
      const { indexes = [] } = await response.json();
      const queue = indexes.filter((index) => Number.isInteger(index));
      const firstIndex = queue.shift();
      if (Number.isInteger(firstIndex)) {
        const firstBuffer = await this.readChunk(firstIndex);
        if (firstBuffer) await this.uploadServerChunk(firstIndex, firstBuffer, { force: true });
      }
      const workerCount = Math.min(HTTP_RELAY_UPLOAD_CONCURRENCY, queue.length);
      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          while (queue.length > 0 && this.owns(this.meta.id)) {
            if (chatPriorityActive()) break;
            const index = queue.shift();
            const buffer = await this.readChunk(index);
            if (!buffer) continue;
            await this.uploadServerChunk(index, buffer, { force: true });
            await wait(HTTP_UPLOAD_GAP_MS);
          }
        })
      );
    } catch {
      // P2P sharing remains available if HTTP relay polling fails briefly.
    } finally {
      this.httpRelayUploading = false;
      this.httpRelayStartedAt = 0;
    }
  }

  async resolveClientId() {
    if (this.clientId) return this.clientId;
    if (!this.socket.clientId) return null;
    try {
      this.clientId = await this.socket.clientId();
    } catch {
      this.clientId = null;
    }
    return this.clientId;
  }

  async uploadPlaybackWindow() {
    if (!this.meta?.id || !this.file || this.httpPreloadUploading) return;
    if (chatPriorityActive()) return;
    this.httpPreloadUploading = true;
    this.httpPreloadStartedAt = Date.now();
    try {
      const response = await fetchWithTimeout(`/api/playback?t=${Date.now()}`, { cache: "no-store" }, 5000);
      if (!response.ok) return;
      const playback = await response.json();
      if (playback?.videoId !== this.meta.id) return;

      const duration = Number(playback.duration || 0);
      const currentTime = Number(playback.currentTime || 0);
      if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(currentTime)) return;

      const currentIndex = Math.min(
        this.meta.totalChunks - 1,
        Math.max(0, Math.floor((currentTime / duration) * this.meta.totalChunks))
      );
      const start = Math.max(0, currentIndex - HTTP_PRELOAD_BEHIND_CHUNKS);
      const end = Math.min(this.meta.totalChunks - 1, currentIndex + HTTP_PRELOAD_AHEAD_CHUNKS);
      const candidates = [];

      for (let index = start; index <= end; index += 1) {
        if (this.serverUploadInFlight.has(index)) continue;
        candidates.push(index);
        if (candidates.length >= HTTP_PRELOAD_CHECK_LIMIT) break;
      }

      const missing = await this.serverMissingChunks(candidates);
      const queue = missing
        .filter((index) => !this.serverUploadInFlight.has(index))
        .slice(0, HTTP_PRELOAD_BATCH_LIMIT);

      const workerCount = Math.min(HTTP_RELAY_UPLOAD_CONCURRENCY, queue.length);
      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          while (queue.length > 0 && this.owns(this.meta.id)) {
            if (chatPriorityActive()) break;
            const index = queue.shift();
            const buffer = await this.readChunk(index);
            if (!buffer) continue;
            await this.uploadServerChunk(index, buffer, { force: true });
            await wait(HTTP_UPLOAD_GAP_MS);
          }
        })
      );
    } catch {
      // Demand-driven chunk requests still fill the server cache if preloading misses.
    } finally {
      this.httpPreloadUploading = false;
      this.httpPreloadStartedAt = 0;
    }
  }

  async uploadCriticalWindow() {
    if (!this.meta?.id || !this.file || this.httpCriticalUploading) return;
    if (chatPriorityActive()) return;
    this.httpCriticalUploading = true;
    try {
      const candidates = [];
      const seen = new Set();
      const add = (index) => {
        if (!Number.isInteger(index) || index < 0 || index >= this.meta.totalChunks || seen.has(index)) return;
        seen.add(index);
        candidates.push(index);
      };

      const headLimit = Math.min(this.meta.totalChunks, HTTP_CRITICAL_HEAD_CHUNKS);
      for (let index = 0; index < headLimit; index += 1) add(index);
      for (let offset = 0; offset < HTTP_STARTUP_TAIL_CHUNKS; offset += 1) add(this.meta.totalChunks - 1 - offset);

      const playback = await this.fetchPlaybackSnapshot();
      const duration = Number(playback?.duration || this.meta.duration || 0);
      const currentTime = Number(playback?.videoId === this.meta.id ? playback.currentTime : 0);
      if (Number.isFinite(duration) && duration > 0 && Number.isFinite(currentTime)) {
        const center = Math.min(
          this.meta.totalChunks - 1,
          Math.max(0, Math.floor((Math.max(0, currentTime) / duration) * this.meta.totalChunks))
        );
        for (let offset = 0; offset <= HTTP_CRITICAL_AHEAD_CHUNKS; offset += 1) add(center + offset);
        for (let offset = 1; offset <= HTTP_CRITICAL_BEHIND_CHUNKS; offset += 1) add(center - offset);
      }

      const missing = await this.serverMissingChunks(candidates);
      const queue = missing
        .filter((index) => !this.serverUploadInFlight.has(index))
        .slice(0, HTTP_CRITICAL_BATCH_LIMIT);
      await this.uploadQueue(queue, Math.min(HTTP_RELAY_UPLOAD_CONCURRENCY, queue.length));
    } catch {
      // Other upload loops will retry if this fast critical pass misses once.
    } finally {
      this.httpCriticalUploading = false;
    }
  }

  async fetchPlaybackSnapshot() {
    try {
      const response = await fetchWithTimeout(`/api/playback?t=${Date.now()}`, { cache: "no-store" }, 3500);
      if (!response.ok) return null;
      return response.json();
    } catch {
      return null;
    }
  }

  async uploadQueue(queue, workerCount) {
    if (!Array.isArray(queue) || queue.length === 0 || workerCount <= 0) return;
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (queue.length > 0 && this.owns(this.meta.id)) {
          if (chatPriorityActive()) break;
          const index = queue.shift();
          const buffer = await this.readChunk(index);
          if (!buffer) continue;
          await this.uploadServerChunk(index, buffer, { force: true });
          await wait(HTTP_UPLOAD_GAP_MS);
        }
      })
    );
  }

  async uploadContinuousWindow() {
    if (!this.meta?.id || !this.file || this.httpContinuousUploading) return;
    if (chatPriorityActive()) return;
    this.httpContinuousUploading = true;
    try {
      const total = this.meta.totalChunks || 0;
      if (total <= 0) return;
      const indexes = [];
      for (let offset = 0; offset < HTTP_CONTINUOUS_CHECK_LIMIT; offset += 1) {
        indexes.push((this.continuousUploadIndex + offset) % total);
      }
      const missing = await this.serverMissingChunks(indexes);
      const queue = missing
        .filter((index) => !this.serverUploadInFlight.has(index))
        .slice(0, HTTP_CONTINUOUS_BATCH_LIMIT);

      for (const index of queue) {
        if (chatPriorityActive()) break;
        const buffer = await this.readChunk(index);
        if (buffer) await this.uploadServerChunk(index, buffer, { force: true });
      }

      this.continuousUploadIndex = (this.continuousUploadIndex + Math.max(1, HTTP_CONTINUOUS_BATCH_LIMIT)) % total;
    } catch {
      // The demand-driven and playback-window upload loops will keep retrying.
    } finally {
      this.httpContinuousUploading = false;
    }
  }

  async serverMissingChunks(indexes) {
    if (!this.meta?.id || !Array.isArray(indexes) || indexes.length === 0) return [];
    try {
      const response = await fetchWithTimeout("/api/chunks/missing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: this.meta.id, indexes })
      }, 5000);
      if (!response.ok) return indexes.filter((index) => !this.uploadedToServer.has(index));
      const result = await response.json();
      return Array.isArray(result?.indexes) ? result.indexes.filter((index) => Number.isInteger(index)) : [];
    } catch {
      return indexes.filter((index) => !this.uploadedToServer.has(index));
    }
  }

  async uploadStartupChunks() {
    if (!this.meta?.id || !this.file) return;
    const priorityQueue = [];
    const queue = [];
    const seen = new Set();
    const add = (index, priority = false) => {
      if (!Number.isInteger(index) || index < 0 || index >= this.meta.totalChunks || seen.has(index)) return;
      seen.add(index);
      if (priority) priorityQueue.push(index);
      else queue.push(index);
    };

    const criticalHead = Math.min(4, this.meta.totalChunks);
    for (let index = 0; index < criticalHead; index += 1) add(index, true);
    for (let offset = 0; offset < HTTP_STARTUP_TAIL_CHUNKS; offset += 1) add(this.meta.totalChunks - 1 - offset, true);
    for (let index = 0; index < HTTP_STARTUP_HEAD_CHUNKS; index += 1) add(index);

    const firstPriorityIndex = priorityQueue.shift();
    if (Number.isInteger(firstPriorityIndex)) {
      const firstBuffer = await this.readChunk(firstPriorityIndex);
      if (firstBuffer) await this.uploadServerChunk(firstPriorityIndex, firstBuffer, { force: true });
    }
    await this.uploadQueue(priorityQueue, Math.min(HTTP_STARTUP_UPLOAD_CONCURRENCY, priorityQueue.length));
    const workerCount = Math.min(HTTP_RELAY_UPLOAD_CONCURRENCY, queue.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (queue.length > 0 && this.owns(this.meta.id)) {
          if (chatPriorityActive()) break;
          const index = queue.shift();
          const buffer = await this.readChunk(index);
          if (!buffer) continue;
          await this.uploadServerChunk(index, buffer, { force: true });
          await wait(HTTP_UPLOAD_GAP_MS);
        }
      })
    ).catch(() => {});
  }

  async uploadServerChunk(index, buffer = null, options = {}) {
    if (!this.owns(this.meta?.id) || !Number.isInteger(index)) return false;
    if (this.serverUploadInFlight.has(index)) return true;
    if (!options.force && this.uploadedToServer.has(index)) return true;
    this.serverUploadInFlight.add(index);
    try {
      const payload = buffer || (await this.readChunk(index));
      if (!payload) return false;
      const response = await fetchWithTimeout(`/api/chunks/${encodeURIComponent(this.meta.id)}/${index}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: payload
      }, 25000);
      if (!response.ok) return false;
      const result = await response.json().catch(() => null);
      if (result?.ok) this.markUploaded(index);
      return Boolean(result?.ok);
    } finally {
      this.serverUploadInFlight.delete(index);
    }
  }

  markUploaded(index) {
    this.uploadedToServer.set(index, Date.now());
    if (this.uploadedToServer.size <= HTTP_UPLOADED_TRACK_LIMIT) return;
    const stale = Array.from(this.uploadedToServer, ([key, value]) => ({ key, value }))
      .sort((a, b) => a.value - b.value)
      .slice(0, this.uploadedToServer.size - HTTP_UPLOADED_TRACK_LIMIT);
    stale.forEach(({ key }) => this.uploadedToServer.delete(key));
  }

  async sendChunk(peerId, index) {
    const buffer = await this.readChunk(index);
    if (!buffer) return false;
    const sent = await this.mesh.sendChunk(peerId, { videoId: this.meta.id, index }, buffer);
    await wait(8);
    return sent;
  }

  async readChunk(index) {
    if (!this.file || !this.meta || !Number.isInteger(index)) return null;
    const start = index * this.meta.chunkSize;
    if (start < 0 || start >= this.file.size) return null;
    const end = Math.min(start + this.meta.chunkSize, this.file.size);
    return this.file.slice(start, end).arrayBuffer();
  }
}
