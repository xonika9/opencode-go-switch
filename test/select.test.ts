import { describe, expect, test } from "bun:test";
import { blockOf, candidates, exhaustedWindow, isEligible, pickNext } from "../src/select.ts";
import { createAccount } from "../src/types.ts";
import type { Usage } from "../src/types.ts";
import { DAY, HOUR, T0, usage, win } from "./support.ts";

function account(id: string, label: string, value: Usage | null = null) {
  const created = createAccount({ id, label, disabled: false });
  created.usage = value;
  return created;
}

describe("eligibility", () => {
  test("any exhausted window makes the account ineligible", () => {
    const rolling = account("a", "cooper9", usage({ rolling: win(100, T0 + HOUR) }));
    const weekly = account("b", "cooper95", usage({ weekly: win(100, T0 + DAY) }));
    const monthly = account("c", "cooper99", usage({ monthly: win(100, T0 + 10 * DAY) }));

    expect(blockOf(rolling, T0)).toEqual({ kind: "exhausted", label: "5h", until: T0 + HOUR });
    expect(blockOf(weekly, T0)).toEqual({ kind: "exhausted", label: "weekly", until: T0 + DAY });
    expect(blockOf(monthly, T0)).toEqual({ kind: "exhausted", label: "monthly", until: T0 + 10 * DAY });
    expect(isEligible(monthly, T0 + 11 * DAY)).toBe(true);
  });

  test("a window at 100% counts as exhausted even when status is ok", () => {
    const subject = account("a", "cooper9", usage({ monthly: win(100, T0 + DAY) }));
    expect(isEligible(subject, T0)).toBe(false);
  });

  test("a rate-limited window below 100% is still exhausted", () => {
    const subject = account(
      "a",
      "cooper9",
      usage({ weekly: { percent: 40, limited: true, resetsAt: T0 + DAY } }),
    );
    expect(blockOf(subject, T0)).toEqual({ kind: "exhausted", label: "weekly", until: T0 + DAY });
  });

  test("the latest reset governs when several windows are exhausted", () => {
    const subject = account(
      "a",
      "cooper9",
      usage({ rolling: win(100, T0 + HOUR), monthly: win(100, T0 + 5 * DAY) }),
    );
    expect(exhaustedWindow(subject.usage!, T0)).toEqual({
      window: "monthly",
      label: "monthly",
      until: T0 + 5 * DAY,
    });
  });

  test("an exhausted window without a reset time blocks until the next successful poll", () => {
    const subject = account("a", "cooper9", usage({ monthly: { percent: 100, limited: true, resetsAt: null } }));
    expect(isEligible(subject, T0)).toBe(false);
    expect(isEligible(subject, T0 + 365 * DAY)).toBe(false);
  });

  test("a disabled account and an invalid key are not eligible", () => {
    const disabled = createAccount({ id: "a", label: "cooper9", disabled: true });
    const invalid = account("b", "cooper95");
    invalid.invalidKey = true;

    expect(blockOf(disabled, T0)).toEqual({ kind: "disabled" });
    expect(blockOf(invalid, T0)).toEqual({ kind: "invalid-key" });
  });

  test("an account recovers once its exhausted window resets", () => {
    const reset = T0 + 2 * HOUR;
    const subject = account("a", "cooper9", usage({ monthly: win(100, reset) }));

    expect(isEligible(subject, reset - 1)).toBe(false);
    expect(isEligible(subject, reset)).toBe(true);
  });
});

describe("ordering", () => {
  test("the eligible account with the earliest monthly reset wins, unknown reset goes last", () => {
    const late = account("a", "late", usage({ monthly: win(10, T0 + 5 * DAY) }));
    const unknown = account("b", "unknown", usage({ rolling: win(10, T0 + DAY) }));
    const early = account("c", "early", usage({ monthly: win(90, T0 + 2 * DAY) }));

    expect(candidates([late, unknown, early], T0).map((entry) => entry.label)).toEqual([
      "early",
      "late",
      "unknown",
    ]);
  });

  test("ties break by label, then id", () => {
    const reset = T0 + DAY;
    const b = account("id-b", "beta", usage({ monthly: win(10, reset) }));
    const a = account("id-a", "alpha", usage({ monthly: win(10, reset) }));
    const a2 = account("id-0", "alpha", usage({ monthly: win(10, reset) }));

    expect(pickNext([b, a, a2], T0)?.id).toBe("id-0");
  });

  test("accounts with unknown usage are eligible but sort last", () => {
    const known = account("a", "known", usage({ monthly: win(10, T0 + DAY) }));
    const unknown = account("b", "unknown");

    expect(pickNext([unknown, known], T0)?.label).toBe("known");
    expect(pickNext([unknown], T0)?.label).toBe("unknown");
  });

  test("excluded accounts are skipped", () => {
    const a = account("a", "cooper9", usage({ monthly: win(10, T0 + DAY) }));
    const b = account("b", "cooper95", usage({ monthly: win(10, T0 + 2 * DAY) }));

    expect(pickNext([a, b], T0, new Set(["a"]))?.label).toBe("cooper95");
  });

  test("no eligible account means no candidate", () => {
    const a = account("a", "cooper9", usage({ monthly: win(100, T0 + DAY) }));
    expect(pickNext([a], T0)).toBeUndefined();
  });
});
