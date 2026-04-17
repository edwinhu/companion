#!/usr/bin/env bun
// probe-ide.ts — diagnostic for the Companion /ide integration.
//
// Enumerates `~/.claude/ide/*.lock` files, parses them tolerantly, prunes
// entries whose PID is no longer alive, and prints both (a) a normalized
// summary and (b) the exact `mcp_set_servers` payload Companion would send
// to bind each surviving IDE.
//
// Safe to run with: `bun scripts/probe-ide.ts`
// Exits 0 on success even when zero lockfiles exist.
//
// This implements PROBE-01 / PROBE-02 from `.planning/PLAN.md`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// -- Types ------------------------------------------------------------------

export interface ParsedLockfile {
  /** PID of the IDE process that wrote this lockfile. */
  pid: number;
  /** Workspace folders the IDE has open (multi-root for VSCode). */
  workspaceFolders: string[];
  /** Human-readable IDE name (e.g. "Neovim", "Visual Studio Code"). */
  ideName: string;
  /** Token the CLI uses to authenticate to the IDE's MCP server. */
  authToken?: string;
  /** Newer field — "ws" for WebSocket, "sse" for SSE. */
  transport?: "ws" | "sse" | string;
  /** Older field — VSCode sets this instead of `transport`. */
  useWebSocket?: boolean;
  /** Informational flag set by some IDE adapters. */
  running?: boolean;
  /** Any unknown fields are surfaced here for debugging. */
  raw: Record<string, unknown>;
}

export interface ProbeRow {
  path: string;
  ideName: string;
  workspaceFolders: string[];
  pid: number;
  port: number;
  transport: "ws-ide" | "sse-ide";
  authToken?: string;
}

// -- Parser (exported for tests) --------------------------------------------

/**
 * Parse a single lockfile's raw string contents.
 * Returns `null` on any failure (malformed JSON, non-object, missing
 * required `pid`/`ideName`/`workspaceFolders`).
 *
 * Tolerant to unknown fields — those are preserved on `raw`.
 */
export function parseLockfile(raw: string): ParsedLockfile | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return null;
  }
  const o = obj as Record<string, unknown>;

  const pid = typeof o.pid === "number" ? o.pid : NaN;
  const ideName = typeof o.ideName === "string" ? o.ideName : "";
  const workspaceFolders = Array.isArray(o.workspaceFolders)
    ? o.workspaceFolders.filter((w): w is string => typeof w === "string")
    : [];

  // Require the fields we actually use downstream.
  //
  // SECURITY (issue #5): pid must be a positive integer. `process.kill(0, 0)`
  // signals the caller's entire process group (always "alive"), and negative
  // pids signal the group |pid|. Treating either as a live IDE would surface
  // stale lockfiles in the picker and wire mcp_set_servers to dead ports.
  if (!Number.isFinite(pid) || !Number.isInteger(pid) || pid <= 0 || !ideName) {
    return null;
  }

  return {
    pid,
    ideName,
    workspaceFolders,
    authToken: typeof o.authToken === "string" ? o.authToken : undefined,
    transport: typeof o.transport === "string" ? o.transport : undefined,
    useWebSocket: typeof o.useWebSocket === "boolean" ? o.useWebSocket : undefined,
    running: typeof o.running === "boolean" ? o.running : undefined,
    raw: o,
  };
}

// -- PID liveness -----------------------------------------------------------

/**
 * Returns true if `pid` is an alive process on this host.
 * `process.kill(pid, 0)` throws ESRCH for dead pids (and EPERM if the
 * caller lacks permission — which still means "alive", so we treat it
 * as alive to avoid false negatives).
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EPERM") return true; // alive, just not ours
    return false; // ESRCH or anything else → treat as dead
  }
}

// -- mcp_set_servers payload shape ------------------------------------------

/**
 * Derive the transport type and URL Companion would use when binding.
 * VSCode-style lockfiles use `useWebSocket: true` and their filename is
 * `{port}.lock`. Neovim-style lockfiles use `transport: "ws" | "sse"`.
 */
