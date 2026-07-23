const path = require("path");
const fs = require("fs");
const { Readable } = require("stream");
const express = require("express");
const compression = require("compression");
const http = require("http");
const https = require("https");
const { Server } = require("socket.io");
const config = require("./config");
const attachSocketHandlers = require("./socket");
const { isBilibiliUrl, resolveBilibiliStream, resolveBilibiliUrl } = require("./bilibili");
const { createSensitiveFilter } = require("./sensitive");
const { SharedSegmentCache } = require("./segment-cache");
const { SharedRangeCache } = require("./range-cache");

const app = express();
function readHttpsOptions() {
  const pfxPath = config.https?.pfxPath ? path.resolve(config.https.pfxPath) : "";
  const keyPath = config.https?.keyPath ? path.resolve(config.https.keyPath) : "";
  const certPath = config.https?.certPath ? path.resolve(config.https.certPath) : "";

  if (pfxPath && fs.existsSync(pfxPath)) {
    return {
      pfx: fs.readFileSync(pfxPath),
      passphrase: config.https.pfxPassphrase || undefined
    };
  }

  if (keyPath && certPath && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    };
  }

  return null;
}

const httpsOptions = readHttpsOptions();
const server = httpsOptions ? https.createServer(httpsOptions, app) : http.createServer(app);
const io = new Server(server, {
  cors: { origin: config.corsOrigin },
  transports: ["websocket"],
  maxHttpBufferSize: config.maxHttpBufferSize,
  pingTimeout: 60000,
  pingInterval: 25000
});

const clientDir = config.clientDir
  ? path.resolve(config.clientDir)
  : path.resolve(__dirname, "..", "client");

app.disable("x-powered-by");
app.use(compression({ threshold: 1024, level: 6 }));
app.use(express.json({ limit: "2mb" }));

const sensitiveFilter = createSensitiveFilter();
const roomState = attachSocketHandlers(io, { sensitiveFilter });
const demoVideoPath = path.resolve(__dirname, "demo", "demo.mp4");
const HTTP_CHUNK_WAIT_MAX_MS = 9000;
const STREAM_CHUNK_WAIT_MS = 12000;
const STREAM_WINDOW_BYTES = 12 * 1024 * 1024;
const STREAM_PRELOAD_AHEAD_CHUNKS = 32;
const STREAM_PRELOAD_BEHIND_CHUNKS = 2;
const httpChunkWaiters = new Map();
const SPEED_TEST_CHUNK = Buffer.allocUnsafe(256 * 1024);
const sensitiveAdminAttempts = new Map();
const bilibiliLiveCache = new Map();
const bilibiliLivePinnedLines = new Map();
const bilibiliVideoResolveCache = new Map();
const remoteTextCache = new Map();
const BILIBILI_LIVE_CACHE_TTL_MS = 30 * 1000;
const BILIBILI_VIDEO_RESOLVE_TTL_MS = 2 * 60 * 1000;
const REMOTE_TEXT_TIMEOUT_MS = 12000;
const REMOTE_PAGE_CACHE_TTL_MS = 30 * 1000;
const liveSegmentCache = new Map();
const LIVE_SEGMENT_CACHE_MAX_ENTRIES = 180;
const LIVE_SEGMENT_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const LIVE_SEGMENT_MAX_ITEM_BYTES = 6 * 1024 * 1024;
let liveSegmentCacheBytes = 0;
const vodSegmentCache = new SharedSegmentCache({
  headersFor: sourceHeaders,
  maxEntries: 480,
  maxBytes: 256 * 1024 * 1024,
  maxItemBytes: 16 * 1024 * 1024,
  ttlMs: 30 * 60 * 1000,
  timeoutMs: 20000
});
const bilibiliVodRangeCache = new SharedRangeCache({
  headersFor: sourceHeaders,
  blockBytes: 1 * 1024 * 1024,
  startupLimitBytes: Number.MAX_SAFE_INTEGER,
  maxEntries: 64,
  maxBytes: 64 * 1024 * 1024,
  ttlMs: 10 * 60 * 1000,
  timeoutMs: 12000
});
const SENSITIVE_ADMIN_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const SENSITIVE_ADMIN_MAX_FAILURES = 8;

for (let index = 0; index < SPEED_TEST_CHUNK.length; index += 1) {
  SPEED_TEST_CHUNK[index] = (index * 31 + 17) & 255;
}

function isSafeRemoteUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ""));
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase();
    return !["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(host);
  } catch {
    return false;
  }
}

function sensitiveAdminClientKey(req) {
  const remote = String(req.socket?.remoteAddress || "unknown");
  if (["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) {
    return String(req.headers["x-forwarded-for"] || remote).split(",")[0].trim();
  }
  return remote;
}

function sensitiveAdminAttempt(req) {
  const key = sensitiveAdminClientKey(req);
  const now = Date.now();
  const previous = sensitiveAdminAttempts.get(key);
  if (!previous || now - previous.startedAt >= SENSITIVE_ADMIN_ATTEMPT_WINDOW_MS) {
    const fresh = { key, startedAt: now, failures: 0 };
    sensitiveAdminAttempts.set(key, fresh);
    return fresh;
  }
  return { key, ...previous };
}

function proxiedUrl(route, url, referer = "", extraParams = {}) {
  const params = new URLSearchParams({ url });
  if (referer) params.set("referer", referer);
  for (const [key, value] of Object.entries(extraParams)) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  return `/api/source/${route}?${params.toString()}`;
}

function bilibiliVideoUrl(resolved, quality = resolved.quality || 80) {
  const params = new URLSearchParams({ qn: String(quality) });
  if (resolved.episodeId) params.set("epId", String(resolved.episodeId));
  else {
    params.set("bvid", String(resolved.bvid || ""));
    params.set("cid", String(resolved.cid || ""));
  }
  return `/api/bilibili/video/stream?${params.toString()}`;
}

function withBilibiliQualityUrls(resolved) {
  return {
    ...resolved,
    lineCount: Math.min(6, Math.max(1, Array.isArray(resolved.mediaUrls) ? resolved.mediaUrls.length : 1)),
    qualities: Array.isArray(resolved.qualities)
      ? resolved.qualities.map((item) => ({
          ...item,
          playUrl: bilibiliVideoUrl(resolved, item.quality)
        }))
      : [],
    playUrl: bilibiliVideoUrl(resolved, resolved.quality)
  };
}

function sourceHeaders(referer = "") {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    Accept: "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    ...(referer ? { Referer: referer } : {})
  };
}

