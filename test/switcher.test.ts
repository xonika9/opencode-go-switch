import { describe, expect, test } from "bun:test";
import type { RetryInput } from "../src/switcher.ts";
import { createHarness, DAY, HOUR, jsonRequest, keyOf, MINUTE, T0, usage, win } from "./support.ts";

const provider = { providerID: "opencode-go" };

const allAccounts = [
  { id: "c9", label: "cooper9", key: "fake-key-cooper9-9f8e7d" },
  { id: "c95", label: "cooper95", key: "fake-key-cooper95-1a2b3c" },
  { id: "c99", label: "cooper99", key: "fake-key-cooper99-4d5e6f" },
];
const accounts = allAccounts.slice(0, 2);

const KEY_C9 = "fake-key-cooper9-9f8e7d";
const KEY_C95 = "fake-key-cooper95-1a2b3c";
const KEY_C99 = "fake-key-cooper99-4d5e6f";

function exhaustedMonthly(reset: number) {
  return { type: "usage" as const, usage: usage({ monthly: win(100, reset) }) };
}

function headroom(monthly: number, reset: number) {
  return { type: "usage" as const, usage: usage({ monthly: win(monthly, reset) }) };
}

function limitedWeekly(reset: number) {
  return { type: "usage" as const, usage: usage({ weekly: win(100, reset) }) };
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function sentWith(harness: ReturnType<typeof createHarness>) {
  const input = { model: provider, request: jsonRequest() };
  await harness.switcher.onRequest(input);
  return input;
}

describe("choosing an account for a request", () => {
  test("the first request waits for the startup poll instead of taking an alphabetical unknown", async () => {
    const harness = createHarness({
      accounts,
      usage: { c9: exhaustedMonthly(T0 + 4 * DAY), c95: headroom(85, T0 + 23 * DAY) },
      usageDelayMs: { c9: 25, c95: 25 },
      options: { usageTimeoutMs: 2_000 },
    });
    await harness.switcher.init();

    const input = { model: provider, request: jsonRequest() };
    await harness.switcher.onRequest(input);

    expect(keyOf(input.request.headers)).toBe(KEY_C95);
    expect(harness.stored()).toBe("c95");
    expect(harness.activated).toEqual(["c95"]);
    expect(harness.notifications).toEqual([{ label: "cooper95", reason: "startup: earliest monthly reset" }]);
  });

  test("a monthly-exhausted current account switches before the request goes out", async () => {
    const harness = createHarness({
      accounts,
      stored: "c9",
      usage: { c9: exhaustedMonthly(T0 + 20 * DAY), c95: headroom(85, T0 + 10 * DAY) },
    });
    await harness.switcher.init();
    await harness.switcher.refresh();

    const input = await sentWith(harness);

    expect(keyOf(input.request.headers)).toBe(KEY_C95);
    expect(harness.stored()).toBe("c95");
    expect(harness.activated).toEqual(["c95"]);
    expect(harness.notifications).toEqual([{ label: "cooper95", reason: "cooper9 monthly limit" }]);
    expect(await harness.switcher.status()).toContain("current: cooper95 - switched: cooper9 monthly limit");
  });

  test("stays on the current account when another one recovers", async () => {
    const harness = createHarness({
      accounts,
      stored: "c95",
      usage: { c9: exhaustedMonthly(T0 + DAY), c95: headroom(40, T0 + 10 * DAY) },
    });
    await harness.switcher.init();
    await harness.switcher.refresh();

    harness.setNow(T0 + 2 * DAY);
    const first = await sentWith(harness);
    const second = await sentWith(harness);

    expect(keyOf(first.request.headers)).toBe(KEY_C95);
    expect(keyOf(second.request.headers)).toBe(KEY_C95);
    expect(harness.activated).toEqual([]);
    expect(harness.notifications).toEqual([]);

    const text = await harness.switcher.status();
    expect(text).toContain("cooper9 - eligible");
    expect(text).toContain("current: cooper95 - sticky: still has headroom");

    harness.setUsage("c95", exhaustedMonthly(T0 + 30 * DAY));
    await harness.switcher.refresh();
    const third = await sentWith(harness);
    expect(keyOf(third.request.headers)).toBe(KEY_C9);
  });

  test("an empty account list leaves the request untouched", async () => {
    const harness = createHarness({ accounts: [] });
    await harness.switcher.init();

    const request = jsonRequest();
    const input = { model: provider, request };
    await harness.switcher.onRequest(input);

    expect(input.request).toBe(request);
    expect(harness.activated).toEqual([]);
  });

  test("leaves the request untouched when every account is exhausted", async () => {
    const harness = createHarness({
      accounts,
      stored: "c9",
      usage: { c9: exhaustedMonthly(T0 + DAY), c95: exhaustedMonthly(T0 + DAY) },
    });
    await harness.switcher.init();
    await harness.switcher.refresh();

    const request = jsonRequest();
    const input = { model: provider, request };
    await harness.switcher.onRequest(input);

    expect(input.request).toBe(request);
    expect(harness.activated).toEqual([]);
  });

  test("a stored id that no longer exists falls back to the rule", async () => {
    const harness = createHarness({
      accounts,
      stored: "gone",
      usage: { c9: exhaustedMonthly(T0 + 4 * DAY), c95: headroom(85, T0 + 23 * DAY) },
    });
    await harness.switcher.init();

    const input = await sentWith(harness);

    expect(keyOf(input.request.headers)).toBe(KEY_C95);
    expect(harness.stored()).toBe("c95");
  });

  test("replaces an x-api-key instead of adding an authorization header", async () => {
    const harness = createHarness({ accounts, stored: "c9" });
    await harness.switcher.init();

    const input = { model: provider, request: jsonRequest("x-api-key") };
    await harness.switcher.onRequest(input);

    expect(input.request.headers.get("x-api-key")).toBe(KEY_C9);
    expect(input.request.headers.get("authorization")).toBeNull();
  });

  test("sets both headers when the request carries both", async () => {
    const harness = createHarness({ accounts, stored: "c9" });
    await harness.switcher.init();

    const input = { model: provider, request: jsonRequest("both") };
    await harness.switcher.onRequest(input);

    expect(input.request.headers.get("x-api-key")).toBe(KEY_C9);
    expect(input.request.headers.get("authorization")).toBe(`Bearer ${KEY_C9}`);
  });

  test("never throws when the credential cannot be resolved", async () => {
    const harness = createHarness({ accounts: [accounts[0]!], unresolvable: ["c9"] });
    await harness.switcher.init();

    const input = { model: provider, request: jsonRequest() };
    await harness.switcher.onRequest(input);

    expect(input.request.headers.get("authorization")).toBe("Bearer opencode-managed");
  });

  test("a third connected account becomes a candidate after the next poll", async () => {
    const harness = createHarness({
      accounts,
      stored: "c9",
      usage: { c9: headroom(20, T0 + 20 * DAY), c95: exhaustedMonthly(T0 + 10 * DAY) },
    });
    await harness.switcher.init();
    await harness.switcher.refresh();

    const first = await sentWith(harness);
    expect(keyOf(first.request.headers)).toBe(KEY_C9);

    harness.addAccount({ id: "c99", label: "cooper99", key: KEY_C99 });
    harness.setUsage("c99", headroom(10, T0 + DAY));
    harness.setUsage("c9", exhaustedMonthly(T0 + 5 * DAY));
    await harness.switcher.refresh();

    const second = await sentWith(harness);
    expect(harness.switcher.snapshot().accounts.map((account) => account.id)).toContain("c99");
    expect(keyOf(second.request.headers)).toBe(KEY_C99);
  });
});

describe("limits inside the response hook", () => {
  test("a weekly limit ends on the earliest-monthly-reset candidate in the same call", async () => {
    const harness = createHarness({
      accounts: allAccounts,
      stored: "c9",
      usage: {
        c9: headroom(30, T0 + 3 * DAY),
        c95: headroom(20, T0 + 5 * DAY),
        c99: headroom(60, T0 + DAY),
      },
    });
    await harness.switcher.init();
    await harness.switcher.refresh();

    const requestInput = { model: provider, request: jsonRequest() };
    await harness.switcher.onRequest(requestInput);
    expect(keyOf(requestInput.request.headers)).toBe(KEY_C9);
    const url = requestInput.request.url;
    const body = await requestInput.request.clone().text();

    harness.setUsage("c9", limitedWeekly(T0 + 2 * DAY));
    const responseInput = {
      model: provider,
      request: requestInput.request,
      response: new Response("limited", { status: 429 }),
    };
    await harness.switcher.onResponse(responseInput);

    expect(responseInput.response.status).toBe(200);
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]?.key).toBe(KEY_C99);
    expect(harness.sent[0]?.url).toBe(url);
    expect(harness.sent[0]?.method).toBe("POST");
    expect(harness.sent[0]?.body).toBe(body);
    expect(harness.sent[0]?.redirect).toBe("manual");
    expect(harness.notifications).toEqual([{ label: "cooper99", reason: "cooper9 weekly limit" }]);
  });

  test("a 429 that fresh usage does not explain leaves the response alone", async () => {
    const harness = createHarness({
      accounts,
      stored: "c9",
      usage: { c9: headroom(20, T0 + 2 * DAY), c95: headroom(20, T0 + 5 * DAY) },
    });
    await harness.switcher.init();
    await harness.switcher.refresh();

    const requestInput = await sentWith(harness);
    const limited = new Response("rate limited", { status: 429 });
    const responseInput = { model: provider, request: requestInput.request, response: limited };
    await harness.switcher.onResponse(responseInput);

    expect(responseInput.response).toBe(limited);
    expect(harness.sent).toHaveLength(0);
    expect(harness.activated).toEqual([]);
    expect(harness.notifications).toEqual([]);
    expect(harness.stored()).toBe("c9");
  });

  test("a 402 is handled like a 429", async () => {
    const harness = createHarness({
      accounts,
      stored: "c9",
      usage: { c9: headroom(20, T0 + 2 * DAY), c95: headroom(20, T0 + 5 * DAY) },
    });
    await harness.switcher.init();
    await harness.switcher.refresh();

    const requestInput = await sentWith(harness);
    harness.setUsage("c9", exhaustedMonthly(T0 + 3 * DAY));
    const responseInput = {
      model: provider,
      request: requestInput.request,
      response: new Response("payment required", { status: 402 }),
    };
    await harness.switcher.onResponse(responseInput);

    expect(responseInput.response.status).toBe(200);
    expect(harness.sent[0]?.key).toBe(KEY_C95);
  });

  test("a 401 marks the key invalid and retries on the next account", async () => {
    const harness = createHarness({ accounts, stored: "c9", usage: { c95: headroom(20, T0 + 2 * DAY) } });
    await harness.switcher.init();
    await harness.switcher.refresh();

    const requestInput = await sentWith(harness);
    const responseInput = {
      model: provider,
      request: requestInput.request,
      response: new Response("nope", { status: 401 }),
    };
    await harness.switcher.onResponse(responseInput);

    expect(responseInput.response.status).toBe(200);
    expect(harness.sent[0]?.key).toBe(KEY_C95);
    expect(harness.notifications).toEqual([{ label: "cooper95", reason: "cooper9 invalid key" }]);
    expect(harness.switcher.snapshot().accounts.find((account) => account.id === "c9")?.invalidKey).toBe(true);
  });

  test("a 403 changes nothing and is returned unchanged", async () => {
    const harness = createHarness({
      accounts,
      stored: "c9",
      usage: { c9: headroom(20, T0 + 2 * DAY), c95: headroom(20, T0 + 5 * DAY) },
    });
    await harness.switcher.init();
    await harness.switcher.refresh();

    const requestInput = await sentWith(harness);
    const forbidden = new Response("forbidden", { status: 403 });
    const responseInput = { model: provider, request: requestInput.request, response: forbidden };
    await harness.switcher.onResponse(responseInput);

    expect(responseInput.response).toBe(forbidden);
    expect(harness.sent).toHaveLength(0);
    expect(harness.activated).toEqual([]);
    expect(harness.notifications).toEqual([]);
    expect(harness.stored()).toBe("c9");
  });

  test("a 403 on the retried account reaches OpenCode instead of the first limit", async () => {
    const harness = createHarness({
      accounts,
      stored: "c9",
      usage: { c9: headroom(20, T0 + 2 * DAY), c95: headroom(20, T0 + 5 * DAY) },
      respond: () => new Response("forbidden", { status: 403 }),
    });
    await harness.switcher.init();
    await harness.switcher.refresh();

    const requestInput = await sentWith(harness);
    expect(keyOf(requestInput.request.headers)).toBe(KEY_C9);
    harness.setUsage("c9", exhaustedMonthly(T0 + 3 * DAY));
    const limited = new Response("rate limited", { status: 429 });
    const responseInput = { model: provider, request: requestInput.request, response: limited };
    await harness.switcher.onResponse(responseInput);

    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]?.key).toBe(KEY_C95);
    expect(responseInput.response).not.toBe(limited);
    expect(responseInput.response.status).toBe(403);
    expect(await responseInput.response.text()).toBe("forbidden");
  });

  test("a retry that receives a redirect returns it without following it", async () => {
    const harness = createHarness({
      accounts,
      stored: "c9",
      usage: { c9: headroom(20, T0 + 2 * DAY), c95: headroom(20, T0 + 5 * DAY) },
      respond: () => new Response(null, { status: 302, headers: { location: "https://example.test/elsewhere" } }),
    });
    await harness.switcher.init();
    await harness.switcher.refresh();

    const requestInput = await sentWith(harness);
    harness.setUsage("c9", exhaustedMonthly(T0 + 3 * DAY));
    const responseInput = {
      model: provider,
      request: requestInput.request,
      response: new Response("limited", { status: 429 }),
    };
    await harness.switcher.onResponse(responseInput);

    expect(responseInput.response.status).toBe(302);
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]?.redirect).toBe("manual");
  });

  test("all accounts exhausted: the first 429 stands and OpenCode's retry is stopped", async () => {
    const harness = createHarness({
      accounts,
      stored: "c9",
      usage: { c9: exhaustedMonthly(T0 + DAY), c95: exhaustedMonthly(T0 + 2 * DAY) },
    });
    await harness.switcher.init();
    await harness.switcher.refresh();

    const limited = new Response("rate limited", { status: 429 });
    const input = { model: provider, request: jsonRequest(), response: limited };
    await harness.switcher.onResponse(input);

    expect(input.response).toBe(limited);
    expect(harness.sent).toHaveLength(0);

    const decision: RetryInput = { error: { status: 429 }, attempt: 1, decision: { retry: true, delay: 500 } };
    await harness.switcher.onRetry(decision);
    expect(decision.decision).toEqual({ retry: false });

    const otherDecision: RetryInput = {
      error: { status: 500 },
      attempt: 1,
      decision: { retry: true, delay: 500 },
    };
    await harness.switcher.onRetry(otherDecision);
    expect(otherDecision.decision).toEqual({ retry: true, delay: 500 });
  });

  test("merely benched or unknown accounts keep OpenCode's retry untouched", async () => {
    const harness = createHarness({ accounts, stored: "c9", usageThrows: true });
    await harness.switcher.init();

    const requestInput = await sentWith(harness);
    const limited = new Response("rate limited", { status: 429 });
    const responseInput = { model: provider, request: requestInput.request, response: limited };
    await harness.switcher.onResponse(responseInput);
    expect(responseInput.response.status).toBe(200);

    const decision: RetryInput = { error: { status: 429 }, attempt: 1, decision: { retry: true, delay: 1_000 } };
    await harness.switcher.onRetry(decision);
    expect(decision.decision).toEqual({ retry: true, delay: 1_000 });
  });

  test("with usage unreachable a limit still switches and benches for the fallback cooldown", async () => {
    const harness = createHarness({ accounts, stored: "c9", usageThrows: true });
    await harness.switcher.init();

    const requestInput = await sentWith(harness);
    const responseInput = {
      model: provider,
      request: requestInput.request,
      response: new Response("rate limited", { status: 429 }),
    };
    await harness.switcher.onResponse(responseInput);

    expect(responseInput.response.status).toBe(200);
    expect(harness.sent[0]?.key).toBe(KEY_C95);
    expect(harness.stored()).toBe("c95");
    const blocked = harness.switcher.snapshot().accounts.find((account) => account.id === "c9");
    expect(blocked?.blockedUntil).toBe(T0 + 15 * MINUTE);
  });

  test("Retry-After sets the bench, in seconds and as a date", async () => {
    const seconds = createHarness({ accounts, stored: "c9", usageThrows: true });
    await seconds.switcher.init();
    const first = await sentWith(seconds);
    await seconds.switcher.onResponse({
      model: provider,
      request: first.request,
      response: new Response("rate limited", { status: 429, headers: { "retry-after": "60" } }),
    });
    expect(seconds.switcher.snapshot().accounts.find((account) => account.id === "c9")?.blockedUntil).toBe(
      T0 + MINUTE,
    );

    const dated = createHarness({ accounts, stored: "c9", usageThrows: true });
    await dated.switcher.init();
    const second = await sentWith(dated);
    await dated.switcher.onResponse({
      model: provider,
      request: second.request,
      response: new Response("rate limited", {
        status: 429,
        headers: { "retry-after": new Date(T0 + 5 * MINUTE).toUTCString() },
      }),
    });
    expect(dated.switcher.snapshot().accounts.find((account) => account.id === "c9")?.blockedUntil).toBe(
      T0 + 5 * MINUTE,
    );
  });

  test("a usage read slower than its budget counts as unreachable", async () => {
    const harness = createHarness({
      accounts,
      stored: "c9",
      usage: { c95: headroom(20, T0 + 5 * DAY) },
      usageStalls: ["c9"],
    });
    await harness.switcher.init();

    const requestInput = await sentWith(harness);
    const started = Date.now();
    const responseInput = {
      model: provider,
      request: requestInput.request,
      response: new Response("rate limited", { status: 429 }),
    };
    await harness.switcher.onResponse(responseInput);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(1_900);
    expect(responseInput.response.status).toBe(200);
    expect(harness.sent[0]?.key).toBe(KEY_C95);
    expect(harness.switcher.snapshot().accounts.find((account) => account.id === "c9")?.blockedUntil).toBe(
      T0 + 15 * MINUTE,
    );
  }, 10_000);

  test("two parallel failures switch once and both retry on the new account", async () => {
    const harness = createHarness({ accounts, stored: "c9", usageThrows: true });
    await harness.switcher.init();

    const first = await sentWith(harness);
    const second = await sentWith(harness);
    const firstResponse = {
      model: provider,
      request: first.request,
      response: new Response("rate limited", { status: 429 }),
    };
    const secondResponse = {
      model: provider,
      request: second.request,
      response: new Response("rate limited", { status: 429 }),
    };

    await Promise.all([
      harness.switcher.onResponse(firstResponse),
      harness.switcher.onResponse(secondResponse),
    ]);

    expect(firstResponse.response.status).toBe(200);
    expect(secondResponse.response.status).toBe(200);
    expect(harness.activated).toEqual(["c95"]);
    expect(harness.saved).toEqual(["c95"]);
    expect(harness.notifications).toHaveLength(1);
    expect(harness.sent.map((entry) => entry.key)).toEqual([KEY_C95, KEY_C95]);
  });

  test("a response without recorded state never retries a blocked account", async () => {
    const harness = createHarness({
      accounts,
      stored: "c9",
      usage: { c9: exhaustedMonthly(T0 + 10 * DAY), c95: headroom(20, T0 + 20 * DAY) },
    });
    await harness.switcher.init();
    await harness.switcher.refresh();

    const input = {
      model: provider,
      request: jsonRequest(),
      response: new Response("rate limited", { status: 429 }),
    };
    await harness.switcher.onResponse(input);

    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]?.key).toBe(KEY_C95);
    expect(input.response.status).toBe(200);
  });

  test("a rejected activation still sends the retried request", async () => {
    const harness = createHarness({
      accounts,
      stored: "c9",
      usage: { c9: headroom(20, T0 + 2 * DAY), c95: headroom(20, T0 + 5 * DAY) },
      activateFails: true,
    });
    await harness.switcher.init();
    await harness.switcher.refresh();

    const requestInput = await sentWith(harness);
    harness.setUsage("c9", exhaustedMonthly(T0 + 3 * DAY));
    const responseInput = {
      model: provider,
      request: requestInput.request,
      response: new Response("rate limited", { status: 429 }),
    };
    await harness.switcher.onResponse(responseInput);

    expect(responseInput.response.status).toBe(200);
    expect(harness.sent[0]?.key).toBe(KEY_C95);
    expect(harness.stored()).toBe("c95");
    expect(harness.activated).toEqual([]);
  });

  test("does not touch a successful response", async () => {
    const harness = createHarness({ accounts, stored: "c9" });
    await harness.switcher.init();

    const requestInput = await sentWith(harness);
    const ok = new Response("ok", { status: 200 });
    const responseInput = { model: provider, request: requestInput.request, response: ok };
    await harness.switcher.onResponse(responseInput);

    expect(responseInput.response).toBe(ok);
  });
});

