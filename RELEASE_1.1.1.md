# Syncinema 1.1.1

Release time: 2026-07-10 +08:00

This patch saves the current optimized version after the HTTPS/TURN deployment and transfer-speed tuning.

Included updates since 1.1:
- Faster server-assisted segmented video loading.
- Higher upload concurrency for requested chunks.
- Larger playback-window preload around the current timestamp.
- Larger HTTP range stream window so browsers can read ahead more smoothly.
- Larger server relay cache to reduce repeated waiting for recently buffered chunks.
- Range playback now asks the server to warm upcoming chunks instead of waiting for each segment on demand.

Compatibility rule:
- This version is saved as a stable checkpoint.
- Future changes should be additive by default.
- Do not remove existing behavior, controls, APIs, routes, or user-facing features unless explicitly requested.
