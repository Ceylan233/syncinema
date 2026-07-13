export function timeLabel(time) {
  const date = new Date(time);
  if (!Number.isFinite(date.getTime())) return "---- -- -- --:--:--";
  const part = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ` +
    `${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`;
}

export function formatWatchTime(value) {
  if (!Number.isFinite(value)) return "00:00";
  const total = Math.max(0, Math.floor(value));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function userWatchText(user, isLive = false) {
  const watch = user.watchState;
  const fresh = watch && Date.now() - watch.updatedAt < 8000;
  if (!fresh) return user.speaking ? "说话中" : "在线";
  const stateText = watch.paused ? "暂停" : watch.waiting ? "缓冲" : "播放";
  const timeText = isLive ? "" : ` ${formatWatchTime(watch.currentTime)}`;
  return `${stateText}${timeText} · 缓冲${Math.floor(watch.bufferedAhead || 0)}s`;
}