function rememberBilibiliLive(resolved, requestedQuality = 10000) {
  if (!resolved?.live || !resolved.roomId) return resolved;
  const expiresAt = Date.now() + BILIBILI_LIVE_CACHE_TTL_MS;
  const entry = { value: resolved, expiresAt };
  bilibiliLiveCache.set(`${resolved.roomId}:${Number(requestedQuality) || 10000}`, entry);
  bilibiliLiveCache.set(`${resolved.roomId}:${Number(resolved.quality) || 0}`, entry);
  for (const line of Array.isArray(resolved.liveLines) ? resolved.liveLines : []) {
    const host = cleanCdnHost(line?.host);
    if (!host || !line?.url) continue;
    const pinKey = `${resolved.roomId}:${Number(line.quality || resolved.quality) || 0}:${host}`;
    const existingPin = bilibiliLivePinnedLines.get(pinKey);
    if (existingPin?.line && existingPin.expiresAt > Date.now()) continue;
    let lineExpiresAt = Date.now() + 10 * 60 * 1000;
    try {
      const signedExpiry = Number(new URL(line.url).searchParams.get("expires"));
      if (Number.isFinite(signedExpiry) && signedExpiry > 0) {
        lineExpiresAt = Math.max(Date.now() + 30 * 1000, signedExpiry * 1000 - 60 * 1000);
      }
    } catch {
      // Keep the conservative fallback expiry for unusual upstream URLs.
    }
    bilibiliLivePinnedLines.set(pinKey, { line, expiresAt: lineExpiresAt });
  }
  return resolved;
}

async function resolveBilibiliLiveCached(roomId, quality = 10000) {
  const key = `${roomId}:${Number(quality) || 10000}`;
  const cached = bilibiliLiveCache.get(key);
  if (cached?.value && cached.expiresAt > Date.now()) return cached.value;
  if (cached?.promise) return cached.promise;

  const promise = resolveBilibiliUrl(`https://live.bilibili.com/${roomId}`, fetch, { quality })
    .then((resolved) => rememberBilibiliLive(resolved, quality))
    .finally(() => {
      const current = bilibiliLiveCache.get(key);
      if (current?.promise) bilibiliLiveCache.delete(key);
    });
  bilibiliLiveCache.set(key, { promise, expiresAt: Date.now() + 10000 });
  return promise;
}

async function resolveBilibiliVideoCached({ bvid, cid, episodeId, quality, referer }) {
  const key = [episodeId ? `ep:${episodeId}` : `bv:${bvid}:${cid}`, Number(quality) || 80].join(":");
  const cached = bilibiliVideoResolveCache.get(key);
  if (cached?.value && cached.expiresAt > Date.now()) return cached.value;
  if (cached?.promise) return cached.promise;

  const promise = resolveBilibiliStream({ bvid, cid, episodeId, quality, referer })
    .then((value) => {
      bilibiliVideoResolveCache.set(key, {
        value,
        expiresAt: Date.now() + BILIBILI_VIDEO_RESOLVE_TTL_MS
      });
      if (bilibiliVideoResolveCache.size > 120) {
        const oldestKey = bilibiliVideoResolveCache.keys().next().value;
        if (oldestKey && oldestKey !== key) bilibiliVideoResolveCache.delete(oldestKey);
      }
      return value;
    })
    .catch((error) => {
      bilibiliVideoResolveCache.delete(key);
      throw error;
    });
  bilibiliVideoResolveCache.set(key, { promise, expiresAt: Date.now() + 10000 });
  return promise;
}

function cleanCdnHost(value) {
  const host = String(value || "").trim().toLowerCase().slice(0, 255);
  return /^[a-z0-9.-]+$/.test(host) ? host : "";
}

function selectBilibiliLiveLine(resolved, preferredHost = "") {
  const lines = Array.isArray(resolved?.liveLines) ? resolved.liveLines : [];
  const host = cleanCdnHost(preferredHost);
  if (host && resolved?.roomId) {
    const key = `${resolved.roomId}:${Number(resolved.quality) || 0}:${host}`;
    const pinned = bilibiliLivePinnedLines.get(key);
    if (pinned?.line && pinned.expiresAt > Date.now()) return pinned.line;
    if (pinned) bilibiliLivePinnedLines.delete(key);
  }
  const current = lines.find((line) => cleanCdnHost(line.host) === host);
  if (current) return current;
  return lines[0] || {
    host: "",
    url: resolved?.mediaUrl || ""
  };
}

function isBilibiliLiveSegment(url, referer = "") {
  try {
    const source = new URL(String(url || ""));
    const sourceHost = source.hostname.toLowerCase();
    const liveReferer = new URL(String(referer || ""));
    return source.pathname.toLowerCase().endsWith(".m4s") &&
      (sourceHost === "bilivideo.com" || sourceHost.endsWith(".bilivideo.com")) &&
      liveReferer.hostname.toLowerCase() === "live.bilibili.com";
  } catch {
    return false;
  }
}

