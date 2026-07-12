# Syncinema 1.1

Release time: 2026-07-10 +08:00

This release is the current saved Syncinema version after the 1.0 baseline.

Included updates since 1.0:
- Vue 3 componentized UI shell with refreshed desktop and mobile layout.
- Improved mobile video stage, fullscreen controls, and player fit modes.
- Server-assisted segmented video playback with on-demand chunk requests.
- More resilient playback state sync for join, refresh, seek, pause, rate, and fit mode.
- Chat history persistence, clearer system messages, and slash-command support.
- Voice chat refinements with WebRTC receive-only mode, server relay path, RNNoise Web noise reduction, microphone send volume, and output volume.
- Configurable ICE/TURN support through `/api/ice` and environment variables.
- Cleaner voice status wording: direct voice, relay voice, listening, and waiting states.

Compatibility rule:
- Future changes should be additive by default.
- Do not remove existing behavior, controls, APIs, routes, or user-facing features unless explicitly requested.
- When replacing an implementation, preserve the old user-visible behavior unless the user says otherwise.
