# Syncinema 1.4 - 2026-07-12

This release promotes the completed 1.3 synchronization experiment to the official Syncinema service.

## Included

- Server-authoritative playback state with clock calibration, coordinated execution times, startup buffering, and bounded drift correction.
- Reliable play, pause, replay, seek, source switching, playback rate, fit mode, and room state synchronization.
- Local-file sharing, custom Kazumi sources, Bilibili video parsing, multi-part playback, and Bilibili live playback.
- Direct CDN playback with measured line selection and automatic relay fallback for unstable networks.
- Persistent room chat, danmaku settings, playback activity history, categorized sensitive-word management, and command suggestions.
- Member joins and disconnects update the online list silently without adding named system messages to room chat.
- Responsive desktop and mobile controls, complete buffered progress display, synchronized title visibility, and compact activity-history access.
- WebRTC voice with server relay fallback and RNNoise processing.
- Locked review room 1 and independent normal rooms.

## Verification

- Full `npm test` suite passed.
- Production client bundle built successfully.
- Playback synchronization, audio continuity, pause authority, and responsive layouts were verified on the deployed service.

## Deployment

- Official service port: `3100`.
- Package version: `1.4.0`.
- Release cache tag: `20260712-v14-release-1`.
