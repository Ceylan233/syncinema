import assert from "node:assert/strict";
import { CinemaPlayer } from "../client/player.js";

const player = Object.create(CinemaPlayer.prototype);
player.meta = { id: "live-test", live: true };
player.video = {
  paused: false,
  currentTime: 10,
  seekable: {
    length: 1,
    end: () => 30
  }
};
player.showFeedback = (text) => {
  player.feedback = text;
};

assert.equal(player.isLiveSource(), true);
assert.equal(player.remoteTargetTime({ currentTime: 12, paused: false }), null);

player.followLiveEdge();
assert.equal(player.video.currentTime, 27);

player.video.currentTime = 28;
player.followLiveEdge();
assert.equal(player.video.currentTime, 28);

player.followLiveEdge(true);
assert.equal(player.video.currentTime, 28);

player.video.currentTime = 20;
player.seekRelative(-10);
assert.equal(player.video.currentTime, 20);
assert.equal(player.feedback, "直播不支持回看");

globalThis.Element = class Element {};
const editableTarget = new Element();
editableTarget.closest = () => editableTarget;
const keyEvent = {
  defaultPrevented: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  key: "ArrowLeft",
  target: editableTarget,
  preventDefault() {
    this.defaultPrevented = true;
  },
  stopPropagation() {}
};
player.handleGlobalKeydown(keyEvent);
assert.equal(keyEvent.defaultPrevented, false);

let remoteTitle = "";
player.ui = { setNowPlaying: (title) => { remoteTitle = title; }, setTransfer: () => {} };
player.localVideoId = null;
player.setRemoteMeta({ id: "remote-video", name: "新视频.mp4" });
assert.equal(remoteTitle, "新视频.mp4");

let switchedLine = "";
player.hls = { loadSource: (url) => { switchedLine = url; } };
player.liveLineOptions = ["/line-1.m3u8", "/line-2.m3u8"];
player.liveLineIndex = 0;
assert.equal(player.switchToNextLiveLine(), true);
assert.equal(switchedLine, "/line-2.m3u8");
assert.equal(player.switchToNextLiveLine(), false);

player.onlineSourceToken = 7;
player.meta = { id: "live-test", live: true, provider: "bilibili" };
player.liveLineOptions = ["/old-line.m3u8"];
player.liveLineIndex = 0;
player.liveLineRecoveryPromise = null;
player.selectBestBilibiliLiveLine = async () => "/new-line.m3u8";
await player.recoverBilibiliLiveLine("/master.m3u8", 7);
assert.equal(switchedLine, "/new-line.m3u8");

let healthTick = null;
let relayTriggered = false;
globalThis.window = {
  clearInterval() {},
  setInterval(callback) {
    healthTick = callback;
    return 1;
  }
};
player.meta = { id: "live-test", live: true, provider: "bilibili" };
player.video.paused = false;
player.video.currentTime = 0;
player.liveRelayEnabled = false;
player.switchToBilibiliLiveRelay = () => {
  relayTriggered = true;
  return true;
};
player.startLiveHealthMonitor();
player.liveStartedAt = Date.now() - 20000;
player.liveLastProgressAt = Date.now() - 7000;
healthTick();
assert.equal(relayTriggered, true, "a live stream with no progress must enter stable relay");

console.log("Live playback tests passed");