function trimLiveSegmentCache() {
  const now = Date.now();
  for (const [key, entry] of liveSegmentCache) {
    if (entry.promise || entry.expiresAt > now) continue;
    liveSegmentCache.delete(key);
    liveSegmentCacheBytes -= entry.buffer?.length || 0;
  }
  while (liveSegmentCache.size > LIVE_SEGMENT_CACHE_MAX_ENTRIES || liveSegmentCacheBytes > LIVE_SEGMENT_CACHE_MAX_BYTES) {
    const oldest = liveSegmentCache.keys().next().value;
    if (!oldest) break;
    const entry = liveSegmentCache.get(oldest);
    if (entry?.promise) break;
    liveSegmentCache.delete(oldest);
    liveSegmentCacheBytes -= entry?.buffer?.length || 0;
  }
}

async function fetchBilibiliLiveSegment(url, referer) {
  const key = String(url);
  const cached = liveSegmentCache.get(key);
  if (cached?.buffer && cached.expiresAt > Date.now()) return cached;
  if (cached?.promise) return cached.promise;

  const promise = (async () => {
    const upstream = await fetch(url, { headers: sourceHeaders(referer), redirect: "follow" });
    if (!upstream.ok) {
      const error = new Error(`live-segment-${upstream.status}`);
      error.status = upstream.status;
      throw error;
    }
    const contentLength = Number(upstream.headers.get("content-length") || 0);
    if (contentLength > LIVE_SEGMENT_MAX_ITEM_BYTES) throw new Error("live-segment-too-large");
    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (buffer.length > LIVE_SEGMENT_MAX_ITEM_BYTES) throw new Error("live-segment-too-large");
    const entry = {
      buffer,
      contentType: upstream.headers.get("content-type") || "video/mp4",
      expiresAt: Date.now() + (url.includes("/h") ? 10 * 60 * 1000 : 45 * 1000)
    };
    liveSegmentCache.set(key, entry);
    liveSegmentCacheBytes += buffer.length;
    trimLiveSegmentCache();
    return entry;
  })().catch((error) => {
    liveSegmentCache.delete(key);
    throw error;
  });
  liveSegmentCache.set(key, { promise, expiresAt: Date.now() + 15000 });
  return promise;
}

function normalizeEscapedMediaUrl(value, baseUrl) {
  const clean = String(value || "")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .trim();
  if (!clean) return null;
  try {
    return new URL(clean, baseUrl).toString();
  } catch {
    return null;
  }
}

function mediaKind(url) {
  const clean = String(url || "").split("?")[0].toLowerCase();
  if (clean.endsWith(".m3u8")) return "hls";
  if (/\.(mp4|webm|ogg|mov|m4v)$/.test(clean)) return "video";
  return "";
}

function rewriteHlsResource(resourceUrl, manifestUrl, referer, options = {}) {
  const absolute = normalizeEscapedMediaUrl(resourceUrl, manifestUrl);
  if (!absolute) return resourceUrl;
  if (options.directResources) return absolute;
  return mediaKind(absolute) === "hls"
    ? proxiedUrl("hls", absolute, referer || manifestUrl)
    : proxiedUrl("stream", absolute, referer || manifestUrl, { hls: 1 });
}

function rewriteHlsManifest(manifest, manifestUrl, referer = "", options = {}) {
  return String(manifest || "")
    .split(/\r?\n/)
    .map((line) => {
      const clean = line.trim();
      if (!clean) return line;
      if (clean.startsWith("#")) {
        return line.replace(/URI=("?)([^",]+)\1/gi, (_match, quote, uri) => {
          const rewritten = rewriteHlsResource(uri, manifestUrl, referer, options);
          return `URI=${quote || '"'}${rewritten}${quote || '"'}`;
        });
      }
      return rewriteHlsResource(clean, manifestUrl, referer, options);
    })
    .join("\n");
}

