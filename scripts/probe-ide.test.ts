// Vitest test for `scripts/probe-ide.ts` — the IDE lockfile probe.
//
// LOCATION NOTE: this file lives at `scripts/probe-ide.test.ts` (outside `web/`).
// The Vitest include glob in `web/vitest.config.ts` was extended minimally to
// add `../scripts` so `cd web && bun run test` picks it up. The alternative —
// moving the script under `web/` — was rejected because the probe is a
// standalone diagnostic meant to be run with `bun scripts/probe-ide.ts` from
// the repo root, alongside the other top-level scripts.
//
// These tests partially fulfill TEST-03 (the richer lockfile contract test
// ships in Task 4 as `web/server/ide-lockfile-contract.test.ts`).

import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLockfile, deriveBindShape, isValidBindShape, probe, buildBindPayload } from "./probe-ide";

// Representative minimal Neovim-style lockfile. `transport` is the newer
// field name; `running` is an informational flag the CLI sets.
const NEOVIM_FIXTURE = JSON.stringify({
  pid: 12345,
  workspaceFolders: ["/Users/x/repo"],
  ideName: "Neovim",
  transport: "ws",
  running: true,
  authToken: "tok-abc",
});

// Representative minimal VSCode-style lockfile. VSCode uses the older
// `useWebSocket: true` flag in place of `transport`.
const VSCODE_FIXTURE = JSON.stringify({
  pid: 67890,
  workspaceFolders: ["/Users/x/proj", "/Users/x/proj/docs"],
  ideName: "Visual Studio Code",
  useWebSocket: true,
  authToken: "tok-xyz",
});

describe("parseLockfile", () => {
  it("parses a Neovim-style lockfile with `transport` field", () => {
    // Asserts: required fields are surfaced, `transport` field is preserved,
    // `useWebSocket` is absent (Neovim doesn't emit it).
    const parsed = parseLockfile(NEOVIM_FIXTURE);
    expect(parsed).not.toBeNull();
    expect(parsed!.pid).toBe(12345);
    expect(parsed!.ideName).toBe("Neovim");
    expect(parsed!.workspaceFolders).toEqual(["/Users/x/repo"]);
    expect(parsed!.authToken).toBe("tok-abc");
    expect(parsed!.transport).toBe("ws");
    expect(parsed!.useWebSocket).toBeUndefined();
  });

  it("parses a VSCode-style lockfile with `useWebSocket` field and multi-root workspace", () => {
    // Asserts: multiple workspaceFolders are preserved, `useWebSocket`
    // boolean is surfaced (so the probe can derive `ws-ide` vs `sse-ide`).
    const parsed = parseLockfile(VSCODE_FIXTURE);
    expect(parsed).not.toBeNull();
    expect(parsed!.pid).toBe(67890);
    expect(parsed!.ideName).toBe("Visual Studio Code");
    expect(parsed!.workspaceFolders).toEqual([
      "/Users/x/proj",
      "/Users/x/proj/docs",
    ]);
    expect(parsed!.authToken).toBe("tok-xyz");
    expect(parsed!.useWebSocket).toBe(true);
  });

  it("returns null for malformed JSON (does not throw)", () => {
    // The probe iterates over every file in ~/.claude/ide/ — a single
    // malformed lockfile must not crash the whole enumeration. Contract:
    // parser returns null on parse failure; caller skips the entry.
    expect(parseLockfile("{ this is not valid json")).toBeNull();
    expect(parseLockfile("")).toBeNull();
  });

  it("returns null for non-object JSON (array, string, number)", () => {
    // A lockfile that parses as JSON but isn't an object is still invalid.
    expect(parseLockfile("[]")).toBeNull();
    expect(parseLockfile('"just a string"')).toBeNull();
    expect(parseLockfile("42")).toBeNull();
  });

  /**
   * Security: reject pid values that would make `process.kill(pid, 0)`
   * misbehave in isPidAlive (issue #5).
   *
   * process.kill semantics on macOS / Linux:
   *   - pid  >  0  → signal that process (ESRCH if dead)
   *   - pid === 0  → signal EVERY process in the CALLER's group (always alive!)
   *   - pid <   0  → signal EVERY process in group |pid| (likely alive)
   *
   * A lockfile with pid=0 or pid=-1 (garbage or malicious) would therefore
   * be reported as "alive" even when the backing IDE is long gone. That
   * keeps stale lockfiles visible in the IdePicker, and worse, a bind
   * against them still dispatches mcp_set_servers to a dead port.
   *
   * Contract: parseLockfile returns null for pid <= 0.
   */
  it("returns null when pid is <= 0 (defends isPidAlive against process.kill(0) group-signal)", () => {
    const withZero = JSON.stringify({
      pid: 0,
      workspaceFolders: ["/tmp"],
      ideName: "Ghost",
      transport: "ws",
    });
    const withNegative = JSON.stringify({
      pid: -1,
      workspaceFolders: ["/tmp"],
      ideName: "Ghost",
      transport: "ws",
    });
    expect(parseLockfile(withZero)).toBeNull();
    expect(parseLockfile(withNegative)).toBeNull();
  });

  it("returns null when pid is not an integer (e.g. 1.5, NaN)", () => {
    // parseLockfile already rejects NaN via Number.isFinite, but a
    // non-integer float could still slip past. Tighten to integer-only.
    const withFloat = JSON.stringify({
      pid: 1.5,
      workspaceFolders: ["/tmp"],
      ideName: "Weird",
      transport: "ws",
    });
    expect(parseLockfile(withFloat)).toBeNull();
  });

  // cubic-ai review (PR #652): the filename stem is coerced to a port via
  // `Number(stem)`. A lockfile like `foo.lock` produces `NaN`, `.lock`
  // produces 0, and large numeric stems produce out-of-range ports. Before
  // the fix the probe would emit `{port: NaN}` in its bind payload; the
  // downstream CLI rejects NaN but we still surface garbage to humans
  // reading the probe output. Contract: `deriveBindShape` returns `null`
  // for any non-integer or out-of-range port; `probe()` skips the entry.
  it("tolerates unknown fields without throwing", () => {
    // Forward-compat: future CLI versions may add fields. The parser
    // should ignore them and surface the known ones.
    const withExtras = JSON.stringify({
      pid: 111,
      workspaceFolders: ["/tmp"],
      ideName: "Future IDE",
      transport: "ws",
      someNewField: { nested: true },
      anotherExtra: [1, 2, 3],
    });
    const parsed = parseLockfile(withExtras);
    expect(parsed).not.toBeNull();
    expect(parsed!.pid).toBe(111);
    expect(parsed!.ideName).toBe("Future IDE");
  });
});

