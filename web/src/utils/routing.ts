export type Route =
  | { page: "home" }
  | { page: "session"; sessionId: string }
  | { page: "settings" }
  | { page: "integrations" }
  | { page: "integration-linear" }
  | { page: "prompts" }
  | { page: "terminal" }
  | { page: "environments" }
  | { page: "scheduled" }
  | { page: "agents" }
  | { page: "agent-detail"; agentId: string }
  | { page: "playground" };

const SESSION_PREFIX = "#/session/";
const AGENT_PREFIX = "#/agents/";
let clipboardFallbackInstalled = false;

function copyTextWithExecCommand(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof document === "undefined" || typeof document.execCommand !== "function") {
      reject(new Error("Clipboard fallback is unavailable"));
      return;
    }

    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      document.body.removeChild(textarea);
      if (!copied) {
        reject(new Error("Copy command was rejected"));
        return;
      }
      resolve();
    } catch (error) {
      reject(error instanceof Error ? error : new Error("Clipboard copy failed"));
    }
  });
}

export function installClipboardWriteFallback(): void {
  if (clipboardFallbackInstalled || typeof window === "undefined") return;
  clipboardFallbackInstalled = true;

  const nav = window.navigator as Navigator & {
    clipboard?: { writeText?: (text: string) => Promise<void> };
  };
  const clipboard = nav.clipboard;

  if (clipboard?.writeText) {
    const originalWriteText = clipboard.writeText.bind(clipboard);
    try {
      clipboard.writeText = async (text: string) => {
        try {
          await originalWriteText(text);
        } catch {
          try {
            await copyTextWithExecCommand(text);
          } catch {
            // Keep this promise resolved to avoid unhandled rejections in callers
            // that only attach `.then()` handlers.
          }
        }
      };
    } catch {
      // Clipboard object is read-only in this environment.
    }
    return;
  }

  try {
    Object.defineProperty(nav, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          try {
            await copyTextWithExecCommand(text);
          } catch {
            // Keep this promise resolved to avoid unhandled rejections in callers
            // that only attach `.then()` handlers.
          }
        },
      },
    });
  } catch {
    // Navigator.clipboard cannot be reassigned in this environment.
  }
}

export function resetClipboardFallbackForTests(): void {
  clipboardFallbackInstalled = false;
}

/**
 * Parse a window.location.hash string into a typed Route.
 */
export function parseHash(hash: string): Route {
  if (hash === "#/settings") return { page: "settings" };
  if (hash === "#/integrations") return { page: "integrations" };
  if (hash === "#/integrations/linear") return { page: "integration-linear" };
  if (hash === "#/prompts") return { page: "prompts" };
  if (hash === "#/terminal") return { page: "terminal" };
  if (hash === "#/environments") return { page: "environments" };
  // #/scheduled redirects to #/agents (cron absorbed into agents)
  if (hash === "#/scheduled") return { page: "agents" };
  if (hash === "#/agents") return { page: "agents" };
  if (hash === "#/playground") return { page: "playground" };

  if (hash.startsWith(AGENT_PREFIX)) {
    const agentId = hash.slice(AGENT_PREFIX.length);
    if (agentId) return { page: "agent-detail", agentId };
  }

  if (hash.startsWith(SESSION_PREFIX)) {
    const sessionId = hash.slice(SESSION_PREFIX.length);
    if (sessionId) return { page: "session", sessionId };
  }

  return { page: "home" };
}

/**
 * Build a hash string for a given session ID.
 */
export function sessionHash(sessionId: string): string {
  return `#/session/${sessionId}`;
}

/**
 * Navigate to a session by updating the URL hash.
 * When replace=true, uses replaceState to avoid creating a history entry.
 */
export function navigateToSession(sessionId: string, replace = false): void {
  const newHash = sessionHash(sessionId);
  if (replace) {
    history.replaceState(null, "", newHash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = `/session/${sessionId}`;
  }
}

/**
 * Navigate to the home page (no session selected) by clearing the hash.
 * When replace=true, uses replaceState to avoid creating a history entry.
 */
export function navigateHome(replace = false): void {
  if (replace) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = "";
  }
}

installClipboardWriteFallback();
