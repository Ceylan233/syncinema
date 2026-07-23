import { MP4Remuxer } from "./mp4remuxer.js";

const CHUNK_BYTES = 1024 * 1024;
const MAX_IN_FLIGHT = 4;
const TARGET_BUFFER_SECONDS = 45;
const MAX_QUEUED_SEGMENTS = 96;
const RETRY_LIMIT = 3;

function parseContentRange(value) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(String(value || "").trim());
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: Number(match[3])
  };
}

export class ParallelVodLoader {
  constructor(video, ui, onFatal = null) {
    this.video = video;
    this.ui = ui;
    this.onFatal = onFatal;
    this.meta = null;
    this.playUrl = "";
    this.remuxer = null;
    this.totalBytes = 0;
    this.totalChunks = 0;
    this.requested = new Map();
    this.retries = new Map();
    this.loaded = new Set();
    this.failed = false;
    this.destroyed = false;
    this.timer = null;
    this.sessionId = Math.random().toString(36).slice(2);
    this.onWaiting = () => this.requestMore(true);
    this.onTimeUpdate = () => this.requestMore();
    this.onSeeking = () => this.prioritizeCurrentTime();
    this.onCanPlay = () => this.requestMore();
  }

  async start(meta, playUrl) {
    if (!meta?.id || !String(playUrl).includes("/api/bilibili/video/stream")) return false;
    if (!("MediaSource" in window)) return false;

    this.meta = meta;
    this.playUrl = playUrl;
    const probe = await this.fetchRange(0, CHUNK_BYTES - 1, "probe").catch(() => null);
    const contentRange = parseContentRange(probe?.response?.headers.get("content-range"));
    if (!probe?.buffer?.byteLength || !contentRange?.total) return false;

    this.totalBytes = contentRange.total;
    this.totalChunks = Math.ceil(this.totalBytes / CHUNK_BYTES);
    this.remuxer = new MP4Remuxer(this.video, this.ui);
    const started = this.remuxer.start({
      ...meta,
      type: "video/mp4",
      chunkSize: CHUNK_BYTES,
      size: this.totalBytes,
      totalChunks: this.totalChunks
    });
    if (!started) {
      this.remuxer.destroy();
      this.remuxer = null;
      return false;
    }

    this.bind();
    this.acceptChunk(0, probe.buffer);
    this.timer = window.setInterval(() => this.requestMore(), 250);
    this.ui.setTransfer?.("B站点播：四连接分段加载", 0);
    this.requestMore(true);
    return true;
  }

  bind() {
    this.video.addEventListener("waiting", this.onWaiting);
    this.video.addEventListener("timeupdate", this.onTimeUpdate);
    this.video.addEventListener("seeking", this.onSeeking);
    this.video.addEventListener("canplay", this.onCanPlay);
  }

  unbind() {
    this.video.removeEventListener("waiting", this.onWaiting);
    this.video.removeEventListener("timeupdate", this.onTimeUpdate);
    this.video.removeEventListener("seeking", this.onSeeking);
    this.video.removeEventListener("canplay", this.onCanPlay);
  }

  async fetchRange(start, end, lane) {
    const url = new URL(this.playUrl, window.location.href);
    url.searchParams.set("parallel", "1");
    url.searchParams.set("lane", String(lane));
    url.searchParams.set("session", this.sessionId);
    const response = await fetch(`${url.pathname}${url.search}`, {
      cache: "no-store",
      headers: { Range: `bytes=${start}-${end}` }
    });
    if (response.status !== 206) throw new Error(`parallel-vod-${response.status}`);
    return { response, buffer: await response.arrayBuffer() };
  }

  requestMore(force = false) {
    if (this.destroyed || this.failed || !this.remuxer || !this.totalChunks) return;
    if (this.remuxer.failed) {
      this.fail(new Error("parallel-vod-remux-failed"));
      return;
    }
    if (
      !force &&
      this.remuxer.ready &&
      (this.bufferedAhead() >= TARGET_BUFFER_SECONDS || this.remuxer.queue.length >= MAX_QUEUED_SEGMENTS)
    ) return;

    const candidates = this.requestCandidates(MAX_IN_FLIGHT - this.requested.size);
    candidates.forEach((index, lane) => this.requestChunk(index, lane));
    this.updateStatus();
  }

