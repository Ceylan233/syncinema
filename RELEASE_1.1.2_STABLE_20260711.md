# Syncinema 1.1.2 Stable Snapshot - 2026-07-11

This snapshot freezes the production version before the SyncTV-inspired experimental work.

## Verified behavior

- Desktop guest to mobile guest: play, pause, and seek synchronize.
- Mobile guest to desktop guest: play, pause, and seek synchronize.
- Desktop source owner to mobile guest: source switch, play, pause, and seek synchronize.
- Mobile source owner to desktop guest: source switch, play, pause, and seek synchronize.
- Rapid play/pause actions use unique action IDs and reach the authoritative room state.
- Mobile 4:3 rendering was measured at 294.66 x 221 inside a fixed 393 x 221 player surface.
- The production PM2 process was online after deployment.

## Automated checks

- `node scripts/test-playback-sync.js`
- `node --experimental-default-type=module scripts/test-sync-controller.mjs`
- Syntax checks for the edited client and server modules.

## Isolation policy

Experimental work must use a separate local directory, server directory, PM2 process, and port. It must not replace or restart the production `syncinema` process unless explicitly approved.
