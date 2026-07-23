function parseByteRange(value) {
  const match = /^bytes=(\d+)-(\d*)$/i.exec(String(value || "").trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : null;
  if (!Number.isSafeInteger(start) || start < 0) return null;
  if (end !== null && (!Number.isSafeInteger(end) || end < start)) return null;
  return { start, end };
}

function parseContentRange(value) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value || "").trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === "*" ? null : Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
  return { start, end, total: Number.isSafeInteger(total) ? total : null };
}

async function readUpTo(response, limit) {
  if (!response.body?.getReader) {
    return Buffer.from(await response.arrayBuffer()).subarray(0, limit);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = limit - total;
    const chunk = Buffer.from(value).subarray(0, remaining);
    chunks.push(chunk);
    total += chunk.length;
    if (chunk.length < value.byteLength || total >= limit) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return Buffer.concat(chunks, total);
}

class SharedRangeCache {
  constructor(options = {}) {
    this.fetch = options.fetchImpl || fetch;
    this.headersFor = options.headersFor || (() => ({}));
    this.blockBytes = Math.max(1, Number(options.blockBytes || 4 * 1024 * 1024));
    this.responseBytes = Math.max(this.blockBytes, Number(options.responseBytes || this.blockBytes));
    this.startupLimitBytes = Math.max(this.blockBytes, Number(options.startupLimitBytes || 12 * 1024 * 1024));
    this.maxEntries = Math.max(1, Number(options.maxEntries || 16));
    this.maxBytes = Math.max(this.blockBytes, Number(options.maxBytes || 64 * 1024 * 1024));
    this.ttlMs = Math.max(1000, Number(options.ttlMs || 10 * 60 * 1000));
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs || 12000));
    this.now = options.now || (() => Date.now());
    this.entries = new Map();
    this.bytes = 0;
  }

  key(url, referer, start) {
    return `${url}\n${referer || ""}\n${start}`;
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
      const key = this.entries.keys().next().value;
      if (!key) break;
      const entry = this.entries.get(key);
      if (entry?.promise) {
        this.touch(key, entry);
        if (Array.from(this.entries.values()).every((item) => item.promise)) break;
        continue;
      }
      this.delete(key);
    }
  }

  async fetchBlock(url, referer, blockStart) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(url, {
        headers: {
          ...this.headersFor(referer),
          Range: `bytes=${blockStart}-${blockStart + this.blockBytes - 1}`
        },
        redirect: "follow",
        signal: controller.signal
      });
      if (!response.ok) {
        const error = new Error(`range-cache-${response.status}`);
        error.status = response.status;
        throw error;
      }

      const contentRange = parseContentRange(response.headers.get("content-range"));
      if (response.status === 200 && blockStart !== 0) throw new Error("range-cache-not-supported");
      const actualStart = contentRange?.start ?? 0;
      if (actualStart !== blockStart) throw new Error("range-cache-offset-mismatch");

      const buffer = await readUpTo(response, this.blockBytes);
      if (!buffer.length) throw new Error("range-cache-empty");
      const declaredLength = Number(response.headers.get("content-length") || 0);
      const total = contentRange?.total || (response.status === 200 && declaredLength > 0 ? declaredLength : null);
      return {
        buffer,
        start: actualStart,
        end: actualStart + buffer.length - 1,
        total,
        contentType: response.headers.get("content-type") || "video/mp4",
        expiresAt: this.now() + this.ttlMs
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async block(url, referer, blockStart) {
    const key = this.key(url, referer, blockStart);
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

    const promise = this.fetchBlock(url, referer, blockStart)
      .then((entry) => {
        this.entries.set(key, entry);
        this.bytes += entry.buffer.length;
        this.trim();
        return entry;
      })
      .catch((error) => {
        this.delete(key);
        throw error;
      });
    this.entries.set(key, { promise, expiresAt: this.now() + this.timeoutMs });
    const entry = await promise;
    return { ...entry, cacheStatus: "MISS" };
  }

  async get(url, referer, rangeHeader) {
    const requested = parseByteRange(rangeHeader);
    if (!requested) return null;
    const blockStart = Math.floor(requested.start / this.blockBytes) * this.blockBytes;
    if (blockStart >= this.startupLimitBytes) return null;

    const first = await this.block(url, referer, blockStart);
    if (requested.start < first.start || requested.start > first.end) return null;

    const requestedEnd = requested.end ?? requested.start + this.responseBytes - 1;
    const responseEnd = Math.min(
      requestedEnd,
      requested.start + this.responseBytes - 1,
      Number.isSafeInteger(first.total) ? first.total - 1 : Number.MAX_SAFE_INTEGER
    );
    const lastBlockStart = Math.floor(responseEnd / this.blockBytes) * this.blockBytes;
    const blockStarts = [];
    for (let start = blockStart + this.blockBytes; start <= lastBlockStart; start += this.blockBytes) {
      if (start >= this.startupLimitBytes) break;
      blockStarts.push(start);
    }
    const remaining = await Promise.all(blockStarts.map((start) => this.block(url, referer, start)));
    const entries = [first, ...remaining].sort((left, right) => left.start - right.start);
    const slices = [];
    let cursor = requested.start;
    let cacheStatus = "HIT";
    let total = first.total;
    for (const entry of entries) {
      if (entry.start > cursor || entry.end < cursor) break;
      const end = Math.min(responseEnd, entry.end);
      slices.push(entry.buffer.subarray(cursor - entry.start, end - entry.start + 1));
      cursor = end + 1;
      if (entry.cacheStatus === "MISS") cacheStatus = "MISS";
      else if (entry.cacheStatus === "COALESCED" && cacheStatus === "HIT") cacheStatus = "COALESCED";
      if (Number.isSafeInteger(entry.total)) total = entry.total;
      if (cursor > responseEnd) break;
    }
    if (!slices.length) return null;
    const buffer = slices.length === 1 ? slices[0] : Buffer.concat(slices);
    return {
      buffer,
      start: requested.start,
      end: requested.start + buffer.length - 1,
      total,
      contentType: first.contentType,
      cacheStatus
    };
  }

  stats() {
    return { entries: this.entries.size, bytes: this.bytes };
  }
}

module.exports = { SharedRangeCache, parseByteRange, parseContentRange };
