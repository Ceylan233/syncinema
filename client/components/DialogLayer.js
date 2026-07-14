import { timeLabel } from "./format.js?v=20260713-chat-date-1";

export const DialogLayer = {
  name: "DialogLayer",
  props: {
    state: { type: Object, required: true }
  },
  emits: ["close-activity-history", "close-system-notifications"],
  setup() {
    return { timeLabel };
  },
  template: `
    <div>
      <div id="nameModal" :class="['modal', { hidden: !state.nameVisible }]">
        <form id="nameForm" class="name-card">
          <h1>{{ state.nameTitle }}</h1>
          <p>{{ state.nameHint }}</p>
          <input id="nameInput" maxlength="24" placeholder="例如：观众" autofocus />
          <button class="primary-button" type="submit" :disabled="state.nameBusy">
            {{ state.nameBusy ? state.nameBusyText : state.nameSubmitText }}
          </button>
        </form>
      </div>

      <div v-if="state.sourceControlsVisible" id="sourceModal" :class="['modal', 'source-modal', { hidden: !state.source.visible }]">
        <div class="source-card" role="dialog" aria-modal="true" aria-labelledby="sourceTitle">
          <div class="source-head">
            <div>
              <h2 id="sourceTitle">自定义片源点播</h2>
              <p>{{ state.source.status || '导入你自己的 Kazumi 片源规则后搜索点播，也可以直接粘贴播放地址。' }}</p>
            </div>
            <button id="sourceClose" class="icon-button" type="button" aria-label="关闭">×</button>
          </div>

          <div class="source-grid">
            <section class="source-section source-import-panel">
              <h3>片源</h3>
              <form id="sourceImportForm" class="source-import-form">
                <textarea
                  id="sourceImportInput"
                  placeholder="粘贴 kazumi://... 规则，也支持 JSON 规则"
                  rows="4"
                ></textarea>
                <button class="secondary-button" type="submit" :disabled="state.source.busy">导入片源</button>
              </form>
              <div id="sourceList" class="source-list">
                <div
                  v-for="source in state.source.sources"
                  :key="source.id"
                  :class="['source-list-item', { active: source.id === state.source.activeSourceId }]"
                >
                  <button class="source-pick" type="button" :data-source-id="source.id">
                    <span>{{ source.name }}</span>
                    <small>{{ source.baseURL }}</small>
                  </button>
                  <button class="source-delete" type="button" :data-source-delete="source.id" :aria-label="'删除片源 ' + source.name">删除</button>
                </div>
              </div>
            </section>

            <section class="source-section source-search-panel">
              <h3>搜索</h3>
              <form id="sourceSearchForm" class="source-search-form">
                <input id="sourceSearchInput" type="search" placeholder="输入番剧/影片名称" />
                <button class="primary-button" type="submit" :disabled="state.source.busy">
                  {{ state.source.busy ? '搜索中...' : '搜索' }}
                </button>
              </form>
              <div id="sourceSearchResults" class="source-results">
                <button
                  v-for="item in state.source.searchResults"
                  :key="item.url"
                  class="source-result-item"
                  type="button"
                  :data-result-url="item.url"
                  :data-result-name="item.name"
                >
                  {{ item.name }}
                  <small>{{ item.url }}</small>
                </button>
              </div>
            </section>

            <section class="source-section source-direct-panel">
              <h3>直链</h3>
              <form id="sourceDirectForm" class="source-direct-form">
                <input
                  id="sourceDirectInput"
                  type="url"
                  placeholder="粘贴 m3u8/mp4 或播放页地址"
                />
                <button class="secondary-button" type="submit" :disabled="state.source.busy">直接点播</button>
              </form>
            </section>

            <section
              v-show="state.source.chapters.length || (state.source.chapterGroups && state.source.chapterGroups.length)"
              class="source-section source-episodes-panel"
            >
              <div class="source-episodes-head">
                <h3>选集</h3>
                <span v-if="state.source.chapters.length">共 {{ state.source.chapters.length }} 集</span>
              </div>
              <div
                id="sourceRoads"
                class="source-roads"
                v-if="state.source.chapterGroups && state.source.chapterGroups.length > 1"
              >
                <button
                  v-for="group in state.source.chapterGroups"
                  :key="group.id"
                  :class="['source-road-item', { active: group.id === state.source.activeChapterGroupId }]"
                  type="button"
                  :data-source-road-id="group.id"
                >
                  {{ group.name }}
                </button>
              </div>
              <div id="sourceChapters" class="source-chapters">
                <button
                  v-for="chapter in state.source.chapters"
                  :key="chapter.url"
                  class="source-chapter-item"
                  type="button"
                  :data-chapter-url="chapter.url"
                  :data-chapter-name="chapter.name"
                >
                  {{ chapter.name }}
                </button>
              </div>
            </section>
          </div>
        </div>
      </div>

      <div id="confirmModal" :class="['modal', { hidden: !state.confirm.visible }]">
        <div class="confirm-card" role="dialog" aria-modal="true" aria-labelledby="confirmTitle">
          <h2 id="confirmTitle">{{ state.confirm.title }}</h2>
          <p id="confirmMessage">{{ state.confirm.message }}</p>
          <div class="confirm-actions">
            <button id="confirmCancel" class="secondary-button" type="button">{{ state.confirm.cancelText }}</button>
            <button id="confirmOk" class="primary-button" type="button">{{ state.confirm.okText }}</button>
          </div>
        </div>
      </div>

      <div id="sensitiveModal" :class="['modal', 'sensitive-modal', { hidden: !state.sensitive.visible }]">
        <form id="sensitiveForm" class="sensitive-card" role="dialog" aria-modal="true" aria-labelledby="sensitiveTitle">
          <header>
            <div>
              <h2 id="sensitiveTitle">违禁词管理</h2>
              <p>每个分类单独维护，所有分类共同用于聊天和昵称过滤。</p>
            </div>
            <div class="sensitive-head-actions">
              <button id="sensitiveAddCategory" class="secondary-button" type="button">添加分类</button>
              <button id="sensitiveClose" class="icon-button" type="button" aria-label="关闭违禁词管理">×</button>
            </div>
          </header>
          <div id="sensitiveCategoryList" class="sensitive-category-list">
            <section
              v-for="(category, index) in state.sensitive.categories"
              :key="category.id"
              class="sensitive-category"
              :data-category-index="index"
              :data-category-id="category.id"
            >
              <div class="sensitive-category-head">
                <input
                  class="sensitive-category-name"
                  maxlength="40"
                  :value="category.name"
                  :aria-label="'分类名称 ' + (index + 1)"
                />
                <span>{{ category.text ? category.text.split(';').filter(Boolean).length : 0 }} 词</span>
                <button class="sensitive-category-delete" type="button" :data-delete-category="index">删除</button>
              </div>
              <textarea
                class="sensitive-category-words"
                rows="6"
                maxlength="2000000"
                :value="category.text"
                :aria-label="category.name + '违禁词'"
                placeholder="词语一;词语二;词语三"
              ></textarea>
            </section>
            <p v-if="state.sensitive.categories.length === 0" class="sensitive-empty">暂无分类，请点击“添加分类”。</p>
          </div>
          <p class="sensitive-help">每个违禁词用半角分号 ; 分隔。分类名称和内容会一起保存到服务器。</p>
          <p v-if="state.sensitive.status" class="sensitive-status">{{ state.sensitive.status }}</p>
          <button class="primary-button" type="submit" :disabled="state.sensitive.busy">
            {{ state.sensitive.busy ? '正在保存...' : '保存词库' }}
          </button>
        </form>
      </div>

      <div :class="['modal', 'activity-history-modal', { hidden: !state.activityHistoryVisible }]">
        <section class="activity-history-card" role="dialog" aria-modal="true" aria-labelledby="activityHistoryTitle">
          <header>
            <div>
              <h2 id="activityHistoryTitle">操作记录</h2>
              <p>当前房间</p>
            </div>
            <button class="icon-button" type="button" aria-label="关闭操作记录" @click="$emit('close-activity-history')">×</button>
          </header>
          <div class="activity-history-list">
            <div v-if="state.playbackActivities.length === 0" class="activity-history-empty">暂无操作记录</div>
            <article v-for="activity in state.playbackActivities" :key="activity.id" class="activity-history-item">
              <time>{{ timeLabel(activity.time) }}</time>
              <span>{{ activity.text }}</span>
            </article>
          </div>
        </section>
      </div>

      <div :class="['modal', 'system-notification-modal', { hidden: !state.systemNotificationVisible }]">
        <section class="system-notification-card" role="dialog" aria-modal="true" aria-labelledby="systemNotificationTitle">
          <header>
            <div>
              <h2 id="systemNotificationTitle">系统通知</h2>
              <p>本次访问最近 100 条</p>
            </div>
            <button class="icon-button" type="button" aria-label="关闭系统通知" @click="$emit('close-system-notifications')">×</button>
          </header>
          <div class="system-notification-list">
            <div v-if="state.systemNotifications.length === 0" class="system-notification-empty">暂无系统通知</div>
            <article v-for="notice in state.systemNotifications" :key="notice.localKey" class="system-notification-item">
              <time>{{ timeLabel(notice.time) }}</time>
              <span>{{ notice.text }}</span>
            </article>
          </div>
        </section>
      </div>
    </div>
  `
};
