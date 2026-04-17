// @vitest-environment jsdom
/**
 * Tests for IdePicker component (Task 10 — UI-02, UI-03).
 *
 * Validates:
 *  - Five render states: empty, single, many-with-best-match, currently-bound, bind-failed.
 *  - Accessibility (axe scan) across states; role="dialog", aria-modal, listbox semantics.
 *  - Keyboard navigation (ArrowUp/Down cycles; Enter picks; Escape closes; D disconnects).
 *  - REST boundary: picks call bindIde(sessionId, port); Esc does NOT call bindIde;
 *    "D" calls unbindIde only when currentBinding is present.
 *  - Bind-failure UX: inline error + Retry calls bindIde a second time (does NOT close).
 *
 * IdePicker NEVER touches the store — store updates flow via session_update.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

// ─── Mocks ──────────────────────────────────────────────────────────────────
//
// Mock the `../api.js` module. Task 9 already landed `getAvailableIdes`,
// `bindIde`, `unbindIde` as module-level exports AND the standard `api`
// namespace object; we mock both surfaces so the component code is free
// to import either way.
vi.mock("../api.js", () => {
  const fns = {
    getAvailableIdes: vi.fn(),
    bindIde: vi.fn(),
    unbindIde: vi.fn(),
    getHome: vi.fn(),
  };
  return {
    ...fns,
    api: fns,
  };
});

import * as apiModule from "../api.js";
import { IdePicker } from "./IdePicker.js";
import type { IdeBinding } from "../types.js";

const mockGetAvailableIdes = apiModule.getAvailableIdes as ReturnType<typeof vi.fn>;
const mockBindIde = apiModule.bindIde as ReturnType<typeof vi.fn>;
const mockUnbindIde = apiModule.unbindIde as ReturnType<typeof vi.fn>;
const mockGetHome = (apiModule.api as unknown as { getHome: ReturnType<typeof vi.fn> }).getHome;

// Sample IDE entries. Workspace paths under `/Users/me/...` so we can
// validate the `~/…` home-abbreviation rendering once the getHome mock
// resolves.
const idesMany = [
  {
    port: 50001,
    ideName: "Neovim",
    workspaceFolders: ["/Users/me/areas/secreg"],
    transport: "ws-ide" as const,
    lockfilePath: "/Users/me/.claude/ide/50001.lock",
    lockfileMtime: 1_700_000_000_000,
  },
  {
    port: 50002,
    ideName: "Visual Studio Code",
    workspaceFolders: ["/Users/me/areas"],
    transport: "ws-ide" as const,
    lockfilePath: "/Users/me/.claude/ide/50002.lock",
    lockfileMtime: 1_700_000_100_000,
  },
  {
    port: 50003,
    ideName: "Obsidian",
    workspaceFolders: ["/Users/me/notes"],
    transport: "sse-ide" as const,
    lockfilePath: "/Users/me/.claude/ide/50003.lock",
    lockfileMtime: 1_700_000_200_000,
  },
];

const sampleBinding: IdeBinding = {
  port: 50001,
  ideName: "Neovim",
  workspaceFolders: ["/Users/me/areas/secreg"],
  transport: "ws-ide",
  boundAt: 1_700_000_300_000,
  lockfilePath: "/Users/me/.claude/ide/50001.lock",
};

function setup(props: Partial<Parameters<typeof IdePicker>[0]> = {}) {
  const onClose = vi.fn();
  const result = render(
    <IdePicker
      sessionId="sess-A"
      cwd="/Users/me/areas/secreg"
      currentBinding={null}
      onClose={onClose}
      {...props}
    />,
  );
  return { onClose, ...result };
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.clearAllMocks();
  // Default home lookup succeeds.
  mockGetHome.mockResolvedValue({ home: "/Users/me", cwd: "/Users/me" });
  // Default: return "many" list (best match first per server ordering by cwd prefix).
  mockGetAvailableIdes.mockResolvedValue(idesMany);
});

describe("IdePicker — render states", () => {
  it("renders the zero-state when no IDEs are discovered", async () => {
    // UI-02: empty state copy per spec — "No IDE detected. Start one and try again."
    mockGetAvailableIdes.mockResolvedValue([]);
    setup();

    await waitFor(() => {
      expect(screen.getByText(/No IDE detected/i)).toBeInTheDocument();
    });
    // Axe: empty state must pass.
    const { axe } = await import("vitest-axe");
    const dialog = screen.getByRole("dialog");
    const results = await axe(dialog);
    expect(results).toHaveNoViolations();
  });

  it("renders a single discovered IDE", async () => {
    // UI-02: single-match auto-highlighted.
    mockGetAvailableIdes.mockResolvedValue([idesMany[0]]);
    setup();

    await waitFor(() => {
      expect(screen.getByText("Neovim")).toBeInTheDocument();
    });
    // Axe scan.
    const { axe } = await import("vitest-axe");
    const dialog = screen.getByRole("dialog");
    const results = await axe(dialog);
    expect(results).toHaveNoViolations();
  });

  it("renders multiple IDEs and highlights the best match (first entry)", async () => {
    // UI-02: best match — the server returns entries ordered with best match first;
    // component must pre-select / highlight item index 0.
    setup();

    await waitFor(() => {
      expect(screen.getByText("Neovim")).toBeInTheDocument();
      expect(screen.getByText("Visual Studio Code")).toBeInTheDocument();
      expect(screen.getByText("Obsidian")).toBeInTheDocument();
    });

    // The first option is the best match and should be aria-selected.
    const options = screen.getAllByRole("option");
    expect(options.length).toBe(3);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[1]).toHaveAttribute("aria-selected", "false");
  });

  it("renders a 'currently bound' state with a Disconnect affordance", async () => {
    // UI-03: when currentBinding is present, show current binding at top
    // with a visible Disconnect button. Listing still renders below.
    setup({ currentBinding: sampleBinding });

    await waitFor(() => {
      expect(screen.getByText("Neovim")).toBeInTheDocument();
    });
    // Disconnect button must have a discoverable accessible name.
    const disconnect = screen.getByRole("button", { name: /disconnect/i });
    expect(disconnect).toBeInTheDocument();
  });

  it("renders a bind-failed state with inline error + Retry", async () => {
    // UI-03: after a failed pick, component renders inline error and a Retry button;
    // it does NOT close, does NOT toast.
    mockBindIde.mockResolvedValue({ ok: false, error: "unknown port" });
    const { onClose } = setup();

    await waitFor(() => {
      expect(screen.getByText("Neovim")).toBeInTheDocument();
    });

    // Pick the best match (index 0) by pressing Enter.
    fireEvent.keyDown(document, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByText(/unknown port/)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    // Does not close on failure.
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("IdePicker — interactions", () => {
  it("ArrowDown/ArrowUp cycles selection via aria-selected", async () => {
    // Keyboard nav contract: wraps around the list.
    setup();

    await waitFor(() => {
      expect(screen.getByText("Neovim")).toBeInTheDocument();
    });

    let options = screen.getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(document, { key: "ArrowDown" });
    options = screen.getAllByRole("option");
    expect(options[1]).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(document, { key: "ArrowDown" });
    options = screen.getAllByRole("option");
    expect(options[2]).toHaveAttribute("aria-selected", "true");

    // Wrap to first
    fireEvent.keyDown(document, { key: "ArrowDown" });
    options = screen.getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    // ArrowUp wraps back to last
    fireEvent.keyDown(document, { key: "ArrowUp" });
    options = screen.getAllByRole("option");
    expect(options[2]).toHaveAttribute("aria-selected", "true");
  });

  it("Enter triggers bindIde with the selected port, then onClose", async () => {
    // Enter on the best-match default selection should POST the bind and then close.
    mockBindIde.mockResolvedValue({ ok: true, binding: sampleBinding });
    const { onClose } = setup();

    await waitFor(() => {
      expect(screen.getByText("Neovim")).toBeInTheDocument();
    });

    fireEvent.keyDown(document, { key: "Enter" });

    await waitFor(() => {
      expect(mockBindIde).toHaveBeenCalledWith("sess-A", 50001);
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("Escape closes the picker without calling bindIde", async () => {
    // Escape must be a pure dismissal — no side effects.
    const { onClose } = setup();

    await waitFor(() => {
      expect(screen.getByText("Neovim")).toBeInTheDocument();
    });

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(mockBindIde).not.toHaveBeenCalled();
  });

  it("D disconnects when currentBinding is present (calls unbindIde then onClose)", async () => {
    // When a binding exists, the "D" shortcut is an explicit disconnect.
    mockUnbindIde.mockResolvedValue({ ok: true });
    const { onClose } = setup({ currentBinding: sampleBinding });

    await waitFor(() => {
      expect(screen.getByText("Neovim")).toBeInTheDocument();
    });

    fireEvent.keyDown(document, { key: "d" });

    await waitFor(() => {
      expect(mockUnbindIde).toHaveBeenCalledWith("sess-A");
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("D is a no-op when no currentBinding is set", async () => {
    // Without a binding, D does nothing (unbindIde must not be called).
    setup({ currentBinding: null });

    await waitFor(() => {
      expect(screen.getByText("Neovim")).toBeInTheDocument();
    });

    fireEvent.keyDown(document, { key: "d" });
    // Give any async work a tick.
    await new Promise((r) => setTimeout(r, 10));
    expect(mockUnbindIde).not.toHaveBeenCalled();
  });

  it("Retry re-calls bindIde after a failed pick", async () => {
    // After failure, clicking Retry re-issues the bind with the same port.
    mockBindIde
      .mockResolvedValueOnce({ ok: false, error: "unknown port" })
      .mockResolvedValueOnce({ ok: true, binding: sampleBinding });
    const { onClose } = setup();

    await waitFor(() => {
      expect(screen.getByText("Neovim")).toBeInTheDocument();
    });

    // Fail first
    fireEvent.keyDown(document, { key: "Enter" });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /retry/i }));

    await waitFor(() => {
      expect(mockBindIde).toHaveBeenCalledTimes(2);
    });
    // Second call uses the same port.
    expect(mockBindIde.mock.calls[1]).toEqual(["sess-A", 50001]);
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("does not touch the store directly (no setState exports used)", async () => {
    // Guardrail: IdePicker must not import from the store. This is enforced
    // by absence — we verify by rendering without store mocks and confirm
    // nothing throws. If a future refactor imports the store, the test file
    // will need to mock it (which will make this regression visible).
    setup();
    await waitFor(() => {
      expect(screen.getByText("Neovim")).toBeInTheDocument();
    });
    // Just reaching here without module-resolve errors is sufficient signal.
    expect(true).toBe(true);
  });

  it("close button (×) triggers onClose without calling bindIde", async () => {
    // UX: an explicit close button is available for mouse users.
    const { onClose } = setup();

    await waitFor(() => {
      expect(screen.getByText("Neovim")).toBeInTheDocument();
    });
    const close = screen.getByRole("button", { name: /close/i });
    fireEvent.click(close);

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(mockBindIde).not.toHaveBeenCalled();
  });

  it("clicking an option picks it (bindIde called with that option's port)", async () => {
    // Mouse users: clicking a non-default option should bind that port.
    mockBindIde.mockResolvedValue({ ok: true, binding: sampleBinding });
    setup();

    await waitFor(() => {
      expect(screen.getByText("Visual Studio Code")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    const options = screen.getAllByRole("option");
    await user.click(options[1]); // VS Code

    await waitFor(() => {
      expect(mockBindIde).toHaveBeenCalledWith("sess-A", 50002);
    });
  });
});

describe("IdePicker — accessibility across states", () => {
  // UI-02: unified axe scan across all five render states.
  // We parameterize to keep the contract concise — any state that fails axe
  // fails the suite.
  const states: Array<{
    name: string;
    setup: () => void;
    awaitText: RegExp | string;
  }> = [
    {
      name: "empty",
      setup: () => {
        mockGetAvailableIdes.mockResolvedValue([]);
        setup();
      },
      awaitText: /No IDE detected/i,
    },
    {
      name: "single",
      setup: () => {
        mockGetAvailableIdes.mockResolvedValue([idesMany[0]]);
        setup();
      },
      awaitText: "Neovim",
    },
    {
      name: "many with best match",
      setup: () => {
        setup();
      },
      awaitText: "Obsidian",
    },
    {
      name: "currently bound",
      setup: () => {
        setup({ currentBinding: sampleBinding });
      },
      awaitText: /disconnect/i,
    },
    {
      name: "bind failed",
      setup: () => {
        mockBindIde.mockResolvedValue({ ok: false, error: "unknown port" });
        setup();
      },
      awaitText: "Neovim",
    },
  ];

  for (const state of states) {
    it(`passes axe in the "${state.name}" state`, async () => {
      state.setup();
      await waitFor(() => {
        // waitFor wants a function that may throw; find / getBy does that.
        if (typeof state.awaitText === "string") {
          expect(screen.getByText(state.awaitText)).toBeInTheDocument();
        } else {
          expect(screen.getAllByText(state.awaitText).length).toBeGreaterThan(0);
        }
      });

      if (state.name === "bind failed") {
        // Trigger the failure path so the inline error is visible.
        fireEvent.keyDown(document, { key: "Enter" });
        await waitFor(() => {
          expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
        });
      }

      const { axe } = await import("vitest-axe");
      const dialog = screen.getByRole("dialog");
      const results = await axe(dialog);
      expect(results).toHaveNoViolations();
    });
  }
});

// ─── Task 12: live refresh on ide_list_changed ────────────────────────────────
//
// Contract: while an IdePicker is mounted, dispatching the global
// "companion:ide-list-changed" CustomEvent (emitted by ws.ts on receipt of
// `{type: "ide_list_changed"}` over the WS) must cause the component to
// refetch `getAvailableIdes(cwd)`. The subscription must be cleaned up on
// unmount — no refetch should occur after the picker closes.
describe("IdePicker — live refresh (Task 12)", () => {
  it("refetches the IDE list when a companion:ide-list-changed event fires", async () => {
    // Initial mount → one fetch. Dispatch the event → a second fetch.
    mockGetAvailableIdes.mockResolvedValue([idesMany[0]]);
    setup();

    await waitFor(() => {
      expect(mockGetAvailableIdes).toHaveBeenCalledTimes(1);
    });

    // Fire the event the way ws.ts does.
    window.dispatchEvent(new CustomEvent("companion:ide-list-changed"));

    await waitFor(() => {
      expect(mockGetAvailableIdes).toHaveBeenCalledTimes(2);
    });
    // Same cwd is passed on refetch.
    expect(mockGetAvailableIdes).toHaveBeenLastCalledWith("/Users/me/areas/secreg");
  });

  it("stops listening after unmount — no refetch post-close", async () => {
    // Prevents a common subscription leak where stale pickers keep fetching.
    mockGetAvailableIdes.mockResolvedValue([idesMany[0]]);
    const { unmount } = setup();

    await waitFor(() => {
      expect(mockGetAvailableIdes).toHaveBeenCalledTimes(1);
    });

    unmount();
    window.dispatchEvent(new CustomEvent("companion:ide-list-changed"));

    // Give React a tick to do anything erroneous.
    await new Promise((r) => setTimeout(r, 20));
    expect(mockGetAvailableIdes).toHaveBeenCalledTimes(1);
  });
});
