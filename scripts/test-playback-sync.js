const assert = require("assert");
const attachSocketHandlers = require("../server/socket");

function createFakeIo() {
  const events = [];
  return {
    events,
    sockets: { sockets: new Map() },
    on() {},
    to(room) {
      return {
        emit(event, payload) {
          events.push({ room, event, payload });
        }
      };
    }
  };
}

const io = createFakeIo();
const rooms = attachSocketHandlers(io, { persist: false, emptyRoomResetMs: 20 });
function releaseRoomBarrier(room, socketId, clientId, videoId) {
  const socket = { id: socketId, emit() {} };
  io.sockets.sockets.set(socketId, socket);
  room.users.set(socketId, { clientId, name: "Ready User", connectedAt: Date.now() });
  room.handleWatchState(socket, {
    videoId,
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
}
const room2 = rooms.room("2");
const room3 = rooms.room("3");
const meta = {
  id: "video-test",
  name: "test.mp4",
  sourceType: "local",
  duration: 600,
  size: 1024,
  chunkSize: 1024,
  totalChunks: 1
};

room2.setActiveVideoMeta(meta, {
  id: "host-socket",
  socketId: "host-socket",
  clientId: "host-client",
  name: "Host"
});
assert.equal(room2.playbackSnapshot().paused, true, "a newly selected video must wait at the startup barrier");
assert.equal(room2.playbackSnapshot().barrier.pending, true, "a source switch must expose its startup barrier");

const barrierPauseState = room2.applyPlayback(
  {
    reason: "pause-click",
    userIntent: true,
    hasVideo: true,
    videoId: meta.id,
    paused: true,
    currentTime: 12,
    duration: 600,
    playbackRate: 1,
    fitMode: "contain",
    readyState: 4,
    actionId: "barrier-pause"
  },
  { id: "host-socket", clientId: "host-client", name: "Host" }
);
assert.equal(barrierPauseState.paused, true, "pause must update authoritative state during the startup barrier");
assert(Math.abs(barrierPauseState.currentTime - 12) < 0.05, "pause must preserve its authoritative timeline position");
assert.equal(room2.playbackSnapshot().paused, true, "the server timeline must remain frozen after a barrier pause");
const barrierPlayState = room2.applyPlayback(
  {
    reason: "play-click",
    userIntent: true,
    hasVideo: true,
    videoId: meta.id,
    paused: false,
    currentTime: 12,
    duration: 600,
    playbackRate: 1,
    fitMode: "contain",
    readyState: 4,
    actionId: "barrier-play"
  },
  { id: "host-socket", clientId: "host-client", name: "Host" }
);
assert.equal(barrierPlayState.paused, true, "play must wait for the shared startup barrier");

const hostSocket = { id: "host-socket", emit() {} };
const guestSocket = { id: "guest-socket", emit() {} };
io.sockets.sockets.set(hostSocket.id, hostSocket);
io.sockets.sockets.set(guestSocket.id, guestSocket);
room2.users.set(hostSocket.id, { clientId: "host-client", name: "Host", connectedAt: Date.now() });
room2.users.set(guestSocket.id, { clientId: "guest-client", name: "Guest", connectedAt: Date.now() });
const readyState = {
  videoId: meta.id,
  currentTime: 0,
  duration: 600,
  paused: true,
  waiting: false,
  readyState: 4,
  bufferedAhead: 3,
  playbackRate: 1,
  fitMode: "contain"
};
room2.handleWatchState(hostSocket, { ...readyState, hasSource: true });
assert.equal(room2.playbackSnapshot().barrier.ready, 1, "the barrier must wait for every connected member");
room2.handleWatchState(guestSocket, readyState);
const releasedState = room2.playbackSnapshot();
assert.equal(releasedState.barrier, null, "the barrier must release when every member is ready");
assert.equal(releasedState.paused, false, "barrier release must preserve the requested playing state");
assert(releasedState.executeAt > Date.now(), "barrier release must schedule one shared future start");
assert(releasedState.currentTime < 0.05, "the shared timeline must not advance before executeAt");

let state = room2.applyPlayback(
  {
    reason: "seek-release",
    userIntent: true,
    hasVideo: true,
    videoId: meta.id,
    paused: false,
    currentTime: 120,
    duration: 600,
    playbackRate: 1,
    fitMode: "contain",
    readyState: 4,
    waiting: false,
    actionId: "host-seek"
  },
  { id: "host-socket", clientId: "host-client", name: "Host" }
);
assert(Math.abs(state.currentTime - 120) < 0.05, "host seek must become authoritative");

state = room2.applyPlayback(
  {
    reason: "seek-release",
    userIntent: true,
    hasVideo: true,
    videoId: meta.id,
    paused: false,
    currentTime: 240,
    duration: 600,
    playbackRate: 1,
    fitMode: "ratio-4-3",
    readyState: 1,
    waiting: true,
    actionId: "guest-seek"
  },
  { id: "guest-socket", clientId: "guest-client", name: "Guest" }
);
assert(Math.abs(state.currentTime - 240) < 0.05, "guest seek must control the room");
assert.equal(state.fitMode, "ratio-4-3", "fit mode must synchronize");

state = room2.applyPlayback(
  {
    reason: "remote-pause-click",
    userIntent: true,
    hasVideo: true,
    videoId: meta.id,
    paused: true,
    currentTime: 240,
    duration: 600,
    playbackRate: 1,
    fitMode: "ratio-4-3",
    readyState: 1,
    waiting: true,
    actionId: "guest-pause"
  },
  { id: "guest-socket", clientId: "guest-client", name: "Guest" }
);
assert.equal(state.paused, true, "guest pause must work while its player is buffering");

state = room2.applyPlayback(
  {
    reason: "remote-play-click",
    userIntent: true,
    hasVideo: true,
    videoId: meta.id,
    paused: false,
    currentTime: 240,
    duration: 600,
    playbackRate: 1,
    fitMode: "ratio-4-3",
    readyState: 1,
    waiting: true,
    actionId: "guest-play"
  },
  { id: "guest-socket", clientId: "guest-client", name: "Guest" }
);
assert.equal(state.paused, false, "guest play must work while its player is buffering");

state = room2.applyPlayback(
  {
    reason: "heartbeat",
    hasVideo: true,
    videoId: meta.id,
    paused: true,
    currentTime: 10,
    duration: 600,
    playbackRate: 1,
    fitMode: "contain"
  },
  { id: "host-socket", clientId: "host-client", name: "Host" }
);
assert(state.currentTime >= 240, "owner heartbeat must not undo a fresh guest action");
assert.equal(state.paused, false, "a buffering owner heartbeat must not pause the room");
const versionBeforeStaleCommand = state.version;
state = room2.applyPlayback(
  {
    reason: "host-seeked",
    hasVideo: true,
    videoId: meta.id,
    paused: true,
    currentTime: 0,
    duration: 600,
    playbackRate: 1,
    fitMode: "contain",
    sentAt: Date.now() - 13000,
    actionId: "stale-host-seeked"
  },
  { id: "host-socket", clientId: "host-client", name: "Host" }
);
assert.equal(state.paused, false, "a delayed initialization event must not pause the room");
assert.equal(state.version, versionBeforeStaleCommand, "a stale playback command must not change room version");
state = room2.applyPlayback(
  {
    reason: "pause-click",
    userIntent: true,
    hasVideo: true,
    videoId: meta.id,
    paused: true,
    currentTime: state.currentTime,
    duration: 600,
    playbackRate: 1,
    fitMode: "contain",
    sentAt: Date.now() - 13000,
    requestedExecuteAt: Date.now() + 500,
    actionId: "clock-skewed-user-pause"
  },
  { id: "host-socket", clientId: "host-client", name: "Host" }
);
assert.equal(state.paused, true, "clock skew must not discard a real user command");
assert.equal(room3.playbackSnapshot().hasVideo, false, "room state must stay isolated");
assert(io.events.some((item) => item.room === "room:2" && item.event === "playback"), "room playback must broadcast");

const relayRoom = rooms.room("relay-priority-test");
relayRoom.setActiveVideoMeta(
  { ...meta, id: "relay-video", totalChunks: 300, duration: 600 },
  { id: "relay-host", socketId: "relay-host", clientId: "relay-host-client", name: "Relay Host" }
);
relayRoom.requestRelayWindow({ videoId: "relay-video", currentTime: 0, duration: 600 });
relayRoom.requestRelayChunk({ videoId: "relay-video", index: 200, priority: 10 });
const relayRequests = relayRoom.relayRequestList("relay-video", 8);
assert.equal(relayRequests[0], 200, "the currently requested stream chunk must outrank background preload");
assert(relayRequests.length <= 8, "relay polling must respect its bounded batch size");

const replayRoom = rooms.room("replay-test");
replayRoom.setActiveVideoMeta(meta, {
  id: "replay-host",
  socketId: "replay-host",
  clientId: "replay-host-client",
  name: "Replay Host"
});
let replayState = replayRoom.applyPlayback(
  {
    reason: "ended",
    hasVideo: true,
    videoId: meta.id,
    paused: true,
    currentTime: 600,
    duration: 600,
    playbackRate: 1,
    readyState: 4,
    actionId: "host-ended"
  },
  { id: "replay-host", clientId: "replay-host-client", name: "Replay Host" }
);
assert.equal(replayState.currentTime, 600, "ended video must remain at its duration");
assert.equal(replayState.paused, true, "ended video must be paused");

replayState = replayRoom.applyPlayback(
  {
    reason: "remote-replay-click",
    userIntent: true,
    hasVideo: true,
    videoId: meta.id,
    paused: false,
    currentTime: 0,
    duration: 600,
    playbackRate: 1,
    readyState: 4,
    actionId: "guest-replay"
  },
  { id: "replay-guest", clientId: "replay-guest-client", name: "Replay Guest" }
);
assert(replayState.currentTime < 0.1, "explicit replay must reset the room timeline");
assert.equal(replayState.paused, false, "explicit replay must resume playback");

const coalescedRoom = rooms.room("coalesced-seek-test");
const coalescedSocket = { id: "coalesced-host", emit() {} };
io.sockets.sockets.set(coalescedSocket.id, coalescedSocket);
coalescedRoom.users.set(coalescedSocket.id, {
  name: "Coalesced Host",
  clientId: "coalesced-client",
  connectedAt: Date.now(),
  lastSeenAt: Date.now()
});
coalescedRoom.setActiveVideoMeta(
  { ...meta, id: "coalesced-video" },
  { id: "coalesced-host", clientId: "coalesced-client", name: "Coalesced Host" }
);
const coalescedVersion = coalescedRoom.playbackSnapshot().version;
const coalescedActor = { id: "coalesced-host", clientId: "coalesced-client", name: "Coalesced Host" };
const coalescedSeek = (currentTime, actionId) => ({
  reason: "skip",
  userIntent: true,
  hasVideo: true,
  videoId: "coalesced-video",
  paused: true,
  currentTime,
  duration: 600,
  playbackRate: 1,
  fitMode: "contain",
  readyState: 4,
  actionId
});
coalescedRoom.applyPlayback(coalescedSeek(10, "skip-1"), coalescedActor, { coalesceSeek: true });
coalescedRoom.applyPlayback(coalescedSeek(20, "skip-2"), coalescedActor, { coalesceSeek: true });
assert.equal(coalescedRoom.playbackSnapshot().version, coalescedVersion, "rapid skips must not broadcast intermediate states");
setTimeout(() => {
  const state = coalescedRoom.playbackSnapshot();
  assert.equal(state.currentTime, 20, "rapid skips must commit only the final target");
  assert.equal(state.version, coalescedVersion + 1, "rapid skips must create one authoritative version");
}, 420);

const liveRoom = rooms.room("live-test");
liveRoom.setActiveVideoMeta(
  {
    id: "live-video",
    name: "live",
    sourceType: "online",
    provider: "bilibili",
    live: true,
    kind: "hls",
    playUrl: "/api/bilibili/live/1.m3u8"
  },
  { id: "live-host", clientId: "live-client", name: "Live Host" }
);
const liveState = liveRoom.applyPlayback(
  {
    reason: "loadedmetadata",
    hasVideo: true,
    videoId: "live-video",
    paused: false,
    currentTime: 20,
    duration: 8,
    playbackRate: 1,
    fitMode: "contain"
  },
  { id: "live-host", clientId: "live-client", name: "Live Host" }
);
assert.equal(liveState.paused, false, "a live sliding window must not be treated as video end");
assert.equal(liveState.duration, 0, "live window duration must not become room duration");
assert.equal(liveState.currentTime, 0, "live playback must not persist a sliding-window timestamp");

const laterLiveState = liveRoom.playbackSnapshot();
assert.equal(laterLiveState.currentTime, 0, "live snapshots must not advance an absolute timeline");
assert.equal(laterLiveState.duration, 0, "live snapshots must keep duration independent per viewer");

const activityRoom = rooms.room("activity-test");
const otherActivityRoom = rooms.room("activity-other-test");
activityRoom.clearPlaybackActivities({ clientId: "test", name: "Test" });
otherActivityRoom.clearPlaybackActivities({ clientId: "test", name: "Test" });
activityRoom.setActiveVideoMeta(
  { ...meta, id: "activity-video" },
  { id: "activity-host", clientId: "activity-host-client", name: "Activity Host" }
);
otherActivityRoom.setActiveVideoMeta(
  { ...meta, id: "other-activity-video" },
  { id: "other-host", clientId: "other-host-client", name: "Other Host" }
);
releaseRoomBarrier(activityRoom, "activity-host", "activity-host-client", "activity-video");
releaseRoomBarrier(otherActivityRoom, "other-host", "other-host-client", "other-activity-video");

const activityActor = { id: "activity-guest", clientId: "activity-guest-client", name: "Activity Guest" };
const activityState = (overrides = {}) => ({
  reason: "remote-play-click",
  userIntent: true,
  hasVideo: true,
  videoId: "activity-video",
  paused: false,
  currentTime: 30,
  duration: 600,
  playbackRate: 1,
  fitMode: "contain",
  readyState: 4,
  actionId: `activity-${Math.random()}`,
  ...overrides
});

activityRoom.applyPlayback(activityState(), activityActor);
activityRoom.applyPlayback(activityState(), activityActor);
assert.equal(activityRoom.playbackActivities().length, 1, "repeated play actions must be deduplicated");

activityRoom.applyPlayback(activityState({ reason: "seek-release", currentTime: 90 }), activityActor);
activityRoom.applyPlayback(activityState({ reason: "ratechange", currentTime: 90, playbackRate: 1.5 }), activityActor);
activityRoom.applyPlayback(activityState({ reason: "fitchange", currentTime: 90, playbackRate: 1.5, fitMode: "ratio-4-3" }), activityActor);
assert.deepEqual(
  activityRoom.playbackActivities().map((item) => item.kind),
  ["play", "seek", "rate", "fit"],
  "playback history must record supported user operations in order"
);
assert.equal(activityRoom.playbackActivities()[1].currentTime, 90, "seek history must preserve its target time");
assert.equal(activityRoom.playbackActivities()[2].playbackRate, 1.5, "rate history must preserve the selected rate");
assert.equal(activityRoom.playbackActivities()[3].fitMode, "ratio-4-3", "fit history must preserve the selected mode");

const historyCountBeforeChat = activityRoom.playbackActivities().length;
activityRoom.postChat({ clientId: "activity-guest-client", name: "Activity Guest", text: "chat is not an activity" });
assert.equal(activityRoom.playbackActivities().length, historyCountBeforeChat, "chat must not enter playback history");

otherActivityRoom.applyPlayback(
  {
    ...activityState({ videoId: "other-activity-video", actionId: "other-room-play" })
  },
  { id: "other-guest", clientId: "other-guest-client", name: "Other Guest" }
);
assert.equal(otherActivityRoom.playbackActivities().length, 1, "another room must maintain its own history");
activityRoom.clearPlaybackActivities({ clientId: "activity-guest-client", name: "Activity Guest" });
assert.equal(activityRoom.playbackActivities().length, 0, "clear history must clear the current room");
assert.equal(otherActivityRoom.playbackActivities().length, 1, "clear history must not affect another room");
assert(
  io.events.some((item) => item.room === "room:activity-test" && item.event === "playback-activity"),
  "new playback history must broadcast to the room"
);
assert(
  io.events.some((item) => item.room === "room:activity-test" && item.event === "playback-activity-cleared"),
  "clearing playback history must broadcast to the room"
);

const emptyRoom = rooms.room("empty-room-test");
emptyRoom.postChat({ clientId: "http-chat", name: "Keeper", text: "preserve chat" });
emptyRoom.setActiveVideoMeta(
  { ...meta, id: "empty-room-video" },
  { id: "gone-host", clientId: "gone-host-client", name: "Gone Host" }
);
emptyRoom.applyPlayback(
  {
    reason: "seek-release",
    userIntent: true,
    hasVideo: true,
    videoId: "empty-room-video",
    paused: true,
    currentTime: 180,
    duration: 600,
    playbackRate: 1,
    fitMode: "contain",
    readyState: 4,
    actionId: "empty-room-seek"
  },
  { id: "gone-host", clientId: "gone-host-client", name: "Gone Host" }
);
assert.equal(emptyRoom.resetEmptyRoomPlayback(), true, "an empty non-demo room must be resettable");
assert.equal(emptyRoom.activeVideoSnapshot(), null, "empty-room cleanup must remove the active video");
assert.equal(emptyRoom.playbackSnapshot().hasVideo, false, "empty-room cleanup must restore default playback state");
assert.equal(emptyRoom.chatHistory().length, 1, "empty-room cleanup must preserve chat history");
assert.equal(emptyRoom.playbackActivities().length, 1, "empty-room cleanup must preserve playback history");

const timedEmptyRoom = rooms.room("timed-empty-room-test");
timedEmptyRoom.postChat({ clientId: "http-chat", name: "Keeper", text: "preserve timed chat" });
timedEmptyRoom.setActiveVideoMeta(
  { ...meta, id: "timed-empty-room-video" },
  { id: "gone-host", clientId: "gone-host-client", name: "Gone Host" }
);
setTimeout(() => {
  assert.equal(timedEmptyRoom.activeVideoSnapshot(), null, "the empty-room timer must remove the active video");
  assert.equal(timedEmptyRoom.playbackSnapshot().hasVideo, false, "the empty-room timer must reset playback");
  assert.equal(timedEmptyRoom.chatHistory().length, 1, "the empty-room timer must preserve chat history");
}, 45);

console.log("Playback sync tests passed");
