import { describe, it, expect } from "vitest";
import { matchIdesForCwd, type IdeCandidate } from "./ide-matcher.js";

/**
 * Tests for ide-matcher.matchIdesForCwd.
 *
 * Implements MATCH-01 (longest-prefix workspace match) and MATCH-02 (mtime tiebreak).
 *
 * The matcher is a pure function used server-side to rank IDE lockfile candidates
 * against the cwd of a session. It must:
 *   - compare paths on path-segment boundaries (no raw startsWith)
 *   - prefer the candidate whose matched workspace folder is the longest prefix
 *   - break ties using lockfile mtime (most recent first)
 *   - still include zero-overlap candidates (as fallback UX), ranked by mtime after matches
 */

const makeCandidate = (overrides: Partial<IdeCandidate> & Pick<IdeCandidate, "port" | "workspaceFolders" | "lockfileMtime">): IdeCandidate => ({
  ideName: "TestIDE",
  transport: "ws-ide",
  lockfilePath: `/tmp/ide/${overrides.port}.lock`,
  ...overrides,
});

describe("matchIdesForCwd", () => {
  /**
   * Baseline: one candidate whose single workspace folder is exactly the cwd.
   * Verifies the trivial identity match — returns the candidate. Without this,
   * we cannot trust any of the ranked behaviors.
   */
  it("returns a single candidate when its workspaceFolder equals cwd exactly", () => {
    const candidate = makeCandidate({
      port: 1000,
      workspaceFolders: ["/Users/x/repo"],
      lockfileMtime: 1000,
    });
    const result = matchIdesForCwd("/Users/x/repo", [candidate]);
    expect(result).toHaveLength(1);
    expect(result[0]?.port).toBe(1000);
  });

  /**
   * Multi-root IDE scenario: IDEs like VS Code / Neovim can have multiple workspace
   * roots open simultaneously. The matcher must consider ALL of the candidate's
   * workspaceFolders and pick the longest matching one; a non-matching root should
   * not disqualify the candidate.
   */
  it("matches a multi-root candidate via any of its workspaceFolders", () => {
    const candidate = makeCandidate({
      port: 2000,
      workspaceFolders: ["/Users/x/other", "/Users/x/repo"],
      lockfileMtime: 1000,
    });
    const result = matchIdesForCwd("/Users/x/repo/sub", [candidate]);
    expect(result).toHaveLength(1);
    expect(result[0]?.port).toBe(2000);
  });

  /**
   * Core ranking rule (MATCH-01): when two candidates both "match" the cwd but one
   * matches at a deeper folder (/Users/x/repo) than the other (/Users/x), the
   * deeper match must come first. Otherwise the picker would default to a loose
   * parent-directory IDE and miss the repo-specific one.
   */
  it("ranks the longest-prefix candidate first", () => {
    const shallow = makeCandidate({
      port: 3001,
      ideName: "Shallow",
      workspaceFolders: ["/Users/x"],
      lockfileMtime: 9999, // higher mtime to prove prefix length beats mtime
    });
    const deep = makeCandidate({
      port: 3002,
      ideName: "Deep",
      workspaceFolders: ["/Users/x/repo"],
      lockfileMtime: 1,
    });
    const result = matchIdesForCwd("/Users/x/repo/sub", [shallow, deep]);
    expect(result.map((c) => c.port)).toEqual([3002, 3001]);
  });

  /**
   * MATCH-02: when two candidates match at the SAME prefix length, the one with
   * the most recently modified lockfile wins. This models "the IDE the user is
   * actively using" — lockfiles are touched on workspace activity.
   */
  it("breaks ties by lockfile mtime (newest first)", () => {
    const older = makeCandidate({
      port: 4001,
      ideName: "Older",
      workspaceFolders: ["/Users/x/repo"],
      lockfileMtime: 100,
    });
    const newer = makeCandidate({
      port: 4002,
      ideName: "Newer",
      workspaceFolders: ["/Users/x/repo"],
      lockfileMtime: 200,
    });
    const result = matchIdesForCwd("/Users/x/repo", [older, newer]);
    expect(result.map((c) => c.port)).toEqual([4002, 4001]);
  });

  /**
   * Path-boundary correctness (REQUIRED BONUS): naive string startsWith would
   * claim "/Users/x/rep" matches "/Users/x/repo/anything" because the raw
   * string is a prefix. The matcher must operate on path-segment boundaries
   * so the "rep" folder does not cross-match the "repo" folder. We assert the
   * wrong-candidate ends up ranked AFTER the right one and with zero prefix
   * credit.
   */
  it("does not cross-match on partial folder names (path-boundary check)", () => {
    const wrong = makeCandidate({
      port: 5001,
      ideName: "Wrong",
      workspaceFolders: ["/Users/x/rep"], // NOT a parent of /Users/x/repo
      lockfileMtime: 9999,
    });
    const right = makeCandidate({
      port: 5002,
      ideName: "Right",
      workspaceFolders: ["/Users/x/repo"],
      lockfileMtime: 1,
    });
    const result = matchIdesForCwd("/Users/x/repo/anything", [wrong, right]);
    // "right" must be first because "wrong" must not be counted as a match.
    expect(result[0]?.port).toBe(5002);
    // Both are still returned (zero-match candidates come after matched ones).
    expect(result.map((c) => c.port)).toEqual([5002, 5001]);
  });

  /**
   * Zero-match fallback: even candidates with no overlapping workspace folder
   * should still appear in the list — the UX lets the user bind to any IDE
   * manually. They should be ordered AFTER all matched candidates and among
   * themselves by mtime desc.
   */
  it("returns zero-match candidates after matches, ordered by mtime desc", () => {
    const matched = makeCandidate({
      port: 6001,
      ideName: "Matched",
      workspaceFolders: ["/Users/x/repo"],
      lockfileMtime: 1,
    });
    const unmatchedOld = makeCandidate({
      port: 6002,
      ideName: "UnmatchedOld",
      workspaceFolders: ["/totally/unrelated"],
      lockfileMtime: 50,
    });
    const unmatchedNew = makeCandidate({
      port: 6003,
      ideName: "UnmatchedNew",
      workspaceFolders: ["/also/unrelated"],
      lockfileMtime: 500,
    });
    const result = matchIdesForCwd("/Users/x/repo", [unmatchedOld, matched, unmatchedNew]);
    expect(result.map((c) => c.port)).toEqual([6001, 6003, 6002]);
  });
});
