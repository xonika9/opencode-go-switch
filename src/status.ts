import { classify, isUsable, monthlyReset, WINDOWS } from "./select.ts";
import type { Block, Classification } from "./select.ts";
import type { Account } from "./types.ts";

/** The most recent switch, kept apart from the current reason so a status still explains it later. */
export interface LastSwitch {
  readonly from: string | null;
  readonly to: string;
  readonly cause: string;
  readonly at: number;
}

export interface StatusInput {
  readonly version: string;
  readonly accounts: readonly Account[];
  readonly currentID: string | null;
  readonly reason: string;
  readonly lastSwitch: LastSwitch | null;
  readonly now: number;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Rounds a positive span to whole minutes, hours, or days: `13m`, `5h`, `2d`. */
function span(delta: number): string {
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function relativeTime(until: number, now: number): string {
  const delta = until - now;
  if (delta <= 0) return "now";
  if (Math.round(delta / 60_000) < 1) return "in <1m";
  return `in ${span(delta)}`;
}

/** `2026-12-01 (in 13d)`, or a plain fallback when the endpoint gave no reset time. */
export function formatWhen(until: number | null, now: number): string {
  if (until === null) return "next poll";
  return `${isoDate(until)} (${relativeTime(until, now)})`;
}

/** A full instant, for blockers measured in minutes rather than days. */
export function formatMoment(until: number, now: number): string {
  return `${new Date(until).toISOString()} (${relativeTime(until, now)})`;
}

/** How long ago something happened, for the last switch line. */
function formatAgo(at: number, now: number): string {
  const delta = now - at;
  if (delta < 60_000) return "just now";
  return `${span(delta)} ago`;
}

/** What keeps an account out, or how it stands, in the words the tool prints. */
export function describeState(state: Classification, now: number): string {
  switch (state.kind) {
    case "eligible":
      return "eligible";
    case "unknown":
      return "usage unknown";
    case "disabled":
      return "disabled";
    case "invalid-key":
      return "invalid key";
    case "exhausted":
      return `exhausted: ${state.label} until ${formatWhen(state.until, now)}`;
    case "cooldown":
      return `cooling down until ${formatMoment(state.until, now)}`;
  }
}

/** The refusal sentence for a label that cannot be selected, printed above the status. */
export function formatRefusal(label: string, block: Block, now: number): string {
  const reason = block.kind === "invalid-key" ? "has an invalid key" : `is ${describeState(block, now)}`;
  return `Refused: "${label}" ${reason}.`;
}

/** The refusal for a label no connected account carries. */
export function formatUnknownLabel(wanted: string, labels: readonly string[]): string {
  const known = labels.length === 0 ? "none" : labels.join(", ");
  return `Refused: no connected account is labelled "${wanted}". Connected accounts: ${known}.`;
}

/** The refusal for a label several connected accounts share. */
export function formatAmbiguousLabel(wanted: string, labels: readonly string[]): string {
  return `Refused: ${labels.length} connected accounts are labelled "${wanted}" (${labels.join(", ")}); rename one of them before selecting it.`;
}

/** One decimal only where whole numbers would hide that a window is nearly full. */
function percentText(percent: number): string {
  const rounded = Math.round(percent * 10) / 10;
  if (rounded >= 99 && rounded < 100) return `${rounded.toFixed(1)}%`;
  return `${Math.round(rounded)}%`;
}

function usageLine(account: Account): string {
  const usage = account.usage;
  if (usage === null) {
    return WINDOWS.map((spec) => `${spec.label} unknown`).join(" · ");
  }
  return WINDOWS.map((spec) => `${spec.label} ${percentText(usage[spec.key].percent)}`).join(" · ");
}

function resetLine(account: Account, now: number): string {
  const reset = monthlyReset(account);
  if (reset === null) return "monthly reset unknown";
  return `monthly resets ${formatWhen(reset, now)}`;
}

function lastSwitchLine(last: LastSwitch | null, now: number): string {
  if (last === null) return "last switch: none";
  const from = last.from ?? "none";
  return `last switch: ${from} → ${last.to}, ${last.cause}, ${new Date(last.at).toISOString()} (${formatAgo(last.at, now)})`;
}

/**
 * Why the current account is current. The stored reason describes the last decision; when a later poll
 * found the account blocked, its present state replaces that reason so the line never contradicts the
 * account block below it.
 */
function currentReason(current: Account, input: StatusInput): string {
  const state = classify(current, input.now);
  return isUsable(state) ? input.reason : describeState(state, input.now);
}

/** Plain text for the `go_accounts` tool. Never contains credential material. */
export function formatStatus(input: StatusInput): string {
  const current = input.accounts.find((account) => account.id === input.currentID);
  const lines: string[] = [
    `Go Switch ${input.version}`,
    `OpenCode Go accounts (${input.accounts.length} connected)`,
    `current: ${current === undefined ? "none" : `${current.label} - ${currentReason(current, input)}`}`,
    lastSwitchLine(input.lastSwitch, input.now),
  ];

  if (input.accounts.length === 0) {
    lines.push("", "No OpenCode Go keys are connected. Add one under Integrations in OpenCode settings.");
    return lines.join("\n");
  }

  for (const account of input.accounts) {
    const isCurrent = account.id === input.currentID;
    const state = describeState(classify(account, input.now), input.now);
    lines.push("", `${account.label}${isCurrent ? " (current)" : ""} - ${state}`);
    lines.push(`  ${usageLine(account)}`);
    lines.push(`  ${resetLine(account, input.now)}`);
  }
  return lines.join("\n");
}
