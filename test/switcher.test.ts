import { describe, expect, test } from "bun:test";
import { createHarness, DAY, HOUR, jsonRequest, keyOf, T0, usage, win } from "./support.ts";

const provider = { providerID: "opencode-go" };
const allAccounts = [
  { id: "c9", label: "cooper9", key: "fake-key-cooper9-9f8e7d" },
  { id: "c95", label: "cooper95", key: "fake-key-cooper95-1a2b3c" },
  { id: "c99", label: "cooper99", key: "fake-key-cooper99-4d5e6f" },
];
const accounts = allAccounts.slice(0, 2);

function exhaustedMonthly(reset: number) {
  return { type: "usage" as const, usage: usage({ monthly: win(100, reset) }) };
}
function headroom(monthly: number, reset: number) {
  return { type: "usage" as const, usage: usage({ monthly: win(monthly, reset) }) };
}

describe("selection on a request", () => {
  test("monthly-exhausted current account switches to the account with headroom", async () => {
    const harness = createHarness({
      accounts,
      stored: "c9",
      usage: {
        c9: exhaustedMonthly(T0 + 20 * DAY),
        c95: headroom(85, T0 + 10 * DAY),
      },
    });
    await harness.switcher.init();
    await harness.switcher.refresh();

    const input = { model: provider, request: jsonRequest() };
    await harness.switcher.onRequest(input);

    expect(keyOf(input.request.headers)).toBe("fake-key-cooper95-1a2b3c");
    expect(harness.stored()).toBe("c95");
    expect(harness.activated).toEqual(["c95"]);
    expect(harness.toasts).toEqual([{ label: "cooper95", reason: "cooper9 monthly limit" }]);

    const text = await harness.switcher.status();
    expect(text).toContain("current: cooper95");
    expect(text).toContain("cooper9 - exhausted: monthly limit");
    expect(text).not.toContain("fake-key");
  });

  test("stays on the current account while it has headroom, even after the other one recovers", async () => {
    const harness = createHarness({
      accounts,
      stored: "c95",
      usage: {
        c9: exhaustedMonthly(T0 - HOUR),
        c95: headroom(40, T0 + 10 * DAY),
      },
    });
    await harness.switcher.init();
    await harness.switcher.refresh();

    const input = { model: provider, request: jsonRequest() };
    await harness.switcher.onRequest(input);

    expect(keyOf(input.request.headers)).toBe("fake-key-cooper95-1a2b3c");
    expect(harness.activated).toEqual([]);
    expect(harness.toasts).toEqual([]);
    expect(await harness.switcher.status()).toContain("sticky: still has headroom");
  });

  test("a weekly limit switches to the eligible account with the earliest monthly reset", async () => {
    const harness = createHarness({
      accounts: allAccounts,
      stored: "c9",
      usage: {
        c9: { type: "usage", usage: usage({ weekly: win(100, T0 + 2 * DAY), monthly: win(30, T0 + 3 * DAY) }) },
        c95: headroom(20, T0 + 5 * DAY),
        c99: headroom(60, T0 + 1 * DAY),
      },
    });
    await harness.switcher.init();
    await harness.switcher.refresh();

    const input = { model: provider, request: jsonRequest() };
    await harness.switcher.onRequest(input);

    expect(keyOf(input.request.headers)).toBe("fake-key-cooper99-4d5e6f");
    expect(harness.toasts).toEqual([{ label: "cooper99", reason: "cooper9 weekly limit" }]);
  });

  test("an account with an unknown monthly reset goes last", async () => {
    const harness = createHarness({
      accounts: allAccounts,
      stored: "c9",
      usage: {
        c9: exhaustedMonthly(T0 + DAY),
        c95: { type: "usage", usage: usage({ rolling: win(10, T0 + HOUR) }) },
        c99: headroom(95, T0 + 30 * DAY),
      },
    });
    await harness.switcher.init();
    await harness.switcher.refresh();

    const input = { model: provider, request: jsonRequest() };
    await harness.switcher.onRequest(input);

    expect(keyOf(input.request.headers)).toBe("fake-key-cooper99-4d5e6f");
  });

  test("a recovered account becomes usable again but does not steal the sticky current one", async () => {
    const harness = createHarness({
      accounts,
      stored: "c9",
      usage: {
        c9: exhaustedMonthly(T0 + HOUR),
        c95: headroom(50, T0 + 20 * DAY),
      },
    });
    await harness.switcher.init();
    await harness.switcher.refresh();

    const first = { model: provider, request: jsonRequest() };
    await harness.switcher.onRequest(first);
    expect(keyOf(first.request.headers)).toBe("fake-key-cooper95-1a2b3c");

    harness.setNow(T0 + 2 * HOUR);
    expect(await harness.switcher.status()).toContain("cooper9 - eligible");

    const second = { model: provider, request: jsonRequest() };
    await harness.switcher.onRequest(second);
    expect(keyOf(second.request.headers)).toBe("fake-key-cooper95-1a2b3c");
  });

  test("replaces an existing x-api-key instead of adding an authorization header", async () => {
    const harness = createHarness({ accounts, stored: "c9" });
    await harness.switcher.init();

    const input = { model: provider, request: jsonRequest("x-api-key") };
    await harness.switcher.onRequest(input);

    expect(input.request.headers.get("x-api-key")).toBe("fake-key-cooper9-9f8e7d");
    expect(input.request.headers.get("authorization")).toBeNull();
  });

  test("leaves the request untouched when no account is eligible", async () => {
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

  test("an unknown stored credential id falls back to the selection rule", async () => {
    const harness = createHarness({ accounts, stored: "gone" });
    await harness.switcher.init();

    const input = { model: provider, request: jsonRequest() };
    await harness.switcher.onRequest(input);
    expect(keyOf(input.request.headers)).toBe("fake-key-cooper9-9f8e7d");
  });

  test("never throws when the credential cannot be resolved", async () => {
    const harness = createHarness({
      accounts: [accounts[0]!],
      unresolvable: ["c9"],
    });
    await harness.switcher.init();

    const input = { model: provider, request: jsonRequest() };
    await harness.switcher.onRequest(input);
    expect(input.request.headers.get("authorization")).toBe("Bearer opencode-managed");
  });
});

describe("limit handling inside a response hook", () => {
  test("a 429 re-sends the same request with the next key and keeps the body", async () => {
    const harness = createHarness({
      accounts,
      stored: "c9",
      usage: { c9: exhaustedMonthly(T0 + 20 * DAY), c95: headroom(20, T0 + 10 * DAY) },
    });
    await harness.switcher.init();

    const request = jsonRequest();
    const requestInput = { model: provider, request };
    await harness.switcher.onRequest(requestInput);
    const originalRequest = requestInput.request;
    const body = await originalRequest.clone().text();

    const limited = new Response("rate limited", { status: 429 });
    const responseInput = { model: provider, request: originalRequest, response: limited };
    await harness.switcher.onResponse(responseInput);

    expect(responseInput.response.status).toBe(200);
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]?.url).toBe(originalRequest.url);
    expect(harness.sent[0]?.method).toBe("POST");
    expect(harness.sent[0]?.body).toBe(body);
    expect(harness.sent[0]?.key).toBe("fake-key-cooper95-1a2b3c");
    expect(harness.stored()).toBe("c95");
  });

  test("retries a 402 the same way", async () => {
    const harness = createHarness({
      accounts,
      stored: "c9",
      usage: { c9: exhaustedMonthly(T0 + DAY), c95: headroom(20, T0 + 2 * DAY) },
    });
    await harness.switcher.init();

    const requestInput = { model: provider, request: jsonRequest() };
    await harness.switcher.onRequest(requestInput);
    const limited = new Response("payment required", { status: 402 });
    const responseInput = { model: provider, request: requestInput.request, response: limited };
    await harness.switcher.onResponse(responseInput);

    expect(responseInput.response.status).toBe(200);
  });

  test("returns the original error when every account is exhausted", async () => {
    const harness = createHarness({
      accounts,
      stored: "c9",
      usage: { c9: exhaustedMonthly(T0 + DAY), c95: exhaustedMonthly(T0 + DAY) },
    });
    await harness.switcher.init();
    await harness.switcher.refresh();

    const request = jsonRequest();
    const limited = new Response("rate limited", { status: 429 });
    const responseInput = { model: provider, request, response: limited };
    await harness.switcher.onResponse(responseInput);

    expect(responseInput.response).toBe(limited);
    expect(harness.sent).toHaveLength(0);
  });

  test("a 401 marks the key invalid and switches", async () => {
    const harness = createHarness({
      accounts,
      stored: "c9",
      usage: { c95: headroom(20, T0 + 2 * DAY) },
    });
    await harness.switcher.init();

    const requestInput = { model: provider, request: jsonRequest() };
    await harness.switcher.onRequest(requestInput);
    const unauthorized = new Response("nope", { status: 401 });
    const responseInput = { model: provider, request: requestInput.request, response: unauthorized };
    await harness.switcher.onResponse(responseInput);

    expect(responseInput.response.status).toBe(200);
    expect(harness.toasts).toEqual([{ label: "cooper95", reason: "cooper9 invalid key" }]);
  });

  test("a 429 from the provider switches even when the usage endpoint is down", async () => {
    const harness = createHarness({ accounts, stored: "c9", usageThrows: true });
    await harness.switcher.init();

    const requestInput = { model: provider, request: jsonRequest() };
    await harness.switcher.onRequest(requestInput);
    const limited = new Response("rate limited", { status: 429 });
    const responseInput = { model: provider, request: requestInput.request, response: limited };
    await harness.switcher.onResponse(responseInput);

    expect(responseInput.response.status).toBe(200);
    expect(harness.sent[0]?.key).toBe("fake-key-cooper95-1a2b3c");
    const blocked = harness.switcher.snapshot().accounts.find((account) => account.id === "c9");
    expect(blocked?.blockedUntil).toBe(T0 + 900_000);
  });

  test("honours Retry-After when usage is unknown", async () => {
    const harness = createHarness({ accounts, stored: "c9" });
    await harness.switcher.init();

    const requestInput = { model: provider, request: jsonRequest() };
    await harness.switcher.onRequest(requestInput);
    const limited = new Response("rate limited", { status: 429, headers: { "retry-after": "60" } });
    const responseInput = { model: provider, request: requestInput.request, response: limited };
    await harness.switcher.onResponse(responseInput);

    const blocked = harness.switcher.snapshot().accounts.find((account) => account.id === "c9");
    expect(blocked?.blockedUntil).toBe(T0 + 60_000);
  });

  test("a limit that fresh usage does not explain leaves the response alone", async () => {
    const harness = createHarness({
      accounts,
      stored: "c9",
      usage: { c9: headroom(20, T0 + 2 * DAY) },
    });
    await harness.switcher.init();

    const requestInput = { model: provider, request: jsonRequest() };
    await harness.switcher.onRequest(requestInput);
    const limited = new Response("rate limited", { status: 429 });
    const responseInput = { model: provider, request: requestInput.request, response: limited };
    await harness.switcher.onResponse(responseInput);

    expect(responseInput.response).toBe(limited);
    expect(harness.sent).toHaveLength(0);
    expect(harness.activated).toEqual([]);
  });

  test("switching still works when activation is rejected", async () => {
    const harness = createHarness({
      accounts,
      stored: "c9",
      usage: { c9: exhaustedMonthly(T0 + DAY), c95: headroom(20, T0 + 2 * DAY) },
      activateFails: true,
    });
    await harness.switcher.init();

    const requestInput = { model: provider, request: jsonRequest() };
    await harness.switcher.onRequest(requestInput);
    const limited = new Response("rate limited", { status: 429 });
    const responseInput = { model: provider, request: requestInput.request, response: limited };
    await harness.switcher.onResponse(responseInput);

    expect(responseInput.response.status).toBe(200);
    expect(harness.stored()).toBe("c95");
    expect(harness.activated).toEqual([]);
  });

  test("a second failing request reuses the account the first one switched to", async () => {
    const harness = createHarness({
      accounts,
      stored: "c9",
      usage: { c9: exhaustedMonthly(T0 + DAY), c95: headroom(20, T0 + 2 * DAY) },
    });
    await harness.switcher.init();

    const first = { model: provider, request: jsonRequest() };
    const second = { model: provider, request: jsonRequest() };
    await harness.switcher.onRequest(first);
    await harness.switcher.onRequest(second);

    const firstResponse = { model: provider, request: first.request, response: new Response("no", { status: 429 }) };
    await harness.switcher.onResponse(firstResponse);
    const secondResponse = {
      model: provider,
      request: second.request,
      response: new Response("no", { status: 429 }),
    };
    await harness.switcher.onResponse(secondResponse);

    expect(firstResponse.response.status).toBe(200);
    expect(secondResponse.response.status).toBe(200);
    expect(harness.activated).toEqual(["c95"]);
    expect(harness.toasts).toHaveLength(1);
    expect(harness.sent.map((entry) => entry.key)).toEqual([
      "fake-key-cooper95-1a2b3c",
      "fake-key-cooper95-1a2b3c",
    ]);
  });

  test("does not touch a successful response", async () => {
    const harness = createHarness({ accounts, stored: "c9" });
    await harness.switcher.init();

    const requestInput = { model: provider, request: jsonRequest() };
    await harness.switcher.onRequest(requestInput);
    const ok = new Response("ok", { status: 200 });
    const responseInput = { model: provider, request: requestInput.request, response: ok };
    await harness.switcher.onResponse(responseInput);

    expect(responseInput.response).toBe(ok);
  });
});

