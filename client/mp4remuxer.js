import { createFile } from "./vendor/mp4box/mp4box.all.mjs";

const MAX_BUFFER_AHEAD = 100;
const KEEP_BEHIND = 35;

export class MP4Remuxer {
  constructor(video, ui) {
    this.video = video;
    this.ui = ui;
    this.mp4box = null;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.queue = [];
    this.ready = false;
    this.failed = false;
    this.nextChunkHint = 0;
    this.chunkSize = 0;
    this.objectUrl = null;
    this.onTimeUpdate = null;
    this.duration = 0;
  }

  start(meta) {
    if (!/mp4|m4v|quicktime/i.test(meta.type || meta.name || "")) return false;
    if (!("MediaSource" in window)) return false;

    this.chunkSize = meta.chunkSize;
    this.mp4box = createFile(true);
    this.mediaSource = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.mediaSource);
    this.video.src = this.objectUrl;
    this.onTimeUpdate = () => this.flushQueue();
    this.video.addEventListener("timeupdate", this.onTimeUpdate);

    this.mediaSource.addEventListener("sourceopen", () => {
      if (this.duration > 0) this.mediaSource.duration = this.duration;
      this.flushQueue();
    });
    this.mp4box.onError = (error) => {
      console.warn("MP4 remux failed", error);
      this.failed = true;
      this.ui.addSystemMessage("MP4 转成流式分片失败，这个文件可能不能边收边播。");
    };
    this.mp4box.onReady = (info) => this.handleReady(info);
    this.mp4box.onSegment = (id, _user, buffer, sampleNumber) => {
      this.enqueue(buffer);
      this.mp4box.releaseUsedSamples(id, sampleNumber);
    };

    this.ui.addSystemMessage("正在读取 MP4 元数据，准备按需转成可边播的流式分片。");
    return true;
  }

  appendChunk(index, buffer) {
    if (!this.mp4box || this.failed) return;

    const chunk = buffer.slice(0);
    chunk.fileStart = index * this.chunkSize;
    const next = this.mp4box.appendBuffer(chunk);
    this.updateNextHint(next);
  }

  seek(time) {
    if (!this.ready || !this.mp4box || !Number.isFinite(time)) return;

    try {
      const result = this.mp4box.seek(Math.max(0, time), true);
      this.updateNextHint(result?.offset);
    } catch (error) {
      console.warn("MP4 remux seek failed", error);
    }
  }

  handleReady(info) {
    const tracks = info.tracks.filter((track) => track.codec && (track.video || track.audio));
    if (tracks.length === 0) {
      this.failed = true;
      this.ui.addSystemMessage("没有找到浏览器可播放的音视频轨道。");
      return;
    }

    const mime = `video/mp4; codecs="${tracks.map((track) => track.codec).join(",")}"`;
    if (!MediaSource.isTypeSupported(mime)) {
      this.failed = true;
      this.ui.addSystemMessage(`当前浏览器不支持 ${mime}，无法边收边播。`);
      return;
    }

    try {
      this.duration = this.durationFromInfo(info, tracks);
      if (this.duration > 0 && this.mediaSource.readyState === "open") {
        this.mediaSource.duration = this.duration;
      }

      this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);
      this.sourceBuffer.mode = "segments";
      this.sourceBuffer.addEventListener("updateend", () => this.flushQueue());

      for (const track of tracks) {
        this.mp4box.setSegmentOptions(track.id, null, {
          nbSamples: 24,
          rapAlignement: true,
          normalizeAudioSampleEntriesForMSE: true
        });
      }

      const init = this.mp4box.initializeSegmentation();
      if (init?.buffer) this.enqueue(init.buffer);
      else if (Array.isArray(init)) init.forEach((segment) => this.enqueue(segment.buffer));

      this.ready = true;
      this.mp4box.start();
      this.seek(this.video.currentTime || 0);
      this.ui.addSystemMessage("流式分片已就绪，现在只会缓冲播放附近的数据。");
      this.flushQueue();
    } catch (error) {
      console.warn("MSE setup for remux failed", error);
      this.failed = true;
      this.ui.addSystemMessage("浏览器创建流式播放器失败，这个视频可能需要完整接收后播放。");
    }
  }

  durationFromInfo(info, tracks) {
    if (Number.isFinite(info.duration) && Number.isFinite(info.timescale) && info.timescale > 0) {
      return info.duration / info.timescale;
    }

    const durations = tracks
      .map((track) =>
        Number.isFinite(track.duration) && Number.isFinite(track.timescale) && track.timescale > 0
          ? track.duration / track.timescale
          : 0
      )
      .filter((duration) => duration > 0);
    return durations.length > 0 ? Math.max(...durations) : 0;
  }

  updateNextHint(offset) {
    if (Number.isFinite(offset) && offset >= 0 && this.chunkSize > 0) {
      this.nextChunkHint = Math.floor(offset / this.chunkSize);
    }
  }

  enqueue(buffer) {
    if (!buffer || this.failed) return;
    this.queue.push(buffer);
    this.flushQueue();
  }

  flushQueue() {
    if (!this.sourceBuffer || this.sourceBuffer.updating || this.queue.length === 0) return;
    if (this.mediaSource.readyState !== "open") return;
    if (this.bufferedAhead() > MAX_BUFFER_AHEAD) return;

    try {
      this.sourceBuffer.appendBuffer(this.queue[0]);
      this.queue.shift();
    } catch (error) {
      if (error?.name === "QuotaExceededError" && this.trimBuffer()) return;
      console.warn("Appending remuxed segment failed", error);
      this.failed = true;
      this.ui.addSystemMessage("追加流式分片失败，当前视频可能不兼容边播。");
    }
  }

  bufferedAhead() {
    const time = this.video.currentTime || 0;
    const ranges = this.sourceBuffer?.buffered;
    if (!ranges) return 0;
    for (let index = 0; index < ranges.length; index += 1) {
      if (ranges.start(index) <= time + 0.25 && ranges.end(index) >= time) {
        return ranges.end(index) - time;
      }
    }
    return 0;
  }

  trimBuffer() {
    if (!this.sourceBuffer || this.sourceBuffer.updating) return false;
    const ranges = this.sourceBuffer.buffered;
    const currentTime = this.video.currentTime || 0;
    const removeBehindEnd = currentTime - KEEP_BEHIND;

    try {
      for (let index = 0; index < ranges.length; index += 1) {
        const start = ranges.start(index);
        const end = ranges.end(index);
        if (removeBehindEnd > 1 && start < removeBehindEnd) {
          this.sourceBuffer.remove(start, Math.min(end, removeBehindEnd));
          return true;
        }
      }

      const keepAheadEnd = currentTime + MAX_BUFFER_AHEAD;
      for (let index = 0; index < ranges.length; index += 1) {
        const start = ranges.start(index);
        const end = ranges.end(index);
        if (end > keepAheadEnd) {
          this.sourceBuffer.remove(Math.max(start, keepAheadEnd), end);
          return true;
        }
      }
    } catch (error) {
      console.warn("Removing buffer failed", error);
    }

    return false;
  }

  destroy() {
    this.queue = [];
    if (this.onTimeUpdate) this.video.removeEventListener("timeupdate", this.onTimeUpdate);
    this.onTimeUpdate = null;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }
}
