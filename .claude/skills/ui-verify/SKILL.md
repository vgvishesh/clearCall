---
name: ui-verify
description: Visually verify Clearcall screens at phone and desktop sizes by generating screenshots with Playwright and inspecting them for polish, layout and the dark-calm-minimal design. Use before declaring any UI work done, and when asked how a screen looks.
---
# ui-verify
1. `make screenshots` runs the `screens` Playwright project: every screen/state (Home, Lobby, Lobby-permission-denied, Call 1/2/4/7/10 participants, Call with music mode sheet, Ended, Room full, Unsupported) using `?fake=1&scenario=<name>` (FakeCallController scenarios) at iPhone 15, Pixel 7 and 1440×900 → `quality/reports/screens/<screen>-<device>.png`.
2. **Open and look at each relevant PNG** (Read tool). Check:
   - Dark, calm, minimal: one accent color, no visual noise, consistent radii/spacing from tokens.
   - Thumb reach: primary controls in the bottom third on phones; tap targets ≥ 48px; safe areas respected (no controls under the home indicator/notch).
   - Text: nothing truncated or overlapping; names ellipsize; contrast ≥ 4.5:1.
   - Grids: 1/2/3–4/5–10 layouts use space well in portrait and landscape; self-view never covers a face in 1:1.
   - States: muted/camera-off/poor-connection indicators readable at thumbnail size.
3. Light mode outside the call screen: add `colorScheme: 'light'` variant when touching Home/Lobby.
4. Fix, re-run, re-inspect. Report with screenshot paths.
