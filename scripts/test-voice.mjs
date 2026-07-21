import assert from "node:assert/strict";
import { VoiceManager } from "../client/voice.js";

const routing = {
  expectedRemotePeers: new Set(["p2p-peer", "relay-peer"]),
  realtimePeers: new Map([["p2p-peer", Date.now()]])
};
assert.deepEqual(
  VoiceManager.prototype.relayTargetIds.call(routing),
  ["p2p-peer", "relay-peer"],
  "socket PCM must stay available as a fallback for every remote peer"
);
assert.equal(
  VoiceManager.prototype.shouldSuppressRelayPlayback.call({
    realtimePeers: routing.realtimePeers,
    audioUnlocked: false,
    remotePlaybackBlocked: true,
    remoteAudios: new Map([["p2p-peer", { paused: true, readyState: 0 }]]),
    directPlaybackReady: new Map([["p2p-peer", false]]),
    hasRecentP2PAudio: () => false
  }, "p2p-peer"),
  false,
  "a connected but blocked WebRTC path must not suppress relay audio"
);
assert.equal(
  VoiceManager.prototype.shouldSuppressRelayPlayback.call({
    realtimePeers: routing.realtimePeers,
    audioUnlocked: true,
    remotePlaybackBlocked: false,
    hasRecentP2PAudio: () => true,
    remoteAudios: new Map([["p2p-peer", { paused: false, readyState: 2 }]]),
    directPlaybackReady: new Map([["p2p-peer", true]])
  }, "p2p-peer"),
  true,
  "audible WebRTC audio must suppress duplicate relay playback"
);

function fakeGain() {
  const calls = [];
  return {
    calls,
    gain: {
      cancelScheduledValues: (...args) => calls.push(["cancel", ...args]),
      setValueAtTime: (...args) => calls.push(["set", ...args]),
      linearRampToValueAtTime: (...args) => calls.push(["ramp", ...args])
    }
  };
}

const continuous = fakeGain();
VoiceManager.prototype.applyPacketEnvelope.call(
  { outputVolume: 0.8 },
  continuous,
  1,
  0.085,
  true
);
assert.deepEqual(
  continuous.calls,
  [["cancel", 1], ["set", 0.8, 1]],
  "continuous PCM packets must not fade to zero at every packet boundary"
);

let stopped = 0;
const source = { stop: () => { stopped += 1; } };
const player = { sources: new Set([source]), nextTime: 9 };
VoiceManager.prototype.stopRelayPlayback.call({
  relayPlayers: new Map([["peer", player]]),
  audioContext: { currentTime: 2 }
}, "peer");
assert.equal(stopped, 1, "queued relay packets must stop when WebRTC becomes active");
assert.equal(player.sources.size, 0);
assert.equal(player.nextTime, 2.12);

const enhancementNotices = [];
VoiceManager.prototype.reportVoiceEnhancements.call({
  inputStream: {
    getAudioTracks: () => [{
      getSettings: () => ({ echoCancellation: true, autoGainControl: false })
    }]
  },
  noiseReductionEnabled: false,
  rnnoiseAvailable: false,
  ui: { addSystemMessage: (message) => enhancementNotices.push(message) }
});
assert.equal(
  enhancementNotices.some((message) => message.includes("未确认支持：自动增益")),
  false,
  "intentionally disabled auto gain must not be reported as unsupported"
);

const originalMediaDevices = globalThis.navigator.mediaDevices;
Object.defineProperty(globalThis.navigator, "mediaDevices", {
  configurable: true,
  value: {
    getSupportedConstraints: () => ({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    })
  }
});
const plainConstraints = VoiceManager.prototype.buildAudioConstraints.call({
  noiseReductionEnabled: false,
  useRnnoiseEngine: () => true,
  rnnoiseStatus: "off"
});
assert.equal(plainConstraints.echoCancellation, true, "plain mode must retain echo cancellation");
assert.equal(plainConstraints.noiseSuppression, false, "APO mode must not add browser noise suppression");
assert.equal(plainConstraints.autoGainControl, false, "APO mode must not add browser automatic gain control");
const denoisedConstraints = VoiceManager.prototype.buildAudioConstraints.call({
  noiseReductionEnabled: true,
  useRnnoiseEngine: () => true,
  rnnoiseStatus: "ready"
});
assert.equal(denoisedConstraints.echoCancellation, true, "denoising mode must enable echo cancellation");
assert.equal(denoisedConstraints.noiseSuppression, false, "RNNoise mode must avoid double noise suppression");
assert.equal(denoisedConstraints.autoGainControl, false, "RNNoise mode must avoid double automatic gain control");
Object.defineProperty(globalThis.navigator, "mediaDevices", {
  configurable: true,
  value: originalMediaDevices
});

const suspendedContext = {
  state: "suspended",
  async resume() {
    this.state = "running";
  }
};
assert.equal(
  await VoiceManager.prototype.resumeCaptureContext.call({ audioContext: suspendedContext }),
  true,
  "a suspended capture context must resume automatically"
);

const blockedContext = {
  state: "suspended",
  resume: () => new Promise(() => {})
};
const blockedResumeStartedAt = Date.now();
assert.equal(
  await VoiceManager.prototype.resumeCaptureContext.call({ audioContext: blockedContext }, 20),
  false,
  "a blocked AudioContext resume must time out instead of hanging microphone startup"
);
assert.ok(Date.now() - blockedResumeStartedAt < 200, "blocked AudioContext resume must return promptly");

const plainVoiceProfile = VoiceManager.prototype.processingProfile.call({ noiseReductionEnabled: false });
const denoisedVoiceProfile = VoiceManager.prototype.processingProfile.call({ noiseReductionEnabled: true });
assert.ok(plainVoiceProfile.ratio >= 1.5, "plain voice must keep gentle transient compression");
assert.ok(plainVoiceProfile.makeupGain > 1, "quiet speech must receive makeup gain on the plain voice path");
assert.ok(denoisedVoiceProfile.ratio < 2, "denoising must avoid over-compressing speech tails");
assert.ok(denoisedVoiceProfile.makeupGain > 1, "denoised speech must receive makeup gain");

const rawCaptureStream = { id: "raw-microphone" };
const processedCaptureStream = { id: "processed-microphone" };
assert.equal(
  VoiceManager.prototype.webRtcStream.call({ processedStream: processedCaptureStream }, rawCaptureStream),
  processedCaptureStream,
  "WebRTC must use the same processed microphone path as relay audio"
);

console.log("Voice routing tests passed");
