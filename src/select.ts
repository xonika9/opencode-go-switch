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

export type Block =
  | { readonly kind: "disabled" }
  | { readonly kind: "invalid-key" }
  | { readonly kind: "exhausted"; readonly label: string; readonly until: number | null }
  | { readonly kind: "cooldown"; readonly label: string; readonly until: number };

/** Why an account cannot be used right now, or null when it can. */
export function blockOf(account: Account, now: number): Block | null {
  if (account.disabled) return { kind: "disabled" };
  if (account.invalidKey) return { kind: "invalid-key" };
  if (account.usage !== null) {
    const exhausted = exhaustedWindow(account.usage, now);
    if (exhausted !== null) {
      return { kind: "exhausted", label: exhausted.label, until: exhausted.until };
    }
  }
  if (account.blockedUntil !== null && now < account.blockedUntil) {
    return { kind: "cooldown", label: account.blockedLabel ?? "limit", until: account.blockedUntil };
  }
  return null;
}

export function isEligible(account: Account, now: number): boolean {
  return blockOf(account, now) === null;
}

/** A short phrase naming the account and what stops it, for notifications. */
export function causeOf(account: Account, block: Block | null): string {
  if (block === null) return `${account.label} has headroom`;
  switch (block.kind) {
    case "disabled":
      return `${account.label} disabled`;
    case "invalid-key":
      return `${account.label} invalid key`;
    case "exhausted":
      return `${account.label} ${block.label} limit`;
    case "cooldown":
      return `${account.label} limit`;
  }
}

export function monthlyReset(account: Account): number | null {
  return account.usage?.monthly.resetsAt ?? null;
}

function compare(a: Account, b: Account): number {
  const resetA = infinity(monthlyReset(a));
  const resetB = infinity(monthlyReset(b));
  if (resetA !== resetB) return resetA - resetB;
  const byLabel = a.label.localeCompare(b.label, "en");
  if (byLabel !== 0) return byLabel;
  return a.id.localeCompare(b.id);
}

/** Eligible accounts in the order rule 3 wants them. */
export function candidates(
  accounts: readonly Account[],
  now: number,
  exclude?: ReadonlySet<string>,
): Account[] {
  return accounts
    .filter((account) => !exclude?.has(account.id) && isEligible(account, now))
    .sort(compare);
}

/** The eligible account with the earliest monthly reset; unknown reset goes last. */
export function pickNext(
  accounts: readonly Account[],
  now: number,
  exclude?: ReadonlySet<string>,
): Account | undefined {
  return candidates(accounts, now, exclude)[0];
}
