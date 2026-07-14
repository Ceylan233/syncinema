import { ChatPanel } from "./components/ChatPanel.js?v=20260711-history-divider-2";
import { DialogLayer } from "./components/DialogLayer.js?v=20260711-room-dom-1";
import { MembersPanel } from "./components/MembersPanel.js?v=20260710-rename-1";
import { PlayerStage } from "./components/PlayerStage.js?v=20260711-danmaku-settings-3";
import { TopBar } from "./components/TopBar.js?v=20260711-room-dom-1";
import { createApp, nextTick, reactive } from "vue/dist/vue.esm-bundler.js";

function initialRoomId() {
  try {
    const params = new URLSearchParams(window.location.search);
    return String(params.get("room") || localStorage.getItem("pc:room-id") || "1").trim().slice(0, 40) || "1";
  } catch {
    return "1";
  }
}

function playbackTimeLabel(value) {
  const total = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function playbackActivityText(activity = {}) {
  const name = String(activity.name || "有人");
  if (activity.kind === "play") return `${name} 开始播放`;
  if (activity.kind === "pause") return `${name} 暂停了播放`;
  if (activity.kind === "replay") return `${name} 从头重播`;
  if (activity.kind === "seek") return `${name} 跳转到 ${playbackTimeLabel(activity.currentTime)}`;
  if (activity.kind === "rate") return `${name} 调整倍速为 ${Number(activity.playbackRate || 1)}x`;
  if (activity.kind === "source") return `${name} 切换视频为 ${String(activity.fileName || "新视频")}`;
  if (activity.kind === "join") return `${name} 进入房间`;
  if (activity.kind === "leave") return `${name} 离开房间`;
  if (activity.kind === "fit") {
    const labels = { contain: "适应", "ratio-16-9": "16:9", "ratio-4-3": "4:3", fill: "拉伸铺满" };
    return `${name} 调整画面比例为 ${labels[activity.fitMode] || activity.fitMode}`;
  }
  return `${name} 调整了播放状态`;
}

const CHAT_COMMANDS = [
  { value: "/clear", label: "清空当前房间聊天" },
  { value: "/clearactivity", label: "清空当前房间操作记录" },
  { value: "/file", label: "选择本地视频" },
  { value: "/vod", label: "打开点播" },
  { value: "/room ", label: "切换房间" },
  { value: "/sensitive ", label: "管理违禁词" }
];

const rootTemplate = `
  <div class="app-shell">
    <TopBar :state="state" />
    <main class="cinema-layout">
      <PlayerStage :state="state" />
      <MembersPanel :state="state" @toggle-panel="togglePanel" @rename-self="renameSelf" />
      <ChatPanel :state="state" @toggle-panel="togglePanel" @toggle-activity-history="toggleActivityHistory" @open-system-notifications="openSystemNotifications" @select-command="selectCommand" />
    </main>
    <DialogLayer :state="state" @close-activity-history="closeActivityHistory" @close-system-notifications="closeSystemNotifications" />
  </div>
`;

export class UI {
  constructor() {
    if (!createApp || !reactive) throw new Error("Vue 3 is required before app.js loads");

    const mountedRoomId = initialRoomId();
    const roomFeaturesVisible = mountedRoomId !== "1";

    this.state = reactive({
      connectionText: "连接中",
      connectionTone: "warn",
      roomId: mountedRoomId,
      sourceControlsVisible: roomFeaturesVisible,
      voiceControlsVisible: roomFeaturesVisible,
      voiceText: "麦克风已关闭",
      voiceTone: "warn",
      micEnabled: false,
      micBusy: false,
      micText: "",
      noiseEnabled: false,
      noiseBusy: false,
      emptyVisible: true,
      syncing: false,
      isLive: false,
      nowPlayingTitle: "",
      playbackPaused: true,
      danmakuEnabled: localStorage.getItem("syncinema:danmaku:v2") !== "off",
      danmakuSettingsVisible: false,
      danmakuArea: ["full", "half", "quarter"].includes(localStorage.getItem("syncinema:danmaku-area"))
        ? localStorage.getItem("syncinema:danmaku-area")
        : "full",
      danmakuOpacity: Math.min(1, Math.max(0.2, Number(localStorage.getItem("syncinema:danmaku-opacity") || 0.9))),
      syncText: "正在同步...",
      transferVisible: false,
      transferTitle: "等待视频",
      transferPercent: 0,
      quality: {
        disabled: true,
        options: [{ value: "original", label: "原画" }],
        value: "original"
      },
      users: [],
      selfId: null,
      messages: [],
      historyMessageCount: 0,
      systemNotifications: [],
      systemNotificationVisible: false,
      systemNotificationUnread: 0,
      playbackActivities: [],
      activityHistoryVisible: false,
      activityToast: "",
      commandMenuVisible: false,
      commandSuggestions: [],
      commandActiveIndex: 0,
      nameVisible: false,
      nameBusy: false,
      nameTitle: "进入 同映",
      nameHint: "输入一个昵称，之后会自动记住。",
      nameSubmitText: "进入影院",
      nameBusyText: "正在进入...",
      membersCollapsed: false,
      chatCollapsed: false,
      confirm: {
        visible: false,
        title: "确认操作",
        message: "",
        okText: "确定",
        cancelText: "取消"
      },
      sensitive: {
        visible: false,
        busy: false,
        status: "",
        categories: [],
        password: ""
      },
      source: {
        visible: false,
        busy: false,
        status: "",
        sources: [],
        activeSourceId: "",
        searchResults: [],
        chapterGroups: [],
        activeChapterGroupId: "",
        chapters: []
      }
    });
    this.messageIds = new Set();
    this.systemMessageId = 0;
    this.playbackActivityIds = new Set();
    this.activityToastTimer = null;
    this.danmakuLaneCursor = 0;
    this.recentSystemMessages = new Map();
    this.pendingConfirm = null;
    this.pendingNameResolve = null;
    this.nameValidator = null;

    this.app = createApp({
      name: "SyncinemaApp",
      components: { ChatPanel, DialogLayer, MembersPanel, PlayerStage, TopBar },
      setup: () => ({
        state: this.state,
        togglePanel: (panel) => this.togglePanel(panel),
        toggleActivityHistory: () => this.toggleActivityHistory(),
        closeActivityHistory: () => this.closeActivityHistory(),
        openSystemNotifications: () => this.openSystemNotifications(),
        closeSystemNotifications: () => this.closeSystemNotifications(),
        selectCommand: (command) => this.selectCommand(command),
        renameSelf: () => document.dispatchEvent(new CustomEvent("syncinema:rename-self"))
      }),
      template: rootTemplate
    });
    this.app.mount("#app");
    document.documentElement.dataset.uiFramework = "vue3-componentized";
    this.cacheElements();
    this.bindNameForm();
    this.bindConfirmButtons();
  }

  cacheElements() {
    [
      "video",
      "videoFrame",
      "videoSurface",
      "danmakuLayer",
      "danmakuToggleButton",
      "danmakuSettingsButton",
      "danmakuSettingsMenu",
      "danmakuOpacity",
      "fileInput",
      "emptyState",
      "seekFeedback",
      "syncOverlay",
      "connectionBadge",
      "voiceBadge",
      "micToggleButton",
      "noiseToggleButton",
      "micVolume",
      "memberCount",
      "members",
      "messages",
      "chatForm",
      "chatInput",
      "nameModal",
      "nameForm",
      "nameInput",
      "confirmModal",
      "confirmTitle",
      "confirmMessage",
      "confirmOk",
      "confirmCancel",
      "sensitiveModal",
      "sensitiveForm",
      "sensitiveAddCategory",
      "sensitiveCategoryList",
      "sensitiveClose",
      "sourceModal",
      "sourceClose",
      "sourceImportForm",
      "sourceImportInput",
      "sourceList",
      "sourceDirectForm",
      "sourceDirectInput",
      "sourceSearchForm",
      "sourceSearchInput",
      "sourceSearchResults",
      "sourceRoads",
      "sourceChapters",
      "playButton",
      "chooseVideoButton",
      "onlineSourceButton",
      "emptyOnlineSourceButton",
      "seekBar",
      "seekBufferBar",
      "seekPreview",
      "currentTime",
      "duration",
      "rateSelect",
      "fitSelect",
      "qualitySelect",
      "videoVolume",
      "voiceVolume",
      "fullscreenButton",
      "transferPanel",
      "transferTitle",
      "transferProgress",
      "transferPercent"
    ].forEach((id) => {
      this[id] = document.getElementById(id);
    });
  }

  togglePanel(panel) {
    if (window.innerWidth > 860) return;
    if (panel === "members") this.state.membersCollapsed = !this.state.membersCollapsed;
    if (panel === "chat") this.state.chatCollapsed = !this.state.chatCollapsed;
  }

  askName() {
    const saved = localStorage.getItem("pc:name") || "";
    if (saved) {
      return this.openNameModal({
        value: saved,
        hint: "点击进入影院，同时开启视频声音。"
      });
    }
    return this.openNameModal();
  }

  requestRename(currentName = "") {
    return this.openNameModal({
      value: currentName || localStorage.getItem("pc:name") || "",
      title: "修改昵称",
      hint: "改名后会立刻同步到成员列表。",
      submitText: "保存昵称",
      busyText: "正在保存..."
    });
  }

  setNameValidator(validator) {
    this.nameValidator = typeof validator === "function" ? validator : null;
  }

  openNameModal({ value = "", title = "进入 同映", hint = "输入一个昵称，之后会自动记住。", submitText = "进入影院", busyText = "正在进入..." } = {}) {
    this.nameInput.value = value;
    this.state.nameTitle = title;
    this.state.nameHint = hint;
    this.state.nameSubmitText = submitText;
    this.state.nameBusyText = busyText;
    this.state.nameBusy = false;
    this.state.nameVisible = true;
    return new Promise((resolve) => {
      this.pendingNameResolve = resolve;
      nextTick(() => this.nameInput.focus());
    });
  }

  bindNameForm() {
    this.nameForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!this.pendingNameResolve || this.state.nameBusy) return;
      const name = this.nameInput.value.trim() || `用户${Math.floor(Math.random() * 9000 + 1000)}`;
      if (this.nameValidator) {
        this.state.nameBusy = true;
        try {
          const result = await this.nameValidator(name);
          if (!result?.allowed) {
            this.state.nameHint = result?.message || "昵称包含违禁词，请修改。";
            this.nameInput.focus();
            return;
          }
        } catch {
          this.state.nameHint = "暂时无法验证昵称，请稍后重试。";
          return;
        } finally {
          this.state.nameBusy = false;
        }
      }
      localStorage.setItem("pc:name", name);
      this.state.nameVisible = false;
      const resolve = this.pendingNameResolve;
      this.pendingNameResolve = null;
      resolve(name);
    });
  }

  setConnectionState(text, tone = "warn") {
    this.state.connectionText = text;
    this.state.connectionTone = tone;
  }

  setRoom(roomId) {
    const cleanRoomId = String(roomId || "1");
    this.state.roomId = cleanRoomId;
    this.state.sourceControlsVisible = cleanRoomId !== "1";
    this.state.voiceControlsVisible = cleanRoomId !== "1";
  }

  setVoiceState(text, tone = "") {
    this.state.voiceText = text;
    this.state.voiceTone = tone;
  }

  setMicControl({ enabled, busy = false, text } = {}) {
    this.state.micEnabled = Boolean(enabled);
    this.state.micBusy = busy;
    this.state.micText = text || "";
  }

  setNoiseControl({ enabled, busy = false } = {}) {
    this.state.noiseEnabled = Boolean(enabled);
    this.state.noiseBusy = busy;
  }

  openSourceModal() {
    this.state.source.visible = true;
    nextTick(() => this.sourceSearchInput?.focus());
  }

  closeSourceModal() {
    this.state.source.visible = false;
  }

  openSensitiveModal(categories = [], password = "") {
    this.state.sensitive.categories = (Array.isArray(categories) ? categories : []).map((category, index) => ({
      id: String(category?.id || `custom-${Date.now()}-${index}`),
      name: String(category?.name || `分类${index + 1}`),
      text: String(category?.text || "")
    }));
    this.state.sensitive.password = String(password || "");
    this.state.sensitive.status = "";
    this.state.sensitive.busy = false;
    this.state.sensitive.visible = true;
    nextTick(() => this.sensitiveCategoryList?.querySelector("textarea")?.focus());
  }

  addSensitiveCategory() {
    this.state.sensitive.categories.push({
      id: `custom-${Date.now()}`,
      name: "新分类",
      text: ""
    });
    nextTick(() => {
      const inputs = this.sensitiveCategoryList?.querySelectorAll(".sensitive-category-name");
      inputs?.[inputs.length - 1]?.focus();
      inputs?.[inputs.length - 1]?.select();
    });
  }

  removeSensitiveCategory(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.state.sensitive.categories.length) return;
    this.state.sensitive.categories.splice(index, 1);
  }

  closeSensitiveModal() {
    this.state.sensitive.visible = false;
    this.state.sensitive.password = "";
    this.state.sensitive.status = "";
  }

  setSourceState(patch = {}) {
    Object.assign(this.state.source, patch);
  }

  setQualityOptions(options = [], value = "auto", disabled = false) {
    const cleanOptions = Array.isArray(options) && options.length
      ? options.map((option) => ({
          value: String(option.value),
          label: String(option.label)
        }))
      : [{ value: "original", label: "原画" }];
    this.state.quality.options = cleanOptions;
    this.state.quality.value = String(value);
    this.state.quality.disabled = Boolean(disabled);
    nextTick(() => {
      if (!this.qualitySelect) return;
      this.qualitySelect.value = String(value);
      this.qualitySelect.disabled = Boolean(disabled);
    });
  }

  confirm({ title = "确认操作", message = "", okText = "确定", cancelText = "取消" } = {}) {
    this.state.confirm.title = title;
    this.state.confirm.message = message;
    this.state.confirm.okText = okText;
    this.state.confirm.cancelText = cancelText;
    this.state.confirm.visible = true;
    return new Promise((resolve) => {
      this.pendingConfirm = resolve;
      nextTick(() => this.confirmCancel.focus());
    });
  }

  bindConfirmButtons() {
    this.confirmOk.addEventListener("click", () => this.finishConfirm(true));
    this.confirmCancel.addEventListener("click", () => this.finishConfirm(false));
    this.confirmModal.addEventListener("click", (event) => {
      if (event.target === this.confirmModal) this.finishConfirm(false);
    });
    document.addEventListener("keydown", (event) => {
      if (this.state.confirm.visible) {
        if (event.key === "Escape") this.finishConfirm(false);
        if (event.key === "Enter") this.finishConfirm(true);
      }
      if (this.state.source.visible && event.key === "Escape") this.closeSourceModal();
      if (this.state.sensitive.visible && event.key === "Escape") this.closeSensitiveModal();
    });
  }

  finishConfirm(value) {
    if (!this.state.confirm.visible) return;
    this.state.confirm.visible = false;
    const resolve = this.pendingConfirm;
    this.pendingConfirm = null;
    resolve?.(value);
  }

  renderUsers(users = [], selfId) {
    this.state.selfId = selfId || null;
    this.state.users = Array.isArray(users) ? users : [];
  }

  setSpeaking(id, speaking) {
    this.state.users = this.state.users.map((user) => (user.id === id ? { ...user, speaking } : user));
  }

  addMessage(message) {
    if (!message) return false;
    const messageId = String(message.id || "");
    if (messageId && this.messageIds.has(messageId)) return false;
    if (messageId) this.messageIds.add(messageId);
    this.state.messages.push({
      ...message,
      localKey: messageId || `message-${Date.now()}-${this.state.messages.length}`,
      system: false
    });
    this.scrollMessages();
    return true;
  }

  renderMessages(messages = []) {
    this.messageIds.clear();
    this.state.messages = [];
    messages.forEach((message) => this.addMessage(message));
    this.state.historyMessageCount = this.state.messages.length;
    this.scrollMessages();
  }

  addSystemMessage(text) {
    const cleanText = String(text || "").trim();
    if (!cleanText) return false;
    const now = Date.now();
    const lastAt = this.recentSystemMessages.get(cleanText) || 0;
    if (now - lastAt < 6000) return false;
    this.recentSystemMessages.set(cleanText, now);
    this.state.systemNotifications.unshift({
      localKey: `system-${now}-${this.systemMessageId++}`,
      text: cleanText,
      time: now
    });
    if (this.state.systemNotifications.length > 100) this.state.systemNotifications.length = 100;
    if (!this.state.systemNotificationVisible) this.state.systemNotificationUnread += 1;
    return true;
  }

  openSystemNotifications() {
    this.state.systemNotificationVisible = true;
    this.state.systemNotificationUnread = 0;
  }

  closeSystemNotifications() {
    this.state.systemNotificationVisible = false;
  }

  renderPlaybackActivities(items = []) {
    this.playbackActivityIds.clear();
    this.state.playbackActivities = [];
    (Array.isArray(items) ? items : []).forEach((item) => this.addPlaybackActivity(item, { notify: false }));
  }

  addPlaybackActivity(activity, { notify = true } = {}) {
    if (!activity?.kind) return false;
    const id = String(activity.id || `activity-${activity.time || Date.now()}-${activity.kind}`);
    if (this.playbackActivityIds.has(id)) return false;
    this.playbackActivityIds.add(id);
    const item = {
      ...activity,
      id,
      time: Number(activity.time || Date.now()),
      text: playbackActivityText(activity)
    };
    this.state.playbackActivities.unshift(item);
    if (this.state.playbackActivities.length > 100) {
      const removed = this.state.playbackActivities.splice(100);
      removed.forEach((entry) => this.playbackActivityIds.delete(entry.id));
    }
    if (notify) {
      this.state.activityToast = item.text;
      window.clearTimeout(this.activityToastTimer);
      this.activityToastTimer = window.setTimeout(() => {
        this.state.activityToast = "";
      }, 2600);
    }
    return true;
  }

  clearPlaybackActivities() {
    this.playbackActivityIds.clear();
    this.state.playbackActivities = [];
    this.state.activityToast = "";
    this.state.activityHistoryVisible = false;
  }

  toggleActivityHistory() {
    this.state.activityHistoryVisible = !this.state.activityHistoryVisible;
  }

  closeActivityHistory() {
    this.state.activityHistoryVisible = false;
  }

  updateCommandSuggestions(value = "") {
    const clean = String(value || "");
    if (!clean.startsWith("/") || clean.includes(" ")) {
      this.closeCommandSuggestions();
      return;
    }
    const query = clean.toLowerCase();
    const commands = this.state.roomId === "1"
      ? CHAT_COMMANDS.filter((item) => !["/file", "/vod", "/room"].includes(item.value.trim()))
      : CHAT_COMMANDS;
    this.state.commandSuggestions = commands.filter((item) => item.value.trim().startsWith(query));
    this.state.commandMenuVisible = this.state.commandSuggestions.length > 0;
    this.state.commandActiveIndex = Math.min(this.state.commandActiveIndex, Math.max(0, this.state.commandSuggestions.length - 1));
  }

  moveCommandSelection(direction) {
    const total = this.state.commandSuggestions.length;
    if (!this.state.commandMenuVisible || total === 0) return false;
    this.state.commandActiveIndex = (this.state.commandActiveIndex + direction + total) % total;
    return true;
  }

  selectActiveCommand() {
    const command = this.state.commandSuggestions[this.state.commandActiveIndex];
    if (!command) return false;
    this.selectCommand(command.value);
    return true;
  }

  selectCommand(command) {
    if (!this.chatInput) return;
    this.chatInput.value = String(command || "");
    this.closeCommandSuggestions();
    this.chatInput.focus();
  }

  closeCommandSuggestions() {
    this.state.commandMenuVisible = false;
    this.state.commandSuggestions = [];
    this.state.commandActiveIndex = 0;
  }

  setDanmakuEnabled(enabled) {
    this.state.danmakuEnabled = Boolean(enabled);
    localStorage.setItem("syncinema:danmaku:v2", this.state.danmakuEnabled ? "on" : "off");
    if (!this.state.danmakuEnabled && this.danmakuLayer) this.danmakuLayer.replaceChildren();
    return this.state.danmakuEnabled;
  }

  toggleDanmaku() {
    return this.setDanmakuEnabled(!this.state.danmakuEnabled);
  }

  toggleDanmakuSettings() {
    this.state.danmakuSettingsVisible = !this.state.danmakuSettingsVisible;
    return this.state.danmakuSettingsVisible;
  }

  setDanmakuArea(area) {
    if (!["full", "half", "quarter"].includes(area)) return this.state.danmakuArea;
    this.state.danmakuArea = area;
    localStorage.setItem("syncinema:danmaku-area", area);
    return area;
  }

  setDanmakuOpacity(opacity) {
    const value = Math.min(1, Math.max(0.2, Number(opacity) || 0.9));
    this.state.danmakuOpacity = value;
    localStorage.setItem("syncinema:danmaku-opacity", String(value));
    return value;
  }

  showDanmaku(message) {
    if (!this.state.danmakuEnabled || !this.danmakuLayer || !message || message.system) return false;
    const text = String(message.text || "").trim();
    if (!text) return false;
    const item = document.createElement("span");
    item.className = "danmaku-item";
    item.textContent = `${String(message.name || "用户").trim()}: ${text}`;
    const desktopLanes = this.state.danmakuArea === "quarter" ? 2 : this.state.danmakuArea === "half" ? 4 : 7;
    const mobileLanes = this.state.danmakuArea === "quarter" ? 1 : this.state.danmakuArea === "half" ? 2 : 4;
    const laneCount = window.innerWidth <= 680 ? mobileLanes : desktopLanes;
    const lane = this.danmakuLaneCursor++ % laneCount;
    item.style.setProperty("--danmaku-lane", String(lane));
    item.style.setProperty("--danmaku-duration", `${Math.min(13, Math.max(7, 6 + text.length * 0.08))}s`);
    item.addEventListener("animationend", () => item.remove(), { once: true });
    this.danmakuLayer.appendChild(item);
    return true;
  }

  scrollMessages() {
    nextTick(() => {
      this.messages.scrollTop = this.messages.scrollHeight;
    });
  }

  showEmpty(show) {
    this.state.emptyVisible = Boolean(show);
  }

  setNowPlaying(title = "") {
    this.state.nowPlayingTitle = String(title || "").trim();
  }

  setLivePlayback(isLive = false) {
    this.state.isLive = Boolean(isLive);
  }

  setPlaybackPaused(paused) {
    this.state.playbackPaused = Boolean(paused);
  }

  setTransfer(title, percent) {
    this.state.transferVisible = true;
    this.state.transferTitle = title;
    this.state.transferPercent = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  }

  setSyncing(show, text = "正在同步...") {
    this.state.syncing = Boolean(show);
    this.state.syncText = text;
  }
}