function extractMediaUrl(html, pageUrl) {
  const text = String(html || "");
  const candidates = [];
  const patterns = [
    /https?:\\?\/\\?\/[^"'<>\\\s]+?\.(?:m3u8|mp4|webm|m4v)(?:\?[^"'<>\\\s]*)?/gi,
    /["']url["']\s*:\s*["']([^"']+)["']/gi,
    /["']file["']\s*:\s*["']([^"']+)["']/gi,
    /source\s*src=["']([^"']+)["']/gi
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text))) {
      const value = match[1] || match[0];
      const url = normalizeEscapedMediaUrl(value, pageUrl);
      if (url && mediaKind(url)) candidates.push(url);
    }
  }

  candidates.sort((left, right) => {
    const leftHls = mediaKind(left) === "hls" ? 1 : 0;
    const rightHls = mediaKind(right) === "hls" ? 1 : 0;
    return rightHls - leftHls;
  });
  return candidates[0] || null;
}

async function fetchRemoteText(url, referer = "", options = {}) {
  const cacheTtlMs = Math.max(0, Number(options.cacheTtlMs || 0));
  const cacheKey = `${url}\n${referer}`;
  const cached = remoteTextCache.get(cacheKey);
  if (cacheTtlMs && cached?.value && cached.expiresAt > Date.now()) return cached.value;
  if (cacheTtlMs && cached?.promise) return cached.promise;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(options.timeoutMs || REMOTE_TEXT_TIMEOUT_MS)));
  const promise = (async () => {
    const response = await fetch(url, {
      headers: sourceHeaders(referer),
      redirect: "follow",
      signal: controller.signal
    });
    if (!response.ok) {
      const error = new Error(`Remote fetch failed: ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const value = await response.text();
    if (cacheTtlMs) {
      remoteTextCache.set(cacheKey, { value, expiresAt: Date.now() + cacheTtlMs });
      while (remoteTextCache.size > 120) remoteTextCache.delete(remoteTextCache.keys().next().value);
    }
    return value;
  })().finally(() => {
    clearTimeout(timer);
    if (remoteTextCache.get(cacheKey)?.promise === promise) remoteTextCache.delete(cacheKey);
  });
  if (cacheTtlMs) remoteTextCache.set(cacheKey, { promise, expiresAt: Date.now() + REMOTE_TEXT_TIMEOUT_MS });
  return promise;
}

function stateFromReq(req) {
  return roomState.roomFromRequest(req);
}

function roomIdFromReq(req) {
  return roomState.normalizeRoomId(req.query?.roomId || req.body?.roomId || "1");
}

function chunkWaitKey(roomId, videoId, index) {
  return `${roomState.normalizeRoomId(roomId)}:${videoId}:${index}`;
}

function removeHttpChunkWaiter(key, waiter) {
  const waiters = httpChunkWaiters.get(key);
  if (!waiters) return;
  waiters.delete(waiter);
  if (waiters.size === 0) httpChunkWaiters.delete(key);
}

function resolveHttpChunkWaiters(roomId, videoId, index, chunk) {
  const key = chunkWaitKey(roomId, videoId, index);
  const waiters = httpChunkWaiters.get(key);
  if (!waiters) return;
  httpChunkWaiters.delete(key);
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.finish(chunk);
  }
}

function waitForRelayChunk(room, roomId, videoId, index, waitMs = STREAM_CHUNK_WAIT_MS) {
  const cached = room.relayChunk(videoId, index);
  if (cached) return Promise.resolve(cached);

  return new Promise((resolve) => {
    const key = chunkWaitKey(roomId, videoId, index);
    const waiter = {
      finish(chunk) {
        resolve(chunk);
      },
      timer: setTimeout(() => {
        removeHttpChunkWaiter(key, waiter);
        resolve(null);
      }, waitMs)
    };
    if (!httpChunkWaiters.has(key)) httpChunkWaiters.set(key, new Set());
    httpChunkWaiters.get(key).add(waiter);
    room.requestRelayChunk({ videoId, index });
    const arrivedBeforeRegistration = room.relayChunk(videoId, index);
    if (arrivedBeforeRegistration) {
      clearTimeout(waiter.timer);
      removeHttpChunkWaiter(key, waiter);
      resolve(arrivedBeforeRegistration);
    }
  });
}

roomState.onRelayChunkStored((roomId, videoId, index, chunk) => {
  resolveHttpChunkWaiters(roomId, videoId, index, chunk);
});

function parseRange(rangeHeader, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(rangeHeader || "").trim());
  if (!match) return null;

  let start = match[1] === "" ? null : Number(match[1]);
  let end = match[2] === "" ? null : Number(match[2]);

  if (start === null && end !== null) {
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (start !== null && end === null) {
    end = Math.min(size - 1, start + STREAM_WINDOW_BYTES - 1);
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    return null;
  }

  return {
    start,
    end: Math.min(end, size - 1)
  };
}

app.get("/api/playback", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(stateFromReq(req).playbackSnapshot());
});

app.get("/api/ice", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ iceServers: config.iceServers });
});

app.get("/api/speed/ping", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    serverTime: Date.now()
  });
});

app.get("/api/speed/download", (req, res) => {
  const mb = Math.min(64, Math.max(1, Number(req.query.mb || 16)));
  const totalBytes = Math.floor(mb * 1024 * 1024);
  let sent = 0;

  res.setHeader("Cache-Control", "no-store, no-transform");
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Length", String(totalBytes));

  function writeMore() {
    while (sent < totalBytes) {
      const remaining = totalBytes - sent;
      const chunk = remaining >= SPEED_TEST_CHUNK.length
        ? SPEED_TEST_CHUNK
        : SPEED_TEST_CHUNK.subarray(0, remaining);
      sent += chunk.length;
      if (!res.write(chunk)) {
        res.once("drain", writeMore);
        return;
      }
    }
    res.end();
  }

  writeMore();
});

app.post(
  "/api/speed/upload",
  express.raw({ type: "application/octet-stream", limit: "64mb" }),
  (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      bytes: Buffer.isBuffer(req.body) ? req.body.length : 0,
      serverTime: Date.now()
    });
  }
);

app.post("/api/playback", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const snapshot = stateFromReq(req).applyPlayback(req.body || {}, {
    id: String(req.body?.clientId || "http"),
    clientId: String(req.body?.clientId || ""),
    name: String(req.body?.name || "HTTP").slice(0, 24)
  }, { coalesceSeek: true });
  res.json(snapshot);
});

app.get("/api/video", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    videoMeta: stateFromReq(req).activeVideoSnapshot()
  });
});

app.get("/api/state", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const state = stateFromReq(req);
  res.json({
    videoMeta: state.activeVideoSnapshot(),
    playback: state.playbackSnapshot()
  });
});

app.post("/api/video", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const meta = stateFromReq(req).setActiveVideoMeta(req.body || {}, {
    id: String(req.body?.clientId || "http-video"),
    clientId: String(req.body?.clientId || ""),
    name: String(req.body?.ownerName || req.body?.name || "HTTP").slice(0, 24)
  });
  res.json({ ok: Boolean(meta), videoMeta: meta });
});

app.post("/api/source-ready", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const meta = stateFromReq(req).markSourceReady(req.body || {});
  res.json({ ok: Boolean(meta), videoMeta: meta });
});

app.post("/api/source/fetch", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const url = String(req.body?.url || "");
  const referer = String(req.body?.referer || "");
  if (!isSafeRemoteUrl(url)) {
    res.status(400).json({ ok: false, error: "bad-url" });
    return;
  }

  try {
    const html = await fetchRemoteText(url, referer, { cacheTtlMs: REMOTE_PAGE_CACHE_TTL_MS });
    res.json({ ok: true, url, html });
  } catch (error) {
    res.status(error.status || 502).json({ ok: false, error: error.message || "fetch-failed" });
  }
});

app.post("/api/source/resolve", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const url = String(req.body?.url || "");
  const referer = String(req.body?.referer || "");
  if (!isSafeRemoteUrl(url)) {
    res.status(400).json({ ok: false, error: "bad-url" });
    return;
  }

  try {
    if (isBilibiliUrl(url)) {
      const resolved = await resolveBilibiliUrl(url, fetch, {
        inspectVideo: Boolean(req.body?.inspectOnly)
      });
      if (resolved.live) {
        rememberBilibiliLive(resolved, 10000);
        res.json({
          ok: true,
          ...resolved,
          playUrl: resolved.kind === "flv"
            ? `/api/bilibili/live/${encodeURIComponent(resolved.roomId)}.flv`
            : `/api/bilibili/live/${encodeURIComponent(resolved.roomId)}.m3u8`,
          pageUrl: url
        });
      } else {
        res.json({
          ok: true,
          ...(resolved.inspectOnly ? resolved : withBilibiliQualityUrls(resolved)),
          pageUrl: url
        });
      }
      return;
    }
    let mediaUrl = url;
    let kind = mediaKind(mediaUrl);
    if (!kind) {
      const html = await fetchRemoteText(url, referer, { cacheTtlMs: REMOTE_PAGE_CACHE_TTL_MS });
      mediaUrl = extractMediaUrl(html, url);
      kind = mediaKind(mediaUrl);
    }
    if (!mediaUrl || !kind) {
      res.status(422).json({ ok: false, error: "media-not-found" });
      return;
    }
    res.json({
      ok: true,
      mediaUrl,
      kind,
      playUrl: kind === "hls" ? proxiedUrl("hls", mediaUrl, referer || url) : proxiedUrl("stream", mediaUrl, referer || url)
    });
  } catch (error) {
    res.status(error.status || 502).json({ ok: false, error: error.message || "resolve-failed" });
  }
});

app.get("/api/bilibili/video/stream", async (req, res) => {
  const bvid = String(req.query.bvid || "").trim();
  const cid = String(req.query.cid || "").replace(/\D/g, "").slice(0, 24);
  const episodeId = String(req.query.epId || "").replace(/\D/g, "").slice(0, 24);
  const quality = Math.max(16, Math.min(127, Number(req.query.qn) || 80));
  if ((!/^BV[0-9A-Za-z]{10}$/i.test(bvid) || !cid) && !episodeId) {
    res.status(400).end();
    return;
  }

  try {
    const referer = episodeId
      ? `https://www.bilibili.com/bangumi/play/ep${episodeId}`
      : `https://www.bilibili.com/video/${bvid}`;
    const resolved = await resolveBilibiliVideoCached({ bvid, cid, episodeId, quality, referer });
    const headers = sourceHeaders(referer);
    if (req.headers.range) headers.Range = req.headers.range;
    const mediaUrls = Array.isArray(resolved.mediaUrls) && resolved.mediaUrls.length
      ? resolved.mediaUrls
      : [resolved.mediaUrl];
    const lineIndex = Math.min(mediaUrls.length - 1, Math.max(0, Number(req.query.line) || 0));
    try {
      const cachedRange = await bilibiliVodRangeCache.get(
        mediaUrls[lineIndex],
        referer,
        req.headers.range
      );
      if (cachedRange) {
        res.status(206);
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Cache-Control", "private, max-age=120, stale-while-revalidate=30, no-transform");
        res.setHeader("Content-Type", cachedRange.contentType);
        res.setHeader("Content-Length", String(cachedRange.buffer.length));
        res.setHeader(
          "Content-Range",
          `bytes ${cachedRange.start}-${cachedRange.end}/${cachedRange.total || "*"}`
        );
        res.setHeader("X-Syncinema-Cache", cachedRange.cacheStatus);
        res.setHeader("X-Accel-Buffering", "no");
        res.send(cachedRange.buffer);
        return;
      }
    } catch (error) {
      console.warn("Bilibili startup range cache failed", error?.message || error);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const abortPendingFetch = () => controller.abort();
    res.once("close", abortPendingFetch);
    let upstream;
    try {
      upstream = await fetch(mediaUrls[lineIndex], {
        headers,
        redirect: "follow",
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
      res.off("close", abortPendingFetch);
    }
    res.status(upstream.status);
    ["content-type", "content-length", "content-range", "accept-ranges"].forEach((name) => {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    });
    res.setHeader("Cache-Control", "private, max-age=120, stale-while-revalidate=30, no-transform");
    res.setHeader("Vary", "Range");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    if (!upstream.body) {
      res.end();
      return;
    }
    const source = Readable.fromWeb(upstream.body);
    source.on("error", () => {
      if (!res.headersSent) res.status(502);
      if (!res.destroyed) res.destroy();
    });
    res.on("close", () => {
      if (!source.destroyed) source.destroy();
    });
    source.pipe(res);
  } catch (error) {
    res.status(error.status || 502).end();
  }
});

app.get("/api/bilibili/live/:roomId.flv", async (req, res) => {
  const roomId = String(req.params.roomId || "").replace(/\D/g, "").slice(0, 20);
  const quality = Math.max(80, Math.min(10000, Number(req.query.qn) || 10000));
  if (!roomId) {
    res.status(400).end();
    return;
  }

  let source;
  try {
    const resolved = await resolveBilibiliLiveCached(roomId, quality);
    if (resolved.kind !== "flv") {
      res.redirect(307, `/api/bilibili/live/${encodeURIComponent(roomId)}.m3u8`);
      return;
    }
    const line = selectBilibiliLiveLine(resolved, req.query.cdn);
    const upstream = await fetch(line.url, {
      headers: sourceHeaders(resolved.referer),
      redirect: "follow"
    });
    if (!upstream.ok || !upstream.body) {
      res.status(upstream.status || 502).end();
      return;
    }
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "video/x-flv");
    res.setHeader("Cache-Control", "no-store, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    source = Readable.fromWeb(upstream.body);
    source.on("error", () => {
      if (!res.destroyed) res.destroy();
    });
    res.on("close", () => {
      if (source && !source.destroyed) source.destroy();
    });
    source.pipe(res);
  } catch (error) {
    if (source && !source.destroyed) source.destroy();
    if (!res.headersSent) res.status(error.status || 502).end();
    else if (!res.destroyed) res.destroy();
  }
});

app.get("/api/bilibili/live/:roomId.m3u8", async (req, res) => {
  const roomId = String(req.params.roomId || "").replace(/\D/g, "").slice(0, 20);
  if (!roomId) {
    res.status(400).end();
    return;
  }
  try {
    const resolved = await resolveBilibiliLiveCached(roomId, 10000);
    const preferredHost = cleanCdnHost(req.query.cdn);
    const relayResources = String(req.query.relay || "") === "1";
    const qualities = Array.isArray(resolved.qualities) ? resolved.qualities : [];
    if (qualities.length > 1) {
      const resolutionByQuality = new Map([
        [10000, "1920x1080"], [400, "1920x1080"], [250, "1280x720"],
        [150, "854x480"], [80, "640x360"]
      ]);
      const lines = ["#EXTM3U", "#EXT-X-VERSION:7"];
      qualities.forEach((item, index) => {
        const bandwidth = Math.max(500000, 6000000 - index * 900000);
        const resolution = resolutionByQuality.get(Number(item.quality)) || "1280x720";
        lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${resolution},NAME="${item.label}"`);
        const params = new URLSearchParams();
        if (preferredHost) params.set("cdn", preferredHost);
        if (relayResources) params.set("relay", "1");
        const query = params.toString();
        lines.push(`/api/bilibili/live/${roomId}/${item.quality}.m3u8${query ? `?${query}` : ""}`);
      });
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
      res.send(lines.join("\n"));
      return;
    }
    if (resolved.kind !== "hls") {
      res.redirect(307, proxiedUrl("stream", resolved.mediaUrl, resolved.referer));
      return;
    }
    const line = selectBilibiliLiveLine(resolved, preferredHost);
    const manifest = await fetchRemoteText(line.url, resolved.referer);
    const rewritten = rewriteHlsManifest(manifest, line.url, resolved.referer, {
      directResources: !relayResources
    });
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
    res.send(rewritten);
  } catch (error) {
    res.status(error.status || 502).json({ ok: false, error: error.message || "bilibili-live-failed" });
  }
});

app.get("/api/bilibili/live/:roomId/lines.json", async (req, res) => {
  const roomId = String(req.params.roomId || "").replace(/\D/g, "").slice(0, 20);
  if (!roomId) {
    res.status(400).end();
    return;
  }
  try {
    const resolved = await resolveBilibiliLiveCached(roomId, 10000);
    const lines = (Array.isArray(resolved.liveLines) ? resolved.liveLines : [])
      .map((line) => ({ host: cleanCdnHost(line.host), url: line.url }))
      .filter((line) => line.host && line.url);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, roomId, quality: resolved.quality, lines });
  } catch (error) {
    res.status(error.status || 502).json({ ok: false, error: error.message || "bilibili-live-lines-failed" });
  }
});

app.get("/api/bilibili/live/:roomId/:quality.m3u8", async (req, res) => {
  const roomId = String(req.params.roomId || "").replace(/\D/g, "").slice(0, 20);
  const quality = Math.max(80, Math.min(10000, Number(req.params.quality) || 10000));
  if (!roomId) {
    res.status(400).end();
    return;
  }
  try {
    const resolved = await resolveBilibiliLiveCached(roomId, quality);
    if (resolved.kind !== "hls") {
      res.redirect(307, proxiedUrl("stream", resolved.mediaUrl, resolved.referer));
      return;
    }
    const line = selectBilibiliLiveLine(resolved, req.query.cdn);
    const manifest = await fetchRemoteText(line.url, resolved.referer);
    const relayResources = String(req.query.relay || "") === "1";
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
    res.send(rewriteHlsManifest(manifest, line.url, resolved.referer, {
      directResources: !relayResources
    }));
  } catch (error) {
    res.status(error.status || 502).json({ ok: false, error: error.message || "bilibili-live-failed" });
  }
});

app.get("/api/source/hls", async (req, res) => {
  const url = String(req.query.url || "");
  const referer = String(req.query.referer || "");
  if (!isSafeRemoteUrl(url)) {
    res.status(400).end();
    return;
  }

  try {
    const manifest = await fetchRemoteText(url, referer);
    const rewritten = rewriteHlsManifest(manifest, url, referer, {
      directResources: String(req.query.direct || "") === "1"
    });
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
    res.send(rewritten);
  } catch (error) {
    res.status(error.status || 502).end();
  }
});

app.get("/api/source/stream", async (req, res) => {
  const url = String(req.query.url || "");
  const referer = String(req.query.referer || "");
  if (!isSafeRemoteUrl(url)) {
    res.status(400).end();
    return;
  }

  try {
    if (!req.headers.range && isBilibiliLiveSegment(url, referer)) {
      const segment = await fetchBilibiliLiveSegment(url, referer);
      res.setHeader("Cache-Control", "public, max-age=30, immutable");
      res.setHeader("Content-Type", segment.contentType);
      res.setHeader("Content-Length", String(segment.buffer.length));
      res.send(segment.buffer);
      return;
    }
    if (!req.headers.range && String(req.query.hls || "") === "1") {
      const segment = await vodSegmentCache.get(url, referer);
      res.setHeader("Cache-Control", "public, max-age=1800, immutable, no-transform");
      res.setHeader("Content-Type", segment.contentType);
      res.setHeader("Content-Length", String(segment.buffer.length));
      res.setHeader("X-Syncinema-Cache", segment.cacheStatus);
      res.send(segment.buffer);
      return;
    }
    const headers = sourceHeaders(referer);
    if (req.headers.range) headers.Range = req.headers.range;
    const upstream = await fetch(url, { headers, redirect: "follow" });
    res.status(upstream.status);
    ["content-type", "content-length", "content-range", "accept-ranges"].forEach((name) => {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    });
    res.setHeader("Cache-Control", "private, max-age=120, stale-while-revalidate=30, no-transform");
    res.setHeader("Vary", "Range");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    if (!upstream.body) {
      res.end();
      return;
    }
    const source = Readable.fromWeb(upstream.body);
    source.on("error", () => {
      if (!res.headersSent) res.status(502);
      if (!res.destroyed) res.destroy();
    });
    res.on("close", () => {
      if (!source.destroyed) source.destroy();
    });
    source.pipe(res);
  } catch {
    res.status(502).end();
  }
});

app.get("/api/demo/stream", (req, res) => {
  if (!fs.existsSync(demoVideoPath)) {
    res.status(404).end();
    return;
  }

  const stat = fs.statSync(demoVideoPath);
  const range = parseRange(req.headers.range || `bytes=0-`, stat.size);
  if (!range) {
    res.setHeader("Content-Range", `bytes */${stat.size}`);
    res.status(416).end();
    return;
  }

  res.status(206);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Length", range.end - range.start + 1);
  res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`);
  fs.createReadStream(demoVideoPath, { start: range.start, end: range.end }).pipe(res);
});

app.get("/api/demo/info", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!fs.existsSync(demoVideoPath)) {
    res.status(404).json({ ok: false, error: "demo-not-found" });
    return;
  }
  const stat = fs.statSync(demoVideoPath);
  res.json({ ok: true, name: "演示.mp4", size: stat.size });
});

app.post("/api/sensitive/check", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const value = String(req.body?.value || "").slice(0, 1000);
  res.json({ ok: true, allowed: !sensitiveFilter.contains(value) });
});

app.post("/api/sensitive/admin", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const attempt = sensitiveAdminAttempt(req);
  if (attempt.failures >= SENSITIVE_ADMIN_MAX_FAILURES) {
    res.status(429).json({ ok: false, error: "too-many-attempts" });
    return;
  }
  const password = String(req.body?.password || "").slice(0, 128);
  const result = req.body?.action === "save"
    ? sensitiveFilter.update(password, { categories: req.body?.categories })
    : sensitiveFilter.list(password);
  if (!result.ok) {
    sensitiveAdminAttempts.set(attempt.key, {
      startedAt: attempt.startedAt,
      failures: attempt.failures + 1
    });
    res.status(403).json(result);
    return;
  }
  sensitiveAdminAttempts.delete(attempt.key);
  res.json(result);
});

app.post("/api/presence", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    users: stateFromReq(req).touchPresence(req.body || {})
  });
});

app.post("/api/chat", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(stateFromReq(req).postChat(req.body || {}));
});

