# Syncinema 1.0

Release time: 2026-07-10 00:29:48 +08:00

This release is the current stable baseline for Syncinema.

Included baseline features:
- Single-room watch-together cinema.
- Local video sharing with server-assisted segmented relay.
- Playback sync for play, pause, seek, rate, and fit mode.
- Room chat with persisted history and slash commands.
- Voice chat with microphone toggle, voice volume, microphone send volume, and noise-reduction toggle.
- Desktop and mobile responsive player layout.
- Source owner badge in the member list.

Compatibility rule:
- Future changes should be additive by default.
- Do not remove existing behavior, controls, APIs, routes, or user-facing features unless explicitly requested.
- When replacing an implementation, preserve the old user-visible behavior unless the user says otherwise.
