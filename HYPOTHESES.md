# Debug Hypotheses

## Bug: Android TopBar — "Session" tab hidden/missing, can't scroll left
Started: 2025-03-16

### Symptom
On Android, the TopBar tab row shows "Diffs" as the first visible tab, but "Session" should be to its left. User cannot scroll further left. The left pane toggle button may be overlapping/covering the Session tab.

### Screenshot Evidence
- Left pane toggle icon visible at far left
- "Diffs (9)" is the first visible tab text
- "Shell", "Processes", "Edito[r]" follow
- Shield icon, theme toggle, right pane toggle at right end

## Iteration Log

### H1: `justify-center` on overflow-x-auto tab container clips left content
**Date:** 2026-03-16
**Component:** `TopBar.tsx` line 154
**Hypothesis:** The tab container div uses `justify-center` combined with `overflow-x-auto` and hidden scrollbar. This is a known CSS issue: when flex content overflows a centered container, overflow happens symmetrically but scroll only works in the positive (right) direction. The Session tab (first child) gets pushed to a negative scroll offset that is unreachable. On desktop the tabs fit, so it's not visible. On narrow Android screens, the tabs overflow and the first tab becomes inaccessible.
**Test:** Change `justify-center` to `justify-start` on the tab container. This ensures scroll starts at position 0 (Session tab visible) and overflow extends rightward (scrollable).
**Status:** CONFIRMED
**Fix:** Changed `justify-center` to `justify-start` on line 154 of `TopBar.tsx`. All 15 existing tests pass including accessibility.
**Evidence:** CSS spec behavior — `justify-content: center` with overflow causes symmetric overflow, but scroll origin is at left edge, so left-side overflow is unreachable. On Android (narrow viewport), all 6 tabs exceed container width, centering pushes Session tab to negative scroll territory.