describe("persistence and the status tool", () => {
  test("the current account survives a restart", async () => {
    const first = createHarness({ accounts: allAccounts, stored: "c9" });
    await first.switcher.init();
    await first.switcher.status("cooper99");
    expect(first.stored()).toBe("c99");
    await first.switcher.stop();

    const second = createHarness({ accounts: allAccounts, stored: first.stored() });
    await second.switcher.init();
    expect(second.switcher.snapshot().currentID).toBe("c99");
  });

  test("manual activation elsewhere is ignored: only the stored current is used", async () => {
    const harness = createHarness({
      accounts,
      stored: "c95",
      usage: {
        c9: headroom(5, T0 + DAY),
        c95: headroom(90, T0 + 20 * DAY),
      },
    });
    await harness.switcher.init();
    await harness.switcher.refresh();

    const input = { model: provider, request: jsonRequest() };
    await harness.switcher.onRequest(input);

    expect(keyOf(input.request.headers)).toBe("fake-key-cooper95-1a2b3c");
  });

  test("status lists every account without key material", async () => {
    const harness = createHarness({
      accounts: allAccounts,
      stored: "c9",
      usage: {
        c9: exhaustedMonthly(T0 + 10 * DAY),
        c95: headroom(85, T0 + 20 * DAY),
        c99: { type: "invalid-key" },
      },
    });
    await harness.switcher.init();

    const text = await harness.switcher.status();
    expect(text).toContain("OpenCode Go accounts (3 connected)");
    expect(text).toContain("cooper9 - current, exhausted: monthly limit");
    expect(text).toContain("cooper95 - eligible");
    expect(text).toContain("monthly 85%");
    expect(text).toContain("monthly resets");
    expect(text).toContain("cooper99 - invalid key");
    expect(text).not.toContain("fake-key");
    expect(text).not.toContain("cooper9-9f8e7d");
  });

  test("status refreshes usage it has not polled yet", async () => {
    const harness = createHarness({
      accounts,
      stored: "c95",
      usage: { c95: headroom(42, T0 + 3 * DAY) },
    });
    await harness.switcher.init();

    const text = await harness.switcher.status();
    expect(text).toContain("monthly 42%");
  });

  test("select makes the named account current even when another looks better", async () => {
    const harness = createHarness({
      accounts,
      stored: "c95",
      usage: {
        c9: headroom(95, T0 + 10 * DAY),
        c95: headroom(10, T0 + 20 * DAY),
      },
    });
    await harness.switcher.init();
    await harness.switcher.refresh();

    const text = await harness.switcher.status("cooper9");
    expect(text).toContain("current: cooper9 - explicitly selected");
    expect(harness.stored()).toBe("c9");
    expect(harness.activated).toEqual(["c9"]);
    expect(harness.toasts).toEqual([{ label: "cooper9", reason: "explicitly selected" }]);
  });

  test("select matches labels case-insensitively and rejects unknown ones", async () => {
    const harness = createHarness({ accounts: allAccounts, stored: "c9" });
    await harness.switcher.init();

    await harness.switcher.status("COOPER95");
    expect(harness.stored()).toBe("c95");

    await expect(harness.switcher.status("nope")).rejects.toThrow(
      'Unknown account "nope". Connected accounts: cooper9, cooper95, cooper99.',
    );
  });

  test("an empty account list produces a helpful status", async () => {
    const harness = createHarness({ accounts: [] });
    await harness.switcher.init();
    const text = await harness.switcher.status();
    expect(text).toContain("0 connected");
    expect(text).toContain("No OpenCode Go keys are connected");
  });
});
