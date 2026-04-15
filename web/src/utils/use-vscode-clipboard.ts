/**
 * useVSCodeClipboard
 *
 * When the companion app runs inside a VS Code webview (cross-origin iframe),
 * Chromium/Electron blocks native Cmd+C / Cmd+V clipboard shortcuts. The
 * browser never fires 'copy' or 'paste' events for keyboard shortcuts in
 * cross-origin iframes nested under vscode-webview://.
 *
 * Fix:
 *  - Cmd+C: intercepted here via a capture-phase keydown listener.
 *    The selected text is read synchronously (user-gesture activation is
 *    present during keydown) and written via navigator.clipboard.writeText(),
 *    which succeeds because the Feature Policy grants clipboard-write and
 *    there is a transient user activation.
 *
 *  - Cmd+V: intercepted here. We cannot call navigator.clipboard.readText()
 *    in the companion iframe (permission denied). Instead we send a
 *    postMessage request to window.parent (the VS Code extension's webview
 *    HTML, which has granted clipboard-read). The extension HTML reads the
 *    clipboard and responds with the text. We then insert it at the cursor.
 *
 * The extension HTML (extension.ts / getWebviewHtml) must handle the
 * 'vscode:clipboard:read-request' message and respond with
 * 'vscode:clipboard:read-response'.
 *
 * This hook is a no-op when not running inside a VS Code webview (i.e., when
 * window.parent === window, or the parent origin is not vscode-webview://).
 */

import { useEffect } from "react";

function isInVSCodeWebview(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.parent !== window;
  } catch {
    return false;
  }
}

/**
 * Get the text that is currently selected in the given element or in the
 * document selection. Returns an empty string if nothing is selected.
 */
function getSelectedText(active: Element | null): string {
  if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
    const start = active.selectionStart ?? 0;
    const end = active.selectionEnd ?? 0;
    if (start !== end) {
      return active.value.slice(start, end);
    }
    // Nothing explicitly selected — return nothing (do not copy whole value)
    return "";
  }
  const sel = window.getSelection();
  return sel ? sel.toString() : "";
}

/**
 * Insert text at the cursor position of a textarea or input, dispatching a
 * React-compatible synthetic input event so the controlled component updates.
 */
