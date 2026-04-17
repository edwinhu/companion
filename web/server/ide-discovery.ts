// ide-discovery.ts — Watches ~/.claude/ide/ for IDE lockfiles.
//
// Responsibilities (DISC-01, DISC-02, DISC-03):
//   - Initial scan + `fs.watch` for add/modify/delete of `*.lock` files.
//   - Parse each lockfile, prune those with a non-alive PID.
//   - Emit typed events on `companionBus`: ide:added, ide:changed, ide:removed.
//   - Low-frequency rescan (10s) catches PID-death that fs.watch never notifies
//     us about.
//   - Tolerate a missing ideDir (the Claude CLI creates it lazily).
//   - Tolerate malformed lockfile JSON (skip silently; watcher stays alive).
//
// `authToken` is kept in memory only; never persisted. Callers that need
// it (ws-bridge bind path) snapshot it out of `listAvailableIdes()` at
// bind time.
//
// This module is a singleton — `startIdeDiscovery()` enforces one active
// watcher at a time. `resetIdeDiscoveryForTests()` clears internal state
// for test isolation.

import {
  readdirSync,
  readFileSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { companionBus } from "./event-bus.js";
import { parseLockfile, isPidAlive } from "../../scripts/probe-ide.js";

// ─── Public types ───────────────────────────────────────────────────────────

export interface DiscoveredIde {
  port: number;
  ideName: string;
  workspaceFolders: string[];
  transport: "ws-ide" | "sse-ide";
  lockfilePath: string;
  lockfileMtime: number;
  /** Runtime-only; never persisted. */
  authToken?: string;
}

export interface StartIdeDiscoveryOptions {
  /** Override the directory to watch. Defaults to `~/.claude/ide`. */
  ideDir?: string;
}

// ─── Internal state ─────────────────────────────────────────────────────────

let currentWatcher: FSWatcher | null = null;
let currentRescanTimer: ReturnType<typeof setInterval> | null = null;
let currentIdeDir: string | null = null;
let stopped = false;
/** Map keyed by lockfile path. */
const known = new Map<string, DiscoveredIde>();
/** Count of malformed/skipped lockfile reads — diagnostic only. */
let skippedCount = 0;

/** Rescan period for dead-PID pruning. */
const RESCAN_INTERVAL_MS = 10_000;
/** How long to retry a partial file read (fs.watch may fire mid-write). */
const READ_RETRY_BACKOFF_MS = [10, 30, 80];

// ─── Utilities ──────────────────────────────────────────────────────────────

function derivePortAndTransport(
  lockfilePath: string,
  parsed: NonNullable<ReturnType<typeof parseLockfile>>,
): { port: number; transport: "ws-ide" | "sse-ide" } {
  const stem = basename(lockfilePath).replace(/\.lock$/, "");
  let port = Number(stem);
  if (!Number.isFinite(port)) {
    // Fall back to a `port` field embedded in the JSON if present.
    const embedded = (parsed.raw as Record<string, unknown>).port;
    port = typeof embedded === "number" ? embedded : NaN;
  }

  let transport: "ws-ide" | "sse-ide";
  if (parsed.useWebSocket === true || parsed.transport === "ws") {
    transport = "ws-ide";
  } else {
    transport = "sse-ide";
  }

  return { port, transport };
}

/**
 * Read + parse a lockfile with small retry backoff. fs.watch often fires
 * while the IDE is still writing the file; a naive read can see truncated
 * JSON and report "malformed" even though the file is healthy. We retry
 * 2–3 times on parse failure to smooth over that race.
 *
 * Returns null if the file is missing or genuinely malformed after retries.
 */
function readLockfileWithRetry(
  lockfilePath: string,
): { parsed: NonNullable<ReturnType<typeof parseLockfile>>; mtime: number } | null {
  for (let attempt = 0; attempt <= READ_RETRY_BACKOFF_MS.length; attempt++) {
    let raw: string;
    let mtime: number;
    try {
      const st = statSync(lockfilePath);
      if (!st.isFile()) return null;
      mtime = st.mtimeMs;
      raw = readFileSync(lockfilePath, "utf8");
    } catch {
      return null; // file vanished between readdir and read
    }
    const parsed = parseLockfile(raw);
    if (parsed) return { parsed, mtime };
    // Parse failed — might be partial write. Retry synchronously-ish.
    if (attempt < READ_RETRY_BACKOFF_MS.length) {
      const waitMs = READ_RETRY_BACKOFF_MS[attempt]!;
      const end = Date.now() + waitMs;
      while (Date.now() < end) {
        // busy-wait microsleep; this path is rare and tiny.
      }
      continue;
    }
    return null;
  }
  return null;
}

function toDiscovered(
  lockfilePath: string,
  parsed: NonNullable<ReturnType<typeof parseLockfile>>,
  mtime: number,
): DiscoveredIde | null {
  const { port, transport } = derivePortAndTransport(lockfilePath, parsed);
  if (!Number.isFinite(port)) return null;
  return {
    port,
    ideName: parsed.ideName,
    workspaceFolders: parsed.workspaceFolders,
    transport,
    lockfilePath,
    lockfileMtime: mtime,
    authToken: parsed.authToken,
  };
}

function shallowArrayEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ─── Scanning ───────────────────────────────────────────────────────────────

/**
 * Scan the ideDir; add/update/remove entries in `known` and emit events
 * for every change. Tolerates a missing directory.
 */
function scanDir(dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // Missing dir or permission error — treat as empty, no crash.
    // (Any previously-known entries elsewhere stay intact; we do not
    // evict on a transient read error.)
    return;
  }

  const seen = new Set<string>();
  for (const name of entries) {
    if (!name.endsWith(".lock")) continue;
    const path = join(dir, name);
    const read = readLockfileWithRetry(path);
    if (!read) {
      skippedCount++;
      continue;
    }
    if (!isPidAlive(read.parsed.pid)) {
      // Dead pid — never add. (Pruning of previously-alive entries happens
      // below by virtue of `seen` not including this path... actually
      // we DO mark it seen so we don't evict on the next line. Instead,
      // treat dead-pid as absent: don't mark seen, so if it was previously
      // known it'll be removed below.)
      continue;
    }
    const next = toDiscovered(path, read.parsed, read.mtime);
    if (!next) {
      skippedCount++;
      continue;
    }
    seen.add(path);
    const prev = known.get(path);
    if (!prev) {
      known.set(path, next);
      companionBus.emit("ide:added", {
        port: next.port,
        ideName: next.ideName,
        workspaceFolders: next.workspaceFolders,
        lockfilePath: next.lockfilePath,
      });
    } else {
      const changed =
        prev.ideName !== next.ideName ||
        prev.port !== next.port ||
        !shallowArrayEqual(prev.workspaceFolders, next.workspaceFolders);
      known.set(path, next);
      if (changed) {
        companionBus.emit("ide:changed", {
          port: next.port,
          ideName: next.ideName,
          workspaceFolders: next.workspaceFolders,
          lockfilePath: next.lockfilePath,
        });
      }
    }
  }

  // Evict anything no longer present (or whose pid went dead).
  for (const [path, entry] of known) {
    if (!seen.has(path)) {
      known.delete(path);
      companionBus.emit("ide:removed", {
        port: entry.port,
        lockfilePath: entry.lockfilePath,
      });
    }
  }
}