describe("the current account and explicit selection", () => {
  test("the current account survives a restart", async () => {
    const first = createHarness({ accounts: allAccounts, stored: "c9" });
    await first.switcher.init();
    await first.switcher.status("cooper99");
    expect(first.stored()).toBe("c99");
    await first.switcher.stop();

    const second = createHarness({ accounts: allAccounts, stored: first.stored() });
    await second.switcher.init();
    expect(second.switcher.snapshot().currentID).toBe("c99");
    expect(await second.switcher.status()).toContain("current: cooper99 - restored from storage");
  });

  test("manual activation in the host does not change the key in use", async () => {
    const harness = createHarness({
      accounts,
      stored: "c95",
      usage: { c9: headroom(5, T0 + DAY), c95: headroom(90, T0 + 20 * DAY) },
    });
    await harness.switcher.init();
    await harness.switcher.refresh();

    harness.manualActivate("c9");
    const input = await sentWith(harness);

    expect(keyOf(input.request.headers)).toBe(KEY_C95);
  });

  test("selecting an eligible account switches, persists, activates, and notifies", async () => {
    const harness = createHarness({
      accounts,
      stored: "c95",
      usage: { c9: headroom(40, T0 + 10 * DAY), c95: headroom(10, T0 + 20 * DAY) },
    });
    await harness.switcher.init();

    const text = await harness.switcher.status("cooper9");

    expect(text).toContain("current: cooper9 - explicitly selected");
    expect(text).toContain("last switch: cooper95 → cooper9, explicitly selected");
    expect(harness.stored()).toBe("c9");
    expect(harness.activated).toEqual(["c9"]);
    expect(harness.notifications).toEqual([{ label: "cooper9", reason: "explicitly selected" }]);
  });

  test("selecting an unknown-usage account is allowed and matches case-insensitively", async () => {
    const harness = createHarness({ accounts, stored: "c9" });
    await harness.switcher.init();

    const text = await harness.switcher.status("COOPER95");

    expect(text).toContain("current: cooper95 - explicitly selected");
    expect(harness.stored()).toBe("c95");
    expect(harness.activated).toEqual(["c95"]);
  });

  test("selecting the current account changes nothing", async () => {
    const harness = createHarness({
      accounts,
      stored: "c95",
      usage: { c9: headroom(40, T0 + 10 * DAY), c95: headroom(10, T0 + 20 * DAY) },
    });
    await harness.switcher.init();

    const text = await harness.switcher.status("CoOpEr95");

    expect(text).toContain("current: cooper95");
    expect(harness.stored()).toBe("c95");
    expect(harness.saved).toEqual([]);
    expect(harness.activated).toEqual([]);
    expect(harness.notifications).toEqual([]);
  });

  test("selecting an exhausted account is refused with the window and its reset", async () => {
    const harness = createHarness({
      accounts,
      stored: "c95",
      usage: { c9: exhaustedMonthly(T0 + 4 * DAY), c95: headroom(20, T0 + 10 * DAY) },
    });
    await harness.switcher.init();

    const text = await harness.switcher.status("cooper9");
    const firstLine = text.split("\n")[0] ?? "";

    expect(firstLine).toContain('Refused: "cooper9" is exhausted: monthly until ');
    expect(firstLine).toContain(day(T0 + 4 * DAY));
    expect(text).toContain("current: cooper95");
    expect(harness.stored()).toBe("c95");
    expect(harness.activated).toEqual([]);
    expect(harness.notifications).toEqual([]);
  });

  test("selecting a disabled or invalid account is refused", async () => {
    const harness = createHarness({
      accounts: [
        { id: "c9", label: "cooper9", key: KEY_C9, disabled: true },
        { id: "c95", label: "cooper95", key: KEY_C95 },
      ],
      stored: "c95",
      usage: { c95: headroom(20, T0 + 10 * DAY) },
    });
    await harness.switcher.init();

    expect((await harness.switcher.status("cooper9")).split("\n")[0]).toContain(
      'Refused: "cooper9" is disabled',
    );

    harness.setUsage("c95", { type: "invalid-key" });
    await harness.switcher.refresh();
    expect((await harness.switcher.status("cooper95")).split("\n")[0]).toContain(
      'Refused: "cooper95" has an invalid key',
    );
    expect(harness.stored()).toBe("c95");
  });

  test("an unknown label is refused with the connected labels", async () => {
    const harness = createHarness({ accounts, stored: "c9" });
    await harness.switcher.init();

    const text = await harness.switcher.status("nope");
    const firstLine = text.split("\n")[0] ?? "";

    expect(firstLine).toContain('Refused: no connected account is labelled "nope"');
    expect(firstLine).toContain("Connected accounts: cooper9, cooper95");
    expect(harness.stored()).toBe("c9");
  });

  test("duplicate labels are refused as ambiguous", async () => {
    const harness = createHarness({
      accounts: [
        { id: "c9", label: "cooper9", key: KEY_C9 },
        { id: "c91", label: "cooper9", key: "fake-key-cooper9-second" },
      ],
      stored: "c9",
    });
    await harness.switcher.init();

    const text = await harness.switcher.status("Cooper9");

    expect(text.split("\n")[0]).toContain("Refused: 2 connected accounts are labelled \"Cooper9\"");
    expect(harness.stored()).toBe("c9");
    expect(harness.activated).toEqual([]);
  });
});

