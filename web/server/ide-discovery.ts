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
/**
 * Monotonic generation counter bumped at the start of every scan. Each scan
 * captures its generation at entry; after each `await` and before any mutation
 * of `known` or emit, it checks whether it is still the latest. A scan whose
 * generation is stale (a newer scan has started or completed) aborts without
 * mutating state — this prevents a retry-delayed scan from evicting lockfiles
 * that a fresher scan already added. Codex adversarial review, issue #4.
 */
let scanGeneration = 0;
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
 *
 * Async so the backoff yields to the Node event loop (timers, microtasks,
 * incoming WS frames all stay responsive). The previous sync busy-wait
 * blocked the loop for up to 120ms — see issue #4.
 */
async function readLockfileWithRetry(
  lockfilePath: string,
): Promise<{ parsed: NonNullable<ReturnType<typeof parseLockfile>>; mtime: number } | null> {
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
    // Parse failed — might be partial write. Retry via async sleep so the
    // event loop stays responsive.
    if (attempt < READ_RETRY_BACKOFF_MS.length) {
      const waitMs = READ_RETRY_BACKOFF_MS[attempt]!;
      await new Promise<void>((r) => setTimeout(r, waitMs));
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
 *
 * Async because readLockfileWithRetry yields to the event loop during
 * partial-write backoff (issue #4). Callers that cannot await (fs.watch
 * listener, setInterval rescan timer) fire-and-forget — the function is
 * idempotent and logs/tolerates internal errors.
 *
 * Concurrency model (codex adversarial review, issue #4):
 * - Every scan captures its own `gen` at entry. A newer scan bumps
 *   `scanGeneration`, staling every scan that's still in progress.
 * - Builds a LOCAL snapshot (`nextKnown`) during the pass; only mutates
 *   the shared `known` map at the end, AFTER rechecking generation.
 * - Also rechecks `stopped` before mutations so an in-flight scan whose
 *   watcher was cancelled (resetIdeDiscoveryForTests, stop()) does not
 *   leak events or re-populate state post-reset.
 */
async function scanDir(dir: string): Promise<void> {
  const gen = ++scanGeneration;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // Missing dir or permission error — treat as empty, no crash.
    // (Any previously-known entries elsewhere stay intact; we do not
    // evict on a transient read error.)
    return;
  }

  // Build a local snapshot of everything this scan observes. We only
  // reconcile against the shared `known` map at the end, after confirming
  // this scan is still the latest.
  const nextKnown = new Map<string, DiscoveredIde>();
  for (const name of entries) {
    if (!name.endsWith(".lock")) continue;
    const path = join(dir, name);
    const read = await readLockfileWithRetry(path);
    // Post-await checkpoint: a newer scan or a stop() may have landed
    // while we were in the retry backoff. Bail before any mutation.
    if (stopped || gen !== scanGeneration) return;
    if (!read) {
      skippedCount++;
      continue;
    }
    if (!isPidAlive(read.parsed.pid)) continue;
    const next = toDiscovered(path, read.parsed, read.mtime);
    if (!next) {
      skippedCount++;
      continue;
    }
    nextKnown.set(path, next);
  }

  // Final generation / stopped guard before touching shared state.
  if (stopped || gen !== scanGeneration) return;
  reconcileKnown(nextKnown, gen);
}

/**
 * Reconcile the shared `known` map with a scan's local snapshot. Emits
 * ide:added / ide:changed / ide:removed as deltas. Runs synchronously —
 * the caller is responsible for the generation/stopped guards.
 *
 * `gen` is the scan generation that produced `nextKnown`. It is forwarded
 * into each emitted bus event so downstream consumers (ws-bridge fan-out)
 * can stamp their browser-facing broadcasts with a monotonic counter,
 * allowing the client to deduplicate by generation instead of time.
 */
function reconcileKnown(
  nextKnown: Map<string, DiscoveredIde>,
  gen: number,
): void {
  for (const [path, next] of nextKnown) {
    const prev = known.get(path);
    if (!prev) {
      known.set(path, next);
      companionBus.emit("ide:added", {
        port: next.port,
        ideName: next.ideName,
        workspaceFolders: next.workspaceFolders,
        lockfilePath: next.lockfilePath,
        generation: gen,
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
          generation: gen,
        });
      }
    }
  }
  // Evict anything no longer present (or whose pid went dead).
  for (const [path, entry] of known) {
    if (!nextKnown.has(path)) {
      known.delete(path);
      companionBus.emit("ide:removed", {
        port: entry.port,
        lockfilePath: entry.lockfilePath,
        generation: gen,
      });
    }
  }
}

/**
 * Synchronous initial scan — used only by startIdeDiscovery to guarantee
 * that lockfiles present on disk before startup are observable via
 * listAvailableIdes() the moment startIdeDiscovery() returns.
 *
 * Rationale: the async scanDir path uses setTimeout-based backoff for
 * partial writes, which defers state population by one or more ticks.
 * REST callers that hit /api/ide/available immediately after server
 * startup would otherwise see an empty list. We accept a one-shot
 * synchronous readFileSync here because it runs exactly once at startup
 * and sees only complete files (partial writes are an fs.watch concern,
 * not a startup one).
 *
 * No retry — a malformed file at startup is either truly malformed or
 * mid-write from a concurrent IDE startup. The fs.watch listener will
 * re-scan on any subsequent modification, so nothing is permanently lost.
 */
function scanDirSync(dir: string): void {
  const gen = ++scanGeneration;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const nextKnown = new Map<string, DiscoveredIde>();
  for (const name of entries) {
    if (!name.endsWith(".lock")) continue;
    const path = join(dir, name);
    let raw: string;
    let mtime: number;
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      mtime = st.mtimeMs;
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const parsed = parseLockfile(raw);
    if (!parsed) {
      skippedCount++;
      continue;
    }
    if (!isPidAlive(parsed.pid)) continue;
    const next = toDiscovered(path, parsed, mtime);
    if (!next) {
      skippedCount++;
      continue;
    }
    nextKnown.set(path, next);
  }
  if (stopped || gen !== scanGeneration) return;
  reconcileKnown(nextKnown, gen);
}

/**
 * Handle a single fs.watch event. Path may be relative to `dir` or, on
 * some platforms, absent — in that case we fall back to a full scan.
 *
 * scanDir is async; we fire-and-forget. The watcher callback must not
 * block, and errors inside scanDir are already swallowed internally.
 */
function handleWatchEvent(dir: string, filename: string | null): void {
  if (!filename) {
    void scanDir(dir);
    return;
  }
  if (!filename.endsWith(".lock")) return;
  void scanDir(dir); // simplest correct path — always reconcile the whole dir.
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

  // Initial scan — synchronous so listAvailableIdes() reflects pre-existing
  // lockfiles the moment startIdeDiscovery returns. See scanDirSync for the
  // rationale (GET /api/ide/available must not race against startup).
  scanDirSync(ideDir);

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
    // Codex round-2 issue #3: catch-up scan. Between scanDirSync() and the
    // watch() call above there is a brief window where an IDE could finish
    // writing its lockfile. fs.watch only reports events that happen AFTER
    // it attaches, so such a file would be invisible until the next 10s
    // periodic rescan. Schedule an immediate async scanDir() — the existing
    // generation counter guarantees correctness if a watch-triggered scan
    // races with it.
    void scanDir(ideDir);
  } catch {
    currentWatcher = null;
    // Directory likely doesn't exist. Rescan timer below will pick up
    // lockfiles if someone later creates the dir.
  }

  currentRescanTimer = setInterval(() => {
    if (stopped || currentIdeDir === null) return;
    void scanDir(currentIdeDir);
  }, RESCAN_INTERVAL_MS);
  // Do not keep the Node event loop alive for this timer.
  (currentRescanTimer as { unref?: () => void }).unref?.();

  return stopCurrent;
}

function stopCurrent(): void {
  stopped = true;
  // Bump generation so any in-flight scanDir that is currently awaiting
  // readLockfileWithRetry will see a stale generation on resume and bail
  // before touching `known` or emitting events.
  scanGeneration++;
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
  // Codex round-2 issue #2: clear `known` here. A subsequent
  // startIdeDiscovery() may point at a missing or permission-denied
  // directory, in which case scanDirSync returns early without reconciling.
  // Without this clear, listAvailableIdes() would keep returning stale
  // entries from the previous dir forever.
  known.clear();
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
  // Bump generation so any async scan still in-flight from a previous test
  // will see a stale generation on its post-await recheck and bail out.
  scanGeneration++;
}

/** Diagnostic accessor (not part of the public contract). */
export function _getSkippedCountForTests(): number {
  return skippedCount;
}