export function deriveBindShape(
  lockPath: string,
  parsed: ParsedLockfile,
): { port: number; transport: "ws-ide" | "sse-ide"; url: string } {
  // Lockfile names are `<port>.lock` for VSCode-style and `<pid>.lock` for
  // Neovim (where the port is negotiated separately inside the JSON, but
  // we fall back to the filename stem as a best-effort default).
  const stem = basename(lockPath).replace(/\.lock$/, "");
  const port = Number(stem);

  let transport: "ws-ide" | "sse-ide";
  if (parsed.useWebSocket === true || parsed.transport === "ws") {
    transport = "ws-ide";
  } else {
    transport = "sse-ide";
  }

  const scheme = transport === "ws-ide" ? "ws" : "http";
  const url = `${scheme}://127.0.0.1:${port}`;
  return { port, transport, url };
}

/**
 * Build the exact `mcp_set_servers` payload Companion would emit to bind
 * this IDE. This matches `claude-adapter.ts :: handleOutgoingMcpSetServers`
 * — same path used by the CLI's internal `/ide` command.
 */
export function buildBindPayload(row: ProbeRow): {
  type: "mcp_set_servers";
  servers: {
    ide: {
      type: "ws-ide" | "sse-ide";
      url: string;
      ideName: string;
      authToken?: string;
      scope: "dynamic";
    };
  };
} {
  const url =
    row.transport === "ws-ide"
      ? `ws://127.0.0.1:${row.port}`
      : `http://127.0.0.1:${row.port}`;
  return {
    type: "mcp_set_servers",
    servers: {
      ide: {
        type: row.transport,
        url,
        ideName: row.ideName,
        authToken: row.authToken,
        scope: "dynamic",
      },
    },
  };
}

// -- main() -----------------------------------------------------------------

const IDE_DIR = join(homedir(), ".claude", "ide");

interface ProbeResult {
  dir: string;
  rows: ProbeRow[];
  skipped: { path: string; reason: string }[];
}

export function probe(dir: string = IDE_DIR): ProbeResult {
  const rows: ProbeRow[] = [];
  const skipped: { path: string; reason: string }[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return { dir, rows: [], skipped: [] };
    }
    throw err;
  }

  for (const name of entries) {
    if (!name.endsWith(".lock")) continue;
    const path = join(dir, name);
    let raw: string;
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      raw = readFileSync(path, "utf8");
    } catch (err) {
      skipped.push({ path, reason: `read failed: ${(err as Error).message}` });
      continue;
    }
    const parsed = parseLockfile(raw);
    if (!parsed) {
      skipped.push({ path, reason: "malformed JSON or missing required fields" });
      continue;
    }
    if (!isPidAlive(parsed.pid)) {
      skipped.push({ path, reason: `pid ${parsed.pid} not alive` });
      continue;
    }
    const { port, transport } = deriveBindShape(path, parsed);
    rows.push({
      path,
      ideName: parsed.ideName,
      workspaceFolders: parsed.workspaceFolders,
      pid: parsed.pid,
      port,
      transport,
      authToken: parsed.authToken,
    });
  }

  return { dir, rows, skipped };
}

async function main(): Promise<void> {
  const result = probe();

  // eslint-disable-next-line no-console
  console.log(`# Companion /ide probe — scanning ${result.dir}`);
  // eslint-disable-next-line no-console
  console.log(`# Found ${result.rows.length} live lockfile(s), ${result.skipped.length} skipped\n`);

  // eslint-disable-next-line no-console
  console.log("## Live IDE lockfiles:");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result.rows, null, 2));

  if (result.skipped.length > 0) {
    // eslint-disable-next-line no-console
    console.log("\n## Skipped entries:");
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result.skipped, null, 2));
  }

  // eslint-disable-next-line no-console
  console.log("\n## `mcp_set_servers` payloads Companion would send:");
  for (const row of result.rows) {
    // eslint-disable-next-line no-console
    console.log(`\n# bind ${row.ideName} (${row.path})`);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(buildBindPayload(row), null, 2));
  }
}

// Run main() only when invoked as a script (not when imported by the test).
// Bun sets `import.meta.main === true` for the entry file.
// Guard so Vitest's import does not trigger console output.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface ImportMeta {
      main?: boolean;
    }
  }
}

if (import.meta.main) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("probe-ide failed:", err);
    process.exit(1);
  });
}
