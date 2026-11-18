import type { Usage, UsageWindow } from "./types.ts";

export const DEFAULT_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

/** Enforced while reading the body, so a lying Content-Length cannot get past it. */
export const MAX_USAGE_BYTES = 64 * 1024;

export type UsageResult =
  | { readonly type: "usage"; readonly usage: Usage }
  | { readonly type: "invalid-key" }
  | { readonly type: "unavailable" };

const unavailable: UsageResult = { type: "unavailable" };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseWindow(value: unknown): UsageWindow | null {
  const window = asRecord(value);
  if (window === null) return null;
  if (window.status !== "ok" && window.status !== "rate-limited") return null;
  const percent = window.percent;
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0) return null;
  let resetsAt: number | null = null;
  if (typeof window.resetsAt === "string") {
    const parsed = Date.parse(window.resetsAt);
    if (Number.isFinite(parsed)) resetsAt = parsed;
  }
  return {
    percent,
    limited: window.status === "rate-limited" || percent >= 100,
    resetsAt,
  };
}

/**
 * Tolerant parser for the undocumented usage payload. Any shape we do not understand becomes "unknown",
 * never a guess; extra fields are ignored.
 */
export function parseUsage(input: unknown): Usage | null {
  const root = asRecord(input);
  if (root === null) return null;
  const usage = asRecord(root.usage);
  if (usage === null) return null;
  const rolling = parseWindow(usage.rolling);
  const weekly = parseWindow(usage.weekly);
  const monthly = parseWindow(usage.monthly);
  if (rolling === null || weekly === null || monthly === null) return null;
  return { rolling, weekly, monthly };
}

/** Minimal fetch shape, so callers and tests do not have to carry the full Bun `fetch` type. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface FetchUsageOptions {
  readonly fetch: FetchLike;
  readonly url: string;
  readonly timeoutMs: number;
  readonly maxBytes?: number;
}

/** Reads at most `maxBytes` of the body and returns null when the limit is crossed. */
async function readCapped(response: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function fetchUsage(key: string, options: FetchUsageOptions): Promise<UsageResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, options.timeoutMs));
  try {
    const response = await options.fetch(options.url, {
      method: "GET",
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      return { type: "invalid-key" };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return unavailable;
    }
    const text = await readCapped(response, options.maxBytes ?? MAX_USAGE_BYTES);
    if (text === null) return unavailable;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return unavailable;
    }
    const usage = parseUsage(parsed);
    return usage === null ? unavailable : { type: "usage", usage };
  } catch {
    return unavailable;
  } finally {
    clearTimeout(timer);
  }
}

/** `Retry-After` in ms from now, accepting both delay-seconds and an HTTP date. */
export function retryAfterMs(header: string | null, now: number): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (trimmed === "") return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return null;
}
