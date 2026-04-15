---
workflow: dev
phase: implement
phase_name: implement
task: 0
total_tasks: 6
status: ready_to_start
last_updated: 2026-03-27T13:30:00Z
---

# Session Handoff: Container OAuth Token Auto-Refresh

## Context

The companion's container sessions receive static OAuth tokens at creation time. When tokens expire, sessions break with 401 errors. We're porting nanoclaw's credential proxy pattern: a host-side HTTP proxy intercepts API requests from containers and injects fresh tokens transparently.

## What's Done

- Phase 1 (brainstorm): Requirements gathered, SPEC.md written
- Phase 2 (explore): Nanoclaw's approach studied in detail, companion's token flow mapped
- Phase 3 (clarify): User chose proxy approach over simple keychain-read
- Phase 4 (design): PLAN.md written and approved by user

## Key Files to Read

- `.planning/SPEC.md` — full spec with exploration findings
- `.planning/PLAN.md` — approved implementation plan (6 tasks)
- `~/projects/nanoclaw/src/keychain.ts` — reference implementation for keychain reader
- `~/projects/nanoclaw/src/credential-proxy.ts` — reference implementation for credential proxy
- `web/server/cli-launcher.ts:560-640` — current container spawn + exit handling
- `web/server/session-orchestrator.ts:243-268` — current token injection
- `web/server/container-manager.ts:278-292` — current seedAuthFiles

## Next Action

Start Phase 5 (implement) with Task 0: port `keychain.ts` from nanoclaw.

## Important Design Decisions

1. **Proxy, not simple keychain read** — user explicitly chose the proxy approach
2. **2-3s delay before auth-error relaunch** — user chose delayed relaunch
3. **Port from nanoclaw, don't rewrite** — adapt nanoclaw's proven code
4. **Use curl for OAuth refresh** — avoids Cloudflare TLS fingerprint blocks on Node.js
5. **Proxy port 3458** — configurable via `COMPANION_CREDENTIAL_PROXY_PORT`