function insertTextAtCursor(el: HTMLTextAreaElement | HTMLInputElement, text: string): void {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const before = el.value.slice(0, start);
  const after = el.value.slice(end);
  const newValue = before + text + after;

  // Use the native setter so React's synthetic event system picks up the change.
  const nativeSetter = Object.getOwnPropertyDescriptor(
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
    "value",
  )?.set;

  if (nativeSetter) {
    nativeSetter.call(el, newValue);
  } else {
    el.value = newValue;
  }

  el.selectionStart = el.selectionEnd = start + text.length;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export function useVSCodeClipboard(): void {
  useEffect(() => {
    if (!isInVSCodeWebview()) return;

    // Map of pending paste requests: requestId → resolve function
    const pendingPasteRequests = new Map<string, (text: string) => void>();

    // --- Cmd+C: copy selected text to clipboard ---
    const handleKeydown = async (e: KeyboardEvent): Promise<void> => {
      if (!e.metaKey && !e.ctrlKey) return;

      // Cmd+Escape: toggle back to VS Code editor.
      // The outer webview document can't see keydown events when this
      // cross-origin iframe has focus, so relay via postMessage.
      if (e.key === "Escape") {
        e.preventDefault();
        console.log("[companion-keys] key: Cmd+Escape -> toggleBack");
        window.parent.postMessage({ type: "toggleBack" }, "*");
        return;
      }

      if (e.key === "c") {
        console.log("[companion-keys] key: Cmd+C");
        const text = getSelectedText(document.activeElement);
        if (!text) return;
        // Do not call e.preventDefault() so the browser can also handle it,
        // but write to clipboard ourselves to ensure it works in the webview.
        try {
          await navigator.clipboard.writeText(text);
          console.log("[companion-keys] clipboard: copied", text.length, "chars");
        } catch {
          // Silently ignore — the browser may have handled it natively already.
        }
        return;
      }

      if (e.key === "v") {
        console.log("[companion-keys] key: Cmd+V");
        const active = document.activeElement;
        if (
          !(active instanceof HTMLTextAreaElement) &&
          !(active instanceof HTMLInputElement)
        ) {
          return;
        }

        // Prevent the browser's (broken) native paste from firing.
        e.preventDefault();

        // Ask the VS Code extension HTML (parent frame) for clipboard contents.
        const requestId = `clip-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        const text = await new Promise<string>((resolve) => {
          pendingPasteRequests.set(requestId, resolve);
          // Timeout after 2 seconds if no response arrives.
          setTimeout(() => {
            if (pendingPasteRequests.has(requestId)) {
              pendingPasteRequests.delete(requestId);
              resolve("");
            }
          }, 2000);

          window.parent.postMessage(
            { type: "vscode:clipboard:read-request", id: requestId },
            "*",
          );
        });

        if (text && active === document.activeElement) {
          insertTextAtCursor(active, text);
          console.log("[companion-keys] clipboard: pasted", text.length, "chars");
        }
        return;
      }

      // Cmd+A: select all text in the focused input/textarea.
      // Native select-all doesn't fire in cross-origin iframes inside Electron,
      // so we implement it manually.
      if (e.key === "a") {
        const active = document.activeElement;
        if (
          active instanceof HTMLTextAreaElement ||
          active instanceof HTMLInputElement
        ) {
          e.preventDefault();
          active.setSelectionRange(0, active.value.length);
          console.log("[companion-keys] key: Cmd+A -> selectAll", active.value.length, "chars");
        }
        return;
      }

      // Cmd+X: cut selected text to clipboard.
      if (e.key === "x") {
        const active = document.activeElement;
        if (
          active instanceof HTMLTextAreaElement ||
          active instanceof HTMLInputElement
        ) {
          const start = active.selectionStart ?? 0;
          const end = active.selectionEnd ?? 0;
          if (start !== end) {
            const text = active.value.slice(start, end);
            try {
              await navigator.clipboard.writeText(text);
            } catch {}
            // Delete the selected text
            insertTextAtCursor(active, "");
            console.log("[companion-keys] key: Cmd+X -> cut", text.length, "chars");
          }
        }
        return;
      }

      // Allow remaining text-editing shortcuts (c, v, z) to stay in the iframe
      const iframeKeys = new Set(["c", "v", "z"]);
      if (iframeKeys.has(e.key.toLowerCase())) return;

      // Ignore bare modifier key presses (e.g., pressing Cmd alone fires
      // keydown with key="Meta"). Forwarding these would preventDefault the
      // modifier itself and break subsequent combo keys like Cmd+A.
      if (["Meta", "Control", "Shift", "Alt"].includes(e.key)) return;

      // Forward all other Cmd/Ctrl shortcuts to VS Code
      // (e.g., Cmd+Shift+P for command palette, Cmd+P for quick open,
      // Cmd+B for sidebar, Cmd+J for panel, etc.)
      e.preventDefault();
      e.stopPropagation();
      console.log(`[companion-keys] forward: ${e.metaKey ? "Cmd" : "Ctrl"}+${e.shiftKey ? "Shift+" : ""}${e.altKey ? "Alt+" : ""}${e.key} -> vscode`);
      window.parent.postMessage({
        type: "vscode:forward-key",
        key: e.key,
        code: e.code,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
      }, "*");
    };

    // --- Handle messages from VS Code extension HTML ---
    const handleMessage = (e: MessageEvent): void => {
      // Paste response from the clipboard bridge
      if (e.data?.type === "vscode:clipboard:read-response") {
        const { id, text } = e.data as { type: string; id: string; text: string };
        const resolve = pendingPasteRequests.get(id);
        if (resolve) {
          pendingPasteRequests.delete(id);
          resolve(text ?? "");
        }
        return;
      }

      // Focus request from the extension (e.g., triggered by Cmd+Escape / companion.open)
      if (e.data?.type === "focusInput") {
        const input = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(
          'textarea, input[type="text"]',
        );
        if (input) input.focus();
        console.log("[companion-keys] focus:", input?.tagName?.toLowerCase() + (input?.id ? "#" + input.id : ""));
      }
    };

    window.addEventListener("keydown", handleKeydown as any as EventListener, { capture: true });
    window.addEventListener("message", handleMessage);

    // Track focus changes for debugging
    const handleFocusIn = (e: FocusEvent): void => {
      const target = e.target as HTMLElement;
      const desc = target?.tagName?.toLowerCase() + (target?.id ? "#" + target.id : "");
      console.log("[companion-keys] focus:", desc);
    };
    window.addEventListener("focusin", handleFocusIn);

    return () => {
      window.removeEventListener("keydown", handleKeydown as any as EventListener, { capture: true });
      window.removeEventListener("message", handleMessage);
      window.removeEventListener("focusin", handleFocusIn);
    };
  }, []);
}
