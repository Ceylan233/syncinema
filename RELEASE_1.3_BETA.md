# Syncinema 1.3 Beta

This beta isolates the next-generation synchronization engine from the v1.2 production service.

- Calibrated server clock with RTT-aware command lead time.
- Server-authoritative future execution timestamps.
- Per-source startup buffer barrier with timeout release.
- Three-level drift correction: ignore, rate correction, and buffered hard seek.
- Per-client synchronization telemetry in watch state.
- Source owners use the same authoritative autoplay recovery as viewers, while local recovery events stay suppressed from room state.
- Explicit seeks synchronize immediately while paused, including targets that were not buffered before the command.
- Non-demo rooms reset only their active video and playback state after 30 minutes without users; chat and playback history are retained.
- Server-authoritative periodic correction ignores drift below 0.35s, smooths 0.35-1.5s, and hard-seeks larger or paused-state drift.
- Entering the cinema permanently unlocks video audio for pause/resume, seeking, and short buffering recovery paths.
- A newly joined viewer applies the server timeline before playback instead of starting temporarily from zero.
- Slider drags and repeated keyboard seeks are coalesced so only the final target becomes an authoritative room command.
- Bilibili VOD reuses resolved CDN URLs, permits browser Range caching, disables proxy transformation, and preloads media proactively.
- Generic Kazumi MP4/HLS proxy responses now support browser caching, unbuffered streaming, and a larger VOD prefetch window.
- Kazumi HLS VOD now follows the proven live strategy: clients fetch CDN segments directly and automatically fall back to the server relay after repeated stalls or network failures.
- Bilibili VOD retains backup CDN URLs, measures them sequentially to avoid bandwidth competition, and switches to the fastest server-relayed line before playback.
- Remote source pages use a bounded request timeout and a short shared cache so search/detail parsing cannot hang indefinitely or refetch the same page for every client.
- A viewer's play/pause click now changes the local media element inside the original user gesture before broadcasting the room command, preventing server round trips from losing autoplay permission and producing frame-by-frame timeline jumps.
- Routine soft drift correction and background hard recovery are silent; the in-player synchronization notice is reserved for initial room alignment and explicit seek/skip/replay commands.
- HLS VOD buffering is capped at a practical 60-180 seconds and 24 MB with worker demuxing enabled, preventing aggressive low-bitrate prefetch from blocking the main thread and starving audio output.
- Follow-up real-output recordings cap HLS VOD more conservatively at 60-90 seconds and 12 MB, eliminating startup audio starvation while preserving a full minute or more of network tolerance.
- Playback catch-up snapshots discard stale seek/skip command metadata, preventing the waiting/canplay recovery loop from treating one old seek as dozens of new exact seeks and repeatedly starving audio.
- Local-source controls now pause or resume the media element immediately, while pause commands also freeze the server-authoritative timeline during the startup buffer barrier.
- The now-playing title follows the player control visibility cycle, so it fades away with the menu instead of covering video content continuously.
- Player controls now respond to the stage width rather than only the viewport, keeping the complete seek track and both timestamps visible when the chat column narrows the video.
- Playback history is anchored in the chat header and no longer consumes a separate row above chat messages.

Production v1.2 remains on port 3100. This beta is deployed separately on port 3300.
