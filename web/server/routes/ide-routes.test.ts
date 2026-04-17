// ide-routes.test.ts — Hono integration tests for /api/ide/* endpoints.
//
// Task 5 (this file creation): tests for GET /api/ide/available and
// GET /api/ide/available?cwd=<path>.
//
// NOTE: Task 7 will append POST/DELETE /api/sessions/:id/ide describe blocks
// to this same file. Keep this file append-safe — do NOT use a file-level
// afterAll that assumes only the GET tests are present.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
  startIdeDiscovery,
  resetIdeDiscoveryForTests,
  listAvailableIdes,
} from "../ide-discovery.js";
import { companionBus } from "../event-bus.js";
import { registerSystemRoutes } from "./system-routes.js";

/** Build a minimally valid lockfile JSON payload (same shape as ide-discovery.test.ts). */
function lockfilePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pid: process.pid, // live pid so discovery keeps it
    ideName: "Neovim",
    workspaceFolders: ["/Users/test/project"],
    authToken: "secret-token",
    transport: "ws",
    ...overrides,
  });
}

/** Tiny idle delay so fs.watch + initial scan settles. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait until listAvailableIdes() reports at least `n` entries (bounded). */
async function waitForDiscoveredCount(n: number, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (listAvailableIdes().length >= n) return;
    await sleep(25);
  }
}

/** Build a Hono app with only system routes mounted — reuses the real registrar so
 * we exercise the production wiring (not a bypass). We pass stub deps because GET
 * /api/ide/available does not depend on launcher / wsBridge / terminalManager. */
