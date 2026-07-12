import assert from "node:assert/strict";
import { CinemaPlayer } from "../client/player.js";

let attempts = 0;
const player = {
  meta: { id: "local-video", live: false },
  liveRelayEnabled: false,
  liveStartupReady: true,
  userVolume: 1,
  mutedForAutoplay: false,
  expectedRemotePlaying: false,
  remoteAutoplayBlockedUntil: 0,
  remoteAutoplayWanted: true,
  remoteAutoplayAttempts: 1,
  video: {
    muted: false,
    paused: true,
    async play() {
      attempts += 1;
      if (!this.muted) throw new Error("authoritative playback must start muted");
      this.paused = false;
    }
  },
  restoreEffectiveVolume() {},
  applyEffectiveVolume() {},
  scheduleAudioRestoreAttempts() {},
  retryRemoteAutoplay() {},
  markRemoteAutoplayBlocked() {}
};

await CinemaPlayer.prototype.playRemoteWithFallback.call(player);

assert.equal(attempts, 1, "a source owner must use one deterministic muted start");
assert.equal(player.video.muted, true, "authoritative playback must start muted so the owner starts reliably");
assert.equal(player.video.paused, false, "the source owner's media must be playing after fallback");
assert.equal(player.expectedRemotePlaying, true, "the authoritative playing state must remain active");

let audibleAttempts = 0;
const unlockedPlayer = {
  ...player,
  userAudioUnlocked: true,
  video: {
    muted: true,
    defaultMuted: true,
    paused: true,
    async play() {
      audibleAttempts += 1;
      assert.equal(this.muted, false, "an unlocked viewer must not be muted again by synchronization");
      this.paused = false;
    }
  },
  enableVideoSound() {
    this.video.muted = false;
    this.video.defaultMuted = false;
    this.mutedForAutoplay = false;
  }
};
await CinemaPlayer.prototype.playRemoteWithFallback.call(unlockedPlayer);
assert.equal(audibleAttempts, 1, "entering the cinema must allow one audible playback start");
assert.equal(unlockedPlayer.video.muted, false, "resume and synchronization must preserve unlocked audio");

const bufferedResumePlayer = {
  userVolume: 1,
  userAudioUnlocked: true,
  mutedForAutoplay: true,
  video: { muted: true, defaultMuted: true },
  applyEffectiveVolume() {}
};
CinemaPlayer.prototype.restoreEffectiveVolume.call(bufferedResumePlayer);
assert.equal(bufferedResumePlayer.video.muted, false, "a short buffering recovery must restore unlocked audio");
assert.equal(bufferedResumePlayer.mutedForAutoplay, false, "buffering must not restore autoplay muting after entry");

globalThis.HTMLMediaElement = globalThis.HTMLMediaElement || {
  HAVE_METADATA: 1,
  HAVE_FUTURE_DATA: 3
};
const pausedSeekTarget = {
  video: { readyState: globalThis.HTMLMediaElement.HAVE_METADATA },
  isBuffered: () => false
};
assert.equal(
  CinemaPlayer.prototype.shouldApplyRemoteSeek.call(pausedSeekTarget, 300, 200, true),
  true,
  "an explicit paused seek must apply before the target range is buffered"
);
assert.equal(
  CinemaPlayer.prototype.shouldApplyRemoteSeek.call(pausedSeekTarget, 300, 200, false),
  false,
  "background drift correction must still wait for buffered media"
);

const nativeActions = [];
const nativePlayer = {
  video: { paused: false },
  markUserSync() {},
  emitSync(reason, options) { nativeActions.push({ reason, options }); }
};
CinemaPlayer.prototype.syncIndependentPlayerEvent.call(nativePlayer, "seeked");
assert.equal(nativeActions[0].reason, "seek-release", "native player seeking must become an authoritative room seek");
assert.equal(nativeActions[0].options.userIntent, true);

console.log("Source owner autoplay tests passed");