  requestCandidates(limit) {
    if (limit <= 0) return [];
    const result = [];
    const add = (index) => {
      if (!Number.isInteger(index) || index < 0 || index >= this.totalChunks) return;
      if (this.loaded.has(index) || this.requested.has(index) || result.includes(index)) return;
      result.push(index);
    };

    if (!this.remuxer.ready) {
      for (let offset = 0; offset < 4 && result.length < limit; offset += 1) {
        add(offset);
        add(this.totalChunks - 1 - offset);
      }
    }

    const hint = Math.min(
      this.totalChunks - 1,
      Math.max(0, Number(this.remuxer.nextChunkHint || 0))
    );
    for (let offset = 0; offset < 32 && result.length < limit; offset += 1) add(hint + offset);
    for (let index = 0; index < this.totalChunks && result.length < limit; index += 1) add(index);
    return result;
  }

  async requestChunk(index, lane) {
    if (this.destroyed || this.requested.has(index) || this.loaded.has(index)) return;
    const attempt = Number(this.retries.get(index) || 0) + 1;
    const controller = new AbortController();
    this.requested.set(index, { attempt, controller });
    const start = index * CHUNK_BYTES;
    const end = Math.min(this.totalBytes - 1, start + CHUNK_BYTES - 1);

    try {
      const url = new URL(this.playUrl, window.location.href);
      url.searchParams.set("parallel", "1");
      url.searchParams.set("lane", String(lane));
      url.searchParams.set("session", this.sessionId);
      url.searchParams.set("chunk", String(index));
      const response = await fetch(`${url.pathname}${url.search}`, {
        cache: "no-store",
        headers: { Range: `bytes=${start}-${end}` },
        signal: controller.signal
      });
      if (response.status !== 206) throw new Error(`parallel-vod-${response.status}`);
      const buffer = await response.arrayBuffer();
      if (!buffer.byteLength) throw new Error("parallel-vod-empty");
      if (this.destroyed) return;
      this.retries.delete(index);
      this.acceptChunk(index, buffer);
    } catch (error) {
      if (this.destroyed || error?.name === "AbortError") return;
      this.requested.delete(index);
      this.retries.set(index, attempt);
      if (attempt < RETRY_LIMIT) {
        window.setTimeout(() => this.requestChunk(index, lane), 250 * attempt);
        return;
      }
      this.fail(error);
      return;
    } finally {
      const current = this.requested.get(index);
      if (current?.controller === controller) this.requested.delete(index);
    }
    this.requestMore();
  }

  acceptChunk(index, buffer) {
    if (this.destroyed || this.loaded.has(index)) return;
    this.loaded.add(index);
    this.remuxer.appendChunk(index, buffer);
    this.updateStatus();
  }

  prioritizeCurrentTime() {
    if (!this.remuxer || this.destroyed) return;
    this.remuxer.seek(Number(this.video.currentTime || 0));
    this.requestMore(true);
  }

  bufferedAhead() {
    const time = Number(this.video.currentTime || 0);
    const ranges = this.video.buffered;
    for (let index = 0; index < ranges.length; index += 1) {
      if (ranges.start(index) <= time + 0.25 && ranges.end(index) >= time) {
        return Math.max(0, ranges.end(index) - time);
      }
    }
    return 0;
  }

  updateStatus() {
    const ahead = Math.floor(this.bufferedAhead());
    const percent = this.totalChunks ? Math.round((this.loaded.size / this.totalChunks) * 100) : 0;
    this.ui.setTransfer?.(
      `B站点播：四连接分段加载（缓冲 ${ahead}s，并行 ${this.requested.size}/4）`,
      percent
    );
  }

  fail(error) {
    if (this.failed || this.destroyed) return;
    this.failed = true;
    console.warn("Parallel Bilibili VOD failed", error);
    this.onFatal?.(error);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    window.clearInterval(this.timer);
    this.timer = null;
    this.unbind();
    for (const request of this.requested.values()) request.controller?.abort();
    this.requested.clear();
    this.retries.clear();
    this.loaded.clear();
    this.remuxer?.destroy();
    this.remuxer = null;
  }
}
