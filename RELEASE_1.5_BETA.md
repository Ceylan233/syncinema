# Syncinema 1.5 Beta 1 - 2026-07-12

This experiment is isolated from the v1.4 production service.

- Weak-network clients build a recovery buffer before timeline catch-up.
- Background synchronization avoids repeated seeks into unbuffered ranges.
- HLS automatic quality starts conservatively on slow connections.
- Standards, vendor-prefixed, native iOS, and CSS fallback fullscreen paths are supported.
- Quark and similar independent mobile players report native play, pause, and seek actions to the authoritative room timeline.

Production v1.4 remains on port 3100. This beta runs separately on port 3300.

## Beta 2

- Playback permission is primed by the explicit cinema-entry gesture.
- Weak-network buffering no longer delays the actual play command.
- Mobile pause feedback is centered on the video surface.
- Mobile native and fallback fullscreen modes use a compact player overlay.
- Browsers that reject audible remote autoplay fall back to muted visual playback instead of remaining paused.
- Fallback fullscreen is mounted at the document root so transformed page containers cannot clip it.
- Desktop fullscreen keeps the complete control set; compact controls are limited to mobile layouts.
- Fallback fullscreen controls are pinned to the bottom above mobile safe areas.
- VOD HLS segments use a bounded shared LRU cache with in-flight request coalescing.
- VOD HLS starts on the shared relay, buffers up to 90-150 seconds, and prioritizes the released seek target.
- Weak-network status now follows observed rebuffering instead of browser connection hints.

## Beta 9 rollback

- Restored direct-first VOD playback so one slow upstream request cannot stall the whole room.
- Removed forced HLS reloads on seek and restored the proven client buffer limits.
- Shared server caching remains available only after an individual client switches to relay.

## Beta 10

- A fully cached local video remains available after the original uploader disconnects.
- Server-backed local playback no longer reports the source offline when every chunk is cached.

## Beta 13

- Restored the proven v1.4 playback and synchronization behavior while retaining 1.5 features.
- Mobile fullscreen now keeps the complete player control set in portrait and landscape layouts.
- Server speed testing uses bounded download sampling and adaptive upload sizing, so slow links finish instead of waiting on fixed large files.
