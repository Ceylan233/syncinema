import fs from "node:fs";

const [filePath, serverUrl, roomId, videoId, rawChunkSize, rawConcurrency] = process.argv.slice(2);
const chunkSize = Math.max(1, Number(rawChunkSize || 262144));
const concurrency = Math.min(16, Math.max(1, Number(rawConcurrency || 8)));

if (!filePath || !serverUrl || !roomId || !videoId) {
  throw new Error("Usage: node seed-relay-file.mjs <file> <server> <room> <videoId> [chunkSize] [concurrency]");
}

const size = fs.statSync(filePath).size;
const total = Math.ceil(size / chunkSize);
try {
  const response = await fetch(
    `${serverUrl.replace(/\/$/, "")}/api/chunks/${encodeURIComponent(videoId)}/seed?roomId=${encodeURIComponent(roomId)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(size)
      },
      body: fs.createReadStream(filePath),
      duplex: "half"
    }
  );
  const result = await response.json();
  if (response.ok && result.ok) {
    process.stdout.write(`seeded=${result.totalChunks}/${total} bytes=${result.size}\n`);
    process.exit(0);
  }
} catch {
  // Fall back to resumable per-chunk uploads for older servers and interrupted bulk uploads.
}
const handle = fs.openSync(filePath, "r");
const allIndexes = Array.from({ length: total }, (_, index) => index);
let pendingIndexes = allIndexes;
try {
  const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/chunks/missing?roomId=${encodeURIComponent(roomId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId, indexes: allIndexes })
  });
  const result = await response.json();
  if (response.ok && Array.isArray(result.indexes)) pendingIndexes = result.indexes;
} catch {
  // Older servers do not expose the missing-chunk query; uploading all chunks is still safe.
}
let nextIndex = 0;
let completed = 0;
let failed = 0;

async function upload(index, buffer) {
  const url = `${serverUrl.replace(/\/$/, "")}/api/chunks/${encodeURIComponent(videoId)}/${index}?roomId=${encodeURIComponent(roomId)}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: buffer
      });
      const result = await response.json();
      if (response.ok && result.ok) return true;
    } catch {
      // Retry transient network failures below.
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  return false;
}

async function worker() {
  while (true) {
    const index = pendingIndexes[nextIndex++];
    if (index === undefined) return;
    const length = Math.min(chunkSize, size - index * chunkSize);
    const buffer = Buffer.allocUnsafe(length);
    fs.readSync(handle, buffer, 0, length, index * chunkSize);
    if (!await upload(index, buffer)) failed += 1;
    completed += 1;
    if (completed % 25 === 0 || completed === pendingIndexes.length) {
      process.stdout.write(`uploaded=${completed}/${pendingIndexes.length} missing failed=${failed}\n`);
    }
  }
}

try {
  process.stdout.write(`cached=${total - pendingIndexes.length}/${total} missing=${pendingIndexes.length}\n`);
  await Promise.all(Array.from({ length: concurrency }, worker));
} finally {
  fs.closeSync(handle);
}

if (failed) process.exitCode = 1;
