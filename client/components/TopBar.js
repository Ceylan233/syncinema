export const TopBar = {
  name: "TopBar",
  props: {
    state: { type: Object, required: true }
  },
  template: `
    <header class="topbar">
      <div class="topbar-main">
        <div class="brand">
          <div>
            <strong>Syncinema</strong>
            <span>同映</span>
          </div>
        </div>

        <div class="room-summary" aria-label="房间状态">
          <span id="connectionBadge" :class="['status-badge', 'status-' + state.connectionTone]">
            {{ state.connectionText }}
          </span>
          <span v-if="state.roomId !== '1'" id="roomBadge" class="status-badge room-badge" :title="'当前房间：' + state.roomId">
            房间 {{ state.roomId }}
          </span>
          <a
            id="speedTestButton"
            class="status-badge speed-test-link"
            href="/speed-test.html"
            target="_blank"
            rel="noopener"
            title="打开测速页"
          >
            测速
          </a>
          <span id="memberCount" class="status-badge member-count">{{ state.users.length }} 人在线</span>
        </div>
      </div>

      <div v-if="state.voiceControlsVisible" class="status-line">
        <span id="voiceBadge" :class="['status-badge', 'voice-pill', state.voiceTone ? 'status-' + state.voiceTone : '']">
          {{ state.voiceText }}
        </span>
        <div class="voice-control-cluster">
          <button
            id="micToggleButton"
            :class="['status-badge', 'mic-toggle', { 'is-off': !state.micEnabled }]"
            :disabled="state.micBusy"
            type="button"
          >
            {{ state.micText || (state.micEnabled ? '麦克风开' : '麦克风关') }}
          </button>
          <button
            id="noiseToggleButton"
            :class="['status-badge', 'noise-toggle', { 'is-off': !state.noiseEnabled }]"
            :disabled="state.noiseBusy"
            type="button"
          >
            {{ state.noiseEnabled ? '降噪开' : '降噪关' }}
          </button>
          <label class="top-volume-control" title="麦克风发送音量">
            <span>输入</span>
            <input id="micVolume" type="range" min="25" max="200" value="100" />
          </label>
        </div>
      </div>
    </header>
  `
};