function buildApp(): Hono {
  const app = new Hono();
  const api = new Hono();
  registerSystemRoutes(api, {
    launcher: {} as any,
    wsBridge: {} as any,
    terminalManager: {} as any,
    updateCheckStaleMs: 60_000,
  });
  app.route("/api", api);
  return app;
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/ide/available
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/ide/available", () => {
  let tmpDir: string;
  let stop: (() => void) | null = null;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ide-routes-"));
    resetIdeDiscoveryForTests();
    companionBus.clear();
  });

  afterEach(() => {
    if (stop) {
      try { stop(); } catch { /* ignore */ }
      stop = null;
    }
    resetIdeDiscoveryForTests();
    companionBus.clear();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // Validates API-01: empty discovery state returns an empty JSON array.
  it("returns empty array when no IDEs are discovered", async () => {
    stop = startIdeDiscovery({ ideDir: tmpDir });
    await sleep(50); // let initial scan (which finds nothing) complete

    const app = buildApp();
    const res = await app.request("/api/ide/available");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([]);
  });

  // Validates API-01 ordering rule: without cwd, IDEs sort by lockfileMtime desc.
  // We write two lockfiles and explicitly touch their mtimes via fs utilities so
  // the "newer" one is demonstrably newer — don't rely on write-order timing.
  it("returns discovered IDEs ordered by lockfileMtime desc", async () => {
    const olderPath = join(tmpDir, "11111.lock");
    const newerPath = join(tmpDir, "22222.lock");

    writeFileSync(olderPath, lockfilePayload({
      ideName: "OlderIde",
      workspaceFolders: ["/Users/test/older"],
    }));
    writeFileSync(newerPath, lockfilePayload({
      ideName: "NewerIde",
      workspaceFolders: ["/Users/test/newer"],
    }));

    // Force a clear mtime gap by rewriting "newer" after a small delay.
    await sleep(30);
    writeFileSync(newerPath, lockfilePayload({
      ideName: "NewerIde",
      workspaceFolders: ["/Users/test/newer"],
    }));

    stop = startIdeDiscovery({ ideDir: tmpDir });
    await waitForDiscoveredCount(2);

    const app = buildApp();
    const res = await app.request("/api/ide/available");
    expect(res.status).toBe(200);
    const json = (await res.json()) as Array<{ ideName: string; port: number; lockfileMtime: number }>;
    expect(json).toHaveLength(2);
    // Newer mtime first.
    expect(json[0]!.ideName).toBe("NewerIde");
    expect(json[1]!.ideName).toBe("OlderIde");
    // And lockfileMtime is strictly nonincreasing.
    expect(json[0]!.lockfileMtime).toBeGreaterThanOrEqual(json[1]!.lockfileMtime);
  });

  // Validates API-02: when ?cwd=<path> is passed, ranking uses matchIdesForCwd.
  // The IDE whose workspaceFolder is a prefix of cwd must be first, regardless of mtime.
  it("ranks IDEs for a given cwd via the matcher (longest-prefix wins)", async () => {
    // "matchIde" has /Users/test/project as workspace — prefix of request cwd.
    // "otherIde" is in /Users/test/unrelated — no overlap.
    const matchPath = join(tmpDir, "33333.lock");
    const otherPath = join(tmpDir, "44444.lock");

    writeFileSync(matchPath, lockfilePayload({
      ideName: "MatchingIde",
      workspaceFolders: ["/Users/test/project"],
    }));
    // Make "otherIde" the newer file so mtime-only ordering would list it first.
    // If our endpoint correctly uses the matcher, the prefix-match still wins.
    await sleep(30);
    writeFileSync(otherPath, lockfilePayload({
      ideName: "OtherIde",
      workspaceFolders: ["/Users/test/unrelated"],
    }));

    stop = startIdeDiscovery({ ideDir: tmpDir });
    await waitForDiscoveredCount(2);

    const app = buildApp();
    const cwd = "/Users/test/project/src/nested";
    const res = await app.request(`/api/ide/available?cwd=${encodeURIComponent(cwd)}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Array<{ ideName: string }>;
    expect(json).toHaveLength(2);
    // Prefix-match IDE must be first even though the other has a newer mtime.
    expect(json[0]!.ideName).toBe("MatchingIde");
    expect(json[1]!.ideName).toBe("OtherIde");
  });

  // Validates BIND-03 on the wire: authToken must NEVER appear in the JSON body.
  // We seed a lockfile with authToken set (discovery keeps it in memory) and
  // assert the serialized REST response strips it on every entry.
  it("never includes authToken in the response body (BIND-03 on the wire)", async () => {
    const lockPath = join(tmpDir, "55555.lock");
    writeFileSync(lockPath, lockfilePayload({
      ideName: "SecretIde",
      workspaceFolders: ["/Users/test/secret"],
      authToken: "should-not-leak",
    }));

    stop = startIdeDiscovery({ ideDir: tmpDir });
    await waitForDiscoveredCount(1);

    // Sanity check: discovery itself has the token in memory.
    const inMemory = listAvailableIdes();
    expect(inMemory[0]!.authToken).toBe("should-not-leak");

    const app = buildApp();
    const res = await app.request("/api/ide/available");
    expect(res.status).toBe(200);
    const rawText = await res.text();
    // Check at the string level — catches any accidental nesting.
    expect(rawText).not.toContain("should-not-leak");
    expect(rawText).not.toContain("authToken");
    const json = JSON.parse(rawText) as Array<Record<string, unknown>>;
    for (const entry of json) {
      expect(Object.prototype.hasOwnProperty.call(entry, "authToken")).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/sessions/:id/ide  (Task 7 — API-03)
// DELETE /api/sessions/:id/ide  (Task 7 — API-04)
// ═══════════════════════════════════════════════════════════════════════════
//
// These tests exercise the REST layer that delegates to wsBridge.bindIde /
// wsBridge.unbindIde. We use the REAL WsBridge (same class shipped in prod)
// and REAL ide-discovery (seeded via temp lockfiles with our own pid), so
// the path under test is exactly what runs in production minus the WS
// transport — matching the "NO FAKE TESTS" gate in PLAN.md.
//
// The session's backend adapter is a small fake that records every outgoing
// .send() call, so we can assert the critical BIND-06 contract end-to-end
// through the REST surface: a bind REST call results in exactly one
// `mcp_set_servers` message to the adapter AND zero `user_message`
// payloads containing "/ide" text (the slash command must never leak to the
// CLI — it's purely a client-side intercept).

import { WsBridge } from "../ws-bridge.js";
import { registerIdeSessionRoutes } from "./ide-session-routes.js";

/** Construct a Hono app that mounts ONLY the POST/DELETE /sessions/:id/ide
 * routes against a real WsBridge. Using the production registrar keeps this
 * test honest — if the real route wiring regresses, these tests go red. */
function buildSessionIdeApp(wsBridge: WsBridge): Hono {
  const app = new Hono();
  const api = new Hono();
  registerIdeSessionRoutes(api, { wsBridge });
  app.route("/api", api);
  return app;
}

/** Minimal IBackendAdapter stand-in that captures every outgoing .send()
 * call. Mirrors the shape used in ws-bridge.test.ts's IDE-bind describe
 * block so the production bindIde/unbindIde path treats it as a live CLI. */
function makeRecordingAdapter(): { adapter: any; sendCalls: any[] } {
  const sendCalls: any[] = [];
  const adapter = {
    isConnected: () => true,
    send: (msg: any) => {
      sendCalls.push(msg);
      return true;
    },
    disconnect: async () => {},
    onBrowserMessage: () => {},
    onSessionMeta: () => {},
    onDisconnect: () => {},
    onInitError: () => {},
  };
  return { adapter, sendCalls };
}

/** Write a lockfile to the ide dir and wait until discovery reflects it.
 * Mirrors the seedIde helper used in ws-bridge.test.ts so we probe through
 * the same path the routes take (listAvailableIdes → matcher → bindIde). */
async function seedIde(
  ideTmpDir: string,
  opts: {
    port: number;
    ideName?: string;
    workspaceFolders?: string[];
    authToken?: string;
    transport?: "ws" | "sse";
  },
  restartDiscovery: () => (() => void) | null,
): Promise<void> {
  const path = join(ideTmpDir, `${opts.port}.lock`);
  writeFileSync(
    path,
    JSON.stringify({
      pid: process.pid, // live pid → kept by discovery's liveness prune
      ideName: opts.ideName ?? "Neovim",
      workspaceFolders: opts.workspaceFolders ?? ["/Users/test/proj"],
      authToken: opts.authToken ?? "tok-xyz",
      transport: opts.transport ?? "ws",
    }),
  );
  // fs.watch on macOS can lag several hundred ms — poll up to 4s and, as a
  // safety net, force a synchronous rescan by restarting the watcher.
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (listAvailableIdes().some((i) => i.port === opts.port)) return;
    await sleep(20);
  }
  restartDiscovery();
  if (listAvailableIdes().some((i) => i.port === opts.port)) return;
  throw new Error(`seedIde: discovery did not pick up port ${opts.port}`);
}

describe("POST /api/sessions/:id/ide", () => {
  let tmpDir: string;
  let stop: (() => void) | null = null;
  let bridge: WsBridge;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ide-bind-routes-"));
    resetIdeDiscoveryForTests();
    companionBus.clear();
    // Re-create the bridge AFTER companionBus.clear so the constructor's
    // ide:removed subscription survives (BIND-04 auto-unbind wiring).
    bridge = new WsBridge();
    stop = startIdeDiscovery({ ideDir: tmpDir });
  });

  afterEach(() => {
    if (stop) {
      try { stop(); } catch { /* ignore */ }
      stop = null;
    }
    resetIdeDiscoveryForTests();
    companionBus.clear();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const restart = () => {
    if (stop) { try { stop(); } catch { /* ignore */ } }
    stop = startIdeDiscovery({ ideDir: tmpDir });
    return stop;
  };

  // API-03 happy path: valid session + port that discovery knows about →
  // wsBridge.bindIde runs, state is mutated, response carries the binding.
  it("POST with valid port binds the IDE and returns the binding", async () => {
    await seedIde(tmpDir, { port: 42424, ideName: "Neovim" }, restart);

    // Real session in the bridge, with a recording adapter so we can assert
    // on the outbound protocol payload below.
    bridge.getOrCreateSession("sess-A");
    const { adapter, sendCalls } = makeRecordingAdapter();
    bridge.attachBackendAdapter("sess-A", adapter, "claude");
    sendCalls.length = 0; // ignore any init-time sends

    const app = buildSessionIdeApp(bridge);
    const res = await app.request("/api/sessions/sess-A/ide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: 42424 }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; binding: { port: number; ideName: string } | null };
    expect(body.ok).toBe(true);
    expect(body.binding).toBeTruthy();
    expect(body.binding!.port).toBe(42424);
    expect(body.binding!.ideName).toBe("Neovim");

    // State was mutated on the session (bindIde sets ideBinding directly).
    const session = bridge.getSession("sess-A");
    expect(session!.state.ideBinding?.port).toBe(42424);
  });

  // API-03 error mapping: unknown port (not in discovery) must surface as
  // HTTP 400 with the exact error string the FE can key on for retries.
  it("POST with unknown port returns 400 with {error: 'unknown port'}", async () => {
    bridge.getOrCreateSession("sess-B");
    const { adapter } = makeRecordingAdapter();
    bridge.attachBackendAdapter("sess-B", adapter, "claude");

    const app = buildSessionIdeApp(bridge);
    const res = await app.request("/api/sessions/sess-B/ide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: 65000 }), // nothing seeded for this port
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "unknown port" });
  });

  // API-03 error mapping: session id is not known to the bridge. This is
  // distinct from "unknown port" — the plan requires 404 for this case so
  // the FE can distinguish transient vs. client-error states.
  it("POST with nonexistent session returns 404", async () => {
    await seedIde(tmpDir, { port: 42425 }, restart);

    const app = buildSessionIdeApp(bridge);
    const res = await app.request("/api/sessions/does-not-exist/ide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: 42425 }),
    });

    expect(res.status).toBe(404);
  });

  // Body validation: port must be a finite positive integer. We combine
  // missing/negative/non-integer into one test — they all take the same
  // 400 branch and we want the test list tight.
  it("POST with invalid body (missing/negative/non-integer port) returns 400", async () => {
    bridge.getOrCreateSession("sess-C");
    const app = buildSessionIdeApp(bridge);

    // Missing port field
    const r1 = await app.request("/api/sessions/sess-C/ide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(r1.status).toBe(400);

    // Negative port
    const r2 = await app.request("/api/sessions/sess-C/ide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: -1 }),
    });
    expect(r2.status).toBe(400);

    // Non-integer port (float)
    const r3 = await app.request("/api/sessions/sess-C/ide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: 42424.5 }),
    });
    expect(r3.status).toBe(400);

    // Non-number port
    const r4 = await app.request("/api/sessions/sess-C/ide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: "42424" }),
    });
    expect(r4.status).toBe(400);
  });

  // BIND-06 end-to-end through the REST layer: a successful bind must
  // translate into exactly one `mcp_set_servers` message to the adapter
  // AND zero `user_message` payloads carrying "/ide" text. If this test
  // ever fails, the slash command is leaking to the CLI (duplicating the
  // client intercept) — the entire point of routing through bindIde is
  // that the CLI never sees the "/ide" string.
  it("POST results in mcp_set_servers (NEVER a user_message containing /ide)", async () => {
    await seedIde(tmpDir, { port: 55555, ideName: "Neovim", authToken: "tok-55" }, restart);

    bridge.getOrCreateSession("sess-D");
    const { adapter, sendCalls } = makeRecordingAdapter();
    bridge.attachBackendAdapter("sess-D", adapter, "claude");
    sendCalls.length = 0;

    const app = buildSessionIdeApp(bridge);
    const res = await app.request("/api/sessions/sess-D/ide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: 55555 }),
    });
    expect(res.status).toBe(200);

    // Exactly one mcp_set_servers call; it carries the `ide` entry.
    const mcpCalls = sendCalls.filter((m) => m.type === "mcp_set_servers");
    expect(mcpCalls).toHaveLength(1);
    expect(mcpCalls[0].servers).toHaveProperty("ide");

    // Zero user_message calls containing "/ide" text. We check permissively
    // because user_message payloads vary in shape across Claude vs. Codex.
    const userMsgsWithIdeText = sendCalls.filter((m) => {
      if (m.type !== "user_message") return false;
      const blob = JSON.stringify(m);
      return blob.includes("/ide");
    });
    expect(userMsgsWithIdeText).toHaveLength(0);
  });
});

describe("DELETE /api/sessions/:id/ide", () => {
  let tmpDir: string;
  let stop: (() => void) | null = null;
  let bridge: WsBridge;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ide-unbind-routes-"));
    resetIdeDiscoveryForTests();
    companionBus.clear();
    bridge = new WsBridge();
    stop = startIdeDiscovery({ ideDir: tmpDir });
  });

  afterEach(() => {
    if (stop) {
      try { stop(); } catch { /* ignore */ }
      stop = null;
    }
    resetIdeDiscoveryForTests();
    companionBus.clear();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const restart = () => {
    if (stop) { try { stop(); } catch { /* ignore */ } }
    stop = startIdeDiscovery({ ideDir: tmpDir });
    return stop;
  };

  // Happy path: bind via POST, then DELETE — ideBinding must flip to the
  // explicit `null` sentinel (not undefined) so the FE can distinguish
  // "was bound, now disconnected" from "never bound" (BIND-05).
  it("DELETE clears the binding after a previous POST-bind", async () => {
    await seedIde(tmpDir, { port: 33333 }, restart);

    bridge.getOrCreateSession("sess-E");
    const { adapter } = makeRecordingAdapter();
    bridge.attachBackendAdapter("sess-E", adapter, "claude");

    const app = buildSessionIdeApp(bridge);
    // Bind first.
    const postRes = await app.request("/api/sessions/sess-E/ide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: 33333 }),
    });
    expect(postRes.status).toBe(200);
    expect(bridge.getSession("sess-E")!.state.ideBinding?.port).toBe(33333);

    // Then unbind.
    const delRes = await app.request("/api/sessions/sess-E/ide", {
      method: "DELETE",
    });
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({ ok: true });
    // Explicit null, not undefined — critical for BIND-05 banner trigger.
    expect(bridge.getSession("sess-E")!.state.ideBinding).toBeNull();
  });

  // Idempotency: DELETE against a session with no current binding still
  // returns 200 {ok:true}. unbindIde is deliberately idempotent so UI code
  // can "clean up" without caring about current state.
  it("DELETE is idempotent for a session with no current binding", async () => {
    bridge.getOrCreateSession("sess-F");
    const { adapter } = makeRecordingAdapter();
    bridge.attachBackendAdapter("sess-F", adapter, "claude");

    const app = buildSessionIdeApp(bridge);
    const res = await app.request("/api/sessions/sess-F/ide", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  // Nonexistent session → 404 (matches POST behavior). This diverges from
  // unbindIde's internal idempotency (which returns {ok:true} for missing
  // sessions) because the REST layer validates session existence first so
  // the FE can distinguish "wrong id" from "already cleaned up".
  it("DELETE for nonexistent session returns 404", async () => {
    const app = buildSessionIdeApp(bridge);
    const res = await app.request("/api/sessions/never-created/ide", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });
});