/**
 * Handle a single fs.watch event. Path may be relative to `dir` or, on
 * some platforms, absent — in that case we fall back to a full scan.
 */
function handleWatchEvent(dir: string, filename: string | null): void {
  if (!filename) {
    scanDir(dir);
    return;
  }
  if (!filename.endsWith(".lock")) return;
  scanDir(dir); // simplest correct path — always reconcile the whole dir.
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Start watching `ideDir` (default `~/.claude/ide`). Returns a `stop()`
 * function that closes the watcher + cancels the rescan timer.
 *
 * Safe to call when the directory does not exist — treated as empty.
 * Calling while already started is tolerated: the prior watcher is
 * stopped first.
 */
export function startIdeDiscovery(
  options: StartIdeDiscoveryOptions = {},
): () => void {
  // If already running, tear down first so callers get a clean restart.
  if (currentWatcher || currentRescanTimer) {
    stopCurrent();
  }

  const ideDir = options.ideDir ?? join(homedir(), ".claude", "ide");
  currentIdeDir = ideDir;
  stopped = false;

  // Initial scan — emits :added for each live lockfile currently present.
  scanDir(ideDir);

  // fs.watch on a missing dir throws — try, tolerate ENOENT.
  try {
    currentWatcher = watch(
      ideDir,
      { persistent: false },
      (_eventType, filename) => {
        if (stopped) return;
        handleWatchEvent(ideDir, typeof filename === "string" ? filename : null);
      },
    );
    currentWatcher.on("error", () => {
      // Swallow — watcher errors must not crash the server.
    });
  } catch {
    currentWatcher = null;
    // Directory likely doesn't exist. Rescan timer below will pick up
    // lockfiles if someone later creates the dir.
  }

  currentRescanTimer = setInterval(() => {
    if (stopped || currentIdeDir === null) return;
    scanDir(currentIdeDir);
  }, RESCAN_INTERVAL_MS);
  // Do not keep the Node event loop alive for this timer.
  (currentRescanTimer as { unref?: () => void }).unref?.();

  return stopCurrent;
}

function stopCurrent(): void {
  stopped = true;
  if (currentWatcher) {
    try {
      currentWatcher.close();
    } catch {
      // ignore
    }
    currentWatcher = null;
  }
  if (currentRescanTimer) {
    clearInterval(currentRescanTimer);
    currentRescanTimer = null;
  }
  currentIdeDir = null;
}

/** Snapshot of currently-known IDEs. */
export function listAvailableIdes(): DiscoveredIde[] {
  return Array.from(known.values());
}

/** Test-only — wipe internal state between tests. */
export function resetIdeDiscoveryForTests(): void {
  stopCurrent();
  known.clear();
  skippedCount = 0;
}

/** Diagnostic accessor (not part of the public contract). */
export function _getSkippedCountForTests(): number {
  return skippedCount;
}
