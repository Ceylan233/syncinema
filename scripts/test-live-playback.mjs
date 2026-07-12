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
  clearTimeout,
  setTimeout,
  setInterval(callback) {
    healthTick = callback;
    return 1;
  }
};

let pseudoExitCount = 0;
let nativeExitCount = 0;
let orientationUnlockCount = 0;
globalThis.document = {
  fullscreenElement: {},
  webkitFullscreenElement: null,
  async exitFullscreen() {
    nativeExitCount += 1;
    this.fullscreenElement = null;
  }
};
const fullscreenPlayer = Object.create(CinemaPlayer.prototype);
fullscreenPlayer.pseudoFullscreen = true;
fullscreenPlayer.nativePlayerActive = false;
fullscreenPlayer.video = { webkitDisplayingFullscreen: false };
fullscreenPlayer.exitPseudoFullscreen = () => {
  pseudoExitCount += 1;
  fullscreenPlayer.pseudoFullscreen = false;
};
fullscreenPlayer.unlockOrientation = () => {
  orientationUnlockCount += 1;
};
await fullscreenPlayer.exitFullscreenForDialog();
assert.equal(pseudoExitCount, 1, "opening a dialog must leave pseudo fullscreen");
assert.equal(nativeExitCount, 1, "opening a dialog must leave browser fullscreen");
assert.equal(orientationUnlockCount, 1, "opening a dialog must release landscape orientation");

player.meta = { id: "vod-test", live: false };
player.video.duration = 100;
player.video.currentTime = 10;
player.applyingRemote = false;
player.userSyncUntil = 0;
player.keyboardSeekTimer = null;
player.keyboardSeekTarget = null;
player.keyboardSeekDelta = 0;
let keyboardSyncs = 0;
player.scheduleSeekSync = (reason) => {
  assert.equal(reason, "skip");
  keyboardSyncs += 1;
};
player.queueKeyboardSeek(10);
player.queueKeyboardSeek(10);
assert.equal(player.video.currentTime, 10, "repeated keyboard seeks must not restart decoding for every key event");
await new Promise((resolve) => setTimeout(resolve, 520));
assert.equal(player.video.currentTime, 10, "keyboard seek bursts must stay open across normal key-repeat gaps");
assert.equal(keyboardSyncs, 0, "keyboard seek bursts must not publish an intermediate target");
player.queueKeyboardSeek(10);
player.handleGlobalKeyup({ key: "ArrowRight" });
await new Promise((resolve) => setTimeout(resolve, 260));
assert.equal(player.video.currentTime, 40, "releasing a repeated key must commit the accumulated target");
assert.equal(keyboardSyncs, 1, "releasing a repeated key must publish one final seek");

player.video.currentTime = 40;
player.queueKeyboardSeek(10);
player.handleGlobalKeyup({ key: "ArrowRight" });
await new Promise((resolve) => setTimeout(resolve, 100));
player.queueKeyboardSeek(10);
player.handleGlobalKeyup({ key: "ArrowRight" });
await new Promise((resolve) => setTimeout(resolve, 260));
assert.equal(player.video.currentTime, 60, "rapid separate key presses must remain one seek transaction");
assert.equal(keyboardSyncs, 2, "rapid separate key presses must publish only their final target");

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