app.get("/api/chat", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ messages: stateFromReq(req).chatHistory() });
});

app.post("/api/chat/clear", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(stateFromReq(req).clearChatHistory(req.body || {}));
});

app.post("/api/playback-activity/clear", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(stateFromReq(req).clearPlaybackActivities(req.body || {}));
});

app.post("/api/chunks/request", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(stateFromReq(req).requestRelayChunk(req.body || {}));
});

app.post("/api/chunks/preload", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(stateFromReq(req).requestRelayWindow(req.body || {}));
});

app.post("/api/chunks/missing", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    indexes: stateFromReq(req).relayMissingList(req.body?.videoId, req.body?.indexes)
  });
});

app.get("/api/chunks/debug", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(stateFromReq(req).relayDebugSnapshot(req.query.videoId));
});

app.get("/api/chunks/requests", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const limit = Math.min(128, Math.max(1, Number(req.query.limit || 16)));
  res.json({
    indexes: stateFromReq(req).relayRequestList(req.query.videoId, limit, {
      clientId: req.query.clientId,
      name: req.query.name
    })
  });
});

app.post("/api/chunks/:videoId/seed", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const state = stateFromReq(req);
  const videoId = String(req.params.videoId || "");
  const meta = state.activeVideoSnapshot();
  const size = Number(meta?.size || 0);
  const chunkSize = Number(meta?.chunkSize || 0);
  const totalChunks = Number(meta?.totalChunks || 0);
  const contentLength = Number(req.headers["content-length"] || 0);
  if (
    req.headers["content-type"] !== "application/octet-stream" ||
    !meta || meta.id !== videoId || !Number.isSafeInteger(size) || size <= 0 ||
    !Number.isSafeInteger(chunkSize) || chunkSize <= 0 ||
    !Number.isSafeInteger(totalChunks) || totalChunks !== Math.ceil(size / chunkSize) ||
    contentLength !== size
  ) {
    req.resume();
    res.status(400).json({ ok: false, error: "Video metadata or upload size does not match." });
    return;
  }

  let received = 0;
  let index = 0;
  let pending = Buffer.alloc(0);
  let rejected = false;
  const reject = (status, error) => {
    if (rejected) return;
    rejected = true;
    res.status(status).json({ ok: false, error });
  };

  req.on("data", (data) => {
    if (rejected) return;
    received += data.length;
    if (received > size) {
      reject(413, "Upload exceeds the active video size.");
      req.destroy();
      return;
    }
    pending = pending.length ? Buffer.concat([pending, data]) : data;
    while (index < totalChunks) {
      const expected = Math.min(chunkSize, size - index * chunkSize);
      if (pending.length < expected) break;
      const chunk = pending.subarray(0, expected);
      const result = state.storeRelayChunk({ videoId, index, buffer: chunk });
      if (!result.ok) {
        reject(409, "The active video changed while it was being restored.");
        req.destroy();
        return;
      }
      resolveHttpChunkWaiters(roomIdFromReq(req), videoId, index, chunk);
      pending = pending.subarray(expected);
      index += 1;
    }
  });

  req.on("end", () => {
    if (rejected) return;
    if (received !== size || index !== totalChunks || pending.length) {
      reject(400, "Upload ended before all video chunks were received.");
      return;
    }
    res.json({ ok: true, videoId, size, totalChunks });
  });
  req.on("error", () => reject(400, "Upload was interrupted."));
});

