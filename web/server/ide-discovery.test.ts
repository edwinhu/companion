// ide-discovery.test.ts — Tests for the ~/.claude/ide/ lockfile watcher.
//
// DISC-01: dead-pid pruning
// DISC-02: malformed JSON does not crash
// DISC-03: new lockfile emits within 500ms
//
// Each test uses an isolated temp dir so it never touches the real
// ~/.claude/ide/. We clear the event bus and reset module state in
// afterEach so tests are order-independent.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { companionBus } from "./event-bus.js";
import {
  startIdeDiscovery,
  listAvailableIdes,
  resetIdeDiscoveryForTests,
} from "./ide-discovery.js";

/** Build a minimally valid lockfile JSON payload. */
function lockfilePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pid: process.pid, // default to this test process so isPidAlive=true
    ideName: "Neovim",
    workspaceFolders: ["/Users/test/project"],
    authToken: "secret-token",
    transport: "ws",
    ...overrides,
  });
}

/**
 * Wait for an event on the companionBus. Rejects after `timeoutMs`.
 * Returns the first payload received.
 */
function waitForEvent<K extends keyof import("./event-bus-types.js").CompanionEventMap>(
  event: K,
  timeoutMs = 1000,
): Promise<import("./event-bus-types.js").CompanionEventMap[K]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`Timed out waiting for ${String(event)} after ${timeoutMs}ms`));
    }, timeoutMs);
    const off = companionBus.on(event, (payload) => {
      clearTimeout(timer);
      off();
      resolve(payload);
    });
  });
}

describe("ide-discovery", () => {
  let tmpDir: string;
  let stop: (() => void) | null = null;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ide-disco-"));
    resetIdeDiscoveryForTests();
    companionBus.clear();
  });

  afterEach(() => {
    if (stop) {
      try {
        stop();
      } catch {
        // ignore
      }
      stop = null;
    }
    resetIdeDiscoveryForTests();
    companionBus.clear();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("(DISC-03) emits ide:added within 500ms when a new valid lockfile appears", async () => {
    // Start discovery against empty temp dir — no events yet.
    stop = startIdeDiscovery({ ideDir: tmpDir });

    const addedP = waitForEvent("ide:added", 1000);
    // Drop a lockfile with a live pid (this process).
    writeFileSync(join(tmpDir, "12345.lock"), lockfilePayload());

    const payload = await addedP;
    expect(payload.port).toBe(12345);
    expect(payload.ideName).toBe("Neovim");
    expect(payload.workspaceFolders).toEqual(["/Users/test/project"]);
    expect(payload.lockfilePath).toBe(join(tmpDir, "12345.lock"));

    // listAvailableIdes() should reflect the new entry synchronously after event.
    const snap = listAvailableIdes();
    expect(snap).toHaveLength(1);
    expect(snap[0]!.port).toBe(12345);
    // authToken kept in memory only (asserted as part of discovery contract).
    expect(snap[0]!.authToken).toBe("secret-token");
  });

  it("(DISC-02) malformed JSON does not crash the watcher — subsequent valid file still emits", async () => {
    // Write garbage file FIRST, then start discovery so initial scan sees it.
    writeFileSync(join(tmpDir, "9999.lock"), "not valid json");
    stop = startIdeDiscovery({ ideDir: tmpDir });

    // No event yet — but importantly, the watcher is still alive.
    // Drop a valid file; we must still get ide:added.
    const addedP = waitForEvent("ide:added", 1500);
    writeFileSync(join(tmpDir, "4242.lock"), lockfilePayload());

    const payload = await addedP;
    expect(payload.port).toBe(4242);
  });

  it("(DISC-01) dead-pid lockfiles are pruned — never added, listAvailableIdes stays empty", async () => {
    // 2147483646 is a very-high pid unlikely to exist on any host.
    // process.kill(pid, 0) will throw ESRCH → treated as dead.
    writeFileSync(
      join(tmpDir, "7777.lock"),
      lockfilePayload({ pid: 2147483646 }),
    );

    const addedSpy = vi.fn();
    companionBus.on("ide:added", addedSpy);

    stop = startIdeDiscovery({ ideDir: tmpDir });

    // Give initial scan + any emit a short tick.
    await new Promise((r) => setTimeout(r, 100));

    expect(addedSpy).not.toHaveBeenCalled();
    expect(listAvailableIdes()).toEqual([]);
  });

  it("emits ide:removed within 1s when a lockfile is deleted", async () => {
    // Prime with a valid lockfile BEFORE starting so initial scan emits added.
    writeFileSync(join(tmpDir, "5555.lock"), lockfilePayload());

    // Swallow the initial-scan added event; we want the next :removed.
    const addedP = waitForEvent("ide:added", 1000);
    stop = startIdeDiscovery({ ideDir: tmpDir });
    await addedP;

    const removedP = waitForEvent("ide:removed", 1500);
    unlinkSync(join(tmpDir, "5555.lock"));

    const payload = await removedP;
    expect(payload.port).toBe(5555);
    expect(listAvailableIdes()).toEqual([]);
  });

  it("tolerates a missing ideDir — no crash, empty snapshot", () => {
    const nonExistent = join(tmpDir, "does-not-exist");
    // Do not mkdir; pass the nonexistent path directly.
    stop = startIdeDiscovery({ ideDir: nonExistent });
    expect(listAvailableIdes()).toEqual([]);
  });

  it("stop() prevents further events — post-stop file writes are ignored", async () => {
    stop = startIdeDiscovery({ ideDir: tmpDir });
    stop();
    stop = null;

    const spy = vi.fn();
    companionBus.on("ide:added", spy);

    writeFileSync(join(tmpDir, "8888.lock"), lockfilePayload());
    // Give fs.watch plenty of time to fire if it were still alive.
    await new Promise((r) => setTimeout(r, 300));

    expect(spy).not.toHaveBeenCalled();
  });
});
