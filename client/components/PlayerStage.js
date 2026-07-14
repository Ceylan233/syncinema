import { Headset, VideoCamera } from "@element-plus/icons-vue";

export const PlayerStage = {
  name: "PlayerStage",
  components: { Headset, VideoCamera },
  props: {
    state: { type: Object, required: true }
  },
  template: `
    <section :class="['stage', { 'audit-room': !state.sourceControlsVisible }]">
      <div class="video-frame" id="videoFrame">
        <div id="videoSurface" class="video-surface">
          <video
            id="video"
            playsinline
            webkit-playsinline="true"
            x5-playsinline="true"
            x5-video-player-type="h5-page"
            x5-video-player-fullscreen="true"
            x5-video-orientation="landscape"
            preload="auto"
            controlslist="nodownload noplaybackrate noremoteplayback"
            disablepictureinpicture
          ></video>
        <div
          id="danmakuLayer"
          :class="['danmaku-layer', 'area-' + state.danmakuArea]"
          :style="{ '--danmaku-opacity': state.danmakuOpacity }"
          aria-hidden="true"
        ></div>
        <div :class="['now-playing', { hidden: !state.nowPlayingTitle }]">
          <span>正在播放</span>
          <strong>{{ state.nowPlayingTitle }}</strong>
        </div>
        <div :class="['pause-center', { hidden: !state.nowPlayingTitle || !state.playbackPaused || state.emptyVisible }]">
          <span aria-hidden="true"></span>
        </div>
        <div id="seekFeedback" class="seek-feedback hidden"></div>
        <div id="syncOverlay" :class="['sync-overlay', { hidden: !state.syncing }]">
          {{ state.syncText }}
        </div>
        <div :class="['playback-activity-toast', { hidden: !state.activityToast }]">
          {{ state.activityToast }}
        </div>
        <div id="emptyState" :class="['empty-state', { hidden: !state.emptyVisible }]">
          <div v-if="state.sourceControlsVisible" class="empty-card">
            <p>选择本地视频，或从你导入的片源点播。切换后全房间会同步到新片源。</p>
            <label class="primary-button file-button" for="fileInput">选择视频</label>
            <button id="emptyOnlineSourceButton" class="secondary-button source-button" type="button">点播片源</button>
          </div>
        </div>
        </div>
        <div class="controls">
          <div class="danmaku-control-group">
          <button
            id="danmakuToggleButton"
            :class="['icon-button', 'danmaku-toggle', { active: state.danmakuEnabled }]"
            type="button"
            :title="state.danmakuEnabled ? '关闭弹幕' : '开启弹幕'"
            :aria-pressed="state.danmakuEnabled"
          >弹</button>
          <button
            id="danmakuSettingsButton"
            class="icon-button danmaku-settings-toggle"
            type="button"
            title="弹幕设置"
            aria-label="弹幕设置"
            :aria-expanded="state.danmakuSettingsVisible"
          >弹幕设置</button>
          <div
            id="danmakuSettingsMenu"
            :class="['danmaku-settings-menu', { hidden: !state.danmakuSettingsVisible }]"
          >
            <div class="danmaku-setting-row">
              <span>显示区域</span>
              <div class="danmaku-area-options" role="group" aria-label="弹幕显示区域">
                <button type="button" data-danmaku-area="full" :class="{ active: state.danmakuArea === 'full' }">全屏</button>
                <button type="button" data-danmaku-area="half" :class="{ active: state.danmakuArea === 'half' }">1/2</button>
                <button type="button" data-danmaku-area="quarter" :class="{ active: state.danmakuArea === 'quarter' }">1/4</button>
              </div>
            </div>
            <label class="danmaku-setting-row danmaku-opacity-control">
              <span>透明度</span>
              <input id="danmakuOpacity" type="range" min="20" max="100" step="5" :value="Math.round(state.danmakuOpacity * 100)" />
              <output>{{ Math.round(state.danmakuOpacity * 100) }}%</output>
            </label>
          </div>
          </div>
          <button id="playButton" class="icon-button play-toggle" title="播放/暂停">播放</button>
          <template v-if="state.sourceControlsVisible">
            <label id="chooseVideoButton" class="icon-button file-action" for="fileInput" role="button" tabindex="0" title="重新选择视频">上传</label>
            <button id="onlineSourceButton" class="icon-button source-action" type="button" title="网络点播">点播</button>
          </template>
          <div class="progress-wrap">
            <div id="seekPreview" class="seek-preview hidden">00:00</div>
            <div id="seekBufferBar" class="seek-buffer-bar" aria-hidden="true"></div>
            <input id="seekBar" type="range" min="0" max="1000" value="0" />
            <div class="time-row">
              <span id="currentTime">00:00</span>
              <span id="duration">00:00</span>
            </div>
          </div>
          <select id="rateSelect" title="播放速度">
            <option value="0.5">0.5x</option>
            <option value="0.75">0.75x</option>
            <option value="1" selected>1x</option>
            <option value="1.25">1.25x</option>
            <option value="1.5">1.5x</option>
            <option value="2">2x</option>
          </select>
          <select id="fitSelect" title="画面比例">
            <option value="contain" selected>适应</option>
            <option value="ratio-16-9">16:9</option>
            <option value="ratio-4-3">4:3</option>
            <option value="fill">拉伸铺满</option>
          </select>
          <select id="qualitySelect" title="画质" :disabled="state.quality.disabled">
            <option
              v-for="option in state.quality.options"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
          <div class="volume-control volume-popover video-volume-control" data-volume-popover>
            <button class="volume-trigger" type="button" title="视频音量" aria-label="视频音量" aria-expanded="false">
              <VideoCamera aria-hidden="true" />
            </button>
            <div class="volume-flyout" role="group" aria-label="视频音量调节">
              <input id="videoVolume" type="range" min="0" max="100" value="100" aria-label="视频音量" />
            </div>
          </div>
          <div v-if="state.voiceControlsVisible" class="volume-control volume-popover voice-volume-control" data-volume-popover>
            <button class="volume-trigger" type="button" title="语音音量" aria-label="语音音量" aria-expanded="false">
              <Headset aria-hidden="true" />
            </button>
            <div class="volume-flyout" role="group" aria-label="语音音量调节">
              <input id="voiceVolume" type="range" min="0" max="100" value="100" aria-label="语音音量" />
            </div>
          </div>
          <button id="fullscreenButton" class="icon-button fullscreen-toggle" title="全屏" aria-label="全屏">
            <span class="fullscreen-icon" aria-hidden="true"></span>
          </button>
        </div>
      </div>
      <div id="transferPanel" :class="['transfer-panel', { hidden: !state.transferVisible }]">
        <span id="transferTitle">{{ state.transferTitle }}</span>
        <progress id="transferProgress" :value="state.transferPercent" max="100"></progress>
        <span id="transferPercent">{{ state.transferPercent }}%</span>
      </div>
      <input v-if="state.sourceControlsVisible" id="fileInput" class="file-picker" type="file" accept="video/*" />
    </section>
  `
};