app.get("/api/chunks/:videoId/:index", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const roomId = roomIdFromReq(req);
  const state = stateFromReq(req);
  const videoId = req.params.videoId;
  const index = Number(req.params.index);
  const chunk = state.relayChunk(videoId, index);
  if (!chunk) {
    state.requestRelayChunk({ videoId, index });
    const waitMs = Math.min(HTTP_CHUNK_WAIT_MAX_MS, Math.max(0, Number(req.query.wait || 0)));
    if (waitMs > 0) {
      const key = chunkWaitKey(roomId, videoId, index);
      const waiter = {
        finish(chunk) {
          if (res.writableEnded) return;
          res.setHeader("Content-Type", "application/octet-stream");
          res.send(chunk);
        },
        timer: setTimeout(() => {
          removeHttpChunkWaiter(key, waiter);
          if (!res.writableEnded) res.status(204).end();
        }, waitMs)
      };
      if (!httpChunkWaiters.has(key)) httpChunkWaiters.set(key, new Set());
      httpChunkWaiters.get(key).add(waiter);
      req.on("close", () => {
        clearTimeout(waiter.timer);
        removeHttpChunkWaiter(key, waiter);
      });
      return;
    }
    res.status(204).end();
    return;
  }
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("X-Accel-Buffering", "no");
  res.send(chunk);
});

