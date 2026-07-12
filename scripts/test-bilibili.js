const assert = require("assert");
const {
  collectLiveStreams,
  isBilibiliUrl,
  parseBilibiliTarget,
  resolveBilibiliStream,
  resolveBilibiliUrl
} = require("../server/bilibili");

function jsonResponse(payload, url = "https://api.bilibili.com/mock") {
  return {
    ok: true,
    status: 200,
    url,
    async json() {
      return payload;
    }
  };
}

async function run() {
  assert.equal(isBilibiliUrl("https://www.bilibili.com/video/BV1GJ411x7h7"), true);
  assert.equal(isBilibiliUrl("https://example.com/video.mp4"), false);
  assert.deepEqual(parseBilibiliTarget("https://www.bilibili.com/video/BV1GJ411x7h7?p=2"), {
    type: "video",
    bvid: "BV1GJ411x7h7",
    page: 2
  });
  assert.deepEqual(parseBilibiliTarget("https://live.bilibili.com/6"), {
    type: "live",
    roomId: "6"
  });

  const fakeFetch = async (url) => {
    const value = String(url);
    if (value.includes("/x/web-interface/view")) {
      return jsonResponse({
        code: 0,
        data: {
          title: "Test video",
          bvid: "BV1GJ411x7h7",
          pages: [
            { cid: 123, page: 1, part: "Part 1", duration: 60 },
            { cid: 456, page: 2, part: "Part 2", duration: 75 }
          ]
        }
      });
    }
    if (value.includes("/x/player/playurl")) {
      return jsonResponse({
        code: 0,
        data: {
          quality: 64,
          accept_quality: [80, 64, 32],
          accept_description: ["1080P", "720P", "480P"],
          durl: [{ url: "https://cdn.example/video.mp4" }]
        }
      });
    }
    throw new Error(`unexpected URL: ${value}`);
  };

  const video = await resolveBilibiliUrl("https://www.bilibili.com/video/BV1GJ411x7h7", fakeFetch);
  assert.equal(video.kind, "video");
  assert.equal(video.live, false);
  assert.equal(video.mediaUrl, "https://cdn.example/video.mp4");
  assert.equal(video.duration, 60);
  assert.equal(video.chapters.length, 2);
  assert.deepEqual(video.chapters.map((item) => item.name), ["P1 Part 1", "P2 Part 2"]);
  assert.equal(video.chapters[1].url, "https://www.bilibili.com/video/BV1GJ411x7h7?p=2");
  assert.deepEqual(video.qualities.map((item) => item.quality), [80, 64, 32]);

  const stream = await resolveBilibiliStream({ bvid: video.bvid, cid: video.cid, quality: 32 }, fakeFetch);
  assert.equal(stream.mediaUrl, "https://cdn.example/video.mp4");
  assert.equal(stream.quality, 64);

  const streams = collectLiveStreams({
    stream: [{
      protocol_name: "http_hls",
      format: [{
        format_name: "fmp4",
        codec: [{
          codec_name: "avc",
          current_qn: 250,
          accept_qn: [10000, 400, 250, 150],
          base_url: "/live/index.m3u8?",
          url_info: [{ host: "https://live.example", extra: "token=ok" }]
        }]
      }]
    }]
  });
  assert.deepEqual(streams, [{
    url: "https://live.example/live/index.m3u8?token=ok",
    protocol: "http_hls",
    format: "fmp4",
    quality: 250,
    acceptQualities: [10000, 400, 250, 150]
  }]);

  const liveFetch = async (url) => {
    const value = String(url);
    assert.equal(value.includes("room_init"), false);
    if (value.includes("getRoomPlayInfo")) {
      return jsonResponse({
        code: 0,
        data: {
          room_id: 7788,
          live_status: 1,
          playurl_info: {
            playurl: {
              stream: [{
                protocol_name: "http_hls",
                format: [{
                  format_name: "fmp4",
                  codec: [{
                    codec_name: "avc",
                    current_qn: 250,
                    accept_qn: [250, 150],
                    base_url: "/live/index.m3u8?",
                    url_info: [{ host: "https://live.example", extra: "token=ok" }]
                  }]
                }]
              }]
            }
          }
        }
      });
    }
    if (value.includes("/Room/get_info")) {
      return jsonResponse({ code: 0, data: { title: "Live test" } });
    }
    throw new Error(`unexpected live URL: ${value}`);
  };
  const live = await resolveBilibiliUrl("https://live.bilibili.com/7788", liveFetch);
  assert.equal(live.live, true);
  assert.equal(live.roomId, "7788");
  assert.equal(live.kind, "hls");
  assert.equal(live.mediaUrl, "https://live.example/live/index.m3u8?token=ok");
  assert.equal(live.liveLines.length, 1);
  assert.equal(live.liveLines[0].host, "live.example");

  console.log("Bilibili resolver tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
