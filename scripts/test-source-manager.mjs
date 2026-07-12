import assert from "node:assert/strict";
import { SourceManager } from "../client/source-manager.js";

const previousFetch = globalThis.fetch;
globalThis.fetch = async () => ({
  ok: true,
  async json() {
    return {
      ok: true,
      provider: "bilibili",
      title: "测试视频 - P2",
      playUrl: "/api/bilibili/video/stream?part=2",
      referer: "https://www.bilibili.com/video/BV1GJ411x7h7?p=2"
    };
  }
});

const manager = Object.create(SourceManager.prototype);
manager.activeSource = () => null;
manager.currentResult = {
  name: "测试视频",
  url: "https://www.bilibili.com/video/BV1GJ411x7h7"
};
manager.syncState = () => {};

const resolved = await manager.resolveChapter({
  name: "P2 第二部分",
  url: "https://www.bilibili.com/video/BV1GJ411x7h7?p=2"
});

assert.equal(resolved.title, "测试视频 - P2");
assert.equal(resolved.sourceName, "Bilibili");
assert.equal(resolved.pageUrl, "https://www.bilibili.com/video/BV1GJ411x7h7?p=2");

let directRequestBody;
globalThis.fetch = async (_url, options) => {
  directRequestBody = JSON.parse(options.body);
  return {
    ok: true,
    async json() {
      return {
        ok: true,
        provider: "bilibili",
        inspectOnly: true,
        title: "测试视频",
        chapters: [{ name: "第一部分", url: "https://www.bilibili.com/video/BV1GJ411x7h7?p=1" }]
      };
    }
  };
};

const inspected = await manager.resolveDirectUrl("https://www.bilibili.com/video/BV1GJ411x7h7");
assert.equal(directRequestBody.inspectOnly, true);
assert.equal(inspected.inspectOnly, true);
assert.equal(inspected.chapters.length, 1);

globalThis.fetch = previousFetch;
console.log("Source manager tests passed");
