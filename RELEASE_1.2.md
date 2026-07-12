# Syncinema 1.2 - 2026-07-12

This release promotes the port 3300 experimental build to the official Syncinema release.

## Included

- Independent rooms with synchronized video, users, chat, activity history, danmaku, and voice.
- Local-file sharing, custom sources, on-demand playback, Bilibili video parsing, and Bilibili live playback.
- FLV/MSE Bilibili live playback with continuous server relay, audio timestamp correction, health monitoring, and automatic reconnect.
- Authoritative play, pause, seek, source-switch, playback-rate, and fit-mode synchronization.
- Persistent room chat, playback activity, categorized sensitive-word management, and command suggestions.
- Locked review room 1 with the demo video and review-only controls.
- Responsive desktop and mobile player controls.

## Verification

- Full `npm test` suite passed.
- Production client bundle built successfully.
- Bilibili room 1746 played continuously for 150 seconds with `readyState=4` and no client errors.
- Review room 1 hides its room number and `/room` suggestion; normal rooms retain both.

## Deployment

- Official service port: `3100`.
- Package version: `1.2.0`.
