# Change Policy

Syncinema 1.0 is the baseline release.

From this point forward, changes should be additive by default:
- Add new features without removing existing ones.
- Keep existing UI controls and workflows unless the user explicitly asks to remove or redesign them.
- Preserve existing API routes and socket events unless the user explicitly approves a breaking change.
- Prefer compatibility shims over deletion when behavior changes.
- Only delete, downgrade, or remove behavior when the user clearly says to do so.
