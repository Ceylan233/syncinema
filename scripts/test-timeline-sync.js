const assert = require("assert");
const attachSocketHandlers = require("../server/socket");

function createFakeIo() {
  return {
    sockets: { sockets: new Map() },
    on() {},
    to() {
      return { emit() {} };
    }
  };
}

const io = createFakeIo();
const state = attachSocketHandlers(io, { persist: false }).room("timeline-test");
state.setActiveVideoMeta(
  {
    id: "video-test",
    name: "test.mp4",
    sourceType: "local",
    duration: 600,
    size: 1024,
    chunkSize: 1024,
    totalChunks: 1
  },
  { id: "host", socketId: "host", clientId: "host-client", name: "Host" }
);
const hostSocket = { id: "host", emit() {} };
io.sockets.sockets.set("host", hostSocket);
state.users.set("host", {
  name: "Host",
  clientId: "host-client",
  connectedAt: Date.now(),
  lastSeenAt: Date.now()
});
state.handleWatchState(hostSocket, {
  videoId: "video-test",
  currentTime: 0,
  duration: 600,
  paused: true,
  waiting: false,
  readyState: 4,
  bufferedAhead: 3,
  playbackRate: 1,
  fitMode: "contain",
  hasSource: true
});
state.applyPlayback(
  {
    reason: "test-state",
    hasVideo: true,
    videoId: "video-test",
    paused: false,
    currentTime: 100,
    duration: 600,
    playbackRate: 1,
    fitMode: "contain",
    readyState: 4,
    actionId: "host-state"
  },
  { id: "host", clientId: "host-client", name: "Host" }
);

const corrections = [];
const guestSocket = {
  id: "guest",
  emit(event, payload) {
    corrections.push({ event, payload });
  }
};
state.users.set("guest", {
  name: "Guest",
  clientId: "guest-client",
  connectedAt: Date.now(),
  lastSeenAt: Date.now()
});

state.handleWatchState(guestSocket, {
  videoId: "video-test",
  currentTime: 99.9,
  duration: 600,
  paused: false,
  waiting: false,
  readyState: 4,
  playbackRate: 1,
  fitMode: "contain"
});
assert.equal(corrections.length, 0, "small drift should not hard-correct");

const softCorrections = [];
const softSocket = { id: "soft-guest", emit(event, payload) { softCorrections.push({ event, payload }); } };
state.users.set(softSocket.id, {
  name: "Soft Guest",
  clientId: "soft-guest-client",
  connectedAt: Date.now(),
  lastSeenAt: Date.now()
});
state.handleWatchState(softSocket, {
  videoId: "video-test",
  currentTime: 99,
  duration: 600,
  paused: false,
  waiting: false,
  readyState: 4,
  playbackRate: 1,
  fitMode: "contain"
});
assert.equal(softCorrections[0]?.payload.correctionMode, "soft", "moderate drift must use smooth correction");

const hardCorrections = [];
const hardSocket = { id: "hard-guest", emit(event, payload) { hardCorrections.push({ event, payload }); } };
state.users.set(hardSocket.id, {
  name: "Hard Guest",
  clientId: "hard-guest-client",
  connectedAt: Date.now(),
  lastSeenAt: Date.now()
});
state.handleWatchState(hardSocket, {
  videoId: "video-test",
  currentTime: 80,
  duration: 600,
  paused: false,
  waiting: false,
  readyState: 4,
  playbackRate: 1,
  fitMode: "contain"
});
assert.equal(hardCorrections[0]?.payload.correctionMode, "hard", "large drift must hard-seek to server time");

state.handleWatchState(guestSocket, {
  videoId: "video-test",
  currentTime: 80,
  duration: 600,
  paused: false,
  waiting: true,
  readyState: 1,
  playbackRate: 1,
  fitMode: "contain"
});
assert.equal(corrections.length, 0, "buffering guest should not be dragged repeatedly");

state.handleWatchState(guestSocket, {
  videoId: "video-test",
  currentTime: 80,
  duration: 600,
  paused: true,
  waiting: true,
  readyState: 1,
  playbackRate: 1,
  fitMode: "contain"
});
assert.equal(corrections.length, 1, "play state mismatch should correct immediately");
assert.equal(corrections[0].event, "sync-correction");
assert.equal(corrections[0].payload.correctionReason, "play-state");
assert.equal(corrections[0].payload.correctionMode, "hard", "play state mismatch must use an exact correction");

console.log("Timeline sync tests passed");
