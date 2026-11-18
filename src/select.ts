import type { Account, Usage, WindowName } from "./types.ts";

export interface WindowSpec {
  readonly key: WindowName;
  readonly label: string;
}

/** Ordered as they are shown: shortest window first. */
export const WINDOWS: readonly WindowSpec[] = [
  { key: "rolling", label: "5h" },
  { key: "weekly", label: "weekly" },
  { key: "monthly", label: "monthly" },
];

export interface ExhaustedWindow {
  readonly window: WindowName;
  readonly label: string;
  /** Reset time, or null when unknown: then the window stays exhausted until the next successful poll. */
  readonly until: number | null;
}

const infinity = (value: number | null): number => value ?? Number.POSITIVE_INFINITY;

/**
 * The exhausted window that keeps an account out the longest, or null when every window has headroom.
 * A window without a usable reset time counts as exhausted indefinitely.
 */
export function exhaustedWindow(usage: Usage, now: number): ExhaustedWindow | null {
  let found: ExhaustedWindow | null = null;
  for (const spec of WINDOWS) {
    const window = usage[spec.key];
    if (!window.limited) continue;
    if (window.resetsAt !== null && now >= window.resetsAt) continue;
    if (found === null || infinity(window.resetsAt) > infinity(found.until)) {
      found = { window: spec.key, label: spec.label, until: window.resetsAt };
    }
  }
  return found;
}

/** Why an account cannot be used right now. */
export type Block =
  | { readonly kind: "disabled" }
  | { readonly kind: "invalid-key" }
  | { readonly kind: "exhausted"; readonly label: string; readonly until: number | null }
  | { readonly kind: "cooldown"; readonly until: number };

/**
 * Where an account stands at one moment: usable with known headroom, usable with usage nobody has read
 * yet, or blocked for a stated reason.
 */
export type Classification =
  | { readonly kind: "eligible" }
  | { readonly kind: "unknown" }
  | Block;

/**
 * The single place that decides whether an account may carry a request. A disabled account, an invalid
 * key, an exhausted Go window, and a cooldown each report their own block; everything else is eligible
 * when usage is known and unknown when it was never read or the last read never produced a usage record.
 */
export function classify(account: Account, now: number): Classification {
  if (account.disabled) return { kind: "disabled" };
  if (account.invalidKey) return { kind: "invalid-key" };
  if (account.usage !== null) {
    const exhausted = exhaustedWindow(account.usage, now);
    if (exhausted !== null) {
      return { kind: "exhausted", label: exhausted.label, until: exhausted.until };
    }
  }
  if (account.cooldownUntil !== null && now < account.cooldownUntil) {
    return { kind: "cooldown", until: account.cooldownUntil };
  }
  return account.usage === null ? { kind: "unknown" } : { kind: "eligible" };
}

/** True while the account may stay in use: known headroom, or usage nobody has read yet. */
export function usableAsCurrent(account: Account, now: number): boolean {
  const kind = classify(account, now).kind;
  return kind === "eligible" || kind === "unknown";
}

/** True only when every Go window is known to have headroom. */
export function hasKnownHeadroom(account: Account, now: number): boolean {
  return classify(account, now).kind === "eligible";
}

/** A short phrase naming the account and what stops it, for notifications. */
export function causeOf(account: Account, state: Classification): string {
  switch (state.kind) {
    case "eligible":
      return `${account.label} has headroom`;
    case "unknown":
      return `${account.label} usage unknown`;
    case "disabled":
      return `${account.label} disabled`;
    case "invalid-key":
      return `${account.label} invalid key`;
    case "exhausted":
      return `${account.label} ${state.label} limit`;
    case "cooldown":
      return `${account.label} cooling down`;
  }
}

export function monthlyReset(account: Account): number | null {
  return account.usage?.monthly.resetsAt ?? null;
}

/** Order groups for a forced switch: soonest monthly reset, then no usable reset, then usage unknown. */
const RESET_FIRST = 0;
const RESET_LAST = 1;
const UNKNOWN = 2;

interface Ranked {
  readonly account: Account;
  readonly group: number;
  /** Sort key inside a group: the monthly reset itself, or null when there is no usable one. */
  readonly reset: number | null;
}

function rankOf(account: Account, now: number): Ranked | null {
  const state = classify(account, now);
  if (state.kind === "unknown") {
    return { account, group: UNKNOWN, reset: null };
  }
  if (state.kind !== "eligible") return null;
  const reset = monthlyReset(account);
  if (reset === null || reset <= now) {
    return { account, group: RESET_LAST, reset: null };
  }
  return { account, group: RESET_FIRST, reset };
}

function compare(a: Ranked, b: Ranked): number {
  if (a.group !== b.group) return a.group - b.group;
  const aReset = a.reset ?? Number.POSITIVE_INFINITY;
  const bReset = b.reset ?? Number.POSITIVE_INFINITY;
  if (aReset !== bReset) return aReset - bReset;
  const byLabel = a.account.label.localeCompare(b.account.label, "en");
  if (byLabel !== 0) return byLabel;
  return a.account.id.localeCompare(b.account.id);
}

/**
 * Accounts a forced switch may move to, in the order it wants them: eligible accounts by earliest
 * monthly reset, eligible accounts without a usable reset next, then accounts with unknown usage.
 * Ties break by label, then id.
 */
export function candidates(
  accounts: readonly Account[],
  now: number,
  exclude?: ReadonlySet<string>,
): Account[] {
  const ranked: Ranked[] = [];
  for (const account of accounts) {
    if (exclude?.has(account.id) === true) continue;
    const entry = rankOf(account, now);
    if (entry !== null) ranked.push(entry);
  }
  ranked.sort(compare);
  return ranked.map((entry) => entry.account);
}

/** The first of `candidates`; undefined when no account may carry a request. */
export function pickNext(
  accounts: readonly Account[],
  now: number,
  exclude?: ReadonlySet<string>,
): Account | undefined {
  return candidates(accounts, now, exclude)[0];
}
