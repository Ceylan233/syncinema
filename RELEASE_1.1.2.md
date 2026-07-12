# Syncinema 1.1.2

Release time: 2026-07-10 +08:00

This patch saves the current voice-stability version after the 1.1.1 transfer-speed checkpoint.

Included updates since 1.1.1:
- Server voice relay is used as a more reliable fallback instead of trusting WebRTC connection state alone.
- Voice packets are sent through normal Socket.IO delivery instead of volatile delivery.
- Mobile receivers keep relay playback available even when a WebRTC audio track appears connected.
- Relay playback handles sender reconnects and voice sequence restarts more gracefully.
- Mobile and quiet microphone pickup is more sensitive.
- Relay microphone auto-gain is stronger for quiet speech.
- RNNoise is preloaded in the background.
- Toggling noise reduction rebuilds only the microphone processing graph instead of restarting the microphone device, reducing video/audio stutter.

Compatibility rule:
- This version is saved as a stable checkpoint.
- Future changes should be additive by default.
- Do not remove existing behavior, controls, APIs, routes, or user-facing features unless explicitly requested.
