import { blockOf, WINDOWS } from "./select.ts";
import type { Account } from "./types.ts";

export interface StatusInput {
  readonly accounts: readonly Account[];
  readonly currentID: string | null;
  readonly reason: string;
  readonly now: number;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function relativeTime(until: number, now: number): string {
  const delta = until - now;
  if (delta <= 0) return "now";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 1) return "in <1m";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/** `2026-12-01 (in 13d)`, or a plain fallback when the endpoint gave no reset time. */
export function formatWhen(until: number | null, now: number): string {
  if (until === null) return "next poll";
  return `${isoDate(until)} (${relativeTime(until, now)})`;
}

function describe(account: Account, now: number): string {
  const block = blockOf(account, now);
  if (block === null) return account.usage === null ? "usage unknown" : "eligible";
  switch (block.kind) {
    case "disabled":
      return "disabled";
    case "invalid-key":
      return "invalid key";
    case "exhausted":
      return `exhausted: ${block.label} limit until ${formatWhen(block.until, now)}`;
    case "cooldown":
      return `exhausted: ${block.label} until ${formatWhen(block.until, now)}`;
  }
}

function stateText(account: Account, now: number, current: boolean): string {
  if (current) {
    const block = blockOf(account, now);
    return block === null ? "current" : `current, ${describe(account, now)}`;
  }
  return describe(account, now);
}

function usageLine(account: Account): string {
  const usage = account.usage;
  if (usage === null) {
    return WINDOWS.map((spec) => `${spec.label} unknown`).join(" · ");
  }
  return WINDOWS.map((spec) => `${spec.label} ${Math.round(usage[spec.key].percent)}%`).join(" · ");
}

function resetLine(account: Account, now: number): string {
  const reset = account.usage?.monthly.resetsAt ?? null;
  if (reset === null) return "monthly reset unknown";
  return `monthly resets ${formatWhen(reset, now)}`;
}

/** Plain text for the `go_accounts` tool. Never contains credential material. */
export function formatStatus(input: StatusInput): string {
  const current = input.accounts.find((account) => account.id === input.currentID);
  const lines: string[] = [`OpenCode Go accounts (${input.accounts.length} connected)`];
  lines.push(`current: ${current === undefined ? "none" : `${current.label} - ${input.reason}`}`);

  if (input.accounts.length === 0) {
    lines.push("", "No OpenCode Go keys are connected. Add one under Integrations in OpenCode settings.");
    return lines.join("\n");
  }

  for (const account of input.accounts) {
    const isCurrent = account.id === input.currentID;
    lines.push("", `${account.label} - ${stateText(account, input.now, isCurrent)}`);
    lines.push(`  ${usageLine(account)}`);
    lines.push(`  ${resetLine(account, input.now)}`);
  }
  return lines.join("\n");
}
