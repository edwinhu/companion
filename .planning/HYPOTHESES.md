# Debug Hypotheses

## Bug: Stale sessions persist in GUI sidebar after being cleared server-side
Started: 2026-03-26

### Symptom
User reports that stale (non-existent) sessions remain visible in the sidebar even though the Sidebar component has a 5-second polling interval (`setInterval(poll, 5000)`). A hard browser refresh was required to clear them.

### Initial Observations (from conversation)
- Sidebar.tsx line 181: `setInterval(poll, 5000)` polls `api.listSessions()`
- Sidebar.tsx line 158: poll calls `setSdkSessions(list)` which replaces the `sdkSessions` array
- Sidebar.tsx lines 420-422: `allSessionIds` is the UNION of `sessions.keys()` (client Map) and `sdkSessions` (server list)
- `sessions` Map entries are only removed by explicit `removeSession(id)` calls
- **Possible root cause:** Even when `sdkSessions` is updated and a stale session disappears from the server list, the `sessions` Map retains the entry, keeping the ghost visible in the sidebar

## Iteration Log

### H1: Poll updates `sdkSessions` but never removes stale entries from the `sessions` Map

**Hypothesis:** The poll calls `setSdkSessions(list)` which replaces `sdkSessions` with the server's current list, but the client-side `sessions` Map is never pruned. The sidebar renders `allSessionIds = UNION(sessions.keys(), sdkSessions)`, so a session that was removed server-side disappears from `sdkSessions` but remains in `sessions`, keeping the ghost entry visible.

**Test:** Compare HEAD `Sidebar.tsx` poll code with the working-tree version.

**Result:** CONFIRMED

**Evidence:**
- HEAD poll code (committed) only calls `setSdkSessions(list)` and `connectAllSessions(list)`. It does NOT call `removeSession` for sessions absent from the server list.
- Working tree already has a fix that iterates `store.sessions.keys()` and calls `removeSession(id)` for any ID not in the server response.
- The sidebar renders from `allSessionIds = UNION(sessions.keys(), sdkSessions)`. After `setSdkSessions([])`, `sdkSessions` is empty, but `sessions` still contains the stale entry. So `allSessionIds` still contains the stale session ID, and it renders in the sidebar.

**Root cause confirmed:** The `sessions` Map is populated by WebSocket `session_init` messages and never cleaned up by the poll. The poll only updates `sdkSessions` — not `sessions`.

**Fix:** Already applied in working tree: after `setSdkSessions(list)`, iterate `store.sessions.keys()` and call `removeSession(id)` for any ID not in the server list.

### H2: Pruning loop evicts sessions that arrived via session_init mid-flight (race condition)

**Hypothesis:** `listSessions()` is async. A `session_init` WebSocket message arriving between dispatch and response processing adds a session to `store.sessions`. That session is absent from the `list` snapshot, so the pruning loop (introduced in H1's fix) incorrectly calls `removeSession` on a live, connected session.

**Test:** Added regression test "poll does not remove sessions that arrived via session_init after listSessions was dispatched" — simulates a session with `connectionStatus: "connected"` that is absent from the server snapshot. Confirmed it FAILED before the fix.

**Result:** CONFIRMED

**Evidence:** The test failed with the H1 fix in place (current code). The pruning loop had no guard on `connectionStatus`, so any session absent from the server list was evicted regardless of live WebSocket state.

**Fix (PR #621):**
- Re-read store state with `useStore.getState()` AFTER `setSdkSessions` to get the freshest snapshot
- Guard removal with `connectionStatus.get(id) !== "connected"` — a session that just received `session_init` will be connected and must survive
- Added `connectionStatus` field to `MockStoreState` in test file
- Two new regression tests covering the race condition and the expected prune-on-disconnect behavior
- All 99 Sidebar tests pass
