import { createId } from "./id.js";

const DEFAULT_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" }
];
const DATA_CHANNEL_FRAME_SIZE = 16 * 1024;
const DATA_CHANNEL_HIGH_WATER = 512 * 1024;
const DATA_CHANNEL_LOW_WATER = 128 * 1024;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeSend(channel, payload) {
  if (channel.readyState !== "open") return false;
  try {
    channel.send(payload);
    return true;
  } catch {
    return false;
  }
}

async function waitForChannelBackpressure(channel) {
  while (channel.readyState === "open" && channel.bufferedAmount > DATA_CHANNEL_HIGH_WATER) {
    await wait(25);
  }
}

export class PeerMesh extends EventTarget {
  constructor(roomSocket) {
    super();
    this.socket = roomSocket;
    this.peers = new Map();
    this.localStream = null;
    this.selfId = null;
    this.iceServers = DEFAULT_ICE_SERVERS;
    this.iceReady = this.loadIceServers();
  }

  async loadIceServers() {
    try {
      const response = await fetch(`/api/ice?t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) return;
      const { iceServers } = await response.json();
      if (!Array.isArray(iceServers) || iceServers.length === 0) return;
      this.iceServers = iceServers;
      this.dispatchEvent(new CustomEvent("ice-config", { detail: { iceServers } }));
      this.repairUnconnectedPeers(Array.from(this.peers.keys()), { force: true });
    } catch (error) {
      console.warn("ICE config load failed", error);
    }
  }

  setSelfId(id) {
    if (this.selfId && this.selfId !== id) this.reset();
    this.selfId = id;
  }

  async setLocalStream(stream) {
    this.localStream = stream;
    await this.refreshAudio();
  }

  connectToPeers(peerIds) {
    const activePeerIds = new Set(peerIds.filter((peerId) => peerId && peerId !== this.selfId));
    for (const peerId of this.peers.keys()) {
      if (!activePeerIds.has(peerId)) this.removePeer(peerId);
    }
    activePeerIds.forEach((peerId) => this.ensurePeer(peerId, true));
    void this.refreshAudio();
  }

  ensureReceiveOnlyPeers(peerIds = []) {
    this.connectToPeers(peerIds);
  }

  async refreshAudio() {
    const peers = Array.from(this.peers.values());
    await Promise.all(peers.map((peer) => this.addStreamTracks(peer)));
    for (const peer of peers) this.scheduleRenegotiate(peer.id, 80);
  }

  reset() {
    for (const peer of this.peers.values()) {
      window.clearTimeout(peer.renegotiateTimer);
      peer.channel?.close();
      peer.pc.close();
    }
    this.peers.clear();
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    window.clearTimeout(peer.renegotiateTimer);
    peer.channel?.close();
    peer.pc.close();
    this.peers.delete(peerId);
    this.dispatchEvent(new CustomEvent("peer-close", { detail: { peerId } }));
  }

  async handleSignal(payload = {}) {
    const { from, description, candidate, sessionId, replyToSessionId } = payload;
    if (!from || from === this.selfId) return;
    let peer = this.ensurePeer(from, false);

    // A refreshed peer starts a new SDP session. Reusing the old connection can
    // make Chromium reject the new offer when its m-line layout differs.
    if (
      description?.type === "offer" &&
      sessionId &&
      peer.remoteSessionId &&
      sessionId !== peer.remoteSessionId
    ) {
      peer = this.recreatePeer(from, false);
    }

    peer.signalQueue = peer.signalQueue
      .then(() => this.applySignal(peer, { from, description, candidate, sessionId, replyToSessionId }, true))
      .catch((error) => console.warn("WebRTC signal failed", error));
    return peer.signalQueue;
  }

  async applySignal(peer, { from, description, candidate, sessionId, replyToSessionId }, allowRecreate = true) {
    if (!from || from === this.selfId || !peer || peer.pc.signalingState === "closed") return;

    if (replyToSessionId && replyToSessionId !== peer.localSessionId) return;
    if (candidate && sessionId && peer.remoteSessionId && sessionId !== peer.remoteSessionId) return;

    try {
      if (description) {
        if (description.type === "offer" && sessionId && sessionId !== peer.remoteSessionId) {
          peer.remoteSessionId = sessionId;
          peer.queuedCandidates = [];
        }
        if (description.type === "answer" && peer.pc.signalingState !== "have-local-offer") {
          return;
        }
        if (description.type === "answer" && sessionId) {
          peer.remoteSessionId = sessionId;
        }
        const offerCollision =
          description.type === "offer" &&
          (peer.makingOffer || peer.pc.signalingState !== "stable");
        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return;
        if (offerCollision) {
          await peer.pc.setLocalDescription({ type: "rollback" }).catch(() => {});
        }
        await peer.pc.setRemoteDescription(description);
        while (peer.queuedCandidates.length > 0) {
          await peer.pc.addIceCandidate(peer.queuedCandidates.shift());
        }
        if (description.type === "offer") {
          await this.addStreamTracks(peer);
          await peer.pc.setLocalDescription(await peer.pc.createAnswer());
          this.sendPeerSignal(peer, { description: peer.pc.localDescription });
        }
      }

      if (candidate) {
        if (peer.ignoreOffer) return;
        if (peer.pc.remoteDescription) {
          await peer.pc.addIceCandidate(candidate);
        } else {
          peer.queuedCandidates.push(candidate);
        }
      }
    } catch (error) {
      if (allowRecreate && description?.type === "offer" && this.isSdpLayoutError(error)) {
        const replacement = this.recreatePeer(from, false);
        replacement.remoteSessionId = sessionId || null;
        await this.applySignal(
          replacement,
          { from, description, candidate, sessionId, replyToSessionId: null },
          false
        );
        return;
      }
      console.warn("WebRTC signal failed", error);
    }
  }

  isSdpLayoutError(error) {
    const message = String(error?.message || error || "");
    return /m-lines|SSL role|ERROR_CONTENT|setRemoteDescription/i.test(message);
  }

  recreatePeer(peerId, initiator = false) {
    const current = this.peers.get(peerId);
    if (current) {
      window.clearTimeout(current.renegotiateTimer);
      current.channel?.close();
      current.pc.close();
      this.peers.delete(peerId);
    }
    return this.ensurePeer(peerId, initiator);
  }

  ensurePeer(peerId, initiator) {
    const existing = this.peers.get(peerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer = {
      id: peerId,
      pc,
      channel: null,
      audioTransceiver: null,
      localSessionId: createId("rtc"),
      remoteSessionId: null,
      polite: this.isPolitePeer(peerId),
      ignoreOffer: false,
      pendingBinary: null,
      incomingChunks: new Map(),
      makingOffer: false,
      queuedCandidates: [],
      sendQueue: Promise.resolve(),
      signalQueue: Promise.resolve(),
      renegotiateTimer: null,
      createdAt: Date.now(),
      lastConnectedAt: 0,
      lastRepairAt: 0,
      repairAttempts: 0
    };
    this.peers.set(peerId, peer);

    this.ensureAudioTransceiver(peer);
    void this.addStreamTracks(peer);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendPeerSignal(peer, { candidate: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      const stream = event.streams?.[0] || new MediaStream([event.track]);
      this.dispatchEvent(new CustomEvent("remote-stream", { detail: { peerId, stream } }));
    };

    pc.ondatachannel = (event) => {
      this.attachChannel(peer, event.channel);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        peer.lastConnectedAt = Date.now();
        peer.repairAttempts = 0;
      }
      this.dispatchEvent(
        new CustomEvent("peer-state", {
          detail: {
            peerId,
            state: pc.connectionState,
            iceState: pc.iceConnectionState,
            signalingState: pc.signalingState,
            summary: this.connectionSummary()
          }
        })
      );
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
        if (pc.connectionState === "failed") this.restartIce(peer);
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        peer.lastConnectedAt = Date.now();
        peer.repairAttempts = 0;
      }
      this.dispatchEvent(
        new CustomEvent("peer-state", {
          detail: {
            peerId,
            state: pc.connectionState,
            iceState: pc.iceConnectionState,
            signalingState: pc.signalingState,
            summary: this.connectionSummary()
          }
        })
      );
    };

    pc.onnegotiationneeded = async () => {
      if (initiator || peer.channel?.readyState === "open") {
        this.scheduleRenegotiate(peerId, 60);
      }
    };

    if (initiator) {
      this.attachChannel(peer, pc.createDataChannel("syncinema", { ordered: true }));
      queueMicrotask(() => this.scheduleRenegotiate(peerId, 60));
    } else {
      queueMicrotask(() => this.scheduleRenegotiate(peerId, 120));
    }

    return peer;
  }

  isPolitePeer(peerId) {
    if (!this.selfId || !peerId) return false;
    return String(this.selfId) > String(peerId);
  }

  async addStreamTracks(peer) {
    const audioTrack = this.localStream?.getAudioTracks?.()[0] || null;
    const transceiver = this.ensureAudioTransceiver(peer);
    if (!transceiver) return;
    transceiver.direction = audioTrack ? "sendrecv" : "recvonly";
    if (transceiver.sender.track !== audioTrack) {
      await transceiver.sender.replaceTrack(audioTrack).catch((error) => {
        console.warn("Audio track replace failed", error);
      });
    }
  }

  ensureAudioTransceiver(peer) {
    if (peer.audioTransceiver) return peer.audioTransceiver;
    const existing = peer.pc
      .getTransceivers()
      .find((transceiver) => transceiver.receiver?.track?.kind === "audio" || transceiver.sender?.track?.kind === "audio");
    peer.audioTransceiver =
      existing ||
      peer.pc.addTransceiver("audio", {
        direction: this.localStream?.getAudioTracks?.()[0] ? "sendrecv" : "recvonly"
      });
    return peer.audioTransceiver;
  }

  sendPeerSignal(peer, payload) {
    this.socket.sendSignal(peer.id, {
      ...payload,
      sessionId: peer.localSessionId,
      replyToSessionId: peer.remoteSessionId || null
    });
  }

  attachChannel(peer, channel) {
    peer.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = DATA_CHANNEL_LOW_WATER;

    channel.onopen = () => {
      this.dispatchEvent(new CustomEvent("peer-open", { detail: { peerId: peer.id } }));
    };

    channel.onclose = () => {
      this.dispatchEvent(new CustomEvent("peer-close", { detail: { peerId: peer.id } }));
    };

    channel.onmessage = async (event) => {
      if (typeof event.data === "string") {
        this.handleJsonMessage(peer, event.data);
        return;
      }

      const buffer = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
      this.handleBinaryPayload(peer, buffer);
    };
  }

  handleJsonMessage(peer, raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (message.kind === "chunk-start") {
      this.prepareIncomingChunk(peer, message);
      return;
    }

    if (message.kind === "chunk" || message.kind === "chunk-part") {
      peer.pendingBinary = message;
      return;
    }

    this.dispatchEvent(
      new CustomEvent("data-message", {
        detail: { peerId: peer.id, message }
      })
    );
  }

  prepareIncomingChunk(peer, message) {
    const messageId = String(message.messageId || "");
    const parts = Number(message.parts);
    const byteLength = Number(message.byteLength);
    if (!messageId || !Number.isInteger(parts) || parts <= 0 || !Number.isFinite(byteLength)) return;

    peer.incomingChunks.set(messageId, {
      header: {
        kind: "chunk",
        videoId: message.videoId,
        index: message.index,
        byteLength
      },
      parts: new Array(parts),
      received: 0,
      receivedBytes: 0,
      byteLength
    });
  }

  handleBinaryPayload(peer, buffer) {
    const header = peer.pendingBinary;
    peer.pendingBinary = null;
    if (!header) return;

    if (header.kind !== "chunk-part") {
      this.dispatchEvent(
        new CustomEvent("binary-message", {
          detail: { peerId: peer.id, header, buffer }
        })
      );
      return;
    }

    const state = peer.incomingChunks.get(header.messageId);
    const partIndex = Number(header.partIndex);
    if (!state || !Number.isInteger(partIndex) || partIndex < 0 || partIndex >= state.parts.length) return;
    if (state.parts[partIndex]) return;

    state.parts[partIndex] = buffer;
    state.received += 1;
    state.receivedBytes += buffer.byteLength || buffer.length || 0;

    if (state.received !== state.parts.length) return;

    peer.incomingChunks.delete(header.messageId);
    const merged = new Uint8Array(state.receivedBytes);
    let offset = 0;
    for (const part of state.parts) {
      if (!part) return;
      merged.set(new Uint8Array(part), offset);
      offset += part.byteLength || part.length || 0;
    }

    this.dispatchEvent(
      new CustomEvent("binary-message", {
        detail: { peerId: peer.id, header: state.header, buffer: merged.buffer }
      })
    );
  }

  async renegotiate(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer || peer.makingOffer) return;
    if (peer.pc.signalingState !== "stable") {
      this.scheduleRenegotiate(peerId, 300);
      return;
    }

    try {
      peer.makingOffer = true;
      await peer.pc.setLocalDescription(await peer.pc.createOffer());
      this.sendPeerSignal(peer, { description: peer.pc.localDescription });
    } catch (error) {
      console.warn("WebRTC offer failed", error);
    } finally {
      peer.makingOffer = false;
    }
  }

  scheduleRenegotiate(peerId, delay = 80) {
    const peer = this.peers.get(peerId);
    if (!peer || peer.pc.signalingState === "closed") return;
    window.clearTimeout(peer.renegotiateTimer);
    peer.renegotiateTimer = window.setTimeout(() => {
      peer.renegotiateTimer = null;
      this.renegotiate(peerId);
    }, delay);
  }

  async restartIce(peer) {
    try {
      peer.pc.restartIce();
      await this.renegotiate(peer.id);
    } catch (error) {
      console.warn("ICE restart failed", error);
    }
  }

  repairUnconnectedPeers(peerIds = [], options = {}) {
    const activePeerIds = new Set(peerIds.filter((peerId) => peerId && peerId !== this.selfId));
    const now = Date.now();

    for (const peerId of activePeerIds) {
      const peer = this.ensurePeer(peerId, true);
      const connected =
        peer.pc.connectionState === "connected" ||
        peer.pc.iceConnectionState === "connected" ||
        peer.pc.iceConnectionState === "completed";
      if (connected && !options.force) continue;

      const age = now - peer.createdAt;
      const sinceRepair = now - peer.lastRepairAt;
      if (!options.force && (age < 4500 || sinceRepair < 4500)) continue;

      peer.lastRepairAt = now;
      peer.repairAttempts += 1;

      if (options.force || peer.repairAttempts >= 3) {
        this.removePeer(peerId);
        const nextPeer = this.ensurePeer(peerId, true);
        void this.addStreamTracks(nextPeer);
        this.scheduleRenegotiate(peerId, 120);
        continue;
      }

      void this.addStreamTracks(peer);
      if (peer.pc.iceConnectionState === "failed" || peer.pc.connectionState === "failed") {
        this.restartIce(peer);
      } else {
        this.scheduleRenegotiate(peerId, 80);
      }
    }
  }

  sendJSON(peerId, message) {
    const channel = this.peers.get(peerId)?.channel;
    if (!channel || channel.readyState !== "open") return false;
    return safeSend(channel, JSON.stringify(message));
  }

  broadcastJSON(message) {
    let sent = 0;
    for (const peerId of this.peers.keys()) {
      if (this.sendJSON(peerId, message)) sent += 1;
    }
    return sent;
  }

  openPeerCount() {
    let count = 0;
    for (const peer of this.peers.values()) {
      if (peer.channel?.readyState === "open") count += 1;
    }
    return count;
  }

  connectionSummary() {
    const peers = Array.from(this.peers.values());
    return {
      total: peers.length,
      connected: peers.filter((peer) => peer.pc.connectionState === "connected").length,
      connecting: peers.filter((peer) => ["new", "connecting"].includes(peer.pc.connectionState)).length,
      disconnected: peers.filter((peer) => ["disconnected", "failed", "closed"].includes(peer.pc.connectionState)).length,
      channelsOpen: peers.filter((peer) => peer.channel?.readyState === "open").length
    };
  }

  async diagnostics() {
    const peers = [];
    for (const peer of this.peers.values()) {
      let outboundAudio = null;
      let inboundAudio = null;
      try {
        const stats = await peer.pc.getStats();
        stats.forEach((report) => {
          if (report.type === "outbound-rtp" && report.kind === "audio") {
            outboundAudio = {
              bytesSent: Number(report.bytesSent || 0),
              packetsSent: Number(report.packetsSent || 0)
            };
          }
          if (report.type === "inbound-rtp" && report.kind === "audio") {
            inboundAudio = {
              bytesReceived: Number(report.bytesReceived || 0),
              packetsReceived: Number(report.packetsReceived || 0),
              packetsLost: Number(report.packetsLost || 0)
            };
          }
        });
      } catch {
        // A closing peer may reject getStats while diagnostics are collected.
      }
      const senderTrack = peer.audioTransceiver?.sender?.track || null;
      const receiverTrack = peer.audioTransceiver?.receiver?.track || null;
      peers.push({
        peerId: peer.id,
        connectionState: peer.pc.connectionState,
        iceConnectionState: peer.pc.iceConnectionState,
        signalingState: peer.pc.signalingState,
        senderTrack: senderTrack && {
          id: senderTrack.id,
          enabled: senderTrack.enabled,
          muted: senderTrack.muted,
          readyState: senderTrack.readyState
        },
        receiverTrack: receiverTrack && {
          id: receiverTrack.id,
          enabled: receiverTrack.enabled,
          muted: receiverTrack.muted,
          readyState: receiverTrack.readyState
        },
        outboundAudio,
        inboundAudio
      });
    }
    return { selfId: this.selfId, localTrackCount: this.localStream?.getAudioTracks?.().length || 0, peers };
  }

  async sendChunk(peerId, header, buffer) {
    const peer = this.peers.get(peerId);
    const channel = peer?.channel;
    if (!peer || !channel || channel.readyState !== "open") return false;

    peer.sendQueue = peer.sendQueue.then(async () => {
      if (channel.readyState !== "open") return false;
      await waitForChannelBackpressure(channel);
      if (channel.readyState !== "open") return false;
      const messageId = createId("chunk");
      const parts = Math.ceil(buffer.byteLength / DATA_CHANNEL_FRAME_SIZE);
      if (!safeSend(channel, JSON.stringify({ kind: "chunk-start", ...header, messageId, byteLength: buffer.byteLength, parts }))) {
        return false;
      }

      for (let partIndex = 0; partIndex < parts; partIndex += 1) {
        if (channel.readyState !== "open") return false;
        await waitForChannelBackpressure(channel);
        const start = partIndex * DATA_CHANNEL_FRAME_SIZE;
        const end = Math.min(start + DATA_CHANNEL_FRAME_SIZE, buffer.byteLength);
        const part = buffer.slice(start, end);
        if (!safeSend(
          channel,
          JSON.stringify({
            kind: "chunk-part",
            ...header,
            messageId,
            partIndex,
            parts,
            byteLength: part.byteLength
          })
        )) {
          return false;
        }
        await waitForChannelBackpressure(channel);
        if (!safeSend(channel, part)) return false;
        await wait(1);
      }

      await waitForChannelBackpressure(channel);
      if (channel.readyState !== "open") return false;
      return true;
    });

    return peer.sendQueue;
  }
}
