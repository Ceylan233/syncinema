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

console.log("Voice routing tests passed");
