import { describe, expect, test } from "bun:test";
import { candidates, classify, pickNext, usableAsCurrent } from "../src/select.ts";
import { createAccount } from "../src/types.ts";
import type { Account, Usage } from "../src/types.ts";
import { DAY, HOUR, T0, usage, win } from "./support.ts";

function account(id: string, label: string, value: Usage | null = null): Account {
  const created = createAccount({ id, label, disabled: false });
  created.usage = value;
  return created;
}

describe("ordering", () => {
  test("eligible accounts come first by earliest monthly reset, then those without one, then unknown usage", () => {
    const current = account("a", "alpha", usage({ weekly: win(100, T0 + 2 * DAY) }));
    const tenDays = account("b", "bravo", usage({ monthly: win(20, T0 + 10 * DAY) }));
    const threeDays = account("c", "charlie", usage({ monthly: win(40, T0 + 3 * DAY) }));
    const noReset = account("e", "echo", usage({ monthly: win(30, null) }));
    const pastReset = account("f", "foxtrot", usage({ monthly: win(30, T0 - DAY) }));
    const unknown = account("d", "delta");

    const ordered = candidates([current, tenDays, threeDays, noReset, pastReset, unknown], T0, new Set(["a"]));

    expect(ordered.map((entry) => entry.label)).toEqual(["charlie", "bravo", "echo", "foxtrot", "delta"]);
    expect(pickNext([current, unknown, threeDays], T0, new Set(["a"]))?.label).toBe("charlie");
  });

  test("equal monthly resets order by label, then id", () => {
    const reset = T0 + DAY;
    const beta = account("id-b", "beta", usage({ monthly: win(10, reset) }));
    const alpha = account("id-a", "alpha", usage({ monthly: win(10, reset) }));
    const sameLabel = account("id-0", "alpha", usage({ monthly: win(10, reset) }));

    expect(candidates([beta, alpha, sameLabel], T0).map((entry) => entry.id)).toEqual(["id-0", "id-a", "id-b"]);
    expect(pickNext([beta, alpha, sameLabel], T0)?.id).toBe("id-0");
  });

  test("excluded accounts are skipped", () => {
    const a = account("a", "cooper9", usage({ monthly: win(10, T0 + DAY) }));
    const b = account("b", "cooper95", usage({ monthly: win(10, T0 + 2 * DAY) }));

    expect(pickNext([a, b], T0, new Set(["a"]))?.label).toBe("cooper95");
  });
});

describe("eligibility", () => {
  test("a monthly limit makes an account exhausted until its reset, so the other account is the only candidate", () => {
    const cooper9 = account("a", "cooper9", usage({ monthly: win(100, T0 + 4 * DAY) }));
    const cooper95 = account("b", "cooper95", usage({ monthly: win(85, T0 + 23 * DAY) }));

    expect(candidates([cooper9, cooper95], T0).map((entry) => entry.label)).toEqual(["cooper95"]);
    expect(pickNext([cooper9, cooper95], T0)?.label).toBe("cooper95");
  });

  test("a window whose reset has passed no longer blocks, while a window without a reset blocks indefinitely", () => {
    const recovered = account("a", "recovered", usage({ monthly: win(100, T0 + HOUR) }));
    const noReset = account("b", "no-reset", usage({ monthly: { percent: 100, limited: true, resetsAt: null } }));

    expect(candidates([recovered], T0 + HOUR).map((entry) => entry.label)).toEqual(["recovered"]);
    expect(candidates([recovered], T0 + HOUR - 1)).toEqual([]);
    expect(candidates([noReset], T0 + 365 * DAY)).toEqual([]);
  });

  test("a rate-limited window below 100% is still exhausted", () => {
    const subject = account(
      "a",
      "cooper9",
      usage({ weekly: { percent: 40, limited: true, resetsAt: T0 + DAY } }),
    );
    expect(candidates([subject], T0)).toEqual([]);
  });

  test("a disabled account, an invalid key, and a cooling-down account are never candidates", () => {
    const disabled = createAccount({ id: "a", label: "disabled", disabled: true });
    const invalid = account("b", "invalid");
    invalid.invalidKey = true;
    const cooling = account("c", "cooling");
    cooling.cooldownUntil = T0 + HOUR;

    expect(candidates([disabled, invalid, cooling], T0)).toEqual([]);
    expect(pickNext([disabled, invalid, cooling], T0)).toBeUndefined();
  });

  test("a cooling-down account with unknown usage is an unknown candidate once the cooldown ends", () => {
    const cooling = account("a", "cooling");
    cooling.cooldownUntil = T0 + HOUR;
    const known = account("b", "known", usage({ monthly: win(10, T0 + DAY) }));

    expect(candidates([cooling, known], T0)).toEqual([known]);
    expect(candidates([cooling, known], T0 + HOUR).map((entry) => entry.label)).toEqual([
      "known",
      "cooling",
    ]);
  });
});

describe("classification", () => {
  test("a single exhausted window names itself and its reset", () => {
    const cooper9 = account("a", "cooper9", usage({ monthly: win(100, T0 + 4 * DAY) }));
    const cooper95 = account("b", "cooper95", usage({ monthly: win(85, T0 + 23 * DAY) }));

    expect(classify(cooper9, T0)).toEqual({ kind: "exhausted", label: "monthly", until: T0 + 4 * DAY });
    expect(classify(cooper95, T0)).toEqual({ kind: "eligible" });
  });

  test("the latest reset governs when several windows are exhausted", () => {
    const subject = account(
      "a",
      "cooper9",
      usage({ rolling: win(100, T0 + HOUR), monthly: win(100, T0 + 5 * DAY) }),
    );

    expect(classify(subject, T0)).toEqual({ kind: "exhausted", label: "monthly", until: T0 + 5 * DAY });
    expect(candidates([subject], T0 + 5 * DAY - 1)).toEqual([]);
  });

  test("a cooldown and an exhausted Go window report different block kinds", () => {
    const exhausted = account("a", "cooper9", usage({ weekly: win(100, T0 + DAY) }));
    const cooling = account("b", "cooper95");
    cooling.cooldownUntil = T0 + HOUR;

    expect(classify(exhausted, T0)).toEqual({ kind: "exhausted", label: "weekly", until: T0 + DAY });
    expect(classify(cooling, T0)).toEqual({ kind: "cooldown", until: T0 + HOUR });
    expect(classify(cooling, T0 + HOUR).kind).toBe("unknown");
  });

  test("a disabled account and an invalid key are their own blocks", () => {
    const disabled = createAccount({ id: "a", label: "cooper9", disabled: true });
    const invalid = account("b", "cooper95");
    invalid.invalidKey = true;

    expect(classify(disabled, T0)).toEqual({ kind: "disabled" });
    expect(classify(invalid, T0)).toEqual({ kind: "invalid-key" });
  });

  test("unknown usage is usable as current but only known usage is eligible", () => {
    const known = account("a", "known", usage({ monthly: win(10, T0 + DAY) }));
    const unknown = account("b", "unknown");
    const exhausted = account("c", "exhausted", usage({ monthly: win(100, T0 + DAY) }));

    expect(classify(known, T0)).toEqual({ kind: "eligible" });
    expect(classify(unknown, T0)).toEqual({ kind: "unknown" });
    expect(usableAsCurrent(known, T0)).toBe(true);
    expect(usableAsCurrent(unknown, T0)).toBe(true);
    expect(usableAsCurrent(exhausted, T0)).toBe(false);
  });
});
