const fs = require("fs");
const path = require("path");

const baseUrl = String(process.env.SYNCINEMA_URL || "http://localhost:3300").replace(/\/$/, "");
const filePath = path.resolve(process.env.TEST_VIDEO_PATH || path.join(__dirname, "..", "server", "demo", "demo.mp4"));
const chunkSize = 256 * 1024;
const stat = fs.statSync(filePath);
const totalChunks = Math.ceil(stat.size / chunkSize);
const roomId = `relay-benchmark-${Date.now()}`;
const videoId = `benchmark-${Date.now()}`;
const handle = fs.openSync(filePath, "r");
let stopped = false;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readChunk(index) {
  const start = index * chunkSize;
  const length = Math.min(chunkSize, stat.size - start);
  const buffer = Buffer.allocUnsafe(length);
  fs.readSync(handle, buffer, 0, length, start);
  return buffer;
}

async function uploadChunk(index) {
  const response = await fetch(
    `${baseUrl}/api/chunks/${encodeURIComponent(videoId)}/${index}?roomId=${encodeURIComponent(roomId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: await readChunk(index)
    }
  );
  if (!response.ok) throw new Error(`chunk-${index}-http-${response.status}`);
}

async function pumpRequests() {
  while (!stopped) {
    const response = await fetch(
      `${baseUrl}/api/chunks/requests?roomId=${encodeURIComponent(roomId)}` +
        `&videoId=${encodeURIComponent(videoId)}&limit=32&t=${Date.now()}`,
      { cache: "no-store" }
    );
    const { indexes = [] } = response.ok ? await response.json() : {};
    if (!indexes.length) {
      await delay(20);
      continue;
    }
    const queue = indexes.slice();
    await uploadChunk(queue.shift());
    await Promise.all(
      Array.from({ length: Math.min(8, queue.length) }, async () => {
        while (queue.length && !stopped) await uploadChunk(queue.shift());
      })
    );
  }
}

async function run() {
  const metaResponse = await fetch(`${baseUrl}/api/video?roomId=${encodeURIComponent(roomId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: videoId,
      switchId: `switch-${Date.now()}`,
      sourceType: "local",
      name: path.basename(filePath),
      size: stat.size,
      type: "video/mp4",
      duration: 1200,
      chunkSize,
      totalChunks,
      clientId: "relay-benchmark-host",
      ownerName: "Relay Benchmark"
    })
  });
  if (!metaResponse.ok) throw new Error(`video-meta-http-${metaResponse.status}`);

  const pump = pumpRequests();
  const startedAt = Date.now();
  const controller = new AbortController();
  const streamResponse = await fetch(
    `${baseUrl}/api/videos/${encodeURIComponent(videoId)}/stream?roomId=${encodeURIComponent(roomId)}`,
    { headers: { Range: "bytes=0-4194303" }, signal: controller.signal }
  );
  if (streamResponse.status !== 206) throw new Error(`stream-http-${streamResponse.status}`);
  const first = await streamResponse.body.getReader().read();
  const firstByteMs = Date.now() - startedAt;
  stopped = true;
  controller.abort();
  await pump.catch(() => {});
  console.log(JSON.stringify({ baseUrl, bytes: first.value?.byteLength || 0, firstByteMs, totalChunks }));
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    stopped = true;
    fs.closeSync(handle);
  });
