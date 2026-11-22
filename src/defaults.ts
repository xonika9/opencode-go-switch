import { readFileSync } from "node:fs";

export const DEFAULT_POLL_INTERVAL_MS = 300_000;
export const DEFAULT_USAGE_TIMEOUT_MS = 5_000;
export const DEFAULT_FALLBACK_COOLDOWN_MS = 900_000;
export const DEFAULT_LIMIT_USAGE_BUDGET_MS = 2_000;

const UNKNOWN_VERSION = "unknown";

/**
 * The package's own version, read from the file beside the module. Both `src/` and `dist/` sit one
 * directory below the package root, which is why the import graph must not carry package.json: it
 * lives outside the build's rootDir.
 */
function readVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return UNKNOWN_VERSION;
    const version = (parsed as { version?: unknown }).version;
    return typeof version === "string" && version.trim() !== "" ? version.trim() : UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}

export const VERSION = readVersion();
