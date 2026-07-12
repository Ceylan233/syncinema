export class VoiceManager extends EventTarget {
  constructor(roomSocket, ui) {
    super();
    this.socket = roomSocket;
    this.ui = ui;
    this.stream = null;
    this.inputStream = null;
    this.audioContext = null;
    this.gateGain = null;
    this.inputGain = null;
    this.captureSource = null;
    this.highpassFilter = null;
    this.lowpassFilter = null;
    this.postNoiseFilter = null;
    this.compressor = null;
    this.rnnoiseNode = null;
    this.rnnoiseModule = null;
    this.rnnoiseState = null;
    this.rnnoiseProcessor = null;
    this.rnnoiseInputFrame = null;
    this.rnnoiseFrameOffset = 0;
    this.rnnoiseOutputQueue = [];
    this.rnnoiseNoticeShown = false;
    this.rnnoiseAvailable = false;
    this.rnnoiseStatus = "off";
    this.speakingSource = null;
    this.speakingAnalyser = null;
    this.speakingFrame = null;
    this.noiseFloor = 0.006;
    this.speaking = false;
    this.enabled = false;
    this.watching = false;
    this.outputVolume = this.loadOutputVolume();
    this.lastVoiceAt = 0;
    this.lastSignalAt = 0;
    this.playUnlockInstalled = false;
    this.audioUnlocked = false;
    this.lastAudioUnlockNoticeAt = 0;
    this.remotePlaybackBlocked = false;
    this.remoteAudios = new Map();
    this.remoteP2PMeters = new Map();
    this.expectedRemotePeers = new Set();
    this.realtimePeers = new Map();
    this.relayProcessor = null;
    this.relaySource = null;
    this.relayInputNode = null;
    this.relaySilentGain = null;
    this.relaySampleRate = 48000;
    this.relayPlayers = new Map();
    this.voicePacketSeq = 0;
    this.inputVolume = this.loadInputVolume();
    this.noiseReductionEnabled = this.loadNoiseReduction();
    this.ui.setNoiseControl?.({ enabled: this.noiseReductionEnabled });
    this.installPlaybackUnlock();
    window.setTimeout(() => this.preloadRnnoiseModule(), 1200);
  }

  async start() {
    if (this.stream) {
      this.enableTracks();
      this.startSocketRelay();
      return this.stream;
    }

    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      const message = window.isSecureContext
        ? "当前浏览器不支持麦克风接口。"
        : "手机通过局域网 HTTP 打开时，浏览器可能不开放麦克风；请改用 HTTPS。";
      this.ui.setVoiceState("语音需要 HTTPS", "danger");
      this.ui.setMicControl({ enabled: false, busy: false, text: "开启麦克风" });
      this.ui.addSystemMessage(message);
      throw new Error("getUserMedia requires a secure context");
    }

    try {
      this.inputStream = await navigator.mediaDevices.getUserMedia({
        audio: this.buildAudioConstraints(),
        video: false
      });
      this.disconnectProcessingGraph();
      await this.prepareRnnoiseProcessor();
      this.stream = this.createProcessedStream(this.inputStream);
      await this.applyVoiceEnhancements();
      this.reportVoiceEnhancements();
      this.enableTracks();
      this.watchSpeaking();
      this.startSocketRelay();
      return this.stream;
    } catch (error) {
      this.ui.setVoiceState("麦克风未开启", "danger");
      this.ui.setMicControl({ enabled: false, busy: false, text: "开启麦克风" });
      this.ui.addSystemMessage("浏览器没有拿到麦克风权限，仍可观看和聊天。");
      throw error;
    }
  }

  buildAudioConstraints() {
    const supported = navigator.mediaDevices.getSupportedConstraints?.() || {};
    const audio = {};

    if (supported.echoCancellation) audio.echoCancellation = true;
    if (supported.noiseSuppression) audio.noiseSuppression = this.noiseReductionEnabled;
    if (supported.autoGainControl) audio.autoGainControl = false;
    if (supported.voiceIsolation) audio.voiceIsolation = false;
    if (supported.channelCount) audio.channelCount = { ideal: 1 };
    if (supported.sampleRate) audio.sampleRate = { ideal: 48000 };
    if (supported.sampleSize) audio.sampleSize = { ideal: 16 };

    return Object.keys(audio).length > 0 ? audio : true;
  }

  async applyVoiceEnhancements() {
    const [track] = this.inputStream?.getAudioTracks() || [];
    if (!track?.applyConstraints) return;

    try {
      await track.applyConstraints(this.buildAudioConstraints());
    } catch (error) {
      console.warn("Voice enhancement constraints were partially rejected", error);
    }
  }

  async setNoiseReduction(enabled) {
    this.noiseReductionEnabled = Boolean(enabled);
    localStorage.setItem("pc:noise-reduction", this.noiseReductionEnabled ? "1" : "0");
    this.ui.setNoiseControl?.({ enabled: this.noiseReductionEnabled, busy: true });
    if (this.inputStream) {
      await this.rebuildProcessingGraph();
    } else {
      await this.applyVoiceEnhancements();
      this.updateProcessingMode();
    }
    this.ui.setNoiseControl?.({ enabled: this.noiseReductionEnabled });
    this.ui.addSystemMessage(this.noiseReductionEnabled ? "麦克风降噪已开启" : "麦克风降噪已关闭，拾音会更灵敏");
  }

  async toggleNoiseReduction() {
    await this.setNoiseReduction(!this.noiseReductionEnabled);
    return this.stream;
  }

  reportVoiceEnhancements() {
    const [track] = this.inputStream?.getAudioTracks() || [];
    const settings = track?.getSettings?.() || {};
    const enabled = [];
    const unsupported = [];

    if (settings.echoCancellation) enabled.push("回声消除");
    else unsupported.push("回声消除");

    if (this.noiseReductionEnabled && settings.noiseSuppression) enabled.push("浏览器降噪");
    if (this.noiseReductionEnabled && this.rnnoiseAvailable) enabled.push("RNNoise 强力降噪");

    if (settings.autoGainControl) enabled.push("自动增益");
    else unsupported.push("自动增益");

    if (settings.voiceIsolation) enabled.push("人声隔离");

    if (enabled.length > 0) {
      this.ui.addSystemMessage(`麦克风处理已启用：${enabled.join("、")}、软件噪声门。`);
    }

    if (unsupported.length > 0) {
      this.ui.addSystemMessage(`当前浏览器未确认支持：${unsupported.join("、")}。`);
    }
  }

  enableTracks() {
    this.enabled = true;
    this.inputStream?.getAudioTracks().forEach((track) => {
      track.enabled = true;
    });
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = true;
    });
    this.ui.setVoiceState("语音已开启", "ok");
    this.ui.setMicControl({ enabled: true });
  }

  disable() {
    this.enabled = false;
    this.inputStream?.getAudioTracks().forEach((track) => {
      track.enabled = false;
    });
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = false;
    });
    if (this.speaking) {
      this.speaking = false;
      this.socket.sendSpeaking(false);
      this.dispatchEvent(new CustomEvent("local-speaking", { detail: { speaking: false } }));
    }
    this.ui.setVoiceState("麦克风已关闭", "warn");
    this.ui.setMicControl({ enabled: false });
  }

  async toggle() {
    if (this.enabled) {
      this.disable();
      return this.stream;
    }

    return this.start();
  }

  async restartCapture() {
    const wasEnabled = this.enabled;
    this.stopSocketRelay();
    this.stopSpeakingWatch();
    this.disconnectProcessingGraph();
    this.inputStream?.getTracks().forEach((track) => track.stop());
    this.inputStream = await navigator.mediaDevices.getUserMedia({
      audio: this.buildAudioConstraints(),
      video: false
    });
    await this.prepareRnnoiseProcessor();
    this.stream = this.createProcessedStream(this.inputStream);
    await this.applyVoiceEnhancements();
    this.reportVoiceEnhancements();
    this.watchSpeaking();
    if (wasEnabled) {
      this.enableTracks();
      this.startSocketRelay();
    } else {
      this.disable();
    }
    return this.stream;
  }

  async rebuildProcessingGraph() {
    const wasEnabled = this.enabled;
    this.stopSocketRelay();
    this.disconnectProcessingGraph();
    await this.applyVoiceEnhancements();
    await this.prepareRnnoiseProcessor();
    this.stream = this.createProcessedStream(this.inputStream);
    this.watchSpeaking();
    if (wasEnabled) {
      this.enableTracks();
      this.startSocketRelay();
    } else {
      this.disable();
    }
    return this.stream;
  }

  attachRemoteStream(peerId, stream) {
    let audio = document.querySelector(`audio[data-peer-id="${peerId}"]`);
    if (!audio) {
      audio = document.createElement("audio");
      audio.dataset.peerId = peerId;
      audio.autoplay = true;
      audio.playsInline = true;
      audio.muted = false;
      document.body.append(audio);
    }
    audio.volume = this.outputVolume;
    audio.srcObject = stream;
    this.remoteAudios.set(peerId, audio);
    this.stopRemoteP2PMeter(peerId);
    this.startRemoteP2PMeter(peerId, stream);
    this.dispatchEvent(
      new CustomEvent("remote-audio-state", {
        detail: {
          peerId,
          attached: true,
          blocked: false,
          playing: false,
          trackCount: stream.getAudioTracks?.().length || 0
        }
      })
    );
    this.installPlaybackUnlock();
    this.playRemoteAudio(audio);
  }

  async unlockPlayback() {
    const audioContext = this.ensureAudioContext();
    if (!audioContext) return;
    await audioContext.resume?.().catch(() => {});
    this.primeAudioOutput(audioContext);
    this.audioUnlocked = audioContext.state === "running";
    if (this.audioUnlocked) {
      this.remotePlaybackBlocked = false;
    }
    document.querySelectorAll("audio[data-peer-id]").forEach((audio) => {
      this.playRemoteAudio(audio);
    });
  }

  installPlaybackUnlock() {
    if (this.playUnlockInstalled) return;
    this.playUnlockInstalled = true;
    const unlock = () => this.unlockPlayback();
    ["pointerdown", "touchstart", "keydown", "click"].forEach((eventName) => {
      document.addEventListener(eventName, unlock, { passive: true, capture: true });
    });
  }

  ensureAudioContext() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!this.audioContext && AudioContextClass) this.audioContext = new AudioContextClass();
    return this.audioContext;
  }

  primeAudioOutput(audioContext = this.audioContext) {
    if (!audioContext || this.audioUnlocked) return;
    try {
      const buffer = audioContext.createBuffer(1, Math.max(1, Math.floor(audioContext.sampleRate * 0.02)), audioContext.sampleRate);
      const source = audioContext.createBufferSource();
      const gain = audioContext.createGain();
      gain.gain.value = 0.00001;
      source.buffer = buffer;
      source.connect(gain);
      gain.connect(audioContext.destination);
      source.start();
      source.onended = () => {
        try {
          source.disconnect();
          gain.disconnect();
        } catch {
          // Ignore stale unlock nodes.
        }
      };
    } catch {
      // Some mobile browsers reject silent priming until the next gesture.
    }
  }

  playRemoteAudio(audio) {
    audio.play?.().then(() => {
      this.remotePlaybackBlocked = false;
      this.dispatchEvent(
        new CustomEvent("remote-audio-state", {
          detail: {
            peerId: audio.dataset.peerId,
            attached: true,
            blocked: false,
            playbackReady: true,
            playing: false
          }
        })
      );
    }).catch(() => {
      if (this.remotePlaybackBlocked) return;
      this.remotePlaybackBlocked = true;
      this.dispatchEvent(
        new CustomEvent("remote-audio-state", {
          detail: {
            peerId: audio.dataset.peerId,
            attached: true,
            blocked: true,
            playing: false
          }
        })
      );
      this.ui.setVoiceState("语音接收中", "warn");
    });
  }

  startRemoteP2PMeter(peerId, stream) {
    if (!peerId || !stream || this.remoteP2PMeters.has(peerId)) return;
    const tracks = stream.getAudioTracks?.() || [];
    if (tracks.length === 0) return;

    const audioContext = this.ensureAudioContext();
    if (!audioContext) return;
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const meter = {
      source,
      analyser,
      samples,
      frame: null,
      lastAudibleAt: 0,
      stopped: false
    };
    this.remoteP2PMeters.set(peerId, meter);

    const tick = () => {
      if (meter.stopped || this.remoteP2PMeters.get(peerId) !== meter) return;
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const value of samples) {
        const normalized = (value - 128) / 128;
        sum += normalized * normalized;
      }
      const rms = Math.sqrt(sum / samples.length);
      meter.lastRms = rms;
      if (rms > 0.004) meter.lastAudibleAt = Date.now();
      meter.frame = requestAnimationFrame(tick);
    };
    tick();
  }

  stopRemoteP2PMeter(peerId) {
    const meter = this.remoteP2PMeters.get(peerId);
    if (!meter) return;
    meter.stopped = true;
    if (meter.frame) cancelAnimationFrame(meter.frame);
    try {
      meter.source?.disconnect?.();
      meter.analyser?.disconnect?.();
    } catch {
      // Ignore stale remote audio analyser nodes.
    }
    this.remoteP2PMeters.delete(peerId);
  }

  removeRemotePeer(peerId) {
    this.setRealtimePeer(peerId, false);
    this.expectedRemotePeers.delete(peerId);
    this.stopRemoteP2PMeter(peerId);
    const audio = this.remoteAudios.get(peerId);
    if (audio) {
      audio.pause?.();
      audio.srcObject = null;
      audio.remove?.();
    }
    this.remoteAudios.delete(peerId);
    const relay = this.relayPlayers.get(peerId);
    if (relay) {
      try {
        relay.gain?.disconnect?.();
      } catch {
        // Ignore stale relay audio nodes.
      }
    }
    this.relayPlayers.delete(peerId);
  }

  hasRecentP2PAudio(peerId) {
    const meter = this.remoteP2PMeters.get(peerId);
    return Boolean(meter && Date.now() - meter.lastAudibleAt < 550 && (meter.lastRms || 0) > 0.004);
  }

  isMobilePlaybackDevice() {
    const ua = navigator.userAgent || "";
    return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || matchMedia?.("(pointer: coarse)")?.matches;
  }

  shouldSuppressRelayPlayback(peerId) {
    if (!this.audioUnlocked || this.remotePlaybackBlocked) return false;
    if (!this.hasRecentP2PAudio(peerId)) return false;

    const audio = this.remoteAudios.get(peerId);
    if (!audio) return false;
    return !audio.paused && audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
  }

  setExpectedRemotePeers(peerIds = []) {
    this.expectedRemotePeers = new Set(
      peerIds
        .map((peerId) => String(peerId || ""))
        .filter(Boolean)
    );
    for (const peerId of Array.from(this.realtimePeers.keys())) {
      if (!this.expectedRemotePeers.has(peerId)) this.realtimePeers.delete(peerId);
    }
  }

  setRealtimePeer(peerId, connected) {
    if (!peerId) return;
    const id = String(peerId);
    if (connected) {
      this.realtimePeers.set(id, Date.now());
    } else {
      this.realtimePeers.delete(id);
    }
  }

  realtimePeerCount() {
    return Array.from(this.realtimePeers.keys()).filter((peerId) => this.expectedRemotePeers.has(peerId)).length;
  }

  relayTargetIds() {
    return Array.from(this.expectedRemotePeers);
  }

  createProcessedStream(inputStream) {
    this.audioContext = this.ensureAudioContext();
    if (!this.audioContext) throw new Error("AudioContext is not supported");
    this.audioContext.resume?.().catch(() => {});

    const source = this.audioContext.createMediaStreamSource(inputStream);
    this.captureSource = source;
    this.inputGain = this.audioContext.createGain();
    this.inputGain.gain.value = this.inputVolume;
    const highpass = this.audioContext.createBiquadFilter();
    this.highpassFilter = highpass;
    highpass.type = "highpass";
    highpass.frequency.value = this.noiseReductionEnabled ? 55 : 35;
    highpass.Q.value = 0.7;

    const lowpass = this.audioContext.createBiquadFilter();
    this.lowpassFilter = lowpass;
    lowpass.type = "lowpass";
    lowpass.frequency.value = this.noiseReductionEnabled ? 14500 : 18000;
    lowpass.Q.value = 0.45;

    const postNoiseFilter = this.audioContext.createBiquadFilter();
    this.postNoiseFilter = postNoiseFilter;
    postNoiseFilter.type = "lowpass";
    postNoiseFilter.frequency.value = 9600;
    postNoiseFilter.Q.value = 0.35;

    const compressor = this.audioContext.createDynamicsCompressor();
    this.compressor = compressor;
    compressor.threshold.value = this.noiseReductionEnabled ? -26 : -32;
    compressor.knee.value = 30;
    compressor.ratio.value = this.noiseReductionEnabled ? 1.18 : 1.1;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.3;

    this.gateGain = this.audioContext.createGain();
    this.gateGain.gain.value = 1;

    const destination = this.audioContext.createMediaStreamDestination();
    source.connect(this.inputGain);
    this.inputGain.connect(highpass);
    if (this.noiseReductionEnabled && this.rnnoiseProcessor) {
      highpass.connect(lowpass);
      lowpass.connect(this.rnnoiseProcessor);
      this.rnnoiseProcessor.connect(postNoiseFilter);
      postNoiseFilter.connect(this.gateGain);
    } else {
      highpass.connect(lowpass);
      lowpass.connect(compressor);
      compressor.connect(this.gateGain);
    }
    this.gateGain.connect(destination);

    return destination.stream;
  }

  async preloadRnnoiseModule() {
    if (this.rnnoiseModule) return true;
    try {
      const { Rnnoise } = await import("/vendor/rnnoise/rnnoise.js?v=20260710-shiguredo-2");
      this.rnnoiseModule = await Rnnoise.load();
      return true;
    } catch (error) {
      console.warn("RNNoise preload failed", error);
      return false;
    }
  }

  async prepareRnnoiseProcessor() {
    this.rnnoiseNode = null;
    this.rnnoiseProcessor = null;
    this.rnnoiseState?.destroy?.();
    this.rnnoiseState = null;
    this.rnnoiseInputFrame = null;
    this.rnnoiseFrameOffset = 0;
    this.rnnoiseOutputQueue = [];
    this.rnnoiseAvailable = false;
    this.rnnoiseStatus = "off";
    if (!this.noiseReductionEnabled || !this.useRnnoiseEngine()) return false;
    this.audioContext = this.ensureAudioContext();
    if (!this.audioContext?.createScriptProcessor) {
      this.rnnoiseStatus = "unsupported";
      return false;
    }

    try {
      if (!this.rnnoiseModule) {
        await this.preloadRnnoiseModule();
      }
      if (!this.rnnoiseModule) throw new Error("RNNoise module unavailable");
      const frameSize = this.rnnoiseModule.frameSize || 480;
      this.rnnoiseState = this.rnnoiseModule.createDenoiseState();
      this.rnnoiseInputFrame = new Float32Array(frameSize);
      this.rnnoiseFrameOffset = 0;
      this.rnnoiseOutputQueue = [];
      this.rnnoiseProcessor = this.audioContext.createScriptProcessor(2048, 1, 1);
      this.rnnoiseProcessor.onaudioprocess = (event) => this.processRnnoiseAudio(event);
      this.rnnoiseAvailable = true;
      this.rnnoiseStatus = "ready";
      if (!this.rnnoiseNoticeShown) {
        this.ui.addSystemMessage("RNNoise 强力降噪已启用");
        this.rnnoiseNoticeShown = true;
      }
      return true;
    } catch (error) {
      this.rnnoiseStatus = "failed";
      console.warn("RNNoise unavailable", error);
      this.ui.addSystemMessage(`RNNoise 加载失败，已回退到普通麦克风处理：${error?.message || "未知原因"}`);
      return false;
    }
  }

  useRnnoiseEngine() {
    return localStorage.getItem("pc:noise-engine") === "rnnoise";
  }

  processRnnoiseAudio(event) {
    const input = event.inputBuffer.getChannelData(0);
    const output = event.outputBuffer.getChannelData(0);
    if (!this.rnnoiseState || !this.rnnoiseInputFrame) {
      output.set(input);
      return;
    }

    for (let index = 0; index < output.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, input[index] || 0));
      this.rnnoiseInputFrame[this.rnnoiseFrameOffset] = sample * 32768;
      const queued = this.rnnoiseOutputQueue.shift();
      output[index] = queued === undefined ? sample : queued;
      this.rnnoiseFrameOffset += 1;

      if (this.rnnoiseFrameOffset >= this.rnnoiseInputFrame.length) {
        const frame = new Float32Array(this.rnnoiseInputFrame);
        try {
          this.rnnoiseState.processFrame(frame);
          for (let frameIndex = 0; frameIndex < frame.length; frameIndex += 1) {
            this.rnnoiseOutputQueue.push(Math.max(-1, Math.min(1, frame[frameIndex] / 32768)));
          }
        } catch (error) {
          console.warn("RNNoise frame failed", error);
          output.set(input);
          this.rnnoiseStatus = "failed";
          return;
        }
        this.rnnoiseFrameOffset = 0;
      }
    }
  }

  updateProcessingMode() {
    if (!this.audioContext) return;
    const now = this.audioContext.currentTime;
    this.highpassFilter?.frequency?.setTargetAtTime(this.noiseReductionEnabled ? 55 : 35, now, 0.04);
    this.lowpassFilter?.frequency?.setTargetAtTime(this.noiseReductionEnabled ? 14500 : 18000, now, 0.04);
    this.postNoiseFilter?.frequency?.setTargetAtTime(9600, now, 0.04);
    if (this.compressor) {
      this.compressor.threshold.setTargetAtTime(this.noiseReductionEnabled ? -26 : -32, now, 0.04);
      this.compressor.ratio.setTargetAtTime(this.noiseReductionEnabled ? 1.18 : 1.1, now, 0.04);
    }
    if (!this.noiseReductionEnabled && this.gateGain) {
      this.gateGain.gain.setTargetAtTime(this.enabled ? 1 : 0, now, 0.025);
    }
  }

  disconnectProcessingGraph() {
    [
      this.captureSource,
      this.inputGain,
      this.highpassFilter,
      this.lowpassFilter,
      this.postNoiseFilter,
      this.compressor,
      this.rnnoiseNode,
      this.rnnoiseProcessor,
      this.gateGain
    ].forEach((node) => {
      try {
        node?.disconnect?.();
      } catch {
        // Ignore stale WebAudio nodes.
      }
    });
    if (this.rnnoiseProcessor) this.rnnoiseProcessor.onaudioprocess = null;
    this.rnnoiseState?.destroy?.();
    this.rnnoiseState = null;
    this.rnnoiseProcessor = null;
    this.rnnoiseInputFrame = null;
    this.rnnoiseFrameOffset = 0;
    this.rnnoiseOutputQueue = [];
  }

  setOutputVolume(value) {
    this.outputVolume = Math.min(1, Math.max(0, value));
    localStorage.setItem("pc:voice-volume", String(this.outputVolume));
    document.querySelectorAll("audio[data-peer-id]").forEach((audio) => {
      audio.volume = this.outputVolume;
      this.playRemoteAudio(audio);
    });
    for (const player of this.relayPlayers.values()) {
      if (player.gain) player.gain.gain.value = this.outputVolume;
    }
  }

  setInputVolume(value) {
    this.inputVolume = Math.min(2, Math.max(0.25, value));
    localStorage.setItem("pc:mic-volume", String(this.inputVolume));
    if (this.inputGain) {
      this.inputGain.gain.setTargetAtTime(this.inputVolume, this.audioContext.currentTime, 0.02);
    }
  }

  loadOutputVolume() {
    const saved = Number(localStorage.getItem("pc:voice-volume"));
    if (!Number.isFinite(saved) || saved < 0.04) return 1;
    return Math.min(1, Math.max(0, saved));
  }

  loadInputVolume() {
    const saved = Number(localStorage.getItem("pc:mic-volume"));
    if (!Number.isFinite(saved) || saved < 0.25) return this.isMobilePlaybackDevice() ? 1.35 : 1.15;
    return Math.min(2, Math.max(0.25, saved));
  }

  watchSpeaking() {
    if (this.watching) return;
    this.watching = true;
    this.audioContext = this.ensureAudioContext();
    if (!this.audioContext) return;
    const source = this.audioContext.createMediaStreamSource(this.inputStream);
    const analyser = this.audioContext.createAnalyser();
    analyser.fftSize = 1024;
    const samples = new Uint8Array(analyser.fftSize);
    source.connect(analyser);
    this.speakingSource = source;
    this.speakingAnalyser = analyser;

    const tick = () => {
      if (!this.watching || this.speakingAnalyser !== analyser) return;
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const value of samples) {
        const normalized = (value - 128) / 128;
        sum += normalized * normalized;
      }

      const rms = Math.sqrt(sum / samples.length);
      this.updateNoiseGate(rms);
      const isSpeaking = this.enabled && rms > this.speakingThreshold();
      const now = Date.now();
      if (isSpeaking !== this.speaking && now - this.lastSignalAt > 250) {
        this.speaking = isSpeaking;
        this.lastSignalAt = now;
        this.socket.sendSpeaking(isSpeaking);
        this.dispatchEvent(new CustomEvent("local-speaking", { detail: { speaking: isSpeaking } }));
      }

      this.speakingFrame = requestAnimationFrame(tick);
    };

    tick();
  }

  stopSpeakingWatch() {
    this.watching = false;
    if (this.speakingFrame) cancelAnimationFrame(this.speakingFrame);
    this.speakingFrame = null;
    try {
      this.speakingSource?.disconnect?.();
    } catch {
      // Ignore stale analyser graph.
    }
    this.speakingSource = null;
    this.speakingAnalyser = null;
    if (this.speaking) {
      this.speaking = false;
      this.socket.sendSpeaking(false);
      this.dispatchEvent(new CustomEvent("local-speaking", { detail: { speaking: false } }));
    }
  }

  updateNoiseGate(rms) {
    if (!this.gateGain) return;

    const now = Date.now();
    if (!this.noiseReductionEnabled) {
      this.gateGain.gain.setTargetAtTime(this.enabled ? 1 : 0, this.audioContext.currentTime, 0.025);
      if (this.enabled && rms > 0.0045) this.lastVoiceAt = now;
      return;
    }

    if (rms < 0.01) {
      this.noiseFloor = this.noiseFloor * 0.99 + rms * 0.01;
    }

    const openThreshold = Math.max(0.0065, this.noiseFloor * 1.45);
    if (this.enabled && rms > openThreshold) this.lastVoiceAt = now;

    const recentlyVoiced = now - this.lastVoiceAt < 1500;
    const targetGain = this.enabled ? (recentlyVoiced ? 1 : 0.98) : 0;
    const timeConstant = targetGain >= 0.98 ? 0.08 : 0.18;
    this.gateGain.gain.setTargetAtTime(targetGain, this.audioContext.currentTime, timeConstant);
  }

  speakingThreshold() {
    return this.noiseReductionEnabled ? Math.max(0.0075, this.noiseFloor * 1.55) : 0.0075;
  }

  loadNoiseReduction() {
    return localStorage.getItem("pc:noise-reduction") === "1";
  }

  startSocketRelay() {
    if (this.relayProcessor || !this.gateGain || !this.socket?.sendVoicePacket) return;
    this.audioContext = this.ensureAudioContext();
    if (!this.audioContext) return;
    this.audioContext.resume?.().catch(() => {});

    try {
      this.relayProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);
      this.relaySilentGain = this.audioContext.createGain();
      this.relaySilentGain.gain.value = 0;
      this.relayInputNode = this.gateGain;

      this.relayProcessor.onaudioprocess = (event) => {
        if (!this.enabled || !this.socket.raw?.connected) return;
        if (this.expectedRemotePeers.size === 0) return;
        const input = event.inputBuffer.getChannelData(0);
        const downsampled = this.downsample(input, this.audioContext.sampleRate, this.relaySampleRate);
        if (!downsampled?.length) return;
        const pcm = this.floatToInt16(this.applyRelayAutoGain(downsampled));
        this.socket.sendVoicePacket(
          {
            sampleRate: this.relaySampleRate,
            channels: 1,
            seq: this.voicePacketSeq++,
            sentAt: Date.now()
          },
          pcm.buffer
        );
      };

      this.relayInputNode.connect(this.relayProcessor);
      this.relayProcessor.connect(this.relaySilentGain);
      this.relaySilentGain.connect(this.audioContext.destination);
    } catch (error) {
      console.warn("Socket voice relay failed to start", error);
      this.relayProcessor = null;
      this.relaySource = null;
      this.relayInputNode = null;
      this.relaySilentGain = null;
    }
  }

  stopSocketRelay() {
    if (this.relayProcessor) {
      try {
        this.relayProcessor.disconnect();
      } catch {
        // Ignore stale relay node cleanup.
      }
    }
    if (this.relayInputNode) {
      try {
        this.relayInputNode.disconnect(this.relayProcessor);
      } catch {
        // Ignore stale relay node cleanup.
      }
    }
    if (this.relaySilentGain) {
      try {
        this.relaySilentGain.disconnect();
      } catch {
        // Ignore stale relay node cleanup.
      }
    }
    this.relayProcessor = null;
    this.relaySource = null;
    this.relayInputNode = null;
    this.relaySilentGain = null;
  }

  async handleVoicePacket(peerId, meta = {}, buffer) {
    if (!peerId || !buffer) return;
    if (this.shouldSuppressRelayPlayback(peerId)) {
      return;
    }
    this.installPlaybackUnlock();
    const audioContext = this.ensureAudioContext();
    if (!audioContext) {
      this.ui.setVoiceState("浏览器不支持语音播放", "danger");
      return;
    }
    await audioContext.resume?.().catch(() => {});
    this.audioUnlocked = audioContext.state === "running";
    if (this.audioUnlocked) this.remotePlaybackBlocked = false;
    if (audioContext.state !== "running") {
      this.noticeAudioUnlockNeeded(peerId);
    }

    let player = this.relayPlayers.get(peerId);
    if (!player) {
      const gain = audioContext.createGain();
      gain.gain.value = this.outputVolume;
      gain.connect(audioContext.destination);
      player = {
        gain,
        nextTime: audioContext.currentTime + 0.18,
        lastSeq: -1,
        lastSeqAt: 0,
        lastArrivalAt: 0,
        lastDropNoticeAt: 0
      };
      this.relayPlayers.set(peerId, player);
    }

    const nowMs = Date.now();
    const seq = Number(meta.seq);
    let looksLikeSenderRestarted = false;
    if (Number.isFinite(seq)) {
      looksLikeSenderRestarted = seq < 8 && player.lastSeq > 48 && nowMs - (player.lastSeqAt || 0) > 800;
      const looksLikeLatePacket = seq <= player.lastSeq && !looksLikeSenderRestarted;
      if (looksLikeLatePacket) return;
      if (looksLikeSenderRestarted) player.nextTime = audioContext.currentTime + 0.12;
      player.lastSeq = seq;
      player.lastSeqAt = nowMs;
    }

    const previousArrivalAt = player.lastArrivalAt || 0;
    if (previousArrivalAt && nowMs - previousArrivalAt > 900) {
      player.nextTime = audioContext.currentTime + 0.16;
    }
    player.lastArrivalAt = nowMs;

    const bytes = await this.resolveVoiceBuffer(buffer);
    if (!bytes?.byteLength) return;
    const pcm = new Int16Array(bytes);
    if (pcm.length === 0) return;
    const rms = this.pcmRms(pcm);

    const sampleRate = Number(meta.sampleRate || this.relaySampleRate);
    const audioBuffer = audioContext.createBuffer(1, pcm.length, sampleRate);
    const channel = audioBuffer.getChannelData(0);
    for (let index = 0; index < pcm.length; index += 1) {
      channel[index] = Math.max(-1, Math.min(1, pcm[index] / 32768));
    }

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    const packetGain = audioContext.createGain();
    packetGain.connect(player.gain);
    source.connect(packetGain);
    source.onended = () => {
      try {
        source.disconnect();
        packetGain.disconnect();
      } catch {
        // Ignore already-disconnected packet nodes.
      }
    };
    const backlog = player.nextTime - audioContext.currentTime;
    if (backlog > 0.7) {
      player.nextTime = audioContext.currentTime + 0.16;
      this.noticeVoiceDrop(player, peerId);
    }
    const startAt = Math.max(audioContext.currentTime + 0.08, player.nextTime);
    const continuousPacket = previousArrivalAt && nowMs - previousArrivalAt < 260 && !looksLikeSenderRestarted;
    this.applyPacketEnvelope(packetGain, startAt, audioBuffer.duration, continuousPacket);
    source.start(startAt);
    player.nextTime = startAt + audioBuffer.duration;

    if (player.nextTime - audioContext.currentTime > 0.8) {
      player.nextTime = audioContext.currentTime + 0.18;
    }

    this.dispatchEvent(
      new CustomEvent("remote-audio-state", {
        detail: {
          peerId,
          attached: true,
          blocked: false,
          playing: true,
          relay: true,
          rms,
          receivedAt: Date.now()
        }
      })
    );
  }

  noticeAudioUnlockNeeded(peerId) {
    this.remotePlaybackBlocked = true;
    const now = Date.now();
    this.dispatchEvent(
      new CustomEvent("remote-audio-state", {
        detail: {
          peerId,
          attached: true,
          blocked: true,
          playing: false,
          relay: true
        }
      })
    );
    if (now - this.lastAudioUnlockNoticeAt < 5000) return;
    this.lastAudioUnlockNoticeAt = now;
    this.ui.setVoiceState("语音接收中", "warn");
  }

  async resolveVoiceBuffer(buffer) {
    if (buffer instanceof ArrayBuffer) return buffer;
    if (ArrayBuffer.isView(buffer)) {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    }
    if (buffer instanceof Blob) {
      return buffer.arrayBuffer();
    }
    if (buffer?.data && Array.isArray(buffer.data)) {
      return new Uint8Array(buffer.data).buffer;
    }
    return null;
  }

  pcmRms(pcm) {
    let sum = 0;
    for (let index = 0; index < pcm.length; index += 1) {
      const sample = pcm[index] / 32768;
      sum += sample * sample;
    }
    return pcm.length ? Math.sqrt(sum / pcm.length) : 0;
  }

  applyPacketEnvelope(gainNode, startAt, duration, continuousPacket = false) {
    const gain = Math.max(0, Math.min(1, this.outputVolume));
    const fade = continuousPacket ? 0.0008 : Math.min(0.004, Math.max(0.0015, duration / 24));
    gainNode.gain.cancelScheduledValues(startAt);
    gainNode.gain.setValueAtTime(0, startAt);
    gainNode.gain.linearRampToValueAtTime(gain, startAt + fade);
    gainNode.gain.setValueAtTime(gain, startAt + Math.max(fade, duration - 0.001));
  }

  noticeVoiceDrop(player, peerId) {
    const now = Date.now();
    if (now - player.lastDropNoticeAt < 6000) return;
    player.lastDropNoticeAt = now;
    this.dispatchEvent(
      new CustomEvent("remote-audio-state", {
        detail: {
          peerId,
          attached: true,
          blocked: false,
          playing: true,
          relay: true,
          droppingLateAudio: true
        }
      })
    );
  }

  downsample(input, inputRate, outputRate) {
    if (!input?.length || !Number.isFinite(inputRate) || inputRate <= 0) return null;
    if (outputRate >= inputRate) return input;

    const ratio = inputRate / outputRate;
    const outputLength = Math.floor(input.length / ratio);
    const output = new Float32Array(outputLength);
    for (let index = 0; index < outputLength; index += 1) {
      const position = index * ratio;
      const left = Math.floor(position);
      const right = Math.min(input.length - 1, left + 1);
      const mix = position - left;
      output[index] = (input[left] || 0) * (1 - mix) + (input[right] || 0) * mix;
    }
    return output;
  }

  floatToInt16(input) {
    const output = new Int16Array(input.length);
    for (let index = 0; index < input.length; index += 1) {
      const sample = Math.max(-0.92, Math.min(0.92, Number(input[index]) || 0));
      output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return output;
  }

  applyRelayAutoGain(input) {
    let sum = 0;
    let peak = 0;
    for (let index = 0; index < input.length; index += 1) {
      const sample = Number(input[index]) || 0;
      sum += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }

    const rms = Math.sqrt(sum / Math.max(1, input.length));
    if (rms < 0.0012) return input;

    const baseTarget = this.noiseReductionEnabled ? 0.024 : 0.052;
    const volumeScale = Math.min(this.noiseReductionEnabled ? 1.05 : 1.8, Math.max(0.25, this.inputVolume));
    const target = baseTarget * volumeScale;
    const rmsGain = Math.min(this.noiseReductionEnabled ? 1.18 : 3.4, Math.max(0.2, target / rms));
    const peakGain = peak > 0 ? Math.min(this.noiseReductionEnabled ? 1.05 : 1.8, 0.72 / peak) : 1.05;
    const gain = Math.min(rmsGain, peakGain);
    if (Math.abs(gain - 1) < 0.05 && peak <= 0.68) return input;

    const output = new Float32Array(input.length);
    for (let index = 0; index < input.length; index += 1) {
      output[index] = Math.max(-0.9, Math.min(0.9, input[index] * gain));
    }
    return output;
  }

  softLimit(sample, ceiling = 0.82) {
    const normalized = Math.max(-1.5, Math.min(1.5, Number(sample) || 0));
    return Math.max(-ceiling, Math.min(ceiling, Math.tanh(normalized / Math.max(0.25, ceiling)) * ceiling));
  }
}
