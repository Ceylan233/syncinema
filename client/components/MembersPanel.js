import { userWatchText } from "./format.js";

export const MembersPanel = {
  name: "MembersPanel",
  props: {
    state: { type: Object, required: true }
  },
  emits: ["toggle-panel", "rename-self"],
  setup() {
    return { userWatchText };
  },
  template: `
    <aside class="side-panel members-panel" :class="{ collapsed: state.membersCollapsed }">
      <button class="panel-toggle" data-toggle="members" type="button" @click="$emit('toggle-panel', 'members')">
        <span>在线成员</span>
        <small>{{ state.users.length }} 人</small>
      </button>
      <div class="panel-content" id="membersPanel">
        <div id="members" class="members">
          <div v-for="user in state.users" :key="user.id" :class="['member', { speaking: user.speaking }]">
            <div class="avatar">{{ user.initial || (user.name || 'P').slice(0, 1) }}</div>
            <button
              v-if="user.id === state.selfId"
              class="member-name self-name-button"
              type="button"
              title="点击改名"
              @click="$emit('rename-self')"
            >
              {{ user.name }}<span>（我）</span>
              <span v-if="user.sourceOwner" class="source-owner-badge">片源</span>
            </button>
            <div v-else class="member-name">
              {{ user.name }}
              <span v-if="user.sourceOwner" class="source-owner-badge">片源</span>
            </div>
            <div class="member-state">{{ userWatchText(user, state.isLive) }}</div>
          </div>
        </div>
      </div>
    </aside>
  `
};
