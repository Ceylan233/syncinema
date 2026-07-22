import assert from "node:assert/strict";
import { VoiceManager } from "../client/voice.js";

const now = Date.now();
const routing = {
  expectedRemotePeers: new Set(["p2p-peer", "relay-peer"]),
  realtimePeers: new Map([["p2p-peer", now]]),
  voiceRoutes: new Map([
    ["p2p-peer", { mode: "webrtc-primary", connected: true, connectedSince: now - 10000, unhealthySince: 0, relaySince: 0, changedAt: now - 10000 }],
    ["relay-peer", { mode: "relay-active", connected: false, connectedSince: 0, unhealthySince: now - 10000, relaySince: now - 5000, changedAt: now - 5000 }]
  ]),
  ensureVoiceRoute: VoiceManager.prototype.ensureVoiceRoute,
  refreshVoiceRoute: VoiceManager.prototype.refreshVoiceRoute,
  setVoiceRouteMode: VoiceManager.prototype.setVoiceRouteMode,
  applyVoiceRouteOutput: () => {}
};
assert.deepEqual(
  VoiceManager.prototype.relayTargetIds.call(routing),
  ["relay-peer"],
  "socket PCM must only be sent to peers with an active relay route"
);
assert.equal(
  VoiceManager.prototype.shouldSuppressRelayPlayback.call({
    ...routing
  }, "p2p-peer"),
  true,
  "WebRTC primary must suppress relay packets even while the speaker is silent"
);
assert.equal(
  VoiceManager.prototype.shouldSuppressRelayPlayback.call({
    ...routing
  }, "relay-peer"),
  false,
  "an active relay route must accept relay packets"
);

const pending = {
  mode: "relay-pending",
  connected: false,
  connectedSince: 0,
  unhealthySince: now - 2000,
  relaySince: 0,
  changedAt: now - 2000
};
const pendingHarness = {
  voiceRoutes: new Map([["peer", pending]]),
  ensureVoiceRoute: VoiceManager.prototype.ensureVoiceRoute,
  setVoiceRouteMode: VoiceManager.prototype.setVoiceRouteMode,
  applyVoiceRouteOutput: () => {}
};
VoiceManager.prototype.refreshVoiceRoute.call(pendingHarness, "peer", now);
assert.equal(pending.mode, "relay-pending", "brief network jitter must not switch to relay");
VoiceManager.prototype.refreshVoiceRoute.call(pendingHarness, "peer", now + 3500);
assert.equal(pending.mode, "relay-active", "a sustained WebRTC failure must switch to relay");

pending.connected = true;
pending.connectedSince = now + 4000;
VoiceManager.prototype.refreshVoiceRoute.call(pendingHarness, "peer", now + 8000);
assert.equal(pending.mode, "webrtc-recovering", "a recovered connection must remain on relay during stabilization");
VoiceManager.prototype.refreshVoiceRoute.call(pendingHarness, "peer", now + 13000);
assert.equal(pending.mode, "webrtc-recovering", "relay must be held long enough to avoid route flapping");
VoiceManager.prototype.refreshVoiceRoute.call(pendingHarness, "peer", now + 21000);
assert.equal(pending.mode, "webrtc-primary", "stable WebRTC must replace relay in one transition");

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
