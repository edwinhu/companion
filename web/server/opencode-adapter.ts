/**
 * Opencode Adapter (Gemini backend)
 *
 * Translates between the opencode REST + SSE protocol and The Companion's
 * BrowserIncomingMessage / BrowserOutgoingMessage types.
 *
 * opencode protocol overview:
 *   POST /session               → create session, returns {id: "ses_..."}
 *   POST /session/:id/message   → send user message
 *   GET  /event                 → SSE stream (all sessions, no filter)
 *   DELETE /session/:id         → delete session
 *
 * SSE event types we care about:
 *   server.connected      → connection ready
 *   session.updated       → session title change
 *   session.status        → {status: {type: "busy"|"idle"}} (turn start/end)
 *   message.updated       → message metadata (role, model, error)
 *   message.part.updated  → streaming text {part: {type:"text", text: "..."}}
 */

import { randomUUID } from "node:crypto";
import type { IBackendAdapter } from "./backend-adapter.js";
import type {
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  SessionState,
  CLIResultMessage,
} from "./session-types.js";
import { log } from "./logger.js";

// ─── opencode SSE event types ─────────────────────────────────────────────────

interface OpencodeEvent {
  type: string;
  properties: Record<string, unknown>;
}

interface OpencodeSessionInfo {
  id: string;
  slug?: string;
  title?: string;
  directory?: string;
  version?: string;
}

interface OpencodeMessageInfo {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  time?: { created?: number; completed?: number };
  error?: { name?: string; data?: { message?: string } };
  modelID?: string;
  providerID?: string;
  cost?: number;
  tokens?: { input?: number; output?: number };
}

interface OpencodePart {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  text?: string;
}

interface OpencodeSessionStatus {
  type: "busy" | "idle";
}

// ─── OpencodeAdapter ──────────────────────────────────────────────────────────

export class OpencodeAdapter implements IBackendAdapter {
  private baseUrl: string;
  private companionSessionId: string;
  /** The opencode-internal session ID (ses_...) */
  private opencodeSessionId: string | null = null;

  private browserMessageCb: ((msg: BrowserIncomingMessage) => void) | null = null;
  private sessionMetaCb: ((meta: { cliSessionId?: string; model?: string; cwd?: string }) => void) | null = null;
  private disconnectCb: (() => void) | null = null;
  private initErrorCb: ((error: string) => void) | null = null;

  private connected = false;
  private destroyed = false;

  /** SSE abort controller — signals fetch to stop reading */
  private sseAbortController: AbortController | null = null;

  /** Track last text seen per part to emit only new text (SSE sends full text each time) */
  private partTextCache = new Map<string, string>();

  /** Track turn completion state (session.status: idle after busy) */
  private wasBusy = false;
  private currentTurnCost = 0;

  constructor(baseUrl: string, companionSessionId: string, opencodeSessionId: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.companionSessionId = companionSessionId;
    this.opencodeSessionId = opencodeSessionId;
  }

  // ─── IBackendAdapter interface ──────────────────────────────────────────────

  isConnected(): boolean {
    return this.connected && !this.destroyed;
  }

  onBrowserMessage(cb: (msg: BrowserIncomingMessage) => void): void {
    this.browserMessageCb = cb;
  }

  onSessionMeta(cb: (meta: { cliSessionId?: string; model?: string; cwd?: string }) => void): void {
    this.sessionMetaCb = cb;
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCb = cb;
  }

  onInitError(cb: (error: string) => void): void {
    this.initErrorCb = cb;
  }

  /**
   * Send a browser-originated message to opencode.
   * Accepts user messages and translates them to REST calls.
   */
  send(msg: BrowserOutgoingMessage): boolean {
    if (!this.connected || this.destroyed || !this.opencodeSessionId) return false;

    if (msg.type === "user_message") {
      const text = msg.content;
      if (text.trim()) {
        this.postMessage(text).catch((err) => {
          log.warn("opencode-adapter", "Failed to send message", { error: String(err) });
        });
        return true;
      }
    }

    return false;
  }

  async disconnect(): Promise<void> {
    this.destroyed = true;
    this.connected = false;
    this.sseAbortController?.abort();
    this.sseAbortController = null;
  }

  // ─── Initialization ─────────────────────────────────────────────────────────

  /**
   * Start the SSE event stream and emit session_init to the browser.
   * Called after the opencode daemon is ready and a session is created.
   */
  async start(sessionState: Partial<SessionState>): Promise<void> {
    if (this.destroyed) return;

    this.connected = true;

    // Emit cli_connected immediately so the UI updates
    this.emit({ type: "cli_connected" });

    // Emit session_init with base state
    const initState: SessionState = {
      session_id: this.companionSessionId,
      backend_type: "gemini",
      model: sessionState.model || "gemini",
      cwd: sessionState.cwd || "",
      tools: [],
      permissionMode: sessionState.permissionMode || "default",
      claude_code_version: "",
      mcp_servers: [],
      agents: [],
      slash_commands: [],
      skills: [],
      total_cost_usd: 0,
      num_turns: 0,
      context_used_percent: 0,
      is_compacting: false,
      git_branch: "",
      is_worktree: false,
      is_containerized: false,
      repo_root: sessionState.cwd || "",
      git_ahead: 0,
      git_behind: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
    };
    this.emit({ type: "session_init", session: initState });

    // Report meta so the session store knows about the opencode session ID
    this.sessionMetaCb?.({ cliSessionId: this.opencodeSessionId ?? undefined, cwd: sessionState.cwd });

    // Start SSE listener
    this.startSSE();
  }

  // ─── SSE stream ─────────────────────────────────────────────────────────────

