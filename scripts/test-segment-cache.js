const assert = require("assert");
const { SharedSegmentCache } = require("../server/segment-cache");

async function run() {
  let requests = 0;
  let releaseSecond;
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  const cache = new SharedSegmentCache({
    maxEntries: 3,
    maxBytes: 10,
    maxItemBytes: 8,
    ttlMs: 60000,
    fetchImpl: async (url) => {
      requests += 1;
      if (url.endsWith("two.ts")) await secondGate;
      return new Response(Buffer.from(url.endsWith("large.ts") ? "123456789" : "1234"), {
        headers: { "Content-Type": "video/mp2t" }
      });
    }
  });

  const first = await cache.get("https://cdn.test/one.ts", "https://page.test/");
  const hit = await cache.get("https://cdn.test/one.ts", "https://page.test/");
  assert.equal(first.cacheStatus, "MISS");
  assert.equal(hit.cacheStatus, "HIT");
  assert.equal(requests, 1);

  const pendingFirst = cache.get("https://cdn.test/two.ts");
  const pendingSecond = cache.get("https://cdn.test/two.ts");
  releaseSecond();
  const [miss, coalesced] = await Promise.all([pendingFirst, pendingSecond]);
  assert.equal(miss.cacheStatus, "MISS");
  assert.equal(coalesced.cacheStatus, "COALESCED");
  assert.equal(requests, 2);

  await cache.get("https://cdn.test/three.ts");
  assert(cache.stats().bytes <= 10);
  assert(cache.stats().entries <= 3);

  await assert.rejects(() => cache.get("https://cdn.test/large.ts"), /too-large/);
  console.log("Shared segment cache tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
