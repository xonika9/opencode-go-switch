import { describe, expect, test } from "bun:test";
import { fetchUsage, MAX_USAGE_BYTES, parseUsage, retryAfterMs } from "../src/usage.ts";
import type { FetchLike } from "../src/usage.ts";

const validPayload = {
  usage: {
    rolling: { status: "ok", percent: 32.5, resetsAt: "2026-11-18T15:00:00.000Z" },
    weekly: { status: "ok", percent: 44, resetsAt: "2026-11-22T00:00:00.000Z" },
    monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-12-01T00:00:00.000Z" },
  },
  extra: { ignored: true },
};

const options = (fetch: FetchLike, overrides: { timeoutMs?: number; maxBytes?: number } = {}) => ({
  fetch,
  url: "https://opencode.ai/zen/go/v1/usage",
  timeoutMs: overrides.timeoutMs ?? 1_000,
  maxBytes: overrides.maxBytes,
});

describe("parseUsage", () => {
  test("reads all three windows and ignores unknown fields", () => {
    expect(parseUsage(validPayload)).toEqual({
      rolling: { percent: 32.5, limited: false, resetsAt: Date.parse("2026-11-18T15:00:00.000Z") },
      weekly: { percent: 44, limited: false, resetsAt: Date.parse("2026-11-22T00:00:00.000Z") },
      monthly: { percent: 100, limited: true, resetsAt: Date.parse("2026-12-01T00:00:00.000Z") },
    });
  });

  test("keeps a window with an unusable reset time, without a reset time", () => {
    const parsed = parseUsage({
      usage: {
        rolling: { status: "ok", percent: 1 },
        weekly: { status: "ok", percent: 2, resetsAt: "not a date" },
        monthly: { status: "rate-limited", percent: 100, resetsAt: 12345 },
      },
    });
    expect(parsed?.rolling.resetsAt).toBeNull();
    expect(parsed?.weekly.resetsAt).toBeNull();
    expect(parsed?.monthly.limited).toBe(true);
    expect(parsed?.monthly.resetsAt).toBeNull();
  });

  test("treats out-of-range percentages as exhausted rather than rejecting the payload", () => {
    const parsed = parseUsage({
      usage: {
        rolling: { status: "ok", percent: 0 },
        weekly: { status: "ok", percent: 0 },
        monthly: { status: "ok", percent: 140, resetsAt: "2026-12-01T00:00:00Z" },
      },
    });
    expect(parsed?.monthly.limited).toBe(true);
  });

  test("rejects malformed and incomplete payloads", () => {
    const bad: unknown[] = [
      null,
      [],
      {},
      { usage: null },
      { usage: [] },
      { usage: { rolling: { status: "ok", percent: 1 } } },
      {
        usage: {
          rolling: { status: "ok", percent: "10" },
          weekly: { status: "ok", percent: 1 },
          monthly: { status: "ok", percent: 1 },
        },
      },
      {
        usage: {
          rolling: { status: "weird", percent: 1 },
          weekly: { status: "ok", percent: 1 },
          monthly: { status: "ok", percent: 1 },
        },
      },
      {
        usage: {
          rolling: { status: "ok", percent: -5 },
          weekly: { status: "ok", percent: 1 },
          monthly: { status: "ok", percent: 1 },
        },
      },
      {
        usage: {
          rolling: { status: "ok", percent: 1 },
          weekly: { status: "ok", percent: 1 },
          monthly: { status: "ok" },
        },
      },
    ];
    for (const payload of bad) expect(parseUsage(payload)).toBeNull();
  });
});

describe("fetchUsage", () => {
  test("returns parsed usage from a good response", async () => {
    const result = await fetchUsage(
      "test-key",
      options(async () => new Response(JSON.stringify(validPayload), { status: 200 })),
    );
    expect(result.type).toBe("usage");
    if (result.type !== "usage") throw new Error("unreachable");
    expect(result.usage.monthly.limited).toBe(true);
  });

  test("sends the key as a bearer token", async () => {
    let seen: RequestInit | undefined;
    let url: string | undefined;
    await fetchUsage(
      "test-key",
      options(async (input, init) => {
        url = input;
        seen = init;
        return new Response(JSON.stringify(validPayload), { status: 200 });
      }),
    );
    expect(url).toBe("https://opencode.ai/zen/go/v1/usage");
    expect((seen?.headers as Record<string, string>).authorization).toBe("Bearer test-key");
    expect(seen?.signal).toBeDefined();
  });

  test("malformed JSON and a wrong shape are unavailable", async () => {
    expect((await fetchUsage("k", options(async () => new Response("{oops", { status: 200 })))).type).toBe(
      "unavailable",
    );
    expect(
      (await fetchUsage("k", options(async () => new Response('{"usage":{}}', { status: 200 })))).type,
    ).toBe("unavailable");
  });

  test("server errors and network failures are unavailable", async () => {
    expect((await fetchUsage("k", options(async () => new Response("down", { status: 500 })))).type).toBe(
      "unavailable",
    );
    expect(
      (
        await fetchUsage(
          "k",
          options(async () => {
            throw new Error("connection refused");
          }),
        )
      ).type,
    ).toBe("unavailable");
  });

  test("401 and 403 mark the key invalid", async () => {
    expect((await fetchUsage("k", options(async () => new Response("no", { status: 401 })))).type).toBe(
      "invalid-key",
    );
    expect((await fetchUsage("k", options(async () => new Response("no", { status: 403 })))).type).toBe(
      "invalid-key",
    );
  });

  test("the body cap is enforced while streaming, without Content-Length", async () => {
    const body = new TextEncoder().encode(JSON.stringify(validPayload).padEnd(400, " "));
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < body.byteLength; offset += 40) chunks.push(body.slice(offset, offset + 40));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[sent];
        if (chunk === undefined) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    const result = await fetchUsage(
      "k",
      options(() => Promise.resolve(new Response(stream, { status: 200 })), { maxBytes: 100 }),
    );
    expect(result.type).toBe("unavailable");
    expect(sent).toBeLessThan(chunks.length);
  });

  test("a declared Content-Length above the cap short-circuits", async () => {
    const response = new Response(JSON.stringify(validPayload), {
      status: 200,
      headers: { "content-length": String(MAX_USAGE_BYTES + 1) },
    });
    expect((await fetchUsage("k", options(async () => response))).type).toBe("unavailable");
  });

  test("a request that never answers times out as unavailable", async () => {
    const slow: FetchLike = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const started = Date.now();
    const result = await fetchUsage("k", options(slow, { timeoutMs: 20 }));
    expect(result.type).toBe("unavailable");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("retryAfterMs", () => {
  test("accepts delay-seconds and HTTP dates", () => {
    expect(retryAfterMs("60", 0)).toBe(60_000);
    expect(retryAfterMs("Thu, 01 Jan 2026 00:01:00 GMT", Date.parse("2026-01-01T00:00:00Z"))).toBe(60_000);
  });

  test("ignores missing or unparsable values", () => {
    expect(retryAfterMs(null, 0)).toBeNull();
    expect(retryAfterMs("", 0)).toBeNull();
    expect(retryAfterMs("soon", 0)).toBeNull();
  });
});
