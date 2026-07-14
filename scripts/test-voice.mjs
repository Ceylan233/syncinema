import assert from "node:assert/strict";
import { VoiceManager } from "../client/voice.js";

const routing = {
  expectedRemotePeers: new Set(["p2p-peer", "relay-peer"]),
  realtimePeers: new Map([["p2p-peer", Date.now()]])
};
assert.deepEqual(
  VoiceManager.prototype.relayTargetIds.call(routing),
  ["relay-peer"],
  "socket PCM must only target peers without a realtime WebRTC connection"
);
assert.equal(
  VoiceManager.prototype.shouldSuppressRelayPlayback.call({
    realtimePeers: routing.realtimePeers,
    audioUnlocked: false,
    remotePlaybackBlocked: true
  }, "p2p-peer"),
  true,
  "queued socket audio must be suppressed immediately after WebRTC connects"
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
const constraints = VoiceManager.prototype.buildAudioConstraints.call({ noiseReductionEnabled: false });
assert.equal(constraints.autoGainControl, true, "supported automatic gain control must be enabled");
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

console.log("Voice routing tests passed");
