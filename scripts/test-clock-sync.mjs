import assert from "node:assert/strict";
import { ServerClock } from "../client/clock-sync.js";

const clock = new ServerClock({}, {
  now: () => 1000,
  setTimeout,
  setInterval: () => 0
});

assert.equal(clock.acceptSample({
  clientSentAt: 1000,
  clientReceivedAt: 1100,
  serverReceivedAt: 1040,
  serverSentAt: 1060
}), true);
assert.equal(clock.rttMs, 80, "RTT must exclude time spent on the server");
assert.equal(clock.offsetMs, 0, "symmetric traffic must produce the correct clock offset");

clock.rttMs = 10;
assert.equal(clock.suggestedLeadMs(), 380, "command lead must have a stable minimum");
clock.rttMs = 2000;
assert.equal(clock.suggestedLeadMs(), 1200, "command lead must stay bounded on slow links");

clock.offsetMs = 150;
assert.equal(clock.serverNow(), 1150, "server time must include the calibrated offset");
assert.equal(clock.delayUntil(1400), 250, "scheduled delay must use server time");

console.log("Clock sync tests passed");
