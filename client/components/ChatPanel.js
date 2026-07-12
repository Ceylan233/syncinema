import { timeLabel } from "./format.js?v=20260711-chat-seconds-1";

export const ChatPanel = {
  name: "ChatPanel",
  props: {
    state: { type: Object, required: true }
  },
  emits: ["toggle-panel", "toggle-activity-history", "select-command"],
  setup() {
    return { timeLabel };
  },
  template: `
    <aside class="side-panel chat-panel" :class="{ collapsed: state.chatCollapsed }">
      <button class="panel-toggle" data-toggle="chat" type="button" @click="$emit('toggle-panel', 'chat')">
        <span>房间聊天</span>
      </button>
      <div class="chat-tools">
        <button class="activity-history-button" type="button" title="查看操作记录" @click="$emit('toggle-activity-history')">
          操作记录
          <span>{{ state.playbackActivities.length }}</span>
        </button>
      </div>
      <div class="panel-content" id="chatPanel">
        <div id="messages" class="messages">
          <div v-if="state.messages.length === 0" class="chat-empty">还没有消息</div>
          <template v-for="(message, index) in state.messages" :key="message.localKey">
            <div :class="['message', { 'system-message': message.system }]">
              <div class="message-meta">{{ message.system ? '系统' : message.name }} · {{ timeLabel(message.time) }}</div>
              <div class="message-text">{{ message.text }}</div>
            </div>
            <div v-if="index === state.historyMessageCount - 1" class="history-divider">—— 历史消息 ——</div>
          </template>
        </div>
        <div v-if="state.commandMenuVisible" class="command-suggestions" role="listbox" aria-label="命令建议">
          <button
            v-for="(command, index) in state.commandSuggestions"
            :key="command.value"
            :class="['command-suggestion', { active: index === state.commandActiveIndex }]"
            type="button"
            role="option"
            :aria-selected="index === state.commandActiveIndex"
            @mousedown.prevent="$emit('select-command', command.value)"
          >
            <code>{{ command.value }}</code>
            <span>{{ command.label }}</span>
          </button>
        </div>
        <form id="chatForm" class="chat-form">
          <input id="chatInput" autocomplete="off" maxlength="1000" placeholder="发送消息..." />
          <button class="primary-button" type="submit">发送</button>
        </form>
      </div>
    </aside>
  `
};