  private startSSE(): void {
    if (this.destroyed) return;

    this.sseAbortController = new AbortController();
    const signal = this.sseAbortController.signal;

    fetch(`${this.baseUrl}/event`, { signal })
      .then((res) => {
        if (!res.ok || !res.body) {
          throw new Error(`SSE connect failed: ${res.status}`);
        }
        return this.readSSEStream(res.body, signal);
      })
      .catch((err) => {
        if (this.destroyed || signal.aborted) return;
        log.warn("opencode-adapter", "SSE stream ended", {
          sessionId: this.companionSessionId,
          error: String(err),
        });
        this.handleDisconnect();
      });
  }

  private async readSSEStream(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (!this.destroyed && !signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const json = line.slice(6).trim();
            if (json) {
              try {
                const event = JSON.parse(json) as OpencodeEvent;
                this.handleSSEEvent(event);
              } catch {
                // malformed JSON, skip
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (!this.destroyed) {
      this.handleDisconnect();
    }
  }

  // ─── SSE event dispatch ──────────────────────────────────────────────────────

  private handleSSEEvent(event: OpencodeEvent): void {
    // Filter to events for our session only
    const props = event.properties;
    const eventSessionId =
      (props.sessionID as string | undefined) ||
      (props.info as Record<string, unknown> | undefined)?.sessionID as string | undefined ||
      (props.part as Record<string, unknown> | undefined)?.sessionID as string | undefined;

    if (eventSessionId && eventSessionId !== this.opencodeSessionId) return;

    switch (event.type) {
      case "message.part.updated":
        this.handlePartUpdated(props.part as OpencodePart);
        break;

      case "message.updated":
        this.handleMessageUpdated(props.info as OpencodeMessageInfo);
        break;

      case "session.updated":
        this.handleSessionUpdated(props.info as OpencodeSessionInfo);
        break;

      case "session.status":
        this.handleSessionStatus(props.sessionID as string, props.status as OpencodeSessionStatus);
        break;

      case "server.connected":
        // Already connected — no-op
        break;

      default:
        // tui.toast.show and others — ignore
        break;
    }
  }

  private handlePartUpdated(part: OpencodePart): void {
    if (!part || part.type !== "text" || typeof part.text !== "string") return;

    const prev = this.partTextCache.get(part.id) ?? "";
    const newText = part.text.slice(prev.length);
    this.partTextCache.set(part.id, part.text);

    if (!newText) return;

    // Emit as a stream_event (text delta)
    this.emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: newText },
      },
      parent_tool_use_id: null,
    });
  }

  private handleMessageUpdated(info: OpencodeMessageInfo): void {
    if (!info) return;

    // Accumulate cost from completed assistant messages
    if (info.role === "assistant" && info.cost != null) {
      this.currentTurnCost = info.cost;
    }

    // Surface errors to the browser
    if (info.error) {
      const msg = info.error?.data?.message || info.error?.name || "opencode error";
      log.warn("opencode-adapter", "Message error from opencode", {
        sessionId: this.companionSessionId,
        error: msg,
      });
      this.emit({ type: "error", message: msg });
    }
  }

  private handleSessionUpdated(info: OpencodeSessionInfo): void {
    if (!info || info.id !== this.opencodeSessionId) return;
    if (info.title) {
      this.emit({ type: "session_name_update", name: info.title });
    }
  }

  private handleSessionStatus(sesId: string, status: OpencodeSessionStatus): void {
    if (sesId !== this.opencodeSessionId) return;

    if (status?.type === "busy") {
      this.wasBusy = true;
      this.emit({ type: "status_change", status: "running" });
    } else if (status?.type === "idle" && this.wasBusy) {
      this.wasBusy = false;
      this.partTextCache.clear();

      // Emit a result message to signal turn completion
      const result: CLIResultMessage = {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 0,
        duration_api_ms: 0,
        num_turns: 1,
        result: "",
        stop_reason: null,
        total_cost_usd: this.currentTurnCost,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        uuid: randomUUID(),
        session_id: this.opencodeSessionId ?? "",
      };
      this.emit({ type: "result", data: result });
      this.emit({ type: "status_change", status: "idle" });
      this.currentTurnCost = 0;
    }
  }

  // ─── REST helpers ────────────────────────────────────────────────────────────

  private async postMessage(text: string): Promise<void> {
    const url = `${this.baseUrl}/session/${this.opencodeSessionId}/message`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "user",
        parts: [{ type: "text", text }],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`POST /session/.../message failed (${res.status}): ${body}`);
    }
  }

  // ─── Utils ──────────────────────────────────────────────────────────────────

  private emit(msg: BrowserIncomingMessage): void {
    this.browserMessageCb?.(msg);
  }

  private handleDisconnect(): void {
    if (this.destroyed) return;
    this.connected = false;
    this.emit({ type: "cli_disconnected" });
    this.disconnectCb?.();
  }
}

// ─── Factory: wait for opencode serve to be ready ────────────────────────────

/**
 * Polls GET /session until opencode responds with HTTP 200.
 * Returns the base URL once ready, or throws after timeout.
 */
export async function waitForOpencodeReady(
  port: number,
  timeoutMs = 30_000,
): Promise<string> {
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/session`, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status === 200) return baseUrl;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`opencode serve on port ${port} did not become ready within ${timeoutMs}ms`);
}

/**
 * Create a new opencode session and return its ID.
 */
export async function createOpencodeSession(
  baseUrl: string,
  opts: { modelID?: string; cwd?: string } = {},
): Promise<string> {
  const body: Record<string, unknown> = {};
  if (opts.modelID) body.modelID = opts.modelID;

  const res = await fetch(`${baseUrl}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to create opencode session (${res.status}): ${text}`);
  }

  const data = await res.json() as { id?: string };
  if (!data.id) throw new Error("opencode session response missing id");
  return data.id;
}
