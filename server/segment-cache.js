class SharedSegmentCache {
  constructor(options = {}) {
    this.fetch = options.fetchImpl || fetch;
    this.headersFor = options.headersFor || (() => ({}));
    this.maxEntries = Math.max(1, Number(options.maxEntries || 480));
    this.maxBytes = Math.max(1, Number(options.maxBytes || 256 * 1024 * 1024));
    this.maxItemBytes = Math.max(1, Number(options.maxItemBytes || 16 * 1024 * 1024));
    this.ttlMs = Math.max(1000, Number(options.ttlMs || 30 * 60 * 1000));
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs || 20000));
    this.now = options.now || (() => Date.now());
    this.entries = new Map();
    this.bytes = 0;
  }

  key(url, referer) {
    return `${url}\n${referer || ""}`;
  }

  touch(key, entry) {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  delete(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes = Math.max(0, this.bytes - (entry.buffer?.length || 0));
  }

  trim() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (!entry.promise && entry.expiresAt <= now) this.delete(key);
    }
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value;
      if (!oldestKey) break;
      const oldest = this.entries.get(oldestKey);
      if (oldest?.promise) {
        this.touch(oldestKey, oldest);
        if (Array.from(this.entries.values()).every((entry) => entry.promise)) break;
        continue;
      }
      this.delete(oldestKey);
    }
  }

  async readBounded(response) {
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > this.maxItemBytes) {
      const error = new Error("vod-segment-too-large");
      error.status = 413;
      throw error;
    }

    if (!response.body?.getReader) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > this.maxItemBytes) {
        const error = new Error("vod-segment-too-large");
        error.status = 413;
        throw error;
      }
      return buffer;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.maxItemBytes) {
        await reader.cancel().catch(() => {});
        const error = new Error("vod-segment-too-large");
        error.status = 413;
        throw error;
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  }

  async get(url, referer = "") {
    const key = this.key(url, referer);
    const cached = this.entries.get(key);
    if (cached?.buffer && cached.expiresAt > this.now()) {
      this.touch(key, cached);
      return { ...cached, cacheStatus: "HIT" };
    }
    if (cached?.promise) {
      const entry = await cached.promise;
      return { ...entry, cacheStatus: "COALESCED" };
    }
    if (cached) this.delete(key);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const promise = (async () => {
      const response = await this.fetch(url, {
        headers: this.headersFor(referer),
        redirect: "follow",
        signal: controller.signal
      });
      if (!response.ok) {
        const error = new Error(`vod-segment-${response.status}`);
        error.status = response.status;
        throw error;
      }
      const buffer = await this.readBounded(response);
      const entry = {
        buffer,
        contentType: response.headers.get("content-type") || "application/octet-stream",
        expiresAt: this.now() + this.ttlMs
      };
      this.entries.set(key, entry);
      this.bytes += buffer.length;
      this.trim();
      return entry;
    })().catch((error) => {
      this.delete(key);
      throw error;
    }).finally(() => {
      clearTimeout(timer);
    });

    this.entries.set(key, { promise, expiresAt: this.now() + this.timeoutMs });
    const entry = await promise;
    return { ...entry, cacheStatus: "MISS" };
  }

  stats() {
    return { entries: this.entries.size, bytes: this.bytes };
  }
}

module.exports = { SharedSegmentCache };
