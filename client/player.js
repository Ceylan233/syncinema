function formatTime(value) {
  if (!Number.isFinite(value)) return "00:00";
  const total = Math.max(0, Math.floor(value));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function normalizeControlRate(value) {
  const rates = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const incoming = Number(value || 1);
  return rates.reduce((best, rate) => Math.abs(rate - incoming) < Math.abs(best - incoming) ? rate : best, 1);
}

function usesIndependentMobilePlayer() {
  return /Quark|UCBrowser|MQQBrowser|XBrowser/i.test(navigator.userAgent || "");
}

export class CinemaPlayer extends EventTarget {
  constructor(ui) {
    super();
    this.ui = ui;
    this.video = ui.video;
    this.meta = null;
    this.objectUrl = null;
    this.hls = null;
    this.flv = null;
    this.flvRecoveryTimer = null;
    this.flvRestarting = false;
    this.applyingRemote = false;
    this.restoreAfterMetadata = null;
    this.controlsTimer = null;
    this.draggingSeek = false;
    this.blockedSeekDrag = false;
    this.feedbackTimer = null;
    this.seekBlockedTimer = null;
    this.seekSyncTimer = null;
    this.pendingSeekTarget = null;
    this.localSeekCommitUntil = 0;
    this.localSeekGuardTarget = null;
    this.localSeekGuardTimer = null;
    this.keyboardSeekTimer = null;
    this.keyboardSeekTarget = null;
    this.keyboardSeekDelta = 0;
    this.localVideoId = null;
    this.userSyncUntil = 0;
    this.remoteAutoplayWanted = false;
    this.remoteAutoplayTimer = null;
    this.remoteAutoplayAttempts = 0;
    this.remoteAutoplayBlockedUntil = 0;
    this.expectedRemotePlaying = false;
    this.expectedRemotePlayingUntil = 0;
    this.remotePlayWatchdog = null;
    this.onlineSourceToken = 0;
    this.liveLineOptions = [];
    this.liveLineIndex = -1;
    this.liveLineRecoveryPromise = null;
    this.liveNetworkFailureAt = 0;
    this.liveNetworkFailureCount = 0;
    this.liveDirectRecoveries = 0;
    this.liveRelayEnabled = false;
    this.liveWaitingTimes = [];
    this.liveWaitingTimer = null;
    this.liveHealthTimer = null;
    this.liveLastProgressAt = 0;
    this.liveLastTime = 0;
    this.liveLastBufferEnd = 0;
    this.liveStartedAt = 0;
    this.livePlayUrl = "";
    this.liveSourceToken = 0;
    this.liveStartupReady = false;
    this.liveStartupPromise = null;
    this.vodRelayEnabled = false;
    this.vodWaitingTimes = [];
    this.vodWaitingTimer = null;
    this.vodPlayUrl = "";
    this.vodLineOptions = [];
    this.vodLineIndex = -1;
    this.vodAutoQuality = false;
    this.vodCurrentQualityValue = "";
    this.vodLastQualitySwitchAt = 0;
    this.bufferingUiTimer = null;
    this.lastVisiblePlaybackTime = 0;
    this.audioRestoreTimers = [];
    this.audioRestoreBlockedUntil = 0;
    this.mutedForAutoplay = false;
    this.userVolume = this.loadVolume();
    this.ducking = false;
    this.lastAudioUnlockAt = 0;
    this.userAudioUnlocked = false;
    this.video.muted = false;
    this.video.defaultMuted = false;
    this.applyEffectiveVolume();
    this.ui.videoVolume.value = Math.round(this.userVolume * 100);
    window.syncinemaUpdateVolumeSliders?.();
    this.fitMode = "contain";
    this.naturalVideoAspect = 16 / 9;
    this.fitResizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => this.updateVideoGeometry())
      : null;
    if (this.ui.videoSurface) this.fitResizeObserver?.observe(this.ui.videoSurface);
    this.rateCorrectionTimer = null;
    this.programmaticRateValue = 1;
    this.programmaticRateUntil = 0;
    this.programmaticSeekTarget = null;
    this.programmaticSeekUntil = 0;
    this.remoteApplyGeneration = 0;
    this.independentMobilePlayer = usesIndependentMobilePlayer();
    this.nativePlayerActive = false;
    this.pseudoFullscreen = false;
    this.pseudoFullscreenHome = null;
    this.pointerInsideVideoFrame = false;
    this.applyFitMode(this.loadFitMode());
    this.bind();
  }

  bind() {
    this.ui.playButton.addEventListener("click", () => {
      if (!this.hasLocalSource()) {
        this.enableVideoSound();
        this.remoteAutoplayBlockedUntil = 0;
        this.remoteAutoplayAttempts = 0;
        const wantsPlaying = this.video.paused;
        if (wantsPlaying) {
          this.expectedRemotePlaying = true;
          this.expectedRemotePlayingUntil = Date.now() + 10000;
          this.video.play().catch(() => {});
        } else {
          this.expectedRemotePlaying = false;
          this.expectedRemotePlayingUntil = 0;
          this.video.pause();
        }
        this.dispatchEvent(new CustomEvent("remote-play-toggle", { detail: { wantsPlaying } }));
        return;
      }

      this.markUserSync();
      if (this.video.paused) {
        this.enableVideoSound();
        const replay = this.video.ended || (Number.isFinite(this.video.duration) && this.video.currentTime >= this.video.duration - 0.05);
        this.expectedRemotePlaying = true;
        this.expectedRemotePlayingUntil = Date.now() + 10000;
        this.video.play().catch(() => {});
        this.emitSync(replay ? "remote-replay-click" : "play-click", {
          userIntent: true,
          overrides: { paused: false, currentTime: replay ? 0 : this.video.currentTime || 0 }
        });
      } else {
        this.expectedRemotePlaying = false;
        this.expectedRemotePlayingUntil = 0;
        this.video.pause();
        this.emitSync("pause-click", { userIntent: true, overrides: { paused: true } });
      }
    });

    this.ui.seekBar.addEventListener("input", () => {
      if (this.isLiveSource()) return;
      if (!Number.isFinite(this.video.duration)) return;
      if (this.remoteSeekUnavailable()) {
        this.blockSeekUntilBuffered();
        return;
      }
      this.seekFromBar("seek-drag", 1600);
    });

    this.ui.seekBar.addEventListener("change", () => {
      if (this.isLiveSource()) return;
      if (!Number.isFinite(this.video.duration)) return;
      if (this.remoteSeekUnavailable()) {
        this.blockSeekUntilBuffered();
        return;
      }
      this.seekFromBar("seek-release", 2200);
    });

    this.ui.seekBar.addEventListener("pointerdown", (event) => {
      if (this.isLiveSource()) return;
      if (this.remoteSeekUnavailable()) {
        this.blockedSeekDrag = true;
        this.blockSeekUntilBuffered();
        this.showControls();
        return;
      }
      this.markUserSync(1800);
      this.draggingSeek = true;
      this.pendingSeekTarget = Number(this.video.currentTime || 0);
      this.showSeekPreview(event);
      this.showControls();
    });

    this.ui.seekBar.addEventListener("pointermove", (event) => {
      if (this.blockedSeekDrag) return;
      this.showSeekPreview(event);
      this.showControls();
    });

    this.ui.seekBar.addEventListener("pointerleave", () => {
      if (!this.draggingSeek) this.hideSeekPreview();
    });

    window.addEventListener("pointerup", () => {
      const wasDragging = this.draggingSeek;
      const targetTime = this.pendingSeekTarget;
      this.draggingSeek = false;
      this.hideSeekPreview();
      if (this.blockedSeekDrag) {
        this.blockedSeekDrag = false;
        this.updateControls();
        return;
      }
      if (wasDragging) this.scheduleSeekSync("seek-release", 60, targetTime);
    });

    this.ui.rateSelect.addEventListener("change", () => {
      this.markUserSync();
      this.video.playbackRate = Number(this.ui.rateSelect.value);
      this.emitUserSync("ratechange");
    });

    this.ui.fitSelect?.addEventListener("change", () => {
      this.markUserSync();
      this.applyFitMode(this.ui.fitSelect.value);
      this.emitUserSync("fitchange");
    });

    this.ui.qualitySelect?.addEventListener("change", () => {
      this.applyQualitySelection(this.ui.qualitySelect.value);
    });

    this.ui.videoVolume.addEventListener("input", () => {
      const volume = Number(this.ui.videoVolume.value) / 100;
      this.userVolume = Math.min(1, Math.max(0, volume));
      if (this.userVolume <= 0) {
        this.audioRestoreTimers.forEach((timer) => window.clearTimeout(timer));
        this.audioRestoreTimers = [];
        this.mutedForAutoplay = false;
        this.applyEffectiveVolume();
      } else {
        this.enableVideoSound();
      }
      localStorage.setItem("pc:video-volume", String(this.userVolume));
    });

    this.ui.fullscreenButton.addEventListener("click", () => {
      this.toggleFullscreen();
    });

    this.ui.videoFrame.addEventListener("pointerenter", () => {
      this.pointerInsideVideoFrame = true;
    });
    this.ui.videoFrame.addEventListener("pointermove", () => {
      this.pointerInsideVideoFrame = true;
      this.showControls();
    });
    this.ui.videoFrame.addEventListener("pointerdown", () => this.showControls(false, true));
    this.ui.videoFrame.addEventListener("touchstart", () => this.showControls(false, true), { passive: true });
    this.ui.videoFrame.addEventListener("dblclick", (event) => this.handleFrameDoubleClick(event));
    this.ui.videoFrame.addEventListener("mouseleave", () => {
      this.pointerInsideVideoFrame = false;
      this.scheduleControlsHide(1000);
    });
    const handleFullscreenChange = () => {
      const active = Boolean(document.fullscreenElement || document.webkitFullscreenElement || this.pseudoFullscreen);
      this.ui.fullscreenButton?.classList.toggle("is-fullscreen", active);
      if (!active) this.unlockOrientation();
      this.showControls();
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.pseudoFullscreen) this.exitPseudoFullscreen();
    });

    this.video.addEventListener("webkitbeginfullscreen", () => {
      this.nativePlayerActive = true;
      this.dispatchEvent(new CustomEvent("native-player-enter"));
    });
    this.video.addEventListener("webkitendfullscreen", () => {
      this.nativePlayerActive = false;
      this.dispatchEvent(new CustomEvent("native-player-exit"));
      this.showControls();
    });

    ["play", "pause", "seeking", "seeked", "ratechange", "ended"].forEach((eventName) => {
      this.video.addEventListener(eventName, () => {
        this.updateControls();
        if (eventName === "play") this.scheduleControlsHide();
        if (eventName === "pause") {
          this.showControls(true);
          if (
            this.expectedRemotePlaying &&
            Date.now() < this.expectedRemotePlayingUntil &&
            !this.applyingRemote
          ) {
            this.remoteAutoplayWanted = true;
            this.video.muted = true;
            this.mutedForAutoplay = this.userVolume > 0;
            this.retryRemoteAutoplay("unexpected-pause");
          }
        }
        const programmaticMediaEvent =
          (eventName === "ratechange" && this.isProgrammaticRateChange()) ||
          (["seeking", "seeked"].includes(eventName) && this.isProgrammaticSeekEvent(eventName));
        if (!programmaticMediaEvent && !this.applyingRemote && this.isIndependentPlayerInteraction(eventName)) {
          this.syncIndependentPlayerEvent(eventName);
        } else if (!programmaticMediaEvent && !this.applyingRemote && this.shouldSyncUserEvent(eventName)) {
          this.emitSync(eventName, { userIntent: this.hasLocalSource() });
        }
      });
    });

    this.video.addEventListener("timeupdate", () => {
      const currentTime = Number(this.video.currentTime || 0);
      if (!this.video.paused && currentTime > this.lastVisiblePlaybackTime + 0.1) {
        this.lastVisiblePlaybackTime = currentTime;
        window.clearTimeout(this.bufferingUiTimer);
        this.bufferingUiTimer = null;
        if (!this.applyingRemote) this.ui.setSyncing(false);
      }
      this.followLiveEdge();
      this.updateControls();
      this.savePosition();
    });

    this.video.addEventListener("durationchange", () => this.updateControls());
    this.video.addEventListener("loadedmetadata", () => {
      this.restoreEffectiveVolume();
      this.updateNaturalAspect();
      this.updateLocalQualityLabel();
      if (Number.isFinite(this.restoreAfterMetadata)) {
        this.setProgrammaticCurrentTime(Math.min(this.restoreAfterMetadata, this.video.duration || this.restoreAfterMetadata));
        this.restoreAfterMetadata = null;
      }
      this.updateControls();
      if (!this.applyingRemote && this.hasLocalSource()) this.emitSync("metadata");
      this.retryRemoteAutoplay("loadedmetadata");
    });

    this.video.addEventListener("waiting", () => {
      this.handleLiveWaiting();
      this.handleVodWaiting();
      const waitingAt = Number(this.video.currentTime || 0);
      window.clearTimeout(this.bufferingUiTimer);
      this.bufferingUiTimer = window.setTimeout(() => {
        const hasStopped = Number(this.video.currentTime || 0) <= waitingAt + 0.1;
        if (this.meta && !this.video.paused && hasStopped) this.ui.setSyncing(true, "正在缓冲...");
      }, 900);
    });
    this.video.addEventListener("stalled", () => this.handleVodWaiting());
    this.video.addEventListener("loadeddata", () => {
      this.restoreEffectiveVolume();
      this.retryRemoteAutoplay("loadeddata");
    });
    this.video.addEventListener("progress", () => {
      this.followLiveEdge();
      this.updateControls();
      this.retryRemoteAutoplay("progress");
    });
    this.video.addEventListener("canplay", () => {
      window.clearTimeout(this.bufferingUiTimer);
      this.bufferingUiTimer = null;
      this.followLiveEdge(true);
      this.restoreEffectiveVolume();
      this.ui.setSyncing(false);
      this.retryRemoteAutoplay("canplay");
    });
    this.video.addEventListener("playing", () => {
      window.clearTimeout(this.bufferingUiTimer);
      this.bufferingUiTimer = null;
      this.ui.setSyncing(false);
      this.followLiveEdge(true);
      this.restoreEffectiveVolume();
      this.expectedRemotePlaying = this.expectedRemotePlaying || !this.hasLocalSource();
      if (this.expectedRemotePlaying && this.expectedRemotePlayingUntil <= 0) {
        this.expectedRemotePlayingUntil = Date.now() + 10000;
      }
      this.remoteAutoplayWanted = false;
      this.remoteAutoplayAttempts = 0;
    });

    this.showControls(true);
    window.setTimeout(() => this.scheduleControlsHide(900), 900);
    this.installVideoAudioUnlock();
  }

  async toggleFullscreen() {
    const target = this.ui.videoFrame;
    if (this.pseudoFullscreen) {
      this.exitPseudoFullscreen();
      this.unlockOrientation();
      return;
    }
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      try {
        const exit = document.exitFullscreen || document.webkitExitFullscreen || document.webkitCancelFullScreen;
        await exit?.call(document);
      } catch {
        // The CSS fallback below remains available on the next click.
      }
      this.unlockOrientation();
      return;
    }

    try {
      if (target.requestFullscreen) {
        await target.requestFullscreen({ navigationUI: "hide" });
      } else if (target.webkitRequestFullscreen) {
        await target.webkitRequestFullscreen();
      } else if (target.mozRequestFullScreen) {
        await target.mozRequestFullScreen();
      } else if (target.msRequestFullscreen) {
        await target.msRequestFullscreen();
      } else if (this.video.requestFullscreen) {
        await this.video.requestFullscreen({ navigationUI: "hide" });
      } else if (/iPhone|iPad|iPod/i.test(navigator.userAgent || "") && this.video.webkitEnterFullscreen) {
        this.video.webkitEnterFullscreen();
      } else {
        this.enterPseudoFullscreen();
      }
      await this.lockLandscape();
    } catch {
      if (/iPhone|iPad|iPod/i.test(navigator.userAgent || "") && this.video.webkitEnterFullscreen) {
        this.video.webkitEnterFullscreen();
      } else {
        this.enterPseudoFullscreen();
      }
      await this.lockLandscape();
    }
  }

  async exitFullscreenForDialog() {
    let changed = false;

    if (this.pseudoFullscreen) {
      this.exitPseudoFullscreen();
      changed = true;
    }

    if (this.video.webkitDisplayingFullscreen || this.nativePlayerActive) {
      changed = true;
      const ended = new Promise((resolve) => {
        let timer = null;
        const finish = () => {
          window.clearTimeout(timer);
          this.video.removeEventListener?.("webkitendfullscreen", finish);
          resolve();
        };
        this.video.addEventListener?.("webkitendfullscreen", finish, { once: true });
        timer = window.setTimeout(finish, 450);
      });
      try {
        this.video.webkitExitFullscreen?.();
      } catch {
        // The timeout still lets the dialog open on partial WebKit implementations.
      }
      await ended;
    }

    if (document.fullscreenElement || document.webkitFullscreenElement) {
      changed = true;
      const exit = document.exitFullscreen || document.webkitExitFullscreen || document.webkitCancelFullScreen;
      try {
        await exit?.call(document);
      } catch {
        // Opening the dialog is still preferable if a browser reports a stale fullscreen state.
      }
    }

    if (!changed) return;
    this.unlockOrientation();
    await new Promise((resolve) => window.setTimeout(resolve, 40));
  }

  enterPseudoFullscreen() {
    if (!this.pseudoFullscreenHome) {
      this.pseudoFullscreenHome = {
        parent: this.ui.videoFrame.parentNode,
        nextSibling: this.ui.videoFrame.nextSibling
      };
    }
    this.pseudoFullscreen = true;
    document.body.appendChild(this.ui.videoFrame);
    this.ui.videoFrame.classList.add("pseudo-fullscreen");
    document.body.classList.add("pseudo-fullscreen-active");
    this.ui.fullscreenButton?.classList.add("is-fullscreen");
    this.showControls();
  }

  exitPseudoFullscreen() {
    this.pseudoFullscreen = false;
    this.ui.videoFrame.classList.remove("pseudo-fullscreen");
    this.ui.videoFrame.classList.remove("controls-hidden");
    document.body.classList.remove("pseudo-fullscreen-active");
    this.ui.fullscreenButton?.classList.remove("is-fullscreen");
    const home = this.pseudoFullscreenHome;
    if (home?.parent?.isConnected) {
      if (home.nextSibling?.parentNode === home.parent) home.parent.insertBefore(this.ui.videoFrame, home.nextSibling);
      else home.parent.appendChild(this.ui.videoFrame);
    }
    this.pseudoFullscreenHome = null;
    this.showControls();
  }

  async lockLandscape() {
    const orientation = screen.orientation;
    if (!orientation?.lock) return;
    try {
      await orientation.lock("landscape");
    } catch {
      // Some mobile browsers only allow manual rotation.
    }
  }

  unlockOrientation() {
    try {
      screen.orientation?.unlock?.();
    } catch {
      // Ignore browsers that do not support orientation unlock.
    }
  }

  setLocalFile(file, meta, options = {}) {
    const preserveTime = options.preservePlayback ? this.video.currentTime || 0 : null;
    const resumeAfterLoad = options.preservePlayback && !this.video.paused;
    this.destroyNetworkPlayback();
    this.expectedRemotePlaying = false;
    this.expectedRemotePlayingUntil = 0;
    this.ui.setQualityOptions([{ value: "original", label: "原画" }], "original", true);
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(file);
    this.meta = meta;
    this.lastVisiblePlaybackTime = 0;
    this.localVideoId = meta.id;
    this.video.loop = Boolean(meta.loop);
    this.ui.setNowPlaying?.(meta.name || file?.name || "");
    this.ui.setLivePlayback?.(false);
    if (options.resetPlayback) {
      this.video.pause();
      this.restoreAfterMetadata = 0;
      this.setProgrammaticCurrentTime(0);
      this.ui.seekBar.value = 0;
      this.ui.currentTime.textContent = formatTime(0);
    }
    this.enableVideoSound();
    this.video.src = this.objectUrl;
    this.video.load();
    this.ui.showEmpty(false);
    if (Number.isFinite(preserveTime)) this.restoreAfterMetadata = preserveTime;
    else if (options.resetPlayback) this.restoreAfterMetadata = 0;
    else if (!options.skipSavedPosition) this.restoreSavedPosition(meta.id);
    if (resumeAfterLoad) {
      this.video.addEventListener("loadedmetadata", () => this.video.play().catch(() => {}), { once: true });
    }
    if (!options.silent) this.emitSync("file");
  }

  setOnlineSource(meta, options = {}) {
    this.destroyNetworkPlayback();
    const sourceToken = ++this.onlineSourceToken;
    this.expectedRemotePlaying = false;
    this.expectedRemotePlayingUntil = 0;
    this.ui.setQualityOptions([{ value: "auto", label: "自动" }], "auto", true);
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.meta = meta;
    this.lastVisiblePlaybackTime = 0;
    this.localVideoId = null;
    this.liveLineOptions = [];
    this.liveLineIndex = -1;
    this.liveNetworkFailureAt = 0;
    this.liveNetworkFailureCount = 0;
    this.liveDirectRecoveries = 0;
    this.liveRelayEnabled = Boolean(meta.live && meta.provider === "bilibili");
    this.liveWaitingTimes = [];
    window.clearTimeout(this.liveWaitingTimer);
    this.liveWaitingTimer = null;
    window.clearInterval(this.liveHealthTimer);
    this.liveHealthTimer = null;
    this.liveStartedAt = Date.now();
    this.liveLastProgressAt = this.liveStartedAt;
    this.liveLastTime = 0;
    this.livePlayUrl = this.liveRelayEnabled ? (meta.playUrl || "") : "";
    this.liveSourceToken = sourceToken;
    this.liveStartupReady = false;
    this.liveStartupPromise = null;
    this.vodRelayEnabled = false;
    this.vodWaitingTimes = [];
    window.clearTimeout(this.vodWaitingTimer);
    this.vodWaitingTimer = null;
    this.vodPlayUrl = "";
    this.vodLineOptions = [];
    this.vodLineIndex = -1;
    this.vodAutoQuality = false;
    this.vodCurrentQualityValue = "";
    this.vodLastQualitySwitchAt = 0;
    this.video.loop = Boolean(meta.loop);
    this.ui.setNowPlaying?.(meta.name || "网络点播");
    this.ui.setLivePlayback?.(Boolean(meta.live));
    this.restoreAfterMetadata = options.resetPlayback ? 0 : null;
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();

    const qualities = Array.isArray(meta.qualities) ? meta.qualities.filter((item) => item?.playUrl) : [];
    const savedQuality = localStorage.getItem(`pc:quality:${meta.provider || "online"}`) || "auto";
    const selectedQuality = qualities.find((item) => String(item.value) === savedQuality);
    const automaticQuality = !selectedQuality && meta.provider === "bilibili" && !meta.live
      ? this.selectAutomaticVodQuality(qualities)
      : null;
    this.vodAutoQuality = Boolean(automaticQuality);
    this.vodCurrentQualityValue = String((selectedQuality || automaticQuality)?.value || "");
    const playUrl = selectedQuality?.playUrl || automaticQuality?.playUrl || meta.playUrl || meta.url || "";
    if (!playUrl) return;
    if (meta.kind !== "hls" && qualities.length) {
      this.ui.setQualityOptions(
        [{ value: "auto", label: "自动" }, ...qualities.map((item) => ({ value: String(item.value), label: item.label }))],
        selectedQuality ? String(selectedQuality.value) : "auto",
        false
      );
    }
    this.attachOnlineSource(meta, playUrl, sourceToken);

    this.ui.showEmpty(false);
    this.enableVideoSound();
    this.updateControls();
  }

  async attachOnlineSource(meta, playUrl, sourceToken) {
    if (meta.kind === "flv") {
      await this.ensureFlvLibrary();
      if (sourceToken !== this.onlineSourceToken || this.meta?.id !== meta.id) return;
      if (window.flvjs?.isSupported?.()) {
        this.flv = window.flvjs.createPlayer({
          type: "flv",
          url: playUrl,
          isLive: true,
          hasAudio: true,
          hasVideo: true
        }, {
          enableWorker: false,
          enableStashBuffer: true,
          stashInitialSize: 768 * 1024,
          lazyLoad: false,
          autoCleanupSourceBuffer: true,
          autoCleanupMaxBackwardDuration: 30,
          autoCleanupMinBackwardDuration: 15,
          fixAudioTimestampGap: true
        });
        this.flv.attachMediaElement(this.video);
        this.flv.on(window.flvjs.Events.ERROR, () => {
          if (this.flvRestarting || sourceToken !== this.onlineSourceToken || this.meta?.id !== meta.id) return;
          window.clearTimeout(this.flvRecoveryTimer);
          this.flvRecoveryTimer = window.setTimeout(() => {
            this.restartFlvLive(meta, playUrl, sourceToken);
          }, 600);
        });
        this.flv.load();
        this.startFlvHealthMonitor(meta, playUrl, sourceToken);
        return;
      }
    }

    if (meta.kind === "hls") {
      await this.ensureHlsLibrary();
      if (sourceToken !== this.onlineSourceToken || this.meta?.id !== meta.id) return;
      if (window.Hls?.isSupported?.()) {
        let selectedPlayUrl = playUrl;
        if (meta.live && meta.provider === "bilibili") {
          selectedPlayUrl = await this.selectBilibiliStableRelay(playUrl, sourceToken);
        } else if (!meta.live) {
          this.vodPlayUrl = playUrl;
          selectedPlayUrl = this.directHlsUrl(playUrl);
        }
        if (sourceToken !== this.onlineSourceToken || this.meta?.id !== meta.id) return;
        this.hls = new window.Hls({
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: meta.live ? 20 : 30,
          maxBufferLength: meta.live ? 20 : 60,
          maxMaxBufferLength: meta.live ? 30 : 90,
          maxBufferSize: meta.live ? 60 * 1024 * 1024 : 48 * 1024 * 1024,
          startFragPrefetch: !meta.live,
          liveSyncDurationCount: 6,
          liveMaxLatencyDurationCount: 20,
          maxLiveSyncPlaybackRate: 1.08,
          manifestLoadingMaxRetry: 6,
          levelLoadingMaxRetry: 6,
          fragLoadingMaxRetry: 8,
          fragLoadingRetryDelay: 400,
          fragLoadingMaxRetryTimeout: 5000
        });
        this.hls.on(window.Hls.Events.MANIFEST_PARSED, () => this.refreshHlsQualityOptions());
        this.hls.on(window.Hls.Events.LEVELS_UPDATED, () => this.refreshHlsQualityOptions());
        this.hls.on(window.Hls.Events.LEVEL_SWITCHED, () => this.refreshHlsQualityOptions({ keepValue: true }));
        this.hls.on(window.Hls.Events.ERROR, (_event, data) => {
          if (!data?.fatal || !this.hls) return;
          if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
            if (meta.live && meta.provider === "bilibili") {
              if (this.liveRelayEnabled) {
                this.hls.startLoad();
                return;
              }
              const now = Date.now();
              if (now - this.liveNetworkFailureAt > 20000) this.liveNetworkFailureCount = 0;
              this.liveNetworkFailureAt = now;
              this.liveNetworkFailureCount += 1;
              if (this.liveNetworkFailureCount < 2) {
                this.hls.startLoad();
                return;
              }
              this.liveNetworkFailureCount = 0;
              if (this.liveDirectRecoveries >= 1) {
                this.switchToBilibiliLiveRelay(playUrl, sourceToken);
                return;
              }
              this.liveDirectRecoveries += 1;
              this.recoverBilibiliLiveLine(playUrl, sourceToken).then((recovered) => {
                if (!recovered && this.hls && sourceToken === this.onlineSourceToken) this.hls.startLoad();
              });
              return;
            }
            if (!meta.live && this.switchVodHlsToRelay()) return;
            if (this.switchToNextLiveLine()) return;
            this.hls.startLoad();
          } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
            this.hls.recoverMediaError();
          }
        });
        this.hls.loadSource(selectedPlayUrl);
        this.hls.attachMedia(this.video);
        if (meta.live && meta.provider === "bilibili" && !this.liveRelayEnabled) {
          this.startLiveHealthMonitor();
        }
        return;
      }
    }

    if (sourceToken !== this.onlineSourceToken || this.meta?.id !== meta.id) return;
    const selectedVideoUrl = !meta.live && meta.provider === "bilibili"
      ? await this.selectBestBilibiliVodLine(playUrl, meta, sourceToken)
      : playUrl;
    if (sourceToken !== this.onlineSourceToken || this.meta?.id !== meta.id) return;
    this.video.src = selectedVideoUrl;
    this.video.load();
    if (Array.isArray(meta.qualities) && meta.qualities.some((item) => item?.playUrl)) return;
    this.ui.setQualityOptions([{ value: "auto", label: meta.kind === "hls" ? "自动" : "原画" }], "auto", true);
  }

  async selectBestBilibiliLiveLine(playUrl, sourceToken) {
    const match = String(playUrl || "").match(/\/api\/bilibili\/live\/(\d+)\.m3u8/i);
    if (!match) return playUrl;
    try {
      const response = await fetch(`/api/bilibili/live/${match[1]}/lines.json`, { cache: "no-store" });
      const payload = await response.json();
      const lines = Array.isArray(payload?.lines) ? payload.lines.slice(0, 6) : [];
      if (!response.ok || !lines.length) return playUrl;
      const results = (await Promise.all(lines.map((line) => this.probeBilibiliLiveLine(line))))
        .filter(Boolean)
        .sort((left, right) => left.score - right.score);
      if (sourceToken !== this.onlineSourceToken || !results.length) return playUrl;

      const preferredHost = localStorage.getItem("pc:bilibili-live-cdn") || "";
      const preferred = results.find((result) => result.host === preferredHost && result.score <= results[0].score * 1.2);
      const ordered = preferred ? [preferred, ...results.filter((result) => result !== preferred)] : results;
      this.liveLineOptions = ordered.map((result) => this.liveMasterUrl(playUrl, result.host));
      this.liveLineIndex = 0;
      localStorage.setItem("pc:bilibili-live-cdn", ordered[0].host);
      this.ui.setTransfer?.(`直播自动线路：${ordered[0].host}`, 100);
      return this.liveLineOptions[0];
    } catch {
      return playUrl;
    }
  }

  async selectBilibiliStableRelay(playUrl, sourceToken) {
    const match = String(playUrl || "").match(/\/api\/bilibili\/live\/(\d+)\.m3u8/i);
    if (!match) return playUrl;
    let host = localStorage.getItem("pc:bilibili-live-cdn") || "";
    try {
      const response = await fetch(`/api/bilibili/live/${match[1]}/lines.json`, { cache: "no-store" });
      const payload = await response.json();
      const lines = Array.isArray(payload?.lines) ? payload.lines : [];
      if (response.ok && lines.length) host = lines[0].host || host;
    } catch {
      // The relay endpoint can still resolve a line when discovery is temporarily unavailable.
    }
    if (sourceToken !== this.onlineSourceToken) return playUrl;
    this.liveRelayEnabled = true;
    this.liveLineOptions = [this.liveMasterUrl(playUrl, host, false)];
    this.liveLineIndex = 0;
    if (host) localStorage.setItem("pc:bilibili-live-cdn", host);
    this.ui.setTransfer?.("直播稳定中继", 100);
    return this.liveMasterUrl(playUrl, host, true);
  }

  async probeBilibiliLiveLine(line) {
    if (!line?.url || !line?.host) return null;
    const controller = new AbortController();
    const sampleBytes = 256 * 1024;
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    const startedAt = performance.now();
    try {
      const manifestResponse = await fetch(line.url, { cache: "no-store", signal: controller.signal });
      if (!manifestResponse.ok) return null;
      const manifest = await manifestResponse.text();
      const mediaPath = manifest.split(/\r?\n/).map((item) => item.trim()).find((item) => item && !item.startsWith("#"));
      if (!mediaPath) return null;
      const mediaUrl = new URL(mediaPath, line.url).toString();
      const mediaResponse = await fetch(mediaUrl, {
        cache: "no-store",
        headers: { Range: `bytes=0-${sampleBytes - 1}` },
        signal: controller.signal
      });
      if (!mediaResponse.ok) return null;
      const bytes = (await mediaResponse.arrayBuffer()).byteLength;
      const elapsed = Math.max(1, performance.now() - startedAt);
      return { host: line.host, score: elapsed * (sampleBytes / Math.max(65536, bytes)) };
    } catch {
      return null;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  liveMasterUrl(playUrl, host, relay = false) {
    const url = new URL(playUrl, window.location.href);
    url.searchParams.set("cdn", host);
    if (relay) url.searchParams.set("relay", "1");
    else url.searchParams.delete("relay");
    return `${url.pathname}${url.search}`;
  }

  directHlsUrl(playUrl) {
    const url = new URL(playUrl, window.location.href);
    if (url.pathname === "/api/source/hls") url.searchParams.set("direct", "1");
    return `${url.pathname}${url.search}`;
  }

  relayHlsUrl(playUrl) {
    const url = new URL(playUrl, window.location.href);
    url.searchParams.delete("direct");
    return `${url.pathname}${url.search}`;
  }

  switchVodHlsToRelay() {
    if (!this.hls || this.vodRelayEnabled || this.meta?.live || !this.vodPlayUrl) return false;
    const restoreTime = Number(this.video.currentTime || 0);
    const resume = !this.video.paused || this.expectedRemotePlaying;
    const token = this.onlineSourceToken;
    this.vodRelayEnabled = true;
    this.vodWaitingTimes = [];
    window.clearTimeout(this.vodWaitingTimer);
    this.vodWaitingTimer = null;
    this.ui.setTransfer?.("点播稳定中继", 100);
    const onManifest = () => {
      this.hls?.off(window.Hls.Events.MANIFEST_PARSED, onManifest);
      if (!this.hls || token !== this.onlineSourceToken) return;
      if (Number.isFinite(restoreTime)) this.setProgrammaticCurrentTime(restoreTime);
      if (resume) this.playRemoteWithFallback().catch(() => {});
    };
    this.hls.on(window.Hls.Events.MANIFEST_PARSED, onManifest);
    this.hls.loadSource(this.relayHlsUrl(this.vodPlayUrl));
    return true;
  }

  selectAutomaticVodQuality(qualities) {
    const available = [...(Array.isArray(qualities) ? qualities : [])]
      .filter((item) => item?.playUrl)
      .sort((left, right) => Number(right.quality || right.value || 0) - Number(left.quality || left.value || 0));
    if (!available.length) return null;
    return available[0];
  }

  switchToLowerAutomaticVodQuality() {
    if (!this.vodAutoQuality || this.meta?.provider !== "bilibili" || this.meta?.live) return false;
    if (Date.now() - this.vodLastQualitySwitchAt < 3500) return false;
    const qualities = [...(Array.isArray(this.meta?.qualities) ? this.meta.qualities : [])]
      .filter((item) => item?.playUrl)
      .sort((left, right) => Number(right.quality || right.value || 0) - Number(left.quality || left.value || 0));
    const currentQuality = Number(this.vodCurrentQualityValue || this.meta?.quality || 0);
    const next = qualities.find((item) => Number(item.quality || item.value || 0) < currentQuality);
    if (!next) return false;
    return this.switchDirectVodQuality(next, { automatic: true });
  }

  switchDirectVodQuality(selected, { automatic = false } = {}) {
    if (!selected?.playUrl || !this.meta) return false;
    const restoreTime = Number(this.video.currentTime || 0);
    const resume = !this.video.paused || this.expectedRemotePlaying || this.remoteAutoplayWanted;
    const switchStartedAt = Date.now();
    const token = ++this.onlineSourceToken;
    const targetUrl = this.selectBestBilibiliVodLine(selected.playUrl, this.meta, token);
    this.vodCurrentQualityValue = String(selected.value);
    this.vodLastQualitySwitchAt = Date.now();
    this.vodWaitingTimes = [];
    window.clearTimeout(this.vodWaitingTimer);
    this.vodWaitingTimer = null;
    this.applyingRemote = true;
    this.restoreAfterMetadata = restoreTime;
    this.video.pause();
    this.video.src = targetUrl;
    this.video.load();
    this.video.addEventListener("loadedmetadata", () => {
      if (token !== this.onlineSourceToken) return;
      if (Number.isFinite(restoreTime)) {
        const elapsed = resume ? (Date.now() - switchStartedAt) / 1000 * Number(this.video.playbackRate || 1) : 0;
        const resumeTime = restoreTime + elapsed;
        this.setProgrammaticCurrentTime(Math.min(resumeTime, this.video.duration || resumeTime));
      }
      if (resume) this.playRemoteWithFallback().catch(() => {});
      window.setTimeout(() => {
        if (token === this.onlineSourceToken) this.applyingRemote = false;
      }, 150);
    }, { once: true });
    window.setTimeout(() => {
      if (token === this.onlineSourceToken) this.applyingRemote = false;
    }, 12000);
    if (automatic) this.ui.setTransfer?.(`网络较慢，自动切换至 ${selected.label}`, 100);
    return true;
  }

  selectBestBilibiliVodLine(playUrl, meta, sourceToken) {
    const count = Math.min(6, Math.max(1, Number(meta.lineCount || 1)));
    if (count <= 1 || !String(playUrl).includes("/api/bilibili/video/stream")) {
      this.vodLineOptions = [playUrl];
      this.vodLineIndex = 0;
      return playUrl;
    }
    if (sourceToken !== this.onlineSourceToken) return playUrl;
    const savedLine = Math.min(count - 1, Math.max(0, Number(localStorage.getItem("pc:bilibili-vod-line")) || 0));
    const indexes = [savedLine, ...Array.from({ length: count }, (_, index) => index).filter((index) => index !== savedLine)];
    this.vodLineOptions = indexes.map((index) => {
      const url = new URL(playUrl, window.location.href);
      url.searchParams.set("line", String(index));
      return `${url.pathname}${url.search}`;
    });
    this.vodLineIndex = 0;
    return this.vodLineOptions[0];
  }

  switchToNextVodLine() {
    if (this.meta?.provider !== "bilibili" || this.meta?.live || this.vodLineOptions.length < 2) return false;
    const nextIndex = this.vodLineIndex + 1;
    if (nextIndex >= this.vodLineOptions.length) return false;
    const restoreTime = Number(this.video.currentTime || 0);
    const resume = !this.video.paused || this.expectedRemotePlaying;
    this.vodLineIndex = nextIndex;
    this.video.src = this.vodLineOptions[nextIndex];
    this.video.load();
    this.video.addEventListener("loadedmetadata", () => {
      this.setProgrammaticCurrentTime(Math.min(restoreTime, this.video.duration || restoreTime));
      if (resume) this.playRemoteWithFallback().catch(() => {});
    }, { once: true });
    try {
      const line = new URL(this.vodLineOptions[nextIndex], window.location.href).searchParams.get("line");
      if (line !== null) localStorage.setItem("pc:bilibili-vod-line", line);
    } catch {
      // Keep playback working when a custom relative URL cannot be parsed.
    }
    this.ui.setTransfer?.(`点播切换线路 ${nextIndex + 1}`, 100);
    return true;
  }

  handleVodWaiting() {
    if (!this.meta || this.meta.live || this.video.paused) return;
    const now = Date.now();
    this.vodWaitingTimes = this.vodWaitingTimes.filter((time) => now - time < 15000);
    this.vodWaitingTimes.push(now);
    if (this.hls && !this.vodRelayEnabled && this.vodWaitingTimes.length >= 2) {
      this.switchVodHlsToRelay();
      return;
    }
    window.clearTimeout(this.vodWaitingTimer);
    this.vodWaitingTimer = window.setTimeout(() => {
      if (this.video.paused || this.video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return;
      if (this.hls) this.switchVodHlsToRelay();
      else if (!this.switchToLowerAutomaticVodQuality()) this.switchToNextVodLine();
    }, 4500);
  }

  switchToBilibiliLiveRelay(playUrl = this.livePlayUrl, sourceToken = this.liveSourceToken) {
    if (!this.hls || this.liveRelayEnabled || sourceToken !== this.onlineSourceToken || !playUrl) return false;
    const currentUrl = this.liveLineOptions[this.liveLineIndex] || "";
    let host = localStorage.getItem("pc:bilibili-live-cdn") || "";
    try {
      host = new URL(currentUrl, window.location.href).searchParams.get("cdn") || host;
    } catch {
      // Keep the last selected host.
    }
    this.liveRelayEnabled = true;
    this.liveWaitingTimes = [];
    window.clearTimeout(this.liveWaitingTimer);
    this.liveWaitingTimer = null;
    window.clearTimeout(this.vodWaitingTimer);
    this.vodWaitingTimer = null;
    window.clearInterval(this.liveHealthTimer);
    this.liveHealthTimer = null;
    const relayUrl = this.liveMasterUrl(playUrl, host, true);
    this.ui.setTransfer?.("直播稳定中继", 100);
    this.hls.loadSource(relayUrl);
    return true;
  }

  handleLiveWaiting() {
    if (!this.hls || this.liveRelayEnabled || !this.meta?.live || this.meta.provider !== "bilibili") return;
    const now = Date.now();
    if (now - this.liveStartedAt < 12000) {
      window.clearTimeout(this.liveWaitingTimer);
      this.liveWaitingTimer = window.setTimeout(() => {
        if (
          !this.video.paused &&
          this.video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA &&
          this.meta?.live &&
          !this.liveRelayEnabled
        ) {
          this.switchToBilibiliLiveRelay();
        }
      }, Math.max(1000, 16500 - (now - this.liveStartedAt)));
      return;
    }
    this.liveWaitingTimes = this.liveWaitingTimes.filter((time) => now - time < 20000);
    this.liveWaitingTimes.push(now);
    if (this.liveWaitingTimes.length >= 3) {
      this.switchToBilibiliLiveRelay();
      return;
    }
    window.clearTimeout(this.liveWaitingTimer);
    this.liveWaitingTimer = window.setTimeout(() => {
      if (
        !this.video.paused &&
        this.video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA &&
        this.meta?.live &&
        !this.liveRelayEnabled
      ) {
        this.switchToBilibiliLiveRelay();
      }
    }, 4500);
  }

  startLiveHealthMonitor() {
    window.clearInterval(this.liveHealthTimer);
    this.liveLastProgressAt = Date.now();
    this.liveLastTime = Number(this.video.currentTime || 0);
    this.liveHealthTimer = window.setInterval(() => {
      if (this.liveRelayEnabled || !this.meta?.live || this.meta.provider !== "bilibili") return;
      const now = Date.now();
      const currentTime = Number(this.video.currentTime || 0);
      if (currentTime > this.liveLastTime + 0.2) {
        this.liveLastTime = currentTime;
        this.liveLastProgressAt = now;
        return;
      }
      if (
        now - this.liveStartedAt >= 12000 &&
        !this.video.paused &&
        now - this.liveLastProgressAt >= 6000
      ) {
        this.switchToBilibiliLiveRelay();
      }
    }, 2000);
  }

  switchToNextLiveLine() {
    if (!this.hls || this.liveLineIndex < 0 || this.liveLineIndex + 1 >= this.liveLineOptions.length) return false;
    this.liveLineIndex += 1;
    const url = this.liveLineOptions[this.liveLineIndex];
    this.ui.setTransfer?.(`直播备用线路 ${this.liveLineIndex + 1}`, 100);
    this.hls.loadSource(url);
    return true;
  }

  recoverBilibiliLiveLine(playUrl, sourceToken) {
    if (this.liveLineRecoveryPromise) return this.liveLineRecoveryPromise;
    const previousUrl = this.liveLineOptions[this.liveLineIndex] || "";
    this.liveLineRecoveryPromise = (async () => {
      const selectedUrl = await this.selectBestBilibiliLiveLine(playUrl, sourceToken);
      if (!this.hls || sourceToken !== this.onlineSourceToken) return false;
      if (selectedUrl && selectedUrl !== previousUrl) {
        this.hls.loadSource(selectedUrl);
        return true;
      }
      return this.switchToNextLiveLine();
    })()
      .catch(() => false)
      .finally(() => {
        this.liveLineRecoveryPromise = null;
      });
    return this.liveLineRecoveryPromise;
  }

  ensureHlsLibrary() {
    if (window.Hls) return Promise.resolve();
    if (CinemaPlayer.hlsLoadPromise) return CinemaPlayer.hlsLoadPromise;
    CinemaPlayer.hlsLoadPromise = new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = "/vendor/hls/hls.light.min.js?v=1.6.16";
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => resolve();
      document.head.appendChild(script);
    });
    return CinemaPlayer.hlsLoadPromise;
  }

  ensureFlvLibrary() {
    if (window.flvjs) return Promise.resolve();
    if (CinemaPlayer.flvLoadPromise) return CinemaPlayer.flvLoadPromise;
    CinemaPlayer.flvLoadPromise = new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = "/vendor/flv/flv.min.js?v=1.6.2";
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => resolve();
      document.head.appendChild(script);
    });
    return CinemaPlayer.flvLoadPromise;
  }

  async restartFlvLive(meta, playUrl, sourceToken) {
    if (this.flvRestarting || sourceToken !== this.onlineSourceToken || this.meta?.id !== meta.id) return;
    this.flvRestarting = true;
    const shouldResume = !this.video.paused || this.expectedRemotePlaying || this.remoteAutoplayWanted;
    try {
      this.destroyFlvPlayback();
      this.liveStartupReady = false;
      this.liveStartupPromise = null;
      this.liveLastProgressAt = Date.now();
      this.liveLastTime = 0;
      this.liveLastBufferEnd = 0;
      this.ui.setTransfer?.("直播线路重连中", 100);
      await this.attachOnlineSource(meta, playUrl, sourceToken);
      if (shouldResume && sourceToken === this.onlineSourceToken) {
        this.playRemoteWithFallback().catch(() => {});
      }
    } finally {
      this.flvRestarting = false;
    }
  }

  startFlvHealthMonitor(meta, playUrl, sourceToken) {
    window.clearInterval(this.liveHealthTimer);
    this.liveLastProgressAt = Date.now();
    this.liveLastTime = Number(this.video.currentTime || 0);
    this.liveLastBufferEnd = 0;
    this.liveHealthTimer = window.setInterval(() => {
      if (this.flvRestarting || !this.flv || sourceToken !== this.onlineSourceToken || this.meta?.id !== meta.id) return;
      const now = Date.now();
      const currentTime = Number(this.video.currentTime || 0);
      const ranges = this.video.buffered;
      const bufferEnd = ranges.length ? Number(ranges.end(ranges.length - 1)) : 0;
      if (currentTime > this.liveLastTime + 0.15 || bufferEnd > this.liveLastBufferEnd + 0.15) {
        this.liveLastTime = Math.max(this.liveLastTime, currentTime);
        this.liveLastBufferEnd = Math.max(this.liveLastBufferEnd, bufferEnd);
        this.liveLastProgressAt = now;
        return;
      }
      if (this.expectedRemotePlaying && now - this.liveLastProgressAt >= 6000) {
        this.restartFlvLive(meta, playUrl, sourceToken);
      }
    }, 1500);
  }

  destroyFlvPlayback() {
    window.clearTimeout(this.flvRecoveryTimer);
    this.flvRecoveryTimer = null;
    if (!this.flv) return;
    try {
      this.flv.pause();
      this.flv.unload();
      this.flv.detachMediaElement();
      this.flv.destroy();
    } catch {
      // Ignore stale FLV instances.
    }
    this.flv = null;
  }

  destroyNetworkPlayback() {
    window.clearTimeout(this.bufferingUiTimer);
    this.bufferingUiTimer = null;
    window.clearTimeout(this.liveWaitingTimer);
    this.liveWaitingTimer = null;
    window.clearTimeout(this.vodWaitingTimer);
    this.vodWaitingTimer = null;
    window.clearInterval(this.liveHealthTimer);
    this.liveHealthTimer = null;
    this.destroyFlvPlayback();
    if (this.hls) {
      try {
        this.hls.destroy();
      } catch {
        // Ignore stale HLS instances.
      }
      this.hls = null;
    }
  }

  refreshHlsQualityOptions({ keepValue = false } = {}) {
    if (!this.hls) return;
    const levels = Array.isArray(this.hls.levels) ? this.hls.levels : [];
    if (!levels.length) {
      this.ui.setQualityOptions([{ value: "auto", label: "自动" }], "auto", true);
      return;
    }

    const options = [
      { value: "auto", label: "自动" },
      ...levels.map((level, index) => ({
        value: String(index),
        label: this.qualityLabel(level, index)
      }))
    ];
    const currentValue = this.hls.autoLevelEnabled ? "auto" : String(this.hls.currentLevel);
    const selected = keepValue && this.ui.qualitySelect?.value ? this.ui.qualitySelect.value : currentValue;
    this.ui.setQualityOptions(options, selected, false);
  }

  qualityLabel(level, index) {
    const height = Number(level?.height || 0);
    const width = Number(level?.width || 0);
    const bitrate = Number(level?.bitrate || level?.attrs?.BANDWIDTH || 0);
    const parts = [];
    if (height > 0) parts.push(`${height}p`);
    else if (width > 0) parts.push(`${width}w`);
    else parts.push(`线路画质 ${index + 1}`);
    if (bitrate > 0) parts.push(`${Math.round(bitrate / 1000)}kbps`);
    return parts.join(" · ");
  }

  applyQualitySelection(value) {
    if (!this.hls) {
      this.applyDirectQualitySelection(value);
      return;
    }
    if (value === "auto") {
      this.hls.currentLevel = -1;
      this.ui.setQualityOptions(this.currentQualityOptions(), "auto", false);
      return;
    }
    const levelIndex = Number(value);
    if (!Number.isInteger(levelIndex) || levelIndex < 0 || levelIndex >= this.hls.levels.length) return;
    this.hls.currentLevel = levelIndex;
    this.ui.setQualityOptions(this.currentQualityOptions(), String(levelIndex), false);
  }

  applyDirectQualitySelection(value) {
    const qualities = Array.isArray(this.meta?.qualities) ? this.meta.qualities.filter((item) => item?.playUrl) : [];
    if (!qualities.length) return;
    const automatic = value === "auto" && this.meta?.provider === "bilibili" && !this.meta?.live;
    const selected = automatic
      ? this.selectAutomaticVodQuality(qualities)
      : qualities.find((item) => String(item.value) === String(value));
    if (!selected?.playUrl) return;

    const storedValue = automatic ? "auto" : String(selected.value);
    localStorage.setItem(`pc:quality:${this.meta.provider || "online"}`, storedValue);
    const modeChanged = this.vodAutoQuality !== automatic;
    this.vodAutoQuality = automatic;
    this.ui.setQualityOptions(
      [{ value: "auto", label: "自动" }, ...qualities.map((item) => ({ value: String(item.value), label: item.label }))],
      storedValue,
      false
    );
    if (!modeChanged && String(selected.value) === this.vodCurrentQualityValue) return;
    this.switchDirectVodQuality(selected);
  }

  currentQualityOptions() {
    const levels = Array.isArray(this.hls?.levels) ? this.hls.levels : [];
    return [
      { value: "auto", label: "自动" },
      ...levels.map((level, index) => ({
        value: String(index),
        label: this.qualityLabel(level, index)
      }))
    ];
  }

  seekFromBar(reason, syncWindow) {
    if (this.isLiveSource()) return;
    this.markUserSync(syncWindow);
    const targetTime = (Number(this.ui.seekBar.value) / 1000) * this.video.duration;
    this.pendingSeekTarget = targetTime;
    this.video.currentTime = targetTime;
    this.updateSeekPreviewFromEvent();
    if (reason === "seek-release") this.scheduleSeekSync(reason, 60, targetTime);
  }

  scheduleSeekSync(reason, delay = 120, targetTime = null) {
    window.clearTimeout(this.seekSyncTimer);
    if (Number.isFinite(targetTime)) this.protectLocalSeekTarget(targetTime);
    this.seekSyncTimer = window.setTimeout(() => {
      this.seekSyncTimer = null;
      this.markUserSync(800);
      this.emitUserSync(
        reason,
        Number.isFinite(targetTime) ? { currentTime: targetTime } : null
      );
      if (Number.isFinite(targetTime)) this.releasePendingSeekTarget(targetTime);
    }, delay);
  }

  protectLocalSeekTarget(targetTime, duration = 8000) {
    if (!Number.isFinite(targetTime)) return;
    this.localSeekGuardTarget = targetTime;
    this.localSeekCommitUntil = Date.now() + duration;
    window.clearTimeout(this.localSeekGuardTimer);
    this.localSeekGuardTimer = window.setTimeout(() => {
      if (this.localSeekGuardTarget !== targetTime) return;
      this.localSeekGuardTarget = null;
      this.localSeekCommitUntil = 0;
      this.localSeekGuardTimer = null;
    }, duration);
  }

  acknowledgeLocalSeek(state) {
    if (!Number.isFinite(this.localSeekGuardTarget)) return false;
    if (!["seek-release", "skip"].includes(String(state?.reason || ""))) return false;
    const targetTime = this.remoteTargetTime(state);
    if (!Number.isFinite(targetTime) || Math.abs(targetTime - this.localSeekGuardTarget) > 0.75) return false;
    window.clearTimeout(this.localSeekGuardTimer);
    this.localSeekGuardTimer = null;
    this.localSeekGuardTarget = null;
    this.localSeekCommitUntil = 0;
    return true;
  }

  releasePendingSeekTarget(targetTime, deadline = Date.now() + 60000) {
    window.setTimeout(() => {
      if (this.pendingSeekTarget !== targetTime) return;
      const currentTime = Number(this.video.currentTime || 0);
      const reachedTarget = Math.abs(currentTime - targetTime) <= 1;
      const targetIsPlayable = reachedTarget &&
        !this.video.seeking &&
        this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
      if (!targetIsPlayable && Date.now() < deadline) {
        this.releasePendingSeekTarget(targetTime, deadline);
        return;
      }
      this.pendingSeekTarget = null;
      this.updateControls();
    }, 250);
  }

  remoteSeekUnavailable() {
    if (this.hasLocalSource() || !this.meta?.id) return false;
    return !Number.isFinite(this.video.duration) || this.video.duration <= 0;
  }

  isLiveSource() {
    return Boolean(this.meta?.live);
  }

  liveEdge() {
    const hlsTarget = Number(this.hls?.liveSyncPosition);
    if (Number.isFinite(hlsTarget) && hlsTarget > 0) return hlsTarget;
    const ranges = this.video.seekable;
    if (!ranges?.length) return null;
    const edge = ranges.end(ranges.length - 1);
    return Number.isFinite(edge) ? Math.max(0, edge - 3) : null;
  }

  followLiveEdge(force = false) {
    if (!this.isLiveSource() || (this.video.paused && !force)) return;
    const edge = this.liveEdge();
    if (!Number.isFinite(edge)) return;
    const lag = edge - (this.video.currentTime || 0);
    if (lag <= 0) return;
    if (!force && lag <= 12) return;
    try {
      this.setProgrammaticCurrentTime(edge);
    } catch {
      // The live seekable window can change between reading and assigning it.
    }
  }

  blockSeekUntilBuffered() {
    this.blockedSeekDrag = true;
    this.updateControls();
    this.hideSeekPreview();
    this.ui.setSyncing(true, "先等视频读取到时长，再拖动进度");
    window.clearTimeout(this.seekBlockedTimer);
    this.seekBlockedTimer = window.setTimeout(() => {
      if (Number.isFinite(this.video.duration) && this.video.duration > 0) {
        this.ui.setSyncing(false);
      }
    }, 1200);
  }

  setRemoteMeta(meta) {
    this.meta = meta;
    if (this.localVideoId !== meta.id) this.localVideoId = null;
    this.restoreAfterMetadata = null;
    this.ui.setNowPlaying?.(meta.name || "");
    this.ui.setLivePlayback?.(Boolean(meta.live));
  }

  hasLocalSource() {
    return Boolean(this.meta?.id && this.localVideoId === this.meta.id);
  }

  bufferedAhead() {
    const time = this.video.currentTime || 0;
    const ranges = this.video.buffered;
    for (let index = 0; index < ranges.length; index += 1) {
      if (ranges.start(index) <= time + 0.25 && ranges.end(index) >= time) {
        return Math.max(0, ranges.end(index) - time);
      }
    }
    return -1;
  }

  emitSync(reason, options = {}) {
    this.dispatchEvent(
      new CustomEvent("local-sync", {
        detail: {
          reason,
          userIntent: Boolean(options.userIntent),
          hasVideo: Boolean(this.meta),
          videoId: this.meta?.id || null,
          fileName: this.meta?.name || "",
          paused: this.video.paused,
          currentTime: this.video.currentTime || 0,
          duration: Number.isFinite(this.video.duration) && this.video.duration > 0
            ? this.video.duration
            : Number(this.meta?.duration || 0),
          playbackRate: normalizeControlRate(Number(this.ui.rateSelect?.value) || this.video.playbackRate || 1),
          fitMode: this.fitMode || "contain",
          readyState: this.video.readyState,
          waiting: !this.video.paused && this.video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA,
          bufferedAhead: this.bufferedAhead(),
          ...(options.overrides || {})
        }
      })
    );
  }

  emitUserSync(reason, overrides = null) {
    if (this.applyingRemote || !this.shouldSyncUserEvent(reason)) return;
    this.emitSync(reason, { userIntent: true, ...(overrides ? { overrides } : {}) });
  }

  markUserSync(duration = 1200) {
    this.userSyncUntil = Math.max(Number(this.userSyncUntil || 0), Date.now() + duration);
  }

  setProgrammaticPlaybackRate(value) {
    const rate = Math.max(0.25, Math.min(4, Number(value) || 1));
    this.programmaticRateValue = rate;
    this.programmaticRateUntil = Date.now() + 1000;
    this.video.playbackRate = rate;
  }

  isProgrammaticRateChange() {
    return Date.now() < this.programmaticRateUntil &&
      Math.abs(Number(this.video.playbackRate || 1) - this.programmaticRateValue) < 0.001;
  }

  setProgrammaticCurrentTime(value, duration = 8000) {
    const target = Math.max(0, Number(value) || 0);
    this.programmaticSeekTarget = target;
    this.programmaticSeekUntil = Date.now() + duration;
    this.video.currentTime = target;
  }

  isProgrammaticSeekEvent(eventName) {
    if (Date.now() >= this.programmaticSeekUntil || !Number.isFinite(this.programmaticSeekTarget)) return false;
    if (Math.abs(Number(this.video.currentTime || 0) - this.programmaticSeekTarget) > 3) return false;
    if (eventName === "seeked") this.programmaticSeekUntil = Date.now() + 250;
    return true;
  }

  isIndependentPlayerInteraction(eventName) {
    const nativeFullscreen = this.nativePlayerActive || Boolean(this.video.webkitDisplayingFullscreen);
    if (nativeFullscreen) return ["play", "pause", "seeking", "seeked", "ratechange"].includes(eventName);
    return this.independentMobilePlayer && !this.draggingSeek && ["seeking", "seeked"].includes(eventName);
  }

  syncIndependentPlayerEvent(eventName) {
    if (eventName === "seeking") {
      this.markUserSync(4000);
      this.emitSync("seek-drag", { userIntent: true });
      return;
    }
    if (eventName === "seeked") {
      this.markUserSync(4000);
      this.emitSync("seek-release", { userIntent: true });
      return;
    }
    if (eventName === "play") {
      this.emitSync("remote-play-click", { userIntent: true, overrides: { paused: false } });
      return;
    }
    if (eventName === "pause") {
      this.emitSync("remote-pause-click", { userIntent: true, overrides: { paused: true } });
      return;
    }
    if (eventName === "ratechange") {
      const selectedRate = normalizeControlRate(this.video.playbackRate);
      this.ui.rateSelect.value = String(selectedRate);
      this.markUserSync();
      this.emitSync("ratechange", { userIntent: true });
    }
  }

  shouldSyncUserEvent(eventName) {
    if (eventName === "ended") return this.hasLocalSource();
    if (eventName === "ratechange") return document.activeElement === this.ui.rateSelect;
    if (eventName === "fitchange") return document.activeElement === this.ui.fitSelect;
    if (!["seek-drag", "seek-release", "skip"].includes(eventName)) return false;
    return Date.now() < this.userSyncUntil;
  }

  prepareScheduled(state) {
    if (!state?.hasVideo || this.meta?.id !== state.videoId || this.video.readyState < HTMLMediaElement.HAVE_METADATA) return;
    const canPreSeek = state.reason === "remote-replay-click" || (this.video.paused && Number(state.currentTime || 0) <= 0.1);
    if (!canPreSeek) return;
    const targetTime = this.remoteTargetTime({ ...state, paused: true });
    if (!Number.isFinite(targetTime) || !this.isBuffered(targetTime)) return;
    try {
      this.setProgrammaticCurrentTime(targetTime);
    } catch {
      // The scheduled execution will retry once the media element is ready.
    }
  }

  shouldApplyRemoteSeek(targetTime, drift, exactTimelineCommand) {
    if (!Number.isFinite(targetTime)) return false;
    if (exactTimelineCommand) {
      return drift > 0.04 && this.video.readyState >= HTMLMediaElement.HAVE_METADATA;
    }
    return drift > 2.5 && (
      this.isBuffered(targetTime) ||
      this.video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA
    );
  }

  async applyRemote(state) {
    if (!state?.hasVideo) return;
    if (this.draggingSeek) return;
    if (Date.now() < this.localSeekCommitUntil && Number.isFinite(this.localSeekGuardTarget)) {
      const incomingTarget = this.remoteTargetTime(state);
      if (!Number.isFinite(incomingTarget) || Math.abs(incomingTarget - this.localSeekGuardTarget) > 0.75) return;
    }
    const applyGeneration = ++this.remoteApplyGeneration;
    this.applyingRemote = true;
    const targetTime = this.remoteTargetTime(state);
    const drift = targetTime === null ? 0 : Math.abs((this.video.currentTime || 0) - targetTime);
    const exactTimelineCommand = [
      "pause-click",
      "remote-pause-click",
      "remote-replay-click",
      "seek-release",
      "skip"
    ].includes(String(state.reason || "")) || Boolean(state.initialSync) || state.correctionMode === "hard";
    const visibleTimelineCommand = [
      "remote-replay-click",
      "seek-release",
      "skip"
    ].includes(String(state.reason || ""));
    const shouldShowSync = targetTime !== null && (
      (visibleTimelineCommand && drift > 0.25) ||
      (Boolean(state.initialSync) && drift > 0.75)
    );

    try {
      if (
        state.initialSync &&
        targetTime !== null &&
        this.video.readyState < HTMLMediaElement.HAVE_METADATA
      ) {
        this.restoreAfterMetadata = targetTime;
      }

      if (shouldShowSync) {
        this.ui.setSyncing(true, `正在同步到 ${formatTime(targetTime)}`);
      }

      if (Number.isFinite(state.playbackRate)) {
        const baseRate = normalizeControlRate(state.playbackRate);
        window.clearTimeout(this.rateCorrectionTimer);
        const canCorrectRate =
          (!this.hasLocalSource() || state.targetedCorrection) &&
          !state.paused &&
          drift >= 0.2 &&
          drift <= 2.5 &&
          this.video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
        if (canCorrectRate) {
          const localTime = this.video.currentTime || 0;
          const correction = drift < 0.75 ? Math.min(0.06, 0.03 + drift * 0.04) : Math.min(0.12, 0.08 + drift * 0.016);
          this.setProgrammaticPlaybackRate(localTime < targetTime
            ? Math.min(4, baseRate * (1 + correction))
            : Math.max(0.25, baseRate * (1 - correction)));
          this.rateCorrectionTimer = window.setTimeout(() => {
            this.setProgrammaticPlaybackRate(baseRate);
          }, drift < 0.75 ? 900 : 1400);
        } else {
          this.setProgrammaticPlaybackRate(baseRate);
        }
        this.ui.rateSelect.value = String(baseRate);
      }

      if (state.fitMode) {
        this.applyFitMode(state.fitMode);
      }

      if (
        this.shouldApplyRemoteSeek(targetTime, drift, exactTimelineCommand)
      ) {
        if (this.video.readyState < HTMLMediaElement.HAVE_METADATA) {
          this.restoreAfterMetadata = targetTime;
        } else {
          this.setProgrammaticCurrentTime(targetTime);
          if (!state.paused && this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
            await this.waitForPlayableNear(targetTime, 1800);
            if (applyGeneration !== this.remoteApplyGeneration) return;
          }
        }
      }

      if (applyGeneration !== this.remoteApplyGeneration) return;
      if (state.paused) {
        this.expectedRemotePlaying = false;
        this.expectedRemotePlayingUntil = 0;
        this.remoteAutoplayWanted = false;
        this.video.pause();
      } else {
        this.expectedRemotePlaying = true;
        this.expectedRemotePlayingUntil = Date.now() + 10000;
        if (this.expectedRemotePlayingUntil) {
          window.setTimeout(() => this.updateControls(), 2550);
        }
        if (this.video.paused && Date.now() < this.remoteAutoplayBlockedUntil) {
          this.remoteAutoplayWanted = true;
          this.scheduleAutoplayAfterBlock();
          return;
        }
        this.remoteAutoplayWanted = true;
        this.remoteAutoplayAttempts = 0;
        const resumingLive = this.isLiveSource() && this.video.paused;
        this.followLiveEdge(resumingLive);
        await this.playRemoteWithFallback();
        if (applyGeneration !== this.remoteApplyGeneration) return;
        this.followLiveEdge(false);
        this.watchRemotePlayStart();
      }
    } finally {
      window.setTimeout(() => {
        if (applyGeneration !== this.remoteApplyGeneration) return;
        this.applyingRemote = false;
        this.ui.setSyncing(false);
        this.updateControls();
      }, 100);
    }
  }

  async playRemoteWithFallback() {
    if (this.meta?.live && this.liveRelayEnabled && !this.liveStartupReady) {
      await this.waitForLiveStartupBuffer();
    }
    const startAudible = this.userVolume > 0 && this.userAudioUnlocked;
    if (startAudible) {
      this.video.defaultMuted = false;
      this.video.muted = false;
      this.mutedForAutoplay = false;
    } else {
      this.video.muted = true;
      this.mutedForAutoplay = this.userVolume > 0;
    }
    this.applyEffectiveVolume();
    try {
      await this.video.play();
      this.expectedRemotePlaying = true;
      if (startAudible) this.enableVideoSound();
      else if (this.userVolume > 0) this.scheduleAudioRestoreAttempts();
      this.remoteAutoplayBlockedUntil = 0;
      this.remoteAutoplayWanted = false;
      this.remoteAutoplayAttempts = 0;
    } catch (error) {
      if (error?.name === "AbortError") {
        this.retryRemoteAutoplay("abort");
        return;
      }
      if (error?.name === "NotAllowedError" && this.userVolume > 0) {
        this.video.muted = true;
        this.mutedForAutoplay = true;
        this.applyEffectiveVolume();
        try {
          await this.video.play();
          this.expectedRemotePlaying = true;
          this.remoteAutoplayBlockedUntil = 0;
          this.remoteAutoplayWanted = false;
          this.remoteAutoplayAttempts = 0;
          return;
        } catch (mutedError) {
          if (mutedError?.name === "AbortError") {
            this.retryRemoteAutoplay("abort");
            return;
          }
        }
      }
      this.markRemoteAutoplayBlocked(error);
      throw error;
    }
  }

  waitForLiveStartupBuffer(targetSeconds = this.meta?.kind === "flv" ? 3 : 6, timeoutMs = 10000) {
    if (this.liveStartupReady || !this.meta?.live || !this.liveRelayEnabled) return Promise.resolve();
    if (this.liveStartupPromise) return this.liveStartupPromise;
    const sourceToken = this.onlineSourceToken;
    this.liveStartupPromise = (async () => {
      const startedAt = Date.now();
      this.ui.setSyncing(true, "正在准备音视频...");
      while (sourceToken === this.onlineSourceToken && Date.now() - startedAt < timeoutMs) {
        let longestRange = 0;
        for (let index = 0; index < this.video.buffered.length; index += 1) {
          longestRange = Math.max(longestRange, this.video.buffered.end(index) - this.video.buffered.start(index));
        }
        this.ui.setSyncing(
          true,
          `正在准备音视频 ${Math.min(targetSeconds, longestRange).toFixed(1)}/${targetSeconds.toFixed(1)}s`
        );
        if (longestRange >= targetSeconds) break;
        await new Promise((resolve) => window.setTimeout(resolve, 150));
      }
      if (sourceToken !== this.onlineSourceToken) return;
      if (this.video.buffered.length) {
        const index = this.video.buffered.length - 1;
        const start = this.video.buffered.start(index);
        const end = this.video.buffered.end(index);
        const stableStart = Math.max(start, end - targetSeconds);
        if (Math.abs(this.video.currentTime - stableStart) > 0.25) this.setProgrammaticCurrentTime(stableStart);
      }
      this.liveStartupReady = true;
      if (this.userVolume > 0 && this.canUnmuteAudibly()) {
        this.mutedForAutoplay = false;
        this.video.defaultMuted = false;
        this.video.muted = false;
        this.applyEffectiveVolume();
      }
      this.ui.setSyncing(true, "准备完成，正在播放...");
    })().finally(() => {
      this.liveStartupPromise = null;
    });
    return this.liveStartupPromise;
  }

  markRemoteAutoplayBlocked(error) {
    if (error?.name === "AbortError") return;
    this.remoteAutoplayBlockedUntil = Date.now() + 1200;
    this.remoteAutoplayAttempts = 0;
    window.clearTimeout(this.remoteAutoplayTimer);
    this.scheduleAutoplayAfterBlock();
  }

  scheduleAutoplayAfterBlock() {
    window.clearTimeout(this.remoteAutoplayTimer);
    const wait = Math.max(80, this.remoteAutoplayBlockedUntil - Date.now() + 40);
    this.remoteAutoplayTimer = window.setTimeout(() => {
      if (!this.remoteAutoplayWanted || !this.video.paused) return;
      this.retryRemoteAutoplay("blocked");
    }, wait);
  }

  enableVideoSound() {
    if (this.userVolume <= 0) return;
    this.video.muted = false;
    this.video.defaultMuted = false;
    this.mutedForAutoplay = false;
    this.applyEffectiveVolume();
  }

  restoreEffectiveVolume() {
    if (this.userVolume <= 0) return;
    this.video.defaultMuted = false;
    if (this.userAudioUnlocked) {
      this.mutedForAutoplay = false;
      this.video.muted = false;
    } else if (!this.mutedForAutoplay) {
      this.video.muted = false;
    }
    this.applyEffectiveVolume();
  }

  scheduleAudioRestoreAttempts() {
    if (this.userVolume <= 0) return;
    if (!this.canUnmuteAudibly()) return;
    if (Date.now() < this.audioRestoreBlockedUntil) return;
    this.audioRestoreTimers.forEach((timer) => window.clearTimeout(timer));
    this.audioRestoreTimers = [];
    this.audioRestoreBlockedUntil = Date.now() + 30000;
    const timer = window.setTimeout(() => {
      if (this.video.paused || this.userVolume <= 0) return;
      this.video.defaultMuted = false;
      this.video.muted = false;
      this.mutedForAutoplay = false;
      this.applyEffectiveVolume();
    }, 220);
    this.audioRestoreTimers.push(timer);
  }

  installVideoAudioUnlock() {
    const unlock = (event) => {
      if (event.target?.closest?.("#playButton")) return;
      this.unlockVideoAudio();
    };
    ["pointerdown", "pointerup", "touchstart", "touchend", "keydown", "click"].forEach((eventName) => {
      document.addEventListener(eventName, unlock, { passive: true, capture: true });
    });
    document.addEventListener("keydown", (event) => this.handleGlobalKeydown(event), { capture: true });
    document.addEventListener("keyup", (event) => this.handleGlobalKeyup(event), { capture: true });
  }

  handleGlobalKeydown(event) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
    const volume = event.key === "ArrowUp" || event.key === "ArrowDown";
    if (!horizontal && !volume) return;
    const target = event.target;
    const editable = target instanceof Element
      ? target.closest("input, textarea, select, [contenteditable='true']")
      : null;
    if (volume) {
      if (!this.videoKeyboardActive()) return;
      event.preventDefault();
      event.stopPropagation();
      this.adjustVideoVolume(event.key === "ArrowUp" ? 0.1 : -0.1);
      return;
    }
    if (editable && editable !== this.ui?.seekBar) return;
    if (!this.meta || this.isLiveSource() || !Number.isFinite(this.video.duration) || this.video.duration <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.showControls(true);
    this.queueKeyboardSeek(event.key === "ArrowLeft" ? -10 : 10);
  }

  videoKeyboardActive() {
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
    const fullscreenVideo = Boolean(
      fullscreenElement &&
      (fullscreenElement === this.ui?.videoFrame || fullscreenElement.contains?.(this.ui?.videoFrame))
    );
    return Boolean(this.pointerInsideVideoFrame || this.pseudoFullscreen || fullscreenVideo);
  }

  adjustVideoVolume(delta) {
    this.userVolume = Math.min(1, Math.max(0, Math.round((this.userVolume + delta) * 100) / 100));
    if (this.ui?.videoVolume) this.ui.videoVolume.value = Math.round(this.userVolume * 100);
    window.syncinemaUpdateVolumeSliders?.();
    if (this.userVolume <= 0) {
      this.audioRestoreTimers.forEach((timer) => window.clearTimeout(timer));
      this.audioRestoreTimers = [];
      this.mutedForAutoplay = false;
      this.applyEffectiveVolume();
    } else {
      this.enableVideoSound();
    }
    localStorage.setItem("pc:video-volume", String(this.userVolume));
    this.showFeedback(`音量 ${Math.round(this.userVolume * 100)}%`);
  }

  handleGlobalKeyup(event) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    if (!Number.isFinite(this.keyboardSeekTarget)) return;
    this.scheduleKeyboardSeekCommit(220);
  }

  queueKeyboardSeek(seconds) {
    if (this.isLiveSource() || !Number.isFinite(this.video.duration) || this.video.duration <= 0) return;
    this.markUserSync(2500);
    const baseTime = Number.isFinite(this.keyboardSeekTarget)
      ? this.keyboardSeekTarget
      : this.video.currentTime || 0;
    this.keyboardSeekTarget = Math.min(this.video.duration, Math.max(0, baseTime + seconds));
    this.keyboardSeekDelta += seconds;
    const delta = this.keyboardSeekDelta;
    this.showFeedback(delta >= 0 ? `快进 ${delta}s` : `快退 ${Math.abs(delta)}s`);

    this.scheduleKeyboardSeekCommit(1200);
  }

  scheduleKeyboardSeekCommit(delay) {
    window.clearTimeout(this.keyboardSeekTimer);
    this.keyboardSeekTimer = window.setTimeout(() => this.commitKeyboardSeek(), delay);
  }

  commitKeyboardSeek() {
    const targetTime = this.keyboardSeekTarget;
    this.keyboardSeekTimer = null;
    this.keyboardSeekTarget = null;
    this.keyboardSeekDelta = 0;
    if (!Number.isFinite(targetTime)) return;
    this.markUserSync(2500);
    this.pendingSeekTarget = targetTime;
    this.scheduleSeekSync("skip", 120, targetTime);
    this.video.currentTime = targetTime;
  }

  unlockVideoAudio() {
    if (this.userVolume <= 0) return;
    this.userAudioUnlocked = true;
    this.audioRestoreBlockedUntil = 0;
    const now = Date.now();
    const shouldRetryPlay = !this.video.paused && now - this.lastAudioUnlockAt > 250;
    this.lastAudioUnlockAt = now;
    this.enableVideoSound();
    if (shouldRetryPlay) this.video.play().catch(() => {});
  }

  primeVideoPlayback() {
    this.unlockVideoAudio();
    if (!this.meta?.id || !this.video.paused) return;

    const shouldRemainPlaying = this.expectedRemotePlaying || this.remoteAutoplayWanted;
    const previousApplyingRemote = this.applyingRemote;
    this.applyingRemote = true;
    this.video.defaultMuted = false;
    this.video.muted = false;
    this.applyEffectiveVolume();

    const restoreState = (keepMuted = false) => {
      if (!shouldRemainPlaying && !this.expectedRemotePlaying && !this.remoteAutoplayWanted) {
        this.video.pause();
      }
      if (!keepMuted) this.enableVideoSound();
      window.setTimeout(() => {
        this.applyingRemote = previousApplyingRemote;
        this.updateControls();
      }, 80);
    };

    this.video.play().then(restoreState).catch(() => {
      this.video.muted = true;
      this.mutedForAutoplay = this.userVolume > 0;
      this.video.play().then(() => restoreState(true)).catch(() => {
        this.applyingRemote = previousApplyingRemote;
      });
    });
  }

  canUnmuteAudibly() {
    return Boolean(this.userAudioUnlocked || navigator.userActivation?.hasBeenActive);
  }

  retryRemoteAutoplay(reason = "retry") {
    if (!this.remoteAutoplayWanted || !this.meta?.id) return;
    if (Date.now() < this.remoteAutoplayBlockedUntil) return;
    if (!this.video.paused) {
      this.remoteAutoplayWanted = false;
      this.remoteAutoplayAttempts = 0;
      return;
    }
    if (this.remoteAutoplayAttempts > 18) return;
    window.clearTimeout(this.remoteAutoplayTimer);
    const delay = reason === "progress" ? 220 : reason === "abort" || reason === "timer" ? 420 : 40;
    this.remoteAutoplayTimer = window.setTimeout(async () => {
      if (!this.remoteAutoplayWanted || !this.video.paused) return;
      if (Date.now() < this.remoteAutoplayBlockedUntil) return;
      this.remoteAutoplayAttempts += 1;
      const suppressLocalEvents = this.hasLocalSource();
      if (suppressLocalEvents) this.applyingRemote = true;
      try {
        await this.playRemoteWithFallback();
      } catch {
        if (this.remoteAutoplayWanted && this.remoteAutoplayAttempts <= 18) {
          this.retryRemoteAutoplay("timer");
        }
      } finally {
        if (suppressLocalEvents) {
          window.setTimeout(() => {
            this.applyingRemote = false;
          }, 100);
        }
      }
    }, delay);
  }

  watchRemotePlayStart() {
    if (!this.expectedRemotePlaying) return;
    window.clearInterval(this.remotePlayWatchdog);
    const startedAt = Date.now();
    this.remotePlayWatchdog = window.setInterval(() => {
      if (!this.expectedRemotePlaying) {
        window.clearInterval(this.remotePlayWatchdog);
        this.remotePlayWatchdog = null;
        return;
      }
      const deadline = Math.max(startedAt + 10000, this.expectedRemotePlayingUntil || 0);
      if (Date.now() > deadline) {
        window.clearInterval(this.remotePlayWatchdog);
        this.remotePlayWatchdog = null;
        return;
      }
      if (this.video.paused && !this.applyingRemote && Date.now() >= this.remoteAutoplayBlockedUntil) {
        this.remoteAutoplayWanted = true;
        this.video.muted = true;
        this.mutedForAutoplay = this.userVolume > 0;
        this.retryRemoteAutoplay("watchdog");
      }
    }, 180);
  }

  remoteTargetTime(state) {
    if (this.meta?.live) return null;
    if (!Number.isFinite(state.currentTime)) return null;
    let time = Math.max(0, state.currentTime);
    if (!state.paused && Number.isFinite(state.updatedAt)) {
      const executeAt = Number(state.executeAt || 0);
      if (executeAt > Date.now()) return time;
      const elapsed = (Date.now() - state.updatedAt) / 1000;
      if (elapsed >= 0 && elapsed < 5) {
        const rate = Number.isFinite(state.playbackRate) ? state.playbackRate : 1;
        time += elapsed * rate;
      }
    }
    if (Number.isFinite(this.video.duration) && this.video.duration > 0) {
      time = Math.min(time, this.video.duration);
    }
    return time;
  }

  updateControls() {
    const realPaused = this.video.paused;
    this.ui.setPlaybackPaused?.(realPaused);
    this.ui.playButton.textContent = realPaused ? "播放" : "暂停";
    const duration = this.video.duration || 0;
    const current = this.video.currentTime || 0;
    const live = this.isLiveSource();
    this.ui.seekBar.disabled = live;
    this.ui.seekBar.title = live ? "直播保持实时，不支持回看" : "";
    this.ui.seekBar.closest(".progress-wrap")?.classList.toggle("is-live", live);
    if (live) {
      this.ui.currentTime.textContent = "直播";
      this.ui.duration.textContent = "实时";
      this.ui.seekBar.value = 1000;
      this.updateBufferedBar(1, 1);
      return;
    }
    const displayedCurrent = Number.isFinite(this.pendingSeekTarget)
      ? this.pendingSeekTarget
      : current;
    this.ui.currentTime.textContent = formatTime(displayedCurrent);
    this.ui.duration.textContent = formatTime(duration);
    this.ui.seekBar.value = duration > 0 ? Math.round((displayedCurrent / duration) * 1000) : 0;
    this.updateBufferedBar(current, duration);
  }

  effectivePaused() {
    return this.video.paused;
  }

  updateBufferedBar(current, duration) {
    const progressWrap = this.ui.seekBufferBar?.parentElement;
    if (!this.ui.seekBufferBar || !progressWrap) return;
    if (!Number.isFinite(duration) || duration <= 0) {
      progressWrap.style.setProperty("--played", "0%");
      progressWrap.style.setProperty("--buffered", "0%");
      return;
    }

    let bufferedEnd = current;
    const ranges = this.video.buffered;
    for (let index = 0; index < ranges.length; index += 1) {
      const start = ranges.start(index);
      const end = ranges.end(index);
      if (start <= current + 0.35 && end >= current - 0.35) {
        bufferedEnd = Math.max(bufferedEnd, end);
      } else if (start > current && bufferedEnd <= current) {
        bufferedEnd = Math.max(bufferedEnd, end);
        break;
      }
    }

    const playedPercent = Math.min(100, Math.max(0, (current / duration) * 100));
    const bufferedPercent = Math.min(100, Math.max(playedPercent, (bufferedEnd / duration) * 100));
    progressWrap.style.setProperty("--played", `${playedPercent}%`);
    progressWrap.style.setProperty("--buffered", `${bufferedPercent}%`);
  }

  handleFrameDoubleClick(event) {
    if (event.target.closest(".controls") || event.target.closest(".empty-state")) return;

    this.markUserSync();
    const rect = this.ui.videoFrame.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;

    if (this.isLiveSource()) {
      if (ratio < 0.34 || ratio > 0.66) this.showFeedback("直播不支持回看");
      return;
    }

    if (ratio < 0.34) {
      this.seekRelative(-10);
      return;
    }

    if (ratio > 0.66) {
      this.seekRelative(10);
      return;
    }

    if (!this.hasLocalSource()) {
      this.remoteAutoplayBlockedUntil = 0;
      this.remoteAutoplayAttempts = 0;
      const wantsPlaying = this.video.paused;
      if (!wantsPlaying) {
        this.expectedRemotePlaying = false;
        this.expectedRemotePlayingUntil = 0;
      }
      this.dispatchEvent(new CustomEvent("remote-play-toggle", { detail: { wantsPlaying } }));
      this.showFeedback(wantsPlaying ? "播放" : "暂停");
      return;
    }

    if (this.video.paused) {
      const replay = this.video.ended || (Number.isFinite(this.video.duration) && this.video.currentTime >= this.video.duration - 0.05);
      this.enableVideoSound();
      this.emitSync(replay ? "remote-replay-click" : "play-click", {
        userIntent: true,
        overrides: { paused: false, currentTime: replay ? 0 : this.video.currentTime || 0 }
      });
      this.showFeedback(replay ? "重新播放" : "播放");
    } else {
      this.emitSync("pause-click", { userIntent: true, overrides: { paused: true } });
      this.showFeedback("暂停");
    }
  }

  seekRelative(seconds) {
    if (this.isLiveSource()) {
      this.showFeedback("直播不支持回看");
      return;
    }
    if (!Number.isFinite(this.video.duration)) return;
    this.markUserSync(2500);
    const nextTime = Math.min(this.video.duration, Math.max(0, (this.video.currentTime || 0) + seconds));
    this.pendingSeekTarget = nextTime;
    this.scheduleSeekSync("skip", 120, nextTime);
    this.video.currentTime = nextTime;
    this.showFeedback(seconds > 0 ? `快进 ${seconds}s` : `快退 ${Math.abs(seconds)}s`);
  }

  showFeedback(text) {
    window.clearTimeout(this.feedbackTimer);
    this.ui.seekFeedback.textContent = text;
    this.ui.seekFeedback.classList.remove("hidden");
    this.feedbackTimer = window.setTimeout(() => {
      this.ui.seekFeedback.classList.add("hidden");
    }, 650);
    this.showControls();
  }

  showControls(force = false, quick = false) {
    window.clearTimeout(this.controlsTimer);
    this.ui.videoFrame.closest(".stage")?.classList.remove("controls-hidden");
    this.ui.videoFrame.classList.remove("controls-hidden");
    if (!force) {
      const mobile = window.matchMedia?.("(max-width: 860px)").matches;
      this.scheduleControlsHide(mobile ? (quick ? 4200 : 4800) : (quick ? 1600 : 2000));
    }
  }

  scheduleControlsHide(delay = null) {
    window.clearTimeout(this.controlsTimer);
    if (this.video.paused || this.draggingSeek) return;
    const mobile = window.matchMedia?.("(max-width: 860px)").matches;
    const resolvedDelay = Number.isFinite(delay) ? delay : (mobile ? 4800 : 2000);
    this.controlsTimer = window.setTimeout(() => {
      const controlsHost = this.pseudoFullscreen
        ? this.ui.videoFrame
        : this.ui.videoFrame.closest(".stage");
      controlsHost?.classList.add("controls-hidden");
    }, resolvedDelay);
  }

  showSeekPreview(event) {
    if (!Number.isFinite(this.video.duration) || this.video.duration <= 0) return;
    const rect = this.ui.seekBar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    this.ui.seekPreview.textContent = formatTime(ratio * this.video.duration);
    this.ui.seekPreview.style.left = `${ratio * 100}%`;
    this.ui.seekPreview.classList.remove("hidden");
  }

  updateSeekPreviewFromEvent() {
    if (!Number.isFinite(this.video.duration) || this.video.duration <= 0) return;
    const ratio = Number(this.ui.seekBar.value) / 1000;
    this.ui.seekPreview.textContent = formatTime(ratio * this.video.duration);
    this.ui.seekPreview.style.left = `${ratio * 100}%`;
    this.ui.seekPreview.classList.remove("hidden");
  }

  hideSeekPreview() {
    this.ui.seekPreview.classList.add("hidden");
  }

  setVoiceDucking(active) {
    this.ducking = active;
    this.applyEffectiveVolume();
  }

  applyEffectiveVolume() {
    if (this.userVolume <= 0) {
      this.video.volume = 0;
      this.video.muted = true;
      return;
    }
    if (this.userVolume > 0 && this.video.muted && !this.mutedForAutoplay) {
      this.video.muted = false;
    }
    this.video.volume = this.ducking ? this.userVolume * 0.35 : this.userVolume;
  }

  applyFitMode(mode) {
    const aliases = {
      cover: "contain",
      "16-9": "ratio-16-9",
      "4-3": "ratio-4-3"
    };
    const normalized = aliases[mode] || mode;
    const clean = ["contain", "ratio-16-9", "ratio-4-3", "fill"].includes(normalized) ? normalized : "contain";

    this.updateNaturalAspect();
    this.ui.videoFrame.dataset.aspect = "16-9";
    this.ui.videoFrame.dataset.fitMode = clean;
    this.video.dataset.fit = clean;
    this.fitMode = clean;
    if (this.ui.fitSelect) this.ui.fitSelect.value = clean;
    localStorage.setItem("pc:fit-mode", clean);
    this.updateVideoGeometry();
  }

  loadFitMode() {
    return localStorage.getItem("pc:fit-mode") || "contain";
  }

  updateNaturalAspect() {
    const width = Number(this.video.videoWidth || 0);
    const height = Number(this.video.videoHeight || 0);
    if (width > 0 && height > 0) {
      this.naturalVideoAspect = width / height;
      this.ui.videoSurface?.style.setProperty("--video-natural-aspect", `${width} / ${height}`);
      this.updateVideoGeometry();
    }
  }

  updateVideoGeometry() {
    const surface = this.ui.videoSurface;
    if (!surface) return;
    const surfaceWidth = surface.clientWidth;
    const surfaceHeight = surface.clientHeight;
    if (!(surfaceWidth > 0 && surfaceHeight > 0)) return;

    if (this.fitMode === "fill") {
      surface.style.setProperty("--fitted-video-width", `${surfaceWidth}px`);
      surface.style.setProperty("--fitted-video-height", `${surfaceHeight}px`);
      return;
    }

    const targetAspect = this.fitMode === "ratio-4-3"
      ? 4 / 3
      : this.fitMode === "ratio-16-9"
        ? 16 / 9
        : Number(this.naturalVideoAspect || 16 / 9);
    const surfaceAspect = surfaceWidth / surfaceHeight;
    const fittedWidth = surfaceAspect > targetAspect ? surfaceHeight * targetAspect : surfaceWidth;
    const fittedHeight = surfaceAspect > targetAspect ? surfaceHeight : surfaceWidth / targetAspect;
    surface.style.setProperty("--fitted-video-width", `${Math.round(fittedWidth * 100) / 100}px`);
    surface.style.setProperty("--fitted-video-height", `${Math.round(fittedHeight * 100) / 100}px`);
  }

  updateLocalQualityLabel() {
    if (!this.hasLocalSource() || this.hls) return;
    const height = Number(this.video.videoHeight || 0);
    const width = Number(this.video.videoWidth || 0);
    const label = height > 0 ? `原画 ${height}p` : width > 0 ? `原画 ${width}w` : "原画";
    this.ui.setQualityOptions([{ value: "original", label }], "original", true);
  }

  savePosition() {
    if (!this.meta?.id || !Number.isFinite(this.video.currentTime)) return;
    localStorage.setItem(`pc:position:${this.meta.id}`, String(this.video.currentTime));
  }

  clearSavedPositions() {
    Object.keys(localStorage)
      .filter((key) => key.startsWith("pc:position:"))
      .forEach((key) => localStorage.removeItem(key));
    this.restoreAfterMetadata = null;
  }

  restoreSavedPosition(videoId) {
    const saved = Number(localStorage.getItem(`pc:position:${videoId}`));
    if (Number.isFinite(saved) && saved > 3) this.restoreAfterMetadata = saved;
  }

  waitForPlayableNear(time, timeout) {
    if (this.isBuffered(time) || this.video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const done = () => {
        window.clearTimeout(timer);
        this.video.removeEventListener("canplay", done);
        this.video.removeEventListener("seeked", check);
        this.video.removeEventListener("progress", check);
        resolve();
      };
      const check = () => {
        if (this.isBuffered(time) || this.video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) done();
      };
      const timer = window.setTimeout(done, timeout);
      this.video.addEventListener("canplay", done, { once: true });
      this.video.addEventListener("seeked", check);
      this.video.addEventListener("progress", check);
    });
  }

  isBuffered(time) {
    const ranges = this.video.buffered;
    for (let index = 0; index < ranges.length; index += 1) {
      if (ranges.start(index) <= time && ranges.end(index) >= time) return true;
    }
    return false;
  }

  loadVolume() {
    const saved = Number(localStorage.getItem("pc:video-volume"));
    return Number.isFinite(saved) ? Math.min(1, Math.max(0, saved)) : 1;
  }
}
