# Spec: Container OAuth Token Auto-Refresh

> **For Claude:** After writing this spec, discover and read the explore phase skill via cache lookup for `skills/dev-explore/SKILL.md`.

## Problem

Container sessions receive `CLAUDE_CODE_OAUTH_TOKEN` at creation time as a static env var. OAuth tokens expire (typically after a few hours). When the token expires, the Claude CLI inside the container gets 401 errors and the session is stuck. The only recovery path today is manual: extract a fresh token from the macOS keychain, kill the container, and recreate it.

This is the same problem nanoclaw (~/projects/nanoclaw) has solved — we should investigate their approach and adopt or adapt it.

## Requirements

| ID | Requirement | Scope |
|----|-------------|-------|
| TOK-01 | Credential proxy HTTP server that intercepts container API requests and injects real tokens | v1 |
| TOK-02 | Auto-refresh on 401: proxy refreshes token via Anthropic OAuth endpoint and retries request | v1 |
| TOK-03 | Read tokens from macOS keychain with cache TTL (port nanoclaw's keychain.ts) | v1 |
| TOK-04 | Proactive refresh: refresh token 5 min before expiry to prevent 401s | v1 |
| TOK-05 | On CLI auth-error exit: wait 2-3s, read fresh keychain token, relaunch with --resume | v1 |
| TOK-06 | Containers use placeholder token + proxy URL, never hold real credentials | v1 |
| TOK-07 | Persist refreshed tokens back to keychain + credentials file | v1 |

Scope: `v1` = must complete, `v2` = nice to have, `out-of-scope` = explicitly excluded.

## Success Criteria
- [ ] [TOK-01] Container sessions always start with a non-expired OAuth token
- [ ] [TOK-02] When a 401 occurs mid-session, the system automatically reads a fresh token and relaunches the CLI
- [ ] [TOK-03] Token is read from macOS keychain (`security find-generic-password -s "Claude Code-credentials"`)
- [ ] [TOK-04] Session resumes automatically with `--resume` after token refresh — no user action required (brief status message acceptable)
- [ ] [TOK-03b] If keychain read fails, a clear error is surfaced in the UI and session does not silently break
- [ ] [TOK-05] Nanoclaw's approach is documented and relevant patterns adopted

## Constraints
- Container env vars are immutable after creation — fresh tokens are passed per-invocation via `docker exec -e` flags, which only apply to that exec (not the container globally). The CLI must be relaunched to pick up new tokens.
- macOS keychain access only works on the host, not inside containers
- Token refresh must not lose conversation context (use `--resume`)
- Container sessions only — host sessions are out of scope (they use keychain directly)
- Proactive refresh (before expiry) is out of scope for v1 — we detect and recover from 401 errors reactively
- If keychain read fails (locked, biometric prompt denied), log a warning and surface the error in the UI rather than silently failing

## Testing Strategy (MANDATORY - USER APPROVED)

- **User's chosen approach:** Unit tests
- **Framework:** vitest
- **Command:** `cd web && bun run test`

### REAL Test Definition (MANDATORY)

| Field | Value |
|-------|-------|
| **User workflow to replicate** | Container session hits 401 → system detects → reads fresh token → relaunches CLI with fresh token → session resumes |
| **Code paths that must be exercised** | Token expiry detection, keychain read, `docker exec -e` with new token, CLI relaunch with `--resume` |
| **What user actually sees/verifies** | Session continues working after token expiry without manual intervention |
| **Protocol/transport** | WebSocket (CLI ↔ server), `docker exec` for token injection |

### First Failing Test

- **Test name:** `test_container_token_refresh_on_auth_error`
- **What it tests:** When CLI exits with auth error, system reads fresh token and relaunches
- **How it replicates user workflow:** Mock CLI exit with the auth error pattern (exact pattern TBD from EXP-03) → verify relaunch called with fresh token in env
- **Expected failure message:** "Expected relaunch to be called with fresh CLAUDE_CODE_OAUTH_TOKEN"
- **Depends on:** EXP-03 (must know the exact error detection pattern before writing this test)

## Exploration Findings

### EXP-01/02: Nanoclaw's Approach (ANSWERED)

Nanoclaw uses a **credential proxy** (HTTP server on port 3001) that intercepts all API requests from containers. Containers hold only a placeholder token — the proxy injects the real token on every request and auto-refreshes on 401.

Key components:
- `src/keychain.ts` — reads from macOS keychain with 5-min cache TTL
- `src/credential-proxy.ts` — HTTP proxy that intercepts requests, injects real tokens, auto-refreshes on 401
- Token refresh via `https://console.anthropic.com/v1/oauth/token` using curl (not Node.js, to avoid Cloudflare TLS fingerprinting)
- Proactive refresh: 5-min buffer before expiry
- Reactive refresh: 401 triggers immediate refresh + retry
- Persists refreshed tokens back to both `~/.claude/.credentials.json` AND keychain

**Decision: Port nanoclaw's credential proxy approach.**
1. Build a credential proxy (HTTP server) that intercepts API requests from containers
2. Containers get a placeholder token — proxy injects real token on every request
3. Auto-refresh on 401: proxy reads fresh token from keychain, refreshes via Anthropic's OAuth endpoint, retries
4. Proactive refresh: refresh 5 min before expiry
5. On CLI auth-error exit: wait 2-3s, read fresh keychain token, relaunch with `--resume`

Rationale: The proxy approach is more robust — containers never hold real tokens, refresh happens transparently without CLI restart, and it handles mid-request token expiry.

### EXP-03: CLI Auth Error Detection (ANSWERED)

When the CLI gets a 401:
- The CLI process **exits** (non-zero exit code)
- stderr contains the error message (captured by `pipeOutput()` at cli-launcher.ts:1265)
- The `session:exited` event fires on `companionBus` with `{ sessionId, exitCode }`
- Detection: listen for `session:exited` where session is containerized, check if stderr contained "authentication_error" or "OAuth token has expired"

### EXP-04: Integration Points (ANSWERED)

1. **Fresh token at creation**: `session-orchestrator.ts:263` — currently reads from `settings.claudeCodeOAuthToken` (static). Change to read from keychain instead.
2. **Fresh token at relaunch**: `cli-launcher.ts:428` — reads from `sessionEnvs` (stale). Before relaunch, refresh the env with a fresh keychain read.
3. **Auto-relaunch on auth error**: `cli-launcher.ts:636` — `companionBus.emit("session:exited")`. Add listener that detects auth failures and triggers relaunch with fresh token.

### Architecture

| File | Line | Current | Change |
|------|------|---------|--------|
| NEW | — | — | `credential-proxy.ts` — HTTP proxy for token injection (port from nanoclaw) |
| NEW | — | — | `keychain.ts` — macOS keychain reader with cache TTL (port from nanoclaw) |
| `session-orchestrator.ts` | 263 | Reads static `settings.claudeCodeOAuthToken` | Also try keychain read (fresher) |
| `container-manager.ts` | 209 | Passes `CLAUDE_CODE_OAUTH_TOKEN` directly | Pass placeholder + `ANTHROPIC_BASE_URL=http://host.docker.internal:PROXY_PORT` |
| `cli-launcher.ts` | 636 | Emits `session:exited` | Add auth-error detection + delayed auto-relaunch |
| `index.ts` | — | — | Start credential proxy alongside main server |

### Test Infrastructure

- vitest with `vi.hoisted()` mocks, `vi.mock()` for modules
- `cli-launcher.test.ts` (1343 lines) — mocks `Bun.spawn`, `execSync`, process exit
- `session-orchestrator.test.ts` (1623 lines) — tests env var injection with `expect.objectContaining()`
- Pattern: mock `execSync` for `security` command, mock process exit for auth error detection

## Open Questions (Non-Blocking)
- Should we log token refresh events for debugging? (Yes — nanoclaw does this)
- Should the UI show a brief "refreshing auth..." indicator?
