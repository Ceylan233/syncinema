const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

const median = (values) => {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};

export class ServerClock {
  constructor(roomSocket, options = {}) {
    this.socket = roomSocket;
    this.now = options.now || (() => Date.now());
    this.setTimeout = options.setTimeout || ((callback, delay) => window.setTimeout(callback, delay));
    this.setInterval = options.setInterval || ((callback, delay) => window.setInterval(callback, delay));
    this.offsetMs = 0;
    this.rttMs = 120;
    this.ready = false;
    this.samples = [];
    this.refreshTimer = null;
  }

  acceptSample({ clientSentAt, clientReceivedAt, serverReceivedAt, serverSentAt }) {
    const serverWork = Math.max(0, Number(serverSentAt) - Number(serverReceivedAt));
    const rtt = Math.max(0, Number(clientReceivedAt) - Number(clientSentAt) - serverWork);
    const clientMiddle = (Number(clientSentAt) + Number(clientReceivedAt)) / 2;
    const serverMiddle = (Number(serverReceivedAt) + Number(serverSentAt)) / 2;
    const offset = serverMiddle - clientMiddle;
    if (!Number.isFinite(rtt) || !Number.isFinite(offset) || rtt > 5000) return false;
    this.samples.push({ rtt, offset });
    if (this.samples.length > 12) this.samples.shift();
    const best = [...this.samples].sort((left, right) => left.rtt - right.rtt).slice(0, Math.min(5, this.samples.length));
    this.rttMs = median(best.map((sample) => sample.rtt));
    this.offsetMs = median(best.map((sample) => sample.offset));
    this.ready = true;
    return true;
  }

  async sample() {
    const clientSentAt = this.now();
    const response = await this.socket.measureClock(clientSentAt);
    return this.acceptSample({
      clientSentAt,
      clientReceivedAt: this.now(),
      serverReceivedAt: response.serverReceivedAt,
      serverSentAt: response.serverSentAt
    });
  }

  async calibrate(sampleCount = 5) {
    for (let index = 0; index < sampleCount; index += 1) {
      await this.sample().catch(() => false);
      if (index + 1 < sampleCount) {
        await new Promise((resolve) => this.setTimeout(resolve, 70));
      }
    }
    return this.status();
  }

  start() {
    this.calibrate().catch(() => {});
    if (!this.refreshTimer) {
      this.refreshTimer = this.setInterval(() => this.calibrate(3).catch(() => {}), 15000);
    }
  }

  serverNow() {
    return this.now() + this.offsetMs;
  }

  delayUntil(serverTimestamp) {
    return Math.max(0, Number(serverTimestamp || 0) - this.serverNow());
  }

  suggestedLeadMs() {
    return Math.round(clamp(280 + this.rttMs * 1.5, 380, 1200));
  }

  status() {
    return {
      ready: this.ready,
      offsetMs: this.offsetMs,
      rttMs: this.rttMs,
      leadMs: this.suggestedLeadMs()
    };
  }
}
