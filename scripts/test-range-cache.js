const assert = require("assert");
const { SharedRangeCache, parseByteRange, parseContentRange } = require("../server/range-cache");

async function run() {
  assert.deepStrictEqual(parseByteRange("bytes=5-"), { start: 5, end: null });
  assert.deepStrictEqual(parseByteRange("bytes=5-9"), { start: 5, end: 9 });
  assert.strictEqual(parseByteRange("bytes=-5"), null);
  assert.deepStrictEqual(parseContentRange("bytes 4-7/12"), { start: 4, end: 7, total: 12 });

  let fetchCount = 0;
  const cache = new SharedRangeCache({
    blockBytes: 4,
    startupLimitBytes: 8,
    maxEntries: 4,
    maxBytes: 16,
    fetchImpl: async (_url, options) => {
      fetchCount += 1;
      const match = /bytes=(\d+)-(\d+)/.exec(options.headers.Range);
      const start = Number(match[1]);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(Buffer.from([start, start + 1, start + 2, start + 3]), {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": "4",
          "Content-Range": `bytes ${start}-${start + 3}/12`
        }
      });
    }
  });

  const first = await cache.get("https://example.test/video.mp4", "https://example.test/", "bytes=0-");
  assert.strictEqual(first.cacheStatus, "MISS");
  assert.deepStrictEqual([...first.buffer], [0, 1, 2, 3]);

  const hit = await cache.get("https://example.test/video.mp4", "https://example.test/", "bytes=1-2");
  assert.strictEqual(hit.cacheStatus, "HIT");
  assert.deepStrictEqual([...hit.buffer], [1, 2]);
  assert.strictEqual(fetchCount, 1);

  const [coalescedA, coalescedB] = await Promise.all([
    cache.get("https://example.test/video.mp4", "https://example.test/", "bytes=4-"),
    cache.get("https://example.test/video.mp4", "https://example.test/", "bytes=4-")
  ]);
  assert.strictEqual(fetchCount, 2);
  assert.deepStrictEqual(new Set([coalescedA.cacheStatus, coalescedB.cacheStatus]), new Set(["MISS", "COALESCED"]));
  assert.strictEqual(await cache.get("https://example.test/video.mp4", "", "bytes=8-"), null);

  console.log("Range cache tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