app.get("/api/videos/:videoId/stream", async (req, res) => {
  const roomId = roomIdFromReq(req);
  const state = stateFromReq(req);
  const meta = state.activeVideoSnapshot();
  const videoId = String(req.params.videoId || "");
  if (!meta || meta.id !== videoId || !meta.size || !meta.chunkSize) {
    res.status(404).end();
    return;
  }

  const range = parseRange(req.headers.range || `bytes=0-`, meta.size);
  if (!range) {
    res.setHeader("Content-Range", `bytes */${meta.size}`);
    res.status(416).end();
    return;
  }

  const start = range.start;
  const end = Math.min(range.end, start + STREAM_WINDOW_BYTES - 1, meta.size - 1);
  const firstChunk = Math.floor(start / meta.chunkSize);
  const lastChunk = Math.floor(end / meta.chunkSize);
  const contentLength = end - start + 1;
  let aborted = false;

  state.requestRelayWindow({
    videoId,
    index: firstChunk,
    ahead: STREAM_PRELOAD_AHEAD_CHUNKS,
    behind: STREAM_PRELOAD_BEHIND_CHUNKS
  });
  for (let index = firstChunk; index <= lastChunk; index += 1) {
    state.requestRelayChunk({ videoId, index, priority: 10 });
  }

  req.on("close", () => {
    aborted = true;
  });

  res.status(206);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Content-Type", meta.type || "video/mp4");
  res.setHeader("Content-Length", contentLength);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${meta.size}`);

  const chunkPromises = new Map();
  for (let index = firstChunk; index <= lastChunk; index += 1) {
    chunkPromises.set(index, waitForRelayChunk(state, roomId, videoId, index));
  }

  for (let index = firstChunk; index <= lastChunk; index += 1) {
    if (aborted || res.writableEnded) return;
    const chunk = await chunkPromises.get(index);
    if (!chunk) {
      if (!res.writableEnded) res.destroy();
      return;
    }

    const chunkStartByte = index * meta.chunkSize;
    const sliceStart = Math.max(0, start - chunkStartByte);
    const sliceEnd = Math.min(chunk.length, end - chunkStartByte + 1);
    if (sliceStart >= sliceEnd) continue;
    const part = chunk.subarray ? chunk.subarray(sliceStart, sliceEnd) : chunk.slice(sliceStart, sliceEnd);
    if (!res.write(part)) {
      await new Promise((resolve) => res.once("drain", resolve));
    }
  }

  if (!res.writableEnded) res.end();
});

app.post(
  "/api/chunks/:videoId/:index",
  express.raw({ type: "application/octet-stream", limit: "8mb" }),
  (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const state = stateFromReq(req);
    const videoId = req.params.videoId;
    const index = Number(req.params.index);
    const result = state.storeRelayChunk({
      videoId,
      index,
      buffer: req.body
    });
    if (result.ok) {
      const chunk = state.relayChunk(videoId, index);
      if (chunk) resolveHttpChunkWaiters(roomIdFromReq(req), videoId, index, chunk);
    }
    res.json(result);
  }
);

const legacyServiceWorkerCleanup = `
self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    await self.registration.unregister();
    const windows = await self.clients.matchAll({ type: "window" });
    await Promise.all(windows.map((client) => client.navigate("/")));
  })());
});
`;

app.get(["/web/sw.js", "/web/sw.media.js", "/sw.js", "/service-worker.js"], (_req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Service-Worker-Allowed", "/");
  res.send(legacyServiceWorkerCleanup);
});

app.use(
  express.static(clientDir, {
    setHeaders(res, filePath) {
      if (/\.html$/i.test(filePath)) {
        res.setHeader("Cache-Control", "no-store");
      } else if (/\.(?:js|mjs|css|wasm|map|png|jpg|jpeg|gif|svg|ico|webp)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=604800, immutable");
      }
    }
  })
);

app.get("*", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(clientDir, "index.html"));
});

function listen(port, attempts = 0) {
  server.once("error", (error) => {
    if (["EADDRINUSE", "EACCES"].includes(error.code) && attempts < 20) {
      listen(port + 1, attempts + 1);
      return;
    }
    throw error;
  });

  server.listen(port, "0.0.0.0", () => {
    const protocol = httpsOptions ? "https" : "http";
    console.log(`Syncinema is running at ${protocol}://localhost:${port}`);
  });
}

listen(config.port);
