import assert from "node:assert/strict";
import { SyncController } from "../client/sync.js";

globalThis.window = {
  setInterval: () => 0,
  setTimeout,
  clearTimeout
};
globalThis.localStorage = { getItem: () => "Tester" };
globalThis.HTMLMediaElement = {
  HAVE_METADATA: 1,
  HAVE_CURRENT_DATA: 2,
  HAVE_FUTURE_DATA: 3
};

const applied = [];
const player = new EventTarget();
player.meta = { id: "video-test" };
player.video = {
  currentTime: 10,
  paused: false,
  playbackRate: 1,
  readyState: 4
};
player.hasLocalSource = () => false;
player.remoteTargetTime = (state) => state.currentTime;
player.isBuffered = () => true;
player.userSyncUntil = 0;
const prepared = [];
player.prepareScheduled = (state) => prepared.push(state);

const controller = new SyncController(
  { sendPlayback() {}, sendWatchState() {} },
  player,
  () => false,
  () => ({}),
  (state) => applied.push(state),
  async () => "self-client"
);
controller.clientId = "self-client";

assert.equal(
  controller.receive({
    hasVideo: true,
    videoId: "video-test",
    version: 1,
    currentTime: 20,
    paused: false,
    by: { id: "socket-id", clientId: "self-client" }
  }),
  false,
  "self state must not be reapplied"
);
assert.equal(applied.length, 0);

assert.equal(
  controller.receive({
    hasVideo: true,
    videoId: "video-test",
    version: 2,
    currentTime: 30,
    paused: false,
    by: { id: "peer-socket", clientId: "peer-client" }
  }),
  true,
  "new peer state must apply"
);
assert.equal(applied.length, 1);

controller.lastReconcileAt = Date.now();
assert.equal(
  controller.receive({
    hasVideo: true,
    videoId: "video-test",
    version: 2,
    currentTime: 30,
    paused: false,
    by: { id: "peer-socket", clientId: "peer-client" }
  }),
  false,
  "duplicate socket/HTTP state must not run twice"
);
assert.equal(applied.length, 1);

assert.equal(
  controller.receive({
    hasVideo: true,
    videoId: "video-test",
    version: 1,
    currentTime: 5,
    paused: true,
    by: { id: "old-peer", clientId: "old-peer" }
  }),
  false,
  "older state must never overwrite the room"
);
assert.equal(applied.length, 1);

const scheduledAt = Date.now() + 70;
assert.equal(
  controller.receive({
    hasVideo: true,
    videoId: "video-test",
    version: 3,
    currentTime: 40,
    paused: true,
    executeAt: scheduledAt,
    by: { id: "self-socket", clientId: "self-client" }
  }),
  true,
  "a self-originated scheduled action must be applied by the shared clock"
);
assert.equal(applied.length, 1, "a scheduled action must not execute early");
assert.equal(prepared.length, 1, "a scheduled action must prepare media before its deadline");
await new Promise((resolve) => setTimeout(resolve, 90));
assert.equal(applied.length, 2, "a scheduled action must execute once when due");
assert.equal(applied[1].executeAt, 0, "executed states must leave scheduling mode");
assert.equal(applied[1].scheduledExecution, true, "executed states must retain their scheduled-command identity");

controller.receive({
  hasVideo: true,
  videoId: "video-test",
  version: 4,
  currentTime: 45,
  paused: false,
  executeAt: Date.now() + 90,
  by: { id: "peer-socket", clientId: "peer-client" }
});
controller.receive({
  hasVideo: true,
  videoId: "video-test",
  version: 5,
  currentTime: 50,
  paused: true,
  executeAt: Date.now() + 35,
  by: { id: "peer-socket", clientId: "peer-client" }
});
await new Promise((resolve) => setTimeout(resolve, 110));
assert.equal(applied.length, 3, "a newer scheduled version must cancel the older command");
assert.equal(applied[2].version, 5);

let acknowledgedSeek = null;
player.acknowledgeLocalSeek = (state) => { acknowledgedSeek = state; };
player.userSyncUntil = Date.now() + 1000;
assert.equal(
  controller.receive({
    hasVideo: true,
    videoId: "video-test",
    version: 6,
    reason: "skip",
    currentTime: 75,
    paused: false,
    executeAt: Date.now() + 300,
    by: { id: "self-socket", clientId: "self-client" }
  }),
  false,
  "an active local seek must not reapply its own scheduled acknowledgement"
);
assert.equal(acknowledgedSeek?.currentTime, 75, "the local guard must release only after the server acknowledges its target");
player.userSyncUntil = 0;

let httpSends = 0;
controller.sendHttpPlayback = async () => {
  httpSends += 1;
};
controller.lastSentAt = 0;
controller.send({
  reason: "play-click",
  userIntent: true,
  hasVideo: true,
  videoId: "video-test",
  paused: false,
  currentTime: 5,
  duration: 100,
  playbackRate: 1,
  fitMode: "contain"
});
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(httpSends, 1, "each playback action must use only one HTTP fallback request");

player.hasLocalSource = () => true;
player.video.currentTime = 10;
controller.lastReconcileAt = 0;
assert.equal(
  controller.receiveCorrection({
    hasVideo: true,
    videoId: "video-test",
    version: 6,
    currentTime: 12,
    paused: false,
    playbackRate: 1,
    fitMode: "contain",
    by: { clientId: "self-client" }
  }),
  true,
  "a targeted server correction must be allowed to repair the local source owner"
);
assert.equal(applied[applied.length - 1].targetedCorrection, true);

let fallbackRequest = null;
globalThis.fetch = async (url, options = {}) => {
  fallbackRequest = { url: String(url), options };
  return {
    ok: true,
    async json() { return { hasVideo: false }; }
  };
};
const roomAwareController = new SyncController(
  { roomId: () => "room-weak", sendPlayback() {}, sendWatchState() {} },
  player,
  () => false,
  () => ({}),
  () => {},
  async () => "room-client"
);
await roomAwareController.sendHttpPlayback({ reason: "pause-click", actionId: "room-http" }, { urgent: true });
assert.equal(JSON.parse(fallbackRequest.options.body).roomId, "room-weak", "HTTP fallback actions must stay in their current room");
await roomAwareController.pollPlayback();
assert.match(fallbackRequest.url, /roomId=room-weak/, "HTTP playback polling must stay in its current room");

console.log("Sync controller tests passed");
