import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Returns true when opencode has a plausible auth source.
 * Checks for:
 * - explicit GOOGLE_API_KEY / GEMINI_API_KEY env vars, or
 * - opencode's own auth file at ~/.local/share/opencode/auth.json (written by `opencode auth login`)
 */
export function hasOpencodeAuth(envVars?: Record<string, string>): boolean {
  if (
    !!envVars?.GOOGLE_API_KEY
    || !!envVars?.GEMINI_API_KEY
  ) {
    return true;
  }

  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const candidates = [
    join(home, ".local", "share", "opencode", "auth.json"),
  ];

  return candidates.some((p) => existsSync(p));
}
