const assert = require("assert");
const attachSocketHandlers = require("../server/socket");
const { createSensitiveFilter, parseWords } = require("../server/sensitive");

assert.deepEqual(parseWords("测试| 测试 |TEST|test"), ["测试", "TEST"]);
assert.deepEqual(parseWords("甲词;乙词；丙词\n丁词"), ["甲词", "乙词", "丙词", "丁词"]);

const filter = createSensitiveFilter({
  persist: false,
  password: "test-admin-password",
  defaultWords: ["违禁词", "BadWord"]
});

assert.equal(filter.contains("这里有违 禁 词"), true, "spaces must not bypass matching");
assert.equal(filter.contains("BAD-WORD"), true, "case and separators must not bypass matching");
assert.equal(filter.contains("普通内容"), false, "normal content must pass");
assert.equal(filter.list("wrong").ok, false, "wrong password must be rejected");
assert.equal(filter.list("test-admin-password").categories[0].text, "违禁词;BadWord", "admin must receive a semicolon-delimited list");
assert.equal(filter.update("wrong", "新词").ok, false, "wrong password must not update words");
assert.equal(filter.update("test-admin-password", "新词|另一个|新词").categories[0].text, "新词;另一个", "updates must deduplicate words");
assert.equal(filter.contains("包含新词"), true, "updated words must apply immediately");

const categorized = filter.update("test-admin-password", {
  categories: [
    { id: "political", name: "政治", words: "甲词;乙词" },
    { id: "custom", name: "自定义", words: "丙词;丁词" }
  ]
});
assert.equal(categorized.categories.length, 2, "admin must be able to create categories");
assert.equal(categorized.count, 4, "all categories must contribute to the matcher");
assert.equal(filter.contains("包含丁词"), true, "custom category words must apply immediately");

const io = {
  sockets: { sockets: new Map() },
  on() {},
  to() {
    return { emit() {} };
  }
};
const moderatedRoom = attachSocketHandlers(io, { persist: false, sensitiveFilter: filter }).room("moderation-test");
assert.equal(
  moderatedRoom.postChat({ clientId: "normal", name: "正常用户", text: "普通聊天" }).ok,
  true,
  "normal chat must pass server moderation"
);
assert.deepEqual(
  moderatedRoom.postChat({ clientId: "blocked", name: "正常用户", text: "包含丁词" }),
  { ok: false, error: "sensitive" },
  "HTTP chat must reject sensitive text"
);
const moderatedUsers = moderatedRoom.touchPresence({ clientId: "blocked-name", name: "丁词用户" });
assert.equal(
  moderatedUsers.some((user) => user.clientId === "blocked-name" && user.name.includes("丁词")),
  false,
  "server presence must not expose a sensitive nickname"
);

console.log("Sensitive filter tests passed");
