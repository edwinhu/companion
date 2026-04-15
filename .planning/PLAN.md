# Plan: Container OAuth Token Auto-Refresh via Credential Proxy

## Approach

Port nanoclaw's credential proxy pattern to the companion. Containers never hold real OAuth tokens — a host-side HTTP proxy intercepts API requests and injects fresh credentials transparently.

```
Container (Claude CLI)                    Host
┌──────────────────────┐    ┌──────────────────────────────────┐
│ ANTHROPIC_BASE_URL=  │    │                                  │
│  http://host:PORT    │───→│  Credential Proxy (:3458)        │
│                      │    │  ├─ Intercepts API requests       │
│ CLAUDE_CODE_OAUTH_   │    │  ├─ Injects real Bearer token     │
│  TOKEN=placeholder   │    │  ├─ Auto-refreshes on 401         │
│                      │    │  ├─ Proactive refresh (5min buf)  │
│                      │    │  └─ Forwards to api.anthropic.com │
└──────────────────────┘    └──────────────────────────────────┘
                                       │
                                       ▼
                            ┌──────────────────┐
                            │  macOS Keychain   │
                            │  (source of truth)│
                            └──────────────────┘
```

## Tasks

### Task 0: Port keychain.ts from nanoclaw
- **File:** `web/server/keychain.ts` (NEW)
- **What:** Port `~/projects/nanoclaw/src/keychain.ts` — macOS keychain reader with 5-min cache TTL
- **Functions:** `readKeychainOAuthToken()`, `readKeychainOAuthCredentials()`, `_resetKeychainCacheForTests()`
- **Test:** `web/server/keychain.test.ts` — mock `execFileSync('security', ...)`, verify cache behavior
- **Spec refs:** TOK-03

### Task 1: Port credential-proxy.ts from nanoclaw
- **File:** `web/server/credential-proxy.ts` (NEW)
- **What:** Port `~/projects/nanoclaw/src/credential-proxy.ts` — HTTP proxy that intercepts container API requests
- **Key behaviors:**
  - OAuth mode: replace placeholder Bearer token with real one from keychain
  - Auto-refresh on 401: invalidate cache, refresh via `https://console.anthropic.com/v1/oauth/token`, retry
  - Proactive refresh: 5-min buffer before expiry
  - Persist refreshed tokens to `~/.claude/.credentials.json` + keychain
  - Use curl for refresh (avoids Cloudflare TLS fingerprint blocks)
- **Adapt:** Use companion's logger instead of nanoclaw's pino logger. Use companion's port allocation.
- **Test:** `web/server/credential-proxy.test.ts` — mock keychain reads, upstream responses, verify 401 retry, verify proactive refresh
- **Spec refs:** TOK-01, TOK-02, TOK-04, TOK-07

### Task 2: Start proxy alongside main server
- **File:** `web/server/index.ts` (EDIT)
- **What:** Start credential proxy on a configurable port (default 3458, env `COMPANION_CREDENTIAL_PROXY_PORT`) when server boots
- **Lifecycle:** Start after main server, stop on server shutdown
- **Test:** Verify proxy starts in integration test
- **Spec refs:** TOK-01

### Task 3: Wire container sessions to use proxy
- **File:** `web/server/session-orchestrator.ts` (EDIT, ~line 263)
- **File:** `web/server/container-manager.ts` (EDIT, env injection)
- **What:**
  - For container sessions: set `ANTHROPIC_BASE_URL=http://host.docker.internal:3458` and `CLAUDE_CODE_OAUTH_TOKEN=placeholder`
  - Keep host sessions unchanged (they use keychain directly)
  - Remove static `claudeCodeOAuthToken` injection for container sessions
- **Test:** Update `session-orchestrator.test.ts` — verify container sessions get proxy URL + placeholder, host sessions unchanged
- **Spec refs:** TOK-06

### Task 4: Auto-relaunch on auth error
- **File:** `web/server/cli-launcher.ts` (EDIT, ~line 636)
- **What:**
  - In the `session:exited` handler, detect auth errors (check stderr for "authentication_error" or "OAuth token has expired")
  - For container sessions: wait 2-3s, then relaunch with `--resume`
  - Max 2 auto-relaunch attempts per session to prevent infinite loops
  - Log the auth error and relaunch attempt
- **Test:** `cli-launcher.test.ts` — mock process exit with auth error stderr, verify delayed relaunch called
- **Spec refs:** TOK-05

### Task 5: Fresh token at creation time
- **File:** `web/server/session-orchestrator.ts` (EDIT, ~line 263)
- **What:** Before creating a container session, read fresh token from keychain (not just settings). If keychain read succeeds, use that. If it fails, fall back to `settings.claudeCodeOAuthToken`. Log which source was used.
- **Note:** This is a belt-and-suspenders approach — the proxy handles most cases, but starting with a fresh token avoids the very first request failing.
- **Test:** Mock keychain read, verify fresh token preferred over stale settings token
- **Spec refs:** TOK-03

## Task Dependencies

```
Task 0 (keychain.ts)
  ↓
Task 1 (credential-proxy.ts) ← depends on keychain.ts
  ↓
Task 2 (start proxy) ← depends on credential-proxy.ts
  ↓
Task 3 (wire container sessions) ← depends on proxy running
  ↓
Task 4 (auto-relaunch) ← independent, but test after proxy wired
  ↓
Task 5 (fresh token at creation) ← independent, can parallel with Task 4
```

## Success Verification

After all tasks:
1. `cd web && bun run test` — all tests pass
2. `cd web && bun run typecheck` — no type errors
3. Manual verification: create container session, verify proxy intercepts requests, verify token refresh works