describe("isValidBindShape — port validation (cubic-ai review #4)", () => {
  // Minimal parsed lockfile reused across tests. Only `transport` matters
  // for the shape of the bind payload — the rest is filler so the call
  // shape is valid. `probe()` calls `deriveBindShape` then checks
  // `isValidBindShape` before including the row; these tests pin the
  // validator directly against every failure mode.
  const baseParsed = {
    pid: 123,
    workspaceFolders: ["/tmp"],
    ideName: "Neovim",
    transport: "ws" as const,
    raw: {},
  };

  it("rejects lockfile with non-numeric port in filename (foo.lock)", () => {
    // A `.lock` file whose stem is not numeric (e.g. "foo.lock") would
    // coerce to NaN. Skipping is the same as malformed-JSON handling.
    const shape = deriveBindShape("/tmp/foo.lock", baseParsed);
    expect(Number.isNaN(shape.port)).toBe(true);
    expect(isValidBindShape(shape)).toBe(false);
  });

  it("rejects port = 0", () => {
    // Filename stem "0" — technically parseable but port 0 is never a
    // real IDE server (kernel-assigned port not a listening one).
    const shape = deriveBindShape("/tmp/0.lock", baseParsed);
    expect(shape.port).toBe(0);
    expect(isValidBindShape(shape)).toBe(false);
  });

  it("rejects port > 65535", () => {
    // TCP ports are 16-bit unsigned; anything above 65535 cannot reach
    // a real IDE listener. Filename stem "70000" exceeds the range.
    const shape = deriveBindShape("/tmp/70000.lock", baseParsed);
    expect(shape.port).toBe(70000);
    expect(isValidBindShape(shape)).toBe(false);
  });

  it("rejects negative port", () => {
    // `Number("-5")` returns -5 cleanly (not NaN); without the range
    // check, we'd build an invalid URL like `ws://127.0.0.1:-5`.
    const shape = deriveBindShape("/tmp/-5.lock", baseParsed);
    expect(shape.port).toBe(-5);
    expect(isValidBindShape(shape)).toBe(false);
  });

  it("accepts a valid port in range (regression)", () => {
    // Sanity check: the validation didn't clobber the happy path.
    const shape = deriveBindShape("/tmp/50001.lock", baseParsed);
    expect(shape.port).toBe(50001);
    expect(shape.transport).toBe("ws-ide");
    expect(shape.url).toBe("ws://127.0.0.1:50001");
    expect(isValidBindShape(shape)).toBe(true);
  });
});

// ─── probe() integration — invalid port stems are skipped end-to-end ──────────
//
// Codex adversarial review (BRITTLE 3): the unit tests above pin the
// `isValidBindShape` validator in isolation. If a future refactor ever
// disconnected `probe()` from the validator (e.g. deleted the call site),
// those unit tests would still pass but probe() would emit `port: NaN`
// payloads. This integration test drives probe() end-to-end against a real
// temp directory containing a lockfile whose filename stem is non-numeric,
// and asserts the result does NOT include the malformed entry in `rows`
// AND is flagged in `skipped`, AND buildBindPayload is NEVER applied to it
// (no NaN-port URL ever appears).
describe("probe() integration — invalid port filename stems", () => {
  it("skips a .lock file whose stem is non-numeric (no NaN-port in rows or payloads)", () => {
    // Build a real temp ideDir with ONE malformed lockfile: `notanumber.lock`.
    // The JSON body is valid + references a live pid (process.pid) so we know
    // the skip isn't coming from parseLockfile's pid check — it's purely the
    // filename-stem → port validation path the test is exercising.
    const dir = mkdtempSync(join(tmpdir(), "probe-ide-integration-"));
    try {
      mkdirSync(dir, { recursive: true });
      const lockPath = join(dir, "notanumber.lock");
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: process.pid, // definitely alive — passes isPidAlive
          workspaceFolders: ["/tmp"],
          ideName: "Malformed",
          transport: "ws",
          authToken: "tok",
        }),
      );

      const result = probe(dir);

      // The malformed lockfile must NOT appear in rows — isValidBindShape
      // gated it out. The happy-path would have rows.length === 1.
      expect(result.rows).toHaveLength(0);

      // AND it must appear in skipped with the specific invalid-port reason.
      // Any other reason (e.g. "malformed JSON") means the validator wasn't
      // the thing that skipped it, which defeats this test's purpose.
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].path).toBe(lockPath);
      expect(result.skipped[0].reason).toMatch(/invalid port/i);

      // Belt-and-suspenders: if any code path ever re-introduced the entry,
      // buildBindPayload would serialize `ws://127.0.0.1:NaN`. Nothing in
      // rows → no such payload is possible.
      const payloadUrls = result.rows.map((r) => buildBindPayload(r).servers.ide.url);
      for (const url of payloadUrls) {
        expect(url).not.toMatch(/NaN/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