describe("status text", () => {
  test("names the product and version, then the current account, the last switch, and each account", async () => {
    const harness = createHarness({
      accounts: allAccounts,
      stored: "c95",
      usage: {
        c9: exhaustedMonthly(T0 + 4 * DAY),
        c95: headroom(85, T0 + 23 * DAY),
        c99: { type: "invalid-key" },
      },
    });
    await harness.switcher.init();

    const text = await harness.switcher.status();

    expect(text.split("\n")[0]).toBe("Go Switch 1.0.0");
    expect(text).toContain("OpenCode Go accounts (3 connected)");
    expect(text).toContain("current: cooper95 - restored from storage");
    expect(text).toContain("last switch: none");
    expect(text).toContain(`cooper9 - exhausted: monthly until ${day(T0 + 4 * DAY)}`);
    expect(text).toContain("cooper95 (current) - eligible");
    expect(text).toContain("monthly 85%");
    expect(text).toContain("cooper99 - invalid key");
  });

  test("shows one decimal only for a nearly full window", async () => {
    const harness = createHarness({
      accounts,
      stored: "c9",
      usage: { c9: { type: "usage", usage: usage({ rolling: win(99.42), weekly: win(12.6), monthly: win(100) }) } },
    });
    await harness.switcher.init();

    const text = await harness.switcher.status();

    expect(text).toContain("5h 99.4% · weekly 13% · monthly 100%");
  });

  test("keeps the last switch and its cause after several sticky requests", async () => {
    const harness = createHarness({
      accounts,
      stored: "c9",
      usage: { c9: exhaustedMonthly(T0 + 4 * DAY), c95: headroom(85, T0 + 23 * DAY) },
    });
    await harness.switcher.init();
    await harness.switcher.refresh();

    await sentWith(harness);
    await sentWith(harness);
    await sentWith(harness);

    const text = await harness.switcher.status();
    expect(text).toContain("current: cooper95 - sticky: still has headroom");
    expect(text).toContain("last switch: cooper9 → cooper95, cooper9 monthly limit");
  });

  test("refreshes usage it has not polled yet", async () => {
    const harness = createHarness({ accounts, stored: "c95", usage: { c95: headroom(42, T0 + 3 * DAY) } });
    await harness.switcher.init();

    expect(await harness.switcher.status()).toContain("monthly 42%");
  });

  test("never shows a key", async () => {
    const harness = createHarness({
      accounts: allAccounts,
      stored: "c9",
      usage: { c9: headroom(40, T0 + 10 * DAY), c95: headroom(50, T0 + 20 * DAY) },
    });
    await harness.switcher.init();

    const text = await harness.switcher.status();
    for (const key of [KEY_C9, KEY_C95, KEY_C99]) expect(text).not.toContain(key);
    expect(text).not.toContain("fake-key");
  });

  test("an empty account list produces a helpful status", async () => {
    const harness = createHarness({ accounts: [] });
    await harness.switcher.init();

    const text = await harness.switcher.status();
    expect(text.split("\n")[0]).toBe("Go Switch 1.0.0");
    expect(text).toContain("0 connected");
    expect(text).toContain("No OpenCode Go keys are connected");
  });
});
