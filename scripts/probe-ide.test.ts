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
import { parseLockfile } from "./probe-ide";

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
